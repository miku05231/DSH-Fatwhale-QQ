<#
.SYNOPSIS
    QQ-DSH 启动器 · 系统托盘主程序

.DESCRIPTION
    以 Windows PowerShell 5.1（STA）+ WinForms 运行，只依赖 .NET Framework 自带的
    System.Windows.Forms / System.Drawing。托盘图标与窗口图标用 assets\app-icon.png
    （快捷方式用 assets\app-icon.ico），状态用右下角的小圆点表示，头像本身不变。

    本脚本只负责「托盘、右键菜单、定时刷新、把功能接起来」，具体能力来自两个同级模块：
        lib\ProcessControl.ps1   进程探测 / 启动 / 停止 / 登录态 / 日志
        lib\UiWindows.ps1        人格设置窗口 / 会话管理窗口

    图标状态（头像右下角的小点；正常时不画点）：
        无点      NapCat 已登录 且 DSH 运行中（绿色 #2ECC71）
        黄点 #F1C40F  NapCat 在运行但未登录（进程在，不满足正常条件）
        红点 #E74C3C  NapCat 未运行，或 DSH 未运行（$script:RequireDsh = $true 时）
    图标文件丢失时自动退回旧版“彩色实心圆 + 字母 Q”，不会变成空白托盘。

    启动方式：
        powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File launcher\Launcher.ps1

    重要：本文件必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 读取中文会乱码。
#>

# ---------------------------------------------------------------- 运行环境检查（STA）

# WinForms 需要 STA 线程。若被以 MTA 方式拉起，用 -STA 重新启动自己后退出。
try {
    $script:Apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState()
} catch {
    $script:Apartment = [System.Threading.ApartmentState]::Unknown
}
if ($script:Apartment -ne [System.Threading.ApartmentState]::STA) {
    $psExePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ((Test-Path -LiteralPath $psExePath -PathType Leaf) -and (-not [string]::IsNullOrEmpty($PSCommandPath))) {
        $relaunchArgs = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
        try {
            Start-Process -FilePath $psExePath -ArgumentList $relaunchArgs | Out-Null
        } catch {
            # 没有任何 UI 可用，只能静默退出
        }
        exit 0
    }
}

$ErrorActionPreference = 'Continue'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }

# 界面线程未捕获异常：弹气泡 + 记日志，绝不崩溃。
# 必须在消息循环启动、首个窗口句柄创建之前设置，否则 CatchException 模式可能不生效，
# 所以这里放在最前面；被调用的函数在脚本作用域里，晚于此处定义也能正常解析。
try {
    [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
    [System.Windows.Forms.Application]::add_ThreadException({
        param($sender, $eventArgs)
        $message = '未知错误'
        try {
            if (($null -ne $eventArgs) -and ($null -ne $eventArgs.Exception)) {
                $message = $eventArgs.Exception.Message
            }
        } catch {
        }
        try { Write-LauncherLog ('界面线程异常：' + $message) 'ERROR' } catch { }
        try { Show-Balloon 'QQ-DSH 启动器出现异常' ($message + '（已记录到 launcher.log，程序继续运行）') ([System.Windows.Forms.ToolTipIcon]::Error) } catch { }
    })
} catch {
    # 挂不上兜底处理器也不影响主流程，各菜单动作本身都有 try/catch
}

# ---------------------------------------------------------------- 路径与常量

$script:LauncherDir = $PSScriptRoot
$script:LauncherScriptPath = Join-Path $script:LauncherDir 'Launcher.ps1'
$script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $script:LauncherDir '..'))
$script:LibDir = Join-Path $script:LauncherDir 'lib'
$script:ProcessControlPath = Join-Path $script:LibDir 'ProcessControl.ps1'
$script:UiWindowsPath = Join-Path $script:LibDir 'UiWindows.ps1'

$script:StateDir = Join-Path $script:ProjectRoot 'state'
$script:LogPath = Join-Path $script:StateDir 'launcher.log'
$script:NapCatDir = Join-Path $script:ProjectRoot 'napcat'
$script:WorkspaceDir = Join-Path $script:ProjectRoot 'qq-workspace'
$script:AppIconPng = Join-Path $script:ProjectRoot 'assets\app-icon.png'
$script:AppIconIco = Join-Path $script:ProjectRoot 'assets\app-icon.ico'
$script:AppIconImage = $null
$script:ShortcutName = 'QQDshLauncher.lnk'

# 日志最多保留的行数，超出时重写文件
$script:LogLimit = 500

# 服务地址（与 SPEC-launcher.md 一致）
$script:NapCatWebUiUrl = 'http://127.0.0.1:6099'
$script:NapCatScanUrl = 'http://127.0.0.1:6099/webui'
$script:DshUiUrl = 'http://127.0.0.1:5825'
$script:DshPluginsUrl = 'http://127.0.0.1:5825'

# 控制台（Material You 面板）与记忆库（Obsidian）
#
# 控制台端口由 src\webui\server.mjs 启动后写进 state\webui-port.txt：
# 5830 被占用时它会顺延，所以端口一律以文件为准，读不到才退回默认 5830。
$script:ConsoleDefaultPort = 5830
$script:ConsolePortFile = Join-Path $script:StateDir 'webui-port.txt'
$script:EdgeX86Path = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$script:EdgeX64Path = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
# 记忆库根目录（SPEC-2 §2）
# 记忆库默认放在「我的文档」下；config.json 里 memory.root 可覆盖（见 Get-ConfiguredMemoryRoot）
$script:MemoryRoot = ''
try {
    $documents = [Environment]::GetFolderPath('MyDocuments')
    if ([string]::IsNullOrWhiteSpace($documents)) { $documents = Join-Path $env:USERPROFILE 'Documents' }
    $script:MemoryRoot = Join-Path $documents 'Obsidian Vault\大肥鱼'
} catch {
    $script:MemoryRoot = Join-Path $env:USERPROFILE 'Documents\Obsidian Vault\大肥鱼'
}

# 状态色
$script:ColorGreen = [System.Drawing.Color]::FromArgb(46, 204, 113)    # #2ECC71
$script:ColorYellow = [System.Drawing.Color]::FromArgb(241, 196, 15)  # #F1C40F
$script:ColorRed = [System.Drawing.Color]::FromArgb(231, 76, 60)      # #E74C3C

# DSH 未运行时算不算异常：$true 时 DSH 未运行 → 红色；$false 时 DSH 状态不影响颜色
$script:RequireDsh = $true

# 运行期状态
$script:Exiting = $false
$script:LastLevel = ''
$script:LastSummary = ''
$script:LastProblem = ''
$script:LastStatus = $null
$script:TrayIcon = $null
$script:Menu = $null
$script:Timer = $null
$script:StatusItem = $null
$script:AutostartItem = $null
$script:IconGreen = $null
$script:IconYellow = $null
$script:IconRed = $null
$script:OwnsMutex = $false
$script:Mutex = $null

# ---------------------------------------------------------------- 依赖模块检查

$missingModules = @()
if (-not (Test-Path -LiteralPath $script:ProcessControlPath -PathType Leaf)) { $missingModules += $script:ProcessControlPath }
if (-not (Test-Path -LiteralPath $script:UiWindowsPath -PathType Leaf)) { $missingModules += $script:UiWindowsPath }

if ($missingModules.Count -gt 0) {
    $body = '缺少以下必需模块，启动器无法运行：' + "`r`n`r`n" + ($missingModules -join "`r`n") + "`r`n`r`n" + '请确认 launcher\lib 目录完整后重新启动。'
    try {
        $null = [System.Windows.Forms.MessageBox]::Show(
            $body,
            'QQ-DSH 启动器无法启动',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {
        # 连对话框都弹不出来时只能退出码说明问题
    }
    exit 1
}

try {
    . $script:ProcessControlPath
} catch {
    $loadError = $_.Exception.Message
    try {
        $null = [System.Windows.Forms.MessageBox]::Show(
            ('加载 ProcessControl.ps1 失败：' + "`r`n`r`n" + $loadError),
            'QQ-DSH 启动器无法启动',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {
    }
    exit 1
}

try {
    . $script:UiWindowsPath
} catch {
    $loadError = $_.Exception.Message
    try {
        $null = [System.Windows.Forms.MessageBox]::Show(
            ('加载 UiWindows.ps1 失败：' + "`r`n`r`n" + $loadError),
            'QQ-DSH 启动器无法启动',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {
    }
    exit 1
}

# ---------------------------------------------------------------- 单实例互斥体

try {
    $script:Mutex = [System.Threading.Mutex]::new($false, 'Global\qqdsh-launcher')
} catch {
    # Global\ 命名空间不可用时退回 Local\
    try { $script:Mutex = [System.Threading.Mutex]::new($false, 'Local\qqdsh-launcher') } catch { $script:Mutex = $null }
}
if ($null -ne $script:Mutex) {
    try {
        $script:OwnsMutex = $script:Mutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
        # 上一个启动器异常退出，互斥体已被系统移交给我们
        $script:OwnsMutex = $true
    } catch {
        $script:OwnsMutex = $false
    }
}
if (-not $script:OwnsMutex) {
    # 已经有一个启动器在托盘里：静默退出，避免出现第二个图标
    exit 0
}

# ---------------------------------------------------------------- 原生方法（销毁 HICON）

$script:CanDestroyIcon = $false
try {
    if ($null -eq ('QqDshLauncher.NativeMethods' -as [type])) {
        Add-Type -Namespace 'QqDshLauncher' -Name 'NativeMethods' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(System.IntPtr hIcon);
'@
    }
    $script:CanDestroyIcon = $true
} catch {
    # 编译不出 P/Invoke 也能用，只是 GetHicon 出来的句柄会泄漏几个，无实际影响
    $script:CanDestroyIcon = $false
}

# ---------------------------------------------------------------- 日志

# 把可能出现的凭据打码：日志里绝不允许出现 NapCat token 明文
function Hide-SecretText {
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $result = $Text
    # token=xxx / token: xxx / password=xxx 之类
    $result = $result -replace '(?i)(token|access_token|authorization|password|passwd|secret)\s*[=:]\s*[^\s&,;]+', '$1=***'
    # Authorization: Bearer xxx
    $result = $result -replace '(?i)(bearer)\s+[A-Za-z0-9\._\-]+', '$1 ***'
    return $result
}

# 追加一行日志；超过 500 行时重写文件只保留最后 500 行。日志失败绝不影响托盘。
function Write-LauncherLog {
    param([string]$Message, [string]$Level = 'INFO')

    try {
        $safeText = Hide-SecretText ([string]$Message)
        if ($safeText.Length -gt 600) { $safeText = $safeText.Substring(0, 600) + '…' }

        $levelText = [string]$Level
        if ([string]::IsNullOrWhiteSpace($levelText)) { $levelText = 'INFO' }

        $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' [' + $levelText.ToUpperInvariant() + '] ' + $safeText + "`r`n"

        if (-not (Test-Path -LiteralPath $script:StateDir -PathType Container)) {
            $null = New-Item -ItemType Directory -Path $script:StateDir -Force -ErrorAction Stop
        }

        # 追加（新文件由 .NET 自动写 BOM，之后追加不会重复写 BOM）
        [System.IO.File]::AppendAllText($script:LogPath, $line, [System.Text.UTF8Encoding]::new($true))

        # 行数超限时重写文件，保留最近 $script:LogLimit 行
        $lines = [System.IO.File]::ReadAllLines($script:LogPath, [System.Text.Encoding]::UTF8)
        if ($lines.Count -gt $script:LogLimit) {
            $startIndex = $lines.Count - $script:LogLimit
            $keep = $lines[$startIndex..($lines.Count - 1)]
            [System.IO.File]::WriteAllLines($script:LogPath, [string[]]$keep, [System.Text.UTF8Encoding]::new($true))
        }
    } catch {
        # 日志写不进去不能影响托盘
    }
}

# ---------------------------------------------------------------- 通用小工具

# 托盘气泡提示；Text 字段有长度上限，超了直接抛异常，所以一律截断
function Show-Balloon {
    param(
        [string]$Title,
        [string]$Message,
        [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
    )

    if ($null -eq $script:TrayIcon) { return }
    try {
        $titleText = [string]$Title
        if ($titleText.Length -gt 60) { $titleText = $titleText.Substring(0, 60) }
        $messageText = [string]$Message
        if ($messageText.Length -gt 250) { $messageText = $messageText.Substring(0, 250) + '…' }

        $script:TrayIcon.BalloonTipTitle = $titleText
        $script:TrayIcon.BalloonTipText = $messageText
        $script:TrayIcon.BalloonTipIcon = $Icon
        $script:TrayIcon.ShowBalloonTip(4000)
    } catch {
        # 气泡提示失败不影响主流程
    }
}

function Get-OkText {
    param([bool]$Value)
    if ($Value) { return '成功' }
    return '失败'
}

# 用默认浏览器打开 URL
function Open-Url {
    param([string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }

    try {
        Start-Process -FilePath $Url | Out-Null
        return $true
    } catch {
        # Start-Process 失败时退回 ShellExecute
    }

    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $Url
        $startInfo.UseShellExecute = $true
        $null = [System.Diagnostics.Process]::Start($startInfo)
        return $true
    } catch {
        Write-LauncherLog ('打开链接失败：' + $Url + ' → ' + $_.Exception.Message) 'ERROR'
        return $false
    }
}

# ---------------------------------------------------------------- 调用 lib\ProcessControl.ps1 / UiWindows.ps1

function Test-LibFunction {
    param([string]$Name)

    $command = Get-Command -Name $Name -CommandType Function -ErrorAction SilentlyContinue
    return ($null -ne $command)
}

# 统一的库函数调用入口：函数不存在时给出可读的错误，调用方自行 try/catch
function Invoke-LibFunction {
    param(
        [string]$Name,
        [object[]]$Arguments = @()
    )

    if (-not (Test-LibFunction $Name)) {
        throw ('缺少库函数 ' + $Name + '（请检查 launcher\lib 下的模块是否完整）')
    }

    if ($null -ne $Arguments -and $Arguments.Count -gt 0) {
        return (& $Name @Arguments)
    }
    return (& $Name)
}

# ---------------------------------------------------------------- 开机自启（启动文件夹快捷方式）
#
# 自启动项指向 launcher\bootstrap.ps1，而不是托盘脚本：
#   登录 → bootstrap（隐藏窗口）→ NapCat → 桥接 → 控制台 → DSH → 托盘
# 这样先把底层服务拉起来，托盘晚一点出现也不影响 QQ 消息。
# 自启动默认开启，但不硬塞：只有首次运行或旧版指向托盘脚本时才自动修正，用户主动关掉的不再偷偷打开。

$script:AutostartCache = $null
$script:AutostartCacheAt = [DateTime]::MinValue

function Get-StartupShortcutPath {
    $startupDir = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
    return (Join-Path $startupDir $script:ShortcutName)
}

# 读快捷方式的真实指向。结果缓存 15 秒，避免每 3 秒都去开一次 WScript.Shell。
function Get-StartupShortcutInfo {
    param([switch]$Force)

    $now = Get-Date
    if (-not $Force -and ($null -ne $script:AutostartCache)) {
        if (($now - $script:AutostartCacheAt).TotalSeconds -lt 15) { return $script:AutostartCache }
    }

    $info = [pscustomobject]@{
        ShortcutPath      = (Get-StartupShortcutPath)
        Exists            = $false
        TargetPath        = ''
        Arguments         = ''
        PointsToBootstrap = $false
        PointsToLauncher  = $false
        Readable          = $false
    }

    $path = [string]$info.ShortcutPath
    if (-not [string]::IsNullOrWhiteSpace($path) -and [System.IO.File]::Exists($path)) {
        $info.Exists = $true
        $shell = $null
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($path)
            $info.TargetPath = [string]$shortcut.TargetPath
            $info.Arguments = [string]$shortcut.Arguments
            $info.Readable = $true
        } catch {
            # 快捷方式被占用或 COM 不可用：保持 Readable = $false，调用方按“未知”处理
        } finally {
            if ($null -ne $shell) {
                try { $null = [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch { }
            }
        }

        $haystack = ([string]$info.TargetPath + ' ' + [string]$info.Arguments).ToLowerInvariant()
        if ($haystack.IndexOf('bootstrap.ps1') -ge 0) { $info.PointsToBootstrap = $true }
        if ($haystack.IndexOf('launcher.ps1') -ge 0) { $info.PointsToLauncher = $true }
    }

    $script:AutostartCache = $info
    $script:AutostartCacheAt = $now
    return $info
}

# 只有「快捷方式存在 + 确实指向 bootstrap.ps1」才算开启；
# 读不出内容时退化为“存在即视为开启”，避免误把好的自启动关掉。
function Test-AutostartEnabled {
    param([switch]$Force)

    $info = Get-StartupShortcutInfo -Force:$Force
    if (-not $info.Exists) { return $false }
    if (-not $info.Readable) { return $true }
    if ([string]::IsNullOrWhiteSpace($info.TargetPath)) { return $true }
    return [bool]$info.PointsToBootstrap
}

function Get-PowerShellExePath {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $psExe -PathType Leaf) { return $psExe }
    return 'powershell.exe'
}

function Get-BootstrapScriptPath {
    return (Join-Path $script:LauncherDir 'bootstrap.ps1')
}

function Enable-Autostart {
    param([switch]$Silent)

    $shortcutPath = Get-StartupShortcutPath
    $bootstrapPath = Get-BootstrapScriptPath

    if (-not (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
        Write-LauncherLog ('找不到引导脚本，无法设置开机自启：' + $bootstrapPath) 'ERROR'
        if (-not $Silent) {
            Show-Balloon '找不到引导脚本' ('缺少 ' + $bootstrapPath + '，无法设置开机自启。') ([System.Windows.Forms.ToolTipIcon]::Error)
        }
        return $false
    }

    $psExe = Get-PowerShellExePath
    # 目标命令行：powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<bootstrap.ps1>"
    $argumentLine = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $bootstrapPath + '"'

    $shell = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $psExe
        $shortcut.Arguments = $argumentLine
        $shortcut.WorkingDirectory = $script:ProjectRoot
        $shortcut.WindowStyle = 7
        if (Test-Path -LiteralPath $script:AppIconIco -PathType Leaf) {
            $shortcut.IconLocation = $script:AppIconIco + ',0'
        } else {
            $shortcut.IconLocation = $psExe + ',0'
        }
        $shortcut.Description = 'QQ-DSH 一键启动（开机自启）'
        $shortcut.Save()

        $script:AutostartCache = $null
        Write-LauncherLog ('已启用开机自启：' + $shortcutPath + ' → ' + $psExe + ' ' + $argumentLine)
        if (-not $Silent) {
            Show-Balloon '开机自启已开启' '下次登录 Windows 时会自动启动 QQ-DSH（后台隐藏窗口，随后出现托盘图标）。'
        }
        return $true
    } catch {
        Write-LauncherLog ('设置开机自启失败：' + $_.Exception.Message) 'ERROR'
        if (-not $Silent) {
            Show-Balloon '设置开机自启失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
        }
        return $false
    } finally {
        if ($null -ne $shell) {
            try { $null = [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch { }
        }
    }
}

function Disable-Autostart {
    $shortcutPath = Get-StartupShortcutPath
    try {
        if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
            Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction Stop
        }
        $script:AutostartCache = $null
        Write-LauncherLog '已关闭开机自启'
        Show-Balloon '开机自启已关闭' '下次登录 Windows 时不会再自动启动。'
        return $true
    } catch {
        Write-LauncherLog ('取消开机自启失败：' + $_.Exception.Message) 'ERROR'
        Show-Balloon '取消开机自启失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
        return $false
    }
}

# 首次运行 / 旧版自启动项修正：静默执行，不打扰用户（失败只记日志）。
#
# 默认开启，但不硬塞：用 state\autostart-initialized.txt 记住“已经初始化过”，
# 用户之后在菜单里取消勾选，下次启动不会被偷偷改回来。
function Set-AutostartMarker {
    try {
        $markerDir = $script:StateDir
        if (-not [System.IO.Directory]::Exists($markerDir)) {
            $null = [System.IO.Directory]::CreateDirectory($markerDir)
        }
        $markerPath = Join-Path $markerDir 'autostart-initialized.txt'
        $text = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' 自启动项已初始化' + "`r`n"
        [System.IO.File]::WriteAllText($markerPath, $text, (New-Object System.Text.UTF8Encoding($true)))
    } catch {
        # 标记文件写不进去只是会在下次启动时再检查一遍，无副作用
    }
}

function Test-AutostartInitialized {
    try {
        $markerPath = Join-Path $script:StateDir 'autostart-initialized.txt'
        return [System.IO.File]::Exists($markerPath)
    } catch {
        return $false
    }
}

function Sync-AutostartIcon {
    if (-not (Test-Path -LiteralPath $script:AppIconIco -PathType Leaf)) { return }
    $shortcutPath = Get-StartupShortcutPath
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return }

    $shell = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $want = $script:AppIconIco + ',0'
        if ([string]$shortcut.IconLocation -ne $want) {
            $shortcut.IconLocation = $want
            $shortcut.Save()
            Write-LauncherLog '已把开机自启快捷方式的图标换成 assets\app-icon.ico'
        }
    } catch {
        Write-LauncherLog ('更新快捷方式图标失败：' + $_.Exception.Message) 'WARN'
    } finally {
        if ($null -ne $shell) {
            try { $null = [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch { }
        }
    }
}

function Install-AutostartOnFirstRun {
    $info = Get-StartupShortcutInfo -Force
    $initialized = Test-AutostartInitialized

    # 快捷方式早就存在（老用户）也把图标换成头像
    Sync-AutostartIcon

    if ($info.Exists -and $info.PointsToBootstrap) {
        if (-not $initialized) { Set-AutostartMarker }
        return $true
    }

    # 旧版自启动项指向托盘脚本：这种必须改（升级前菜单里没有这个开关，不存在“用户主动关掉”）
    if ($info.Exists -and $info.PointsToLauncher) {
        Write-LauncherLog '自启动项还指向旧的托盘脚本，改为指向 bootstrap.ps1'
        $ok = Enable-Autostart -Silent
        if ($ok) { Set-AutostartMarker }
        return $ok
    }

    # 快捷方式不存在：只有“从没初始化过”才自动补，用户主动关掉的不硬塞回去
    if (-not $initialized) {
        Write-LauncherLog '首次运行：自动创建开机自启项（指向 bootstrap.ps1）'
        $ok = Enable-Autostart -Silent
        if ($ok) { Set-AutostartMarker }
        return $ok
    }

    return $false
}

# ---------------------------------------------------------------- 托盘图标

# 把 assets\app-icon.png 缩放到 Size×Size；State 为 yellow/red 时在右下角点一个状态圆点。
# 返回 clone 过的 Icon，调用方负责 Dispose；图像没加载上时返回 $null（调用方退回字母图标）。
function New-AppStateIcon {
    param(
        [ValidateSet('green', 'yellow', 'red')][string]$State = 'green',
        [int]$Size = 32
    )

    if ($null -eq $script:AppIconImage) { return $null }

    $bitmap = $null
    $graphics = $null
    $dotBrush = $null
    $ringBrush = $null
    $hIcon = [System.IntPtr]::Zero
    $iconResult = $null

    try {
        $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.DrawImage($script:AppIconImage, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))

        if ($State -ne 'green') {
            $color = $script:ColorYellow
            if ($State -eq 'red') { $color = $script:ColorRed }

            $dot = [single][Math]::Max(6, [Math]::Round($Size * 0.34))
            $pad = [single][Math]::Max(1, [Math]::Round($Size * 0.04))
            $x = [single]($Size - $dot - $pad)
            $y = [single]($Size - $dot - $pad)

            # 白色描边，让圆点在任何底色上都看得清
            $ring = [single]($dot + 3)
            $ringBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
            $graphics.FillEllipse($ringBrush, [single]($x - 1.5), [single]($y - 1.5), $ring, $ring)

            $dotBrush = [System.Drawing.SolidBrush]::new($color)
            $graphics.FillEllipse($dotBrush, $x, $y, $dot, $dot)
        }

        $hIcon = $bitmap.GetHicon()
        $rawIcon = [System.Drawing.Icon]::FromHandle($hIcon)
        $iconResult = $rawIcon.Clone()
    } finally {
        if ($null -ne $dotBrush) { try { $dotBrush.Dispose() } catch { } }
        if ($null -ne $ringBrush) { try { $ringBrush.Dispose() } catch { } }
        if ($null -ne $graphics) { try { $graphics.Dispose() } catch { } }
        if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch { } }
        if ($hIcon -ne [System.IntPtr]::Zero) {
            if ($script:CanDestroyIcon) {
                try { $null = [QqDshLauncher.NativeMethods]::DestroyIcon($hIcon) } catch { }
            }
        }
    }

    return $iconResult
}

# 旧版“实心圆 + 字母 Q”：只在 assets 图标缺失时兜底，保证托盘不会空着。
# 画一个 32x32 的实心圆，中间是白色字母 Q。
# 返回 clone 过的 Icon，调用方负责 Dispose；原始 HICON 在这里用 DestroyIcon 释放。
function New-LetterIcon {
    param(
        [System.Drawing.Color]$Color,
        [string]$Letter = 'Q',
        [int]$Size = 32
    )

    $bitmap = $null
    $graphics = $null
    $font = $null
    $textBrush = $null
    $circleBrush = $null
    $textFormat = $null
    $hIcon = [System.IntPtr]::Zero
    $iconResult = $null

    try {
        $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.Color]::Transparent)

        # 实心圆（留一点内边距，避免贴边被裁掉）
        $padding = [int][Math]::Round($Size * 0.12)
        if ($padding -lt 2) { $padding = 2 }
        $diameter = $Size - ($padding * 2)
        if ($diameter -lt 4) { $diameter = 4 }

        $circleBrush = [System.Drawing.SolidBrush]::new($Color)
        try {
            $graphics.FillEllipse($circleBrush, $padding, $padding, $diameter, $diameter)
        } finally {
            $circleBrush.Dispose()
            $circleBrush = $null
        }

        # 白色字母
        $fontSize = [single]([Math]::Max(9, [Math]::Round($Size * 0.62)))
        try {
            $font = [System.Drawing.Font]::new('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        } catch {
            # Segoe UI 不存在时退回通用无衬线字体
            $font = [System.Drawing.Font]::new([System.Drawing.FontFamily]::GenericSansSerif, $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        }

        $textFormat = [System.Drawing.StringFormat]::new()
        $textFormat.Alignment = [System.Drawing.StringAlignment]::Center
        $textFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

        $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
        $rect = [System.Drawing.RectangleF]::new(0, 0, [single]$Size, [single]$Size)
        $graphics.DrawString($Letter, $font, $textBrush, $rect, $textFormat)

        $hIcon = $bitmap.GetHicon()
        $rawIcon = [System.Drawing.Icon]::FromHandle($hIcon)
        # Clone 复制像素，之后销毁原始 HICON 也不会影响这个图标
        $iconResult = $rawIcon.Clone()
    } finally {
        if ($null -ne $textBrush) { try { $textBrush.Dispose() } catch { } }
        if ($null -ne $textFormat) { try { $textFormat.Dispose() } catch { } }
        if ($null -ne $font) { try { $font.Dispose() } catch { } }
        if ($null -ne $graphics) { try { $graphics.Dispose() } catch { } }
        if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch { } }
        if ($hIcon -ne [System.IntPtr]::Zero) {
            if ($script:CanDestroyIcon) {
                try { $null = [QqDshLauncher.NativeMethods]::DestroyIcon($hIcon) } catch { }
            }
        }
    }

    return $iconResult
}

# ---------------------------------------------------------------- 菜单小工具

function Add-LauncherMenuItem {
    param(
        $Collection,
        [string]$Text,
        [scriptblock]$OnClick,
        [switch]$CheckOnClick
    )

    $item = [System.Windows.Forms.ToolStripMenuItem]::new($Text)
    if ($null -ne $OnClick) { $item.Add_Click($OnClick) }
    if ($CheckOnClick) { $item.CheckOnClick = $true }
    $null = $Collection.Add($item)
    return $item
}

function Add-LauncherSeparator {
    param($Collection)
    $null = $Collection.Add([System.Windows.Forms.ToolStripSeparator]::new())
}

# 所有菜单动作的统一兜底：出问题弹气泡并记日志，绝不把异常抛回消息循环
function Invoke-MenuAction {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    try {
        & $Action
    } catch {
        $message = $_.Exception.Message
        Write-LauncherLog ('菜单「' + $Name + '」执行失败：' + $message) 'ERROR'
        Show-Balloon '操作失败' ($Name + '：' + $message) ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

# ---------------------------------------------------------------- 状态探测

# 汇总 NapCat / DSH 的状态，返回 PSCustomObject：
#   NapCatRunning / NapCatPid / LoggedIn / Account / Nickname / LoginDetail
#   DshRunning / DshPid / Level / Summary / Detail / Problem
function Get-LauncherStatus {
    $napcatRunning = $false
    $napcatPid = 0
    $loggedIn = $false
    $account = ''
    $nickname = ''
    $loginDetail = ''
    $dshRunning = $false
    $dshPid = 0
    $problem = ''

    # --- NapCat 进程
    try {
        $napcatProcess = Invoke-LibFunction 'Get-NapCatProcess'
        if ($null -ne $napcatProcess) {
            $napcatRunning = [bool]$napcatProcess.Running
            if ($napcatRunning) {
                try { $napcatPid = [int]$napcatProcess.ProcessId } catch { $napcatPid = 0 }
            }
        }
    } catch {
        # 这里只记录原因，写日志交给 Update-LauncherState 在内容变化时做一次，避免每 3 秒刷屏
        $problem = 'NapCat 进程探测失败：' + $_.Exception.Message
    }

    # --- NapCat 登录态（进程没起来就不去请求 WebUI，避免每 3 秒空转一次）
    if ($napcatRunning) {
        try {
            $loginState = Invoke-LibFunction 'Get-NapCatLoginState'
            if ($null -ne $loginState) {
                $loggedIn = [bool]$loginState.LoggedIn
                $account = [string]$loginState.Account
                $nickname = [string]$loginState.Nickname
                $loginDetail = [string]$loginState.Detail
            }
        } catch {
            $problem = 'NapCat 登录态探测失败：' + $_.Exception.Message
        }
    } else {
        $loginDetail = 'NapCat 未运行'
    }

    # --- DSH 进程
    try {
        $dshProcess = Invoke-LibFunction 'Get-DshProcess'
        if ($null -ne $dshProcess) {
            $dshRunning = [bool]$dshProcess.Running
            if ($dshRunning) {
                try { $dshPid = [int]$dshProcess.ProcessId } catch { $dshPid = 0 }
            }
        }
    } catch {
        $problem = 'DSH 进程探测失败：' + $_.Exception.Message
    }

    # --- 桥接进程（把 QQ 消息送进 DSH 的那个 Node 进程）
    $bridgeRunning = $false
    $bridgePid = 0
    $bridgeSessions = 0
    $bridgeInFlight = 0
    try {
        $bridgeProcess = Invoke-LibFunction 'Get-BridgeProcess'
        if ($null -ne $bridgeProcess) {
            $bridgeRunning = [bool]$bridgeProcess.Running
            if ($bridgeRunning) {
                try { $bridgePid = [int]$bridgeProcess.ProcessId } catch { $bridgePid = 0 }
                try { $bridgeSessions = [int]$bridgeProcess.Sessions } catch { $bridgeSessions = 0 }
                try { $bridgeInFlight = [int]$bridgeProcess.InFlight } catch { $bridgeInFlight = 0 }
            }
        }
    } catch {
        $problem = '桥接进程探测失败：' + $_.Exception.Message
    }

    # --- 状态摘要（形如：NapCat 已登录(大肥鱼) · DSH 运行中 · 桥接运行中）
    $who = ''
    if (-not [string]::IsNullOrWhiteSpace($nickname)) {
        $who = $nickname.Trim()
    } elseif (-not [string]::IsNullOrWhiteSpace($account)) {
        $who = $account.Trim()
    }

    if (-not $napcatRunning) {
        $napcatText = 'NapCat 未运行'
    } elseif ($loggedIn) {
        if ([string]::IsNullOrWhiteSpace($who)) {
            $napcatText = 'NapCat 已登录'
        } else {
            $napcatText = 'NapCat 已登录(' + $who + ')'
        }
    } else {
        $napcatText = 'NapCat 未登录'
        # 异常时把原因带出来，太长就截断
        if (-not [string]::IsNullOrWhiteSpace($loginDetail)) {
            $reason = $loginDetail.Trim()
            if ($reason.Length -gt 24) { $reason = $reason.Substring(0, 24) + '…' }
            $napcatText = $napcatText + '(' + $reason + ')'
        }
    }

    if ($dshRunning) {
        $dshText = 'DSH 运行中'
    } else {
        $dshText = 'DSH 未运行'
    }

    if ($bridgeRunning) {
        if ($bridgeInFlight -gt 0) {
            $bridgeText = '桥接运行中(处理 ' + $bridgeInFlight + ')'
        } else {
            $bridgeText = '桥接运行中'
        }
    } else {
        $bridgeText = '桥接未运行'
    }

    $summary = $napcatText + ' · ' + $dshText + ' · ' + $bridgeText

    # --- 图标颜色
    #   红：NapCat 未运行，或（RequireDsh 时）DSH 未运行
    #   黄：NapCat 在运行但没登录
    #   绿：NapCat 已登录 + DSH 运行中
    $level = 'red'
    if (-not $napcatRunning) {
        $level = 'red'
    } elseif (-not $loggedIn) {
        $level = 'yellow'
    } elseif ($script:RequireDsh -and (-not $dshRunning)) {
        $level = 'red'
    } elseif (-not $bridgeRunning) {
        # NapCat 登录了、DSH 也在，但桥接没起来 —— QQ 消息送不到 DSH，降级成黄色
        $level = 'yellow'
    } else {
        $level = 'green'
    }

    # --- 悬停提示用的详细信息
    $detailParts = @()
    if ($napcatRunning) {
        $detailParts += ('NapCat PID ' + $napcatPid)
    } else {
        $detailParts += 'NapCat 未运行'
    }
    if (-not [string]::IsNullOrWhiteSpace($loginDetail)) {
        $detailParts += ('登录：' + $loginDetail.Trim())
    }
    if ($dshRunning) {
        $detailParts += ('DSH PID ' + $dshPid)
    } else {
        $detailParts += 'DSH 未运行'
    }
    if ($bridgeRunning) {
        $detailParts += ('桥接 PID ' + $bridgePid + '，会话 ' + $bridgeSessions)
    } else {
        $detailParts += '桥接未运行'
    }
    if (-not [string]::IsNullOrWhiteSpace($problem)) {
        $detailParts += $problem
    }

    return [pscustomobject]@{
        NapCatRunning = $napcatRunning
        NapCatPid     = $napcatPid
        LoggedIn      = $loggedIn
        Account       = $account
        Nickname      = $nickname
        LoginDetail   = $loginDetail
        DshRunning    = $dshRunning
        DshPid        = $dshPid
        BridgeRunning = $bridgeRunning
        BridgePid     = $bridgePid
        BridgeSessions = $bridgeSessions
        Level         = $level
        Summary       = $summary
        Detail        = ($detailParts -join ' · ')
        Problem       = $problem
    }
}

# 刷新图标颜色 + 状态摘要 + 悬停提示 + 开机自启勾选态
function Update-LauncherState {
    $status = Get-LauncherStatus
    $script:LastStatus = $status

    # 菜单首行：● <状态摘要>（加粗，点击刷新）
    if ($null -ne $script:StatusItem) {
        $titleText = '● ' + $status.Summary
        if ($script:StatusItem.Text -ne $titleText) {
            $script:StatusItem.Text = $titleText
        }
    }

    # 图标
    $icon = $script:IconRed
    if ($status.Level -eq 'green') {
        $icon = $script:IconGreen
    } elseif ($status.Level -eq 'yellow') {
        $icon = $script:IconYellow
    }
    if (($null -ne $script:TrayIcon) -and ($null -ne $icon)) {
        try {
            if ($script:TrayIcon.Icon -ne $icon) { $script:TrayIcon.Icon = $icon }
        } catch {
        }
    }

    # 悬停提示（NotifyIcon.Text 硬上限 63 个字符）
    $tip = 'QQ-DSH 启动器 · ' + $status.Summary
    if (-not [string]::IsNullOrWhiteSpace($status.Detail)) {
        $tip = $tip + ' · ' + $status.Detail
    }
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 60) + '...' }
    if ($null -ne $script:TrayIcon) {
        try {
            if ($script:TrayIcon.Text -ne $tip) { $script:TrayIcon.Text = $tip }
        } catch {
        }
    }

    # 开机自启勾选态永远反映快捷方式是否真实存在
    if ($null -ne $script:AutostartItem) {
        $shouldCheck = Test-AutostartEnabled
        if ($script:AutostartItem.Checked -ne $shouldCheck) {
            $script:AutostartItem.Checked = $shouldCheck
        }
    }

    # 只有状态真的变化时才写日志，避免每 3 秒刷一行
    if (($status.Level -ne $script:LastLevel) -or ($status.Summary -ne $script:LastSummary)) {
        Write-LauncherLog ('状态变化：' + $status.Summary + '（' + $status.Level + '）')
        $script:LastLevel = $status.Level
        $script:LastSummary = $status.Summary
    }

    # 探测异常同样只在内容变化时记一次
    if ($status.Problem -ne $script:LastProblem) {
        if ([string]::IsNullOrWhiteSpace($status.Problem)) {
            Write-LauncherLog '进程探测已恢复正常'
        } else {
            Write-LauncherLog ('进程探测异常：' + $status.Problem) 'WARN'
        }
        $script:LastProblem = $status.Problem
    }

    return $status
}

# ---------------------------------------------------------------- 菜单动作

function Invoke-AllStart {
    Write-LauncherLog '操作：一键启动全部'

    $napcatOk = $false
    $dshOk = $false
    $bridgeOk = $false

    try {
        $napcatOk = [bool](Invoke-LibFunction 'Start-NapCat')
    } catch {
        Write-LauncherLog ('启动 NapCat 失败：' + $_.Exception.Message) 'ERROR'
    }
    try {
        $dshOk = [bool](Invoke-LibFunction 'Start-Dsh')
    } catch {
        Write-LauncherLog ('启动 DSH 失败：' + $_.Exception.Message) 'ERROR'
    }
    try {
        $bridgeOk = [bool](Invoke-LibFunction 'Start-Bridge')
    } catch {
        Write-LauncherLog ('启动桥接失败：' + $_.Exception.Message) 'ERROR'
    }

    $null = Update-LauncherState
    Start-Sleep -Milliseconds 1500
    $status = Update-LauncherState

    if ($napcatOk -and $dshOk -and $bridgeOk) {
        Show-Balloon '已发起启动' ('NapCat、DSH、桥接正在启动，稍后图标会变绿。当前：' + $status.Summary) ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon '部分项目启动失败' ('NapCat：' + (Get-OkText $napcatOk) + '；DSH：' + (Get-OkText $dshOk) + '；桥接：' + (Get-OkText $bridgeOk) + '。详见 launcher.log。') ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

function Invoke-BridgeStart {
    Write-LauncherLog '操作：启动桥接'

    $ok = $false
    try {
        $ok = [bool](Invoke-LibFunction 'Start-Bridge')
    } catch {
        Write-LauncherLog ('启动桥接失败：' + $_.Exception.Message) 'ERROR'
    }

    $null = Update-LauncherState

    if ($ok) {
        Show-Balloon '桥接已启动' 'QQ 消息现在可以转给 DSH 了。' ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon '桥接启动失败' '详见 state\launcher.log 与 logs\bridge-console.err.log' ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

function Invoke-BridgeStop {
    Write-LauncherLog '操作：停止桥接'

    $ok = $false
    try {
        $ok = [bool](Invoke-LibFunction 'Stop-Bridge')
    } catch {
        Write-LauncherLog ('停止桥接失败：' + $_.Exception.Message) 'ERROR'
    }

    $null = Update-LauncherState

    if ($ok) {
        Show-Balloon '桥接已停止' 'QQ 消息暂时不会转给 DSH。' ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon '桥接未能停止' '可能有残留进程，详见 state\launcher.log' ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

function Invoke-BridgeRestart {
    Write-LauncherLog '操作：重启桥接'
    try { $null = Invoke-LibFunction 'Stop-Bridge' } catch { }
    Start-Sleep -Milliseconds 600
    Invoke-BridgeStart
}

function Show-BridgeLog {
    Write-LauncherLog '操作：查看桥接日志'

    $logPath = ''
    try { $logPath = [string](Invoke-LibFunction 'Get-BridgeLogPath') } catch { }

    if ([string]::IsNullOrWhiteSpace($logPath) -or -not [System.IO.File]::Exists($logPath)) {
        Show-Balloon '暂无桥接日志' '还没生成日志文件，先启动一次桥接。' ([System.Windows.Forms.ToolTipIcon]::Warning)
        return
    }

    $lines = @()
    try { $lines = @(Invoke-LibFunction 'Read-SharedLogFileLines' -Arguments @($logPath, 200)) } catch { $lines = @() }

    $tempFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'qq-bridge-log.txt')
    $header = @(
        ('QQ-DSH 桥接日志（最后 ' + $lines.Count + ' 行）')
        ('生成时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
        ('来源文件：' + $logPath)
        ('-' * 60)
    )
    try {
        [System.IO.File]::WriteAllText($tempFile, (($header + $lines) -join "`r`n"), [System.Text.UTF8Encoding]::new($true))
    } catch {
        Show-Balloon '打开桥接日志失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }

    try {
        Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $tempFile + '"') | Out-Null
    } catch {
        try { Invoke-LibFunction 'Open-PathSafely' -Arguments @($tempFile) } catch { }
    }
}

function Invoke-AllStop {
    Write-LauncherLog '操作：一键停止全部'  # 一键停止全部带桥接

    $napcatOk = $false
    $dshOk = $false
    $bridgeOk = $false

    # 先停桥接：它连着 OneBot，最后停它才不会先收到一堆断线错误
    try {
        $bridgeOk = [bool](Invoke-LibFunction 'Stop-Bridge')
    } catch {
        Write-LauncherLog ('停止桥接失败：' + $_.Exception.Message) 'ERROR'
    }

    try {
        $napcatOk = [bool](Invoke-LibFunction 'Stop-NapCat')
    } catch {
        Write-LauncherLog ('停止 NapCat 失败：' + $_.Exception.Message) 'ERROR'
    }
    try {
        $dshOk = [bool](Invoke-LibFunction 'Stop-Dsh')
    } catch {
        Write-LauncherLog ('停止 DSH 失败：' + $_.Exception.Message) 'ERROR'
    }

    $status = Update-LauncherState

    if ($napcatOk -and $dshOk -and $bridgeOk) {
        Show-Balloon '已全部停止' ('NapCat、DSH、桥接都已停止。当前：' + $status.Summary) ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon '部分项目未能停止' ('NapCat：' + (Get-OkText $napcatOk) + '；DSH：' + (Get-OkText $dshOk) + '；桥接：' + (Get-OkText $bridgeOk) + '。') ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

function Invoke-NapCatStart {
    Write-LauncherLog '操作：启动 NapCat'

    $ok = $false
    try {
        $ok = [bool](Invoke-LibFunction 'Start-NapCat')
    } catch {
        Write-LauncherLog ('启动 NapCat 失败：' + $_.Exception.Message) 'ERROR'
    }

    $null = Update-LauncherState

    if ($ok) {
        Show-Balloon 'NapCat' '已发起启动，登录状态会在几秒内自动刷新。' ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon 'NapCat 启动失败' '请确认 napcat\napcat.bat 存在，并查看 state\launcher.log。' ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

function Invoke-NapCatStop {
    Write-LauncherLog '操作：停止 NapCat'

    $ok = $false
    try {
        $ok = [bool](Invoke-LibFunction 'Stop-NapCat')
    } catch {
        Write-LauncherLog ('停止 NapCat 失败：' + $_.Exception.Message) 'ERROR'
    }

    $null = Update-LauncherState

    if ($ok) {
        Show-Balloon 'NapCat 已停止' 'NapCat 进程已结束。' ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon '停止 NapCat 失败' '可能有残留进程，详见 state\launcher.log。' ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

function Invoke-NapCatRestart {
    Write-LauncherLog '操作：重启 NapCat'

    try {
        $null = [bool](Invoke-LibFunction 'Stop-NapCat')
    } catch {
        Write-LauncherLog ('重启时停止 NapCat 失败：' + $_.Exception.Message) 'ERROR'
    }

    Start-Sleep -Milliseconds 800

    $ok = $false
    try {
        $ok = [bool](Invoke-LibFunction 'Start-NapCat')
    } catch {
        Write-LauncherLog ('重启时启动 NapCat 失败：' + $_.Exception.Message) 'ERROR'
    }

    $null = Update-LauncherState

    if ($ok) {
        Show-Balloon 'NapCat 正在重启' '已发起重启，登录状态会在几秒内自动刷新。' ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon 'NapCat 重启失败' '详见 state\launcher.log。' ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

# 查看日志：取最后若干行写临时文件，用记事本打开
function Show-NapCatLog {
    Write-LauncherLog '操作：查看 NapCat 日志'

    $tail = @()
    try {
        $rawTail = Invoke-LibFunction -Name 'Get-NapCatLogTail' -Arguments @(80)
        if ($null -ne $rawTail) { $tail = @($rawTail) }
    } catch {
        Write-LauncherLog ('读取 NapCat 日志失败：' + $_.Exception.Message) 'ERROR'
    }

    $sourcePath = ''
    try {
        $sourcePath = [string](Invoke-LibFunction 'Get-NapCatLogPath')
    } catch {
        $sourcePath = ''
    }

    if ($tail.Count -eq 0) {
        if (-not [string]::IsNullOrWhiteSpace($sourcePath)) {
            try { Invoke-LibFunction -Name 'Open-PathSafely' -Arguments @($sourcePath) } catch { }
            Show-Balloon 'NapCat 日志还是空的' ('已打开日志文件：' + $sourcePath) ([System.Windows.Forms.ToolTipIcon]::Warning)
        } else {
            Show-Balloon '没有找到 NapCat 日志' 'NapCat 可能还没启动过，日志目录里没有今天的日志。' ([System.Windows.Forms.ToolTipIcon]::Warning)
        }
        return
    }

    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ('qqdsh-napcat-log-' + $stamp + '.txt')

    $header = @(
        ('NapCat 日志（最近 ' + $tail.Count + ' 行）')
        ('生成时间：' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
        ('来源文件：' + $sourcePath)
        ('-' * 60)
    )

    try {
        $content = (($header + $tail) -join "`r`n")
        [System.IO.File]::WriteAllText($tempFile, $content, [System.Text.UTF8Encoding]::new($true))
    } catch {
        Write-LauncherLog ('写临时日志失败：' + $_.Exception.Message) 'ERROR'
        Show-Balloon '打开日志失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }

    try {
        Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $tempFile + '"') | Out-Null
    } catch {
        # 记事本拉不起来就交给资源管理器
        try { Invoke-LibFunction -Name 'Open-PathSafely' -Arguments @($tempFile) } catch { }
    }
}

function Open-NapCatWebUi {
    Write-LauncherLog '操作：打开 NapCat WebUI'
    $ok = Open-Url $script:NapCatWebUiUrl
    if (-not $ok) {
        Show-Balloon '无法打开 NapCat WebUI' ('请确认 NapCat 正在运行，然后手动访问 ' + $script:NapCatWebUiUrl) ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

function Open-NapCatScanPage {
    Write-LauncherLog '操作：打开 NapCat 扫码登录页'
    $ok = Open-Url $script:NapCatScanUrl
    if ($ok) {
        Show-Balloon '扫码登录' '已打开 NapCat 登录页，请用手机 QQ 扫码。若页面要求输入 token，见 napcat\napcat\config\webui.json。' ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon '无法打开登录页' ('请确认 NapCat 正在运行，然后手动访问 ' + $script:NapCatScanUrl) ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

function Open-DshUi {
    Write-LauncherLog '操作：打开 DSH 界面'
    $ok = Open-Url $script:DshUiUrl
    if (-not $ok) {
        Show-Balloon '无法打开 DSH 界面' ('请确认 DSH 正在运行，然后手动访问 ' + $script:DshUiUrl) ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

function Open-DshPlugins {
    Write-LauncherLog '操作：打开 DSH 插件设置'
    $ok = Open-Url $script:DshPluginsUrl
    if (-not $ok) {
        Show-Balloon '无法打开 DSH 插件设置' ('请确认 DSH 正在运行，然后手动访问 ' + $script:DshPluginsUrl) ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

# ---------------------------------------------------------------- 控制台（WebUI）

# 读 state\webui-port.txt 拿端口；文件不存在或内容非法一律退回 5830。
function Get-ConsolePort {
    $fallback = $script:ConsoleDefaultPort

    try {
        if ([string]::IsNullOrWhiteSpace($script:ConsolePortFile)) { return $fallback }
        if (-not [System.IO.File]::Exists($script:ConsolePortFile)) { return $fallback }

        $text = [System.IO.File]::ReadAllText($script:ConsolePortFile, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($text)) { return $fallback }

        $text = $text.Trim()
        # 只认纯数字：半截写入、带 BOM 残留或夹杂别的字符都按非法处理
        if ($text -notmatch '^\d{1,5}$') { return $fallback }

        $port = 0
        if (-not [int]::TryParse($text, [ref]$port)) { return $fallback }
        if ($port -lt 1 -or $port -gt 65535) { return $fallback }
        return $port
    } catch {
        return $fallback
    }
}

# 探测 127.0.0.1:<Port> 是否有人在监听（带超时，不会卡住界面线程）。
function Test-ConsoleListening {
    param([int]$Port)

    if ($Port -le 0 -or $Port -gt 65535) { return $false }

    # 优先复用 lib 里的实现；lib 不可用时用本地兜底
    if (Test-LibFunction 'Test-TcpEndPoint') {
        try {
            return [bool](Invoke-LibFunction 'Test-TcpEndPoint' -Arguments @('127.0.0.1', $Port, 1200))
        } catch {
        }
    }

    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(1200, $false)) { return $false }
        try {
            $client.EndConnect($async)
        } catch {
            return $false
        }
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $client) {
            try { $client.Close() } catch { }
        }
    }
}

# 打开控制台：优先 Edge 无边框窗口（--app），没有 Edge 就用默认浏览器。
function Open-WebUiConsole {
    Write-LauncherLog '操作：打开控制台'

    $port = Get-ConsolePort
    $url = 'http://127.0.0.1:' + $port + '/'

    # 没起来就给一句人话，别让用户对着空窗口发呆
    if (-not (Test-ConsoleListening $port)) {
        Write-LauncherLog ('控制台未监听端口 ' + $port + '，已提示用户') 'WARN'
        Show-Balloon '控制台还没启动' ('端口 ' + $port + ' 上没有服务在跑。请先在菜单里点「一键启动全部」，控制台会随启动流程一起起来。') ([System.Windows.Forms.ToolTipIcon]::Warning)
        return
    }

    $edgePath = ''
    if ([System.IO.File]::Exists($script:EdgeX86Path)) {
        $edgePath = $script:EdgeX86Path
    } elseif ([System.IO.File]::Exists($script:EdgeX64Path)) {
        $edgePath = $script:EdgeX64Path
    }

    if (-not [string]::IsNullOrWhiteSpace($edgePath)) {
        try {
            Start-Process -FilePath $edgePath `
                -ArgumentList @(('--app=' + $url), '--window-size=1180,820') `
                -ErrorAction Stop | Out-Null
            return
        } catch {
            Write-LauncherLog ('Edge 打开控制台失败，改用默认浏览器：' + $_.Exception.Message) 'WARN'
        }
    } else {
        Write-LauncherLog '没找到 Edge，改用默认浏览器打开控制台' 'WARN'
    }

    if (-not (Open-Url $url)) {
        Show-Balloon '打不开控制台' ('请手动访问 ' + $url) ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

# ---------------------------------------------------------------- 记忆库（Obsidian）

function Get-MemoryRoot {
    return $script:MemoryRoot
}

# 目录不在就建一个（记忆模块 ensure 时也会建，这里只是为了菜单能立刻用）
function Confirm-MemoryRoot {
    $root = Get-MemoryRoot
    if ([System.IO.Directory]::Exists($root)) { return $true }

    try {
        $null = [System.IO.Directory]::CreateDirectory($root)
        Write-LauncherLog ('已创建记忆库目录：' + $root)
        return $true
    } catch {
        Write-LauncherLog ('创建记忆库目录失败：' + $_.Exception.Message) 'WARN'
        return $false
    }
}

function Open-MemoryFolder {
    Write-LauncherLog '操作：打开记忆库文件夹'

    $root = Get-MemoryRoot
    if (-not (Confirm-MemoryRoot)) {
        Show-Balloon '找不到记忆库' ('目录不存在，创建也失败了：' + $root) ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }

    try {
        Invoke-LibFunction 'Open-PathSafely' -Arguments @($root)
    } catch {
        Write-LauncherLog ('打开记忆库文件夹失败：' + $_.Exception.Message) 'ERROR'
        Show-Balloon '打不开记忆库文件夹' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

# 用 obsidian://open?path=<URL 编码的绝对路径> 拉起 Obsidian；失败退回文件夹。
function Open-MemoryInObsidian {
    Write-LauncherLog '操作：在 Obsidian 中打开记忆库'

    $root = Get-MemoryRoot
    if (-not (Confirm-MemoryRoot)) {
        Show-Balloon '找不到记忆库' ('目录不存在，创建也失败了：' + $root) ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }

    $encoded = ''
    try {
        $encoded = [System.Uri]::EscapeDataString($root)
    } catch {
        $encoded = ''
    }

    if (-not [string]::IsNullOrWhiteSpace($encoded)) {
        $uri = 'obsidian://open?path=' + $encoded
        try {
            Start-Process -FilePath $uri -ErrorAction Stop | Out-Null
            return
        } catch {
            Write-LauncherLog ('obsidian:// 调用失败，改为打开文件夹：' + $_.Exception.Message) 'WARN'
        }
    }

    Show-Balloon '没能唤起 Obsidian' '可能是没装 Obsidian 或协议未注册，已改为打开记忆库文件夹。' ([System.Windows.Forms.ToolTipIcon]::Warning)
    Open-MemoryFolder
}

function Invoke-DshRestart {
    Write-LauncherLog '操作：重启 DSH'

    try {
        $null = [bool](Invoke-LibFunction 'Stop-Dsh')
    } catch {
        Write-LauncherLog ('重启时停止 DSH 失败：' + $_.Exception.Message) 'ERROR'
    }

    Start-Sleep -Milliseconds 800

    $ok = $false
    try {
        $ok = [bool](Invoke-LibFunction 'Start-Dsh')
    } catch {
        Write-LauncherLog ('重启时启动 DSH 失败：' + $_.Exception.Message) 'ERROR'
    }

    $null = Update-LauncherState

    if ($ok) {
        Show-Balloon 'DSH 正在重启' '已发起重启，界面稍后会重新出现。' ([System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        Show-Balloon 'DSH 重启失败' '详见 state\launcher.log。' ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

function Show-PersonaEditor {
    Write-LauncherLog '操作：打开人格设置窗口'

    $saved = $false
    try {
        $saved = [bool](Invoke-LibFunction 'Show-PersonaWindow')
    } catch {
        Write-LauncherLog ('打开人格设置窗口失败：' + $_.Exception.Message) 'ERROR'
        Show-Balloon '打开人格设置失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }

    if ($saved) {
        Write-LauncherLog '人格设置已保存'
        Show-Balloon '人格设置已保存' 'AGENTS.md 已更新，旧版本已备份为 .bak 文件。' ([System.Windows.Forms.ToolTipIcon]::Info)
    }
}

function Show-SessionManager {
    Write-LauncherLog '操作：打开会话管理窗口'

    try {
        $null = Invoke-LibFunction 'Show-SessionWindow'
        Write-LauncherLog '会话管理窗口已关闭'
    } catch {
        Write-LauncherLog ('打开会话管理窗口失败：' + $_.Exception.Message) 'ERROR'
        Show-Balloon '打开会话管理失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

# ---------------------------------------------------------------- 退出

# 退出流程：确认 → Stop-NapCat → Stop-Dsh → 销毁托盘图标 → 退出
function Invoke-LauncherExit {
    if ($script:Exiting) { return }

    $answer = [System.Windows.Forms.MessageBox]::Show(
        ('确定要退出「QQ-DSH 启动器」吗？' + "`r`n`r`n" + '退出前会停止桥接和 NapCat，QQ 机器人下线；DSH 继续运行。'),
        '退出 QQ-DSH 启动器',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2)

    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
        Write-LauncherLog '用户取消了退出'
        return
    }

    $script:Exiting = $true
    Write-LauncherLog '用户确认退出，开始停止桥接与 NapCat'

    # 停掉定时器，避免退出过程中还在刷新
    if ($null -ne $script:Timer) {
        try { $script:Timer.Stop() } catch { }
    }

    # 0) 先停桥接（它是 OneBot 的客户端，先断开更干净）
    try {
        $bridgeOk = [bool](Invoke-LibFunction 'Stop-Bridge')
        Write-LauncherLog ('退出：停止桥接 ' + (Get-OkText $bridgeOk))
    } catch {
        Write-LauncherLog ('退出：停止桥接失败：' + $_.Exception.Message) 'ERROR'
    }

    # 1) 先停 NapCat
    try {
        $napcatOk = [bool](Invoke-LibFunction 'Stop-NapCat')
        Write-LauncherLog ('退出：停止 NapCat ' + (Get-OkText $napcatOk))
    } catch {
        Write-LauncherLog ('退出：停止 NapCat 失败：' + $_.Exception.Message) 'ERROR'
    }


    # 3) 销毁托盘图标
    if ($null -ne $script:TrayIcon) {
        try { $script:TrayIcon.Visible = $false } catch { }
        try { $script:TrayIcon.Dispose() } catch { }
        $script:TrayIcon = $null
    }

    Write-LauncherLog '启动器退出'

    # 4) 结束消息循环（Application.Run 返回后 finally 里再兜底清理一次）
    try { [System.Windows.Forms.Application]::Exit() } catch { }
}

# 幂等清理：无论正常退出还是异常退出都走这里
function Invoke-LauncherCleanup {
    $script:Exiting = $true

    if ($null -ne $script:Timer) {
        try { $script:Timer.Stop() } catch { }
        try { $script:Timer.Dispose() } catch { }
        $script:Timer = $null
    }

    if ($null -ne $script:TrayIcon) {
        try { $script:TrayIcon.Visible = $false } catch { }
        try { $script:TrayIcon.Dispose() } catch { }
        $script:TrayIcon = $null
    }

    if ($null -ne $script:Menu) {
        try { $script:Menu.Dispose() } catch { }
        $script:Menu = $null
    }

    foreach ($icon in @($script:IconGreen, $script:IconYellow, $script:IconRed)) {
        if ($null -ne $icon) { try { $icon.Dispose() } catch { } }
    }
    $script:IconGreen = $null
    $script:IconYellow = $null
    $script:IconRed = $null
    if ($null -ne $script:AppIconImage) { try { $script:AppIconImage.Dispose() } catch { } }
    $script:AppIconImage = $null

    if ($null -ne $script:Mutex) {
        if ($script:OwnsMutex) { try { $script:Mutex.ReleaseMutex() } catch { } }
        try { $script:Mutex.Dispose() } catch { }
        $script:Mutex = $null
    }
}

# ---------------------------------------------------------------- 主流程

try {
    Write-LauncherLog ('启动器启动（PID ' + $PID + '，RequireDsh=' + $script:RequireDsh + '）')

    # --- 图标：assets 里的头像（找不到时退回旧版字母圆）
    try {
        if (Test-Path -LiteralPath $script:AppIconPng -PathType Leaf) {
            $script:AppIconImage = [System.Drawing.Image]::FromFile($script:AppIconPng)
        } else {
            Write-LauncherLog ('图标文件不存在，退回字母图标：' + $script:AppIconPng) 'WARN'
        }
    } catch {
        $script:AppIconImage = $null
        Write-LauncherLog ('加载图标失败，退回字母图标：' + $_.Exception.Message) 'WARN'
    }
    $script:IconGreen = New-AppStateIcon -State 'green'
    $script:IconYellow = New-AppStateIcon -State 'yellow'
    $script:IconRed = New-AppStateIcon -State 'red'
    if ($null -eq $script:IconGreen) {
        $script:IconGreen = New-LetterIcon -Color $script:ColorGreen -Letter 'Q' -Size 32
        $script:IconYellow = New-LetterIcon -Color $script:ColorYellow -Letter 'Q' -Size 32
        $script:IconRed = New-LetterIcon -Color $script:ColorRed -Letter 'Q' -Size 32
    }

    # 开机自启默认开启：第一次运行（或旧版指向托盘脚本）时静默补上，不用用户手点
    try {
        $null = Install-AutostartOnFirstRun
    } catch {
        Write-LauncherLog ('初始化开机自启失败：' + $_.Exception.Message) 'WARN'
    }

    # --- 右键菜单：只留「退出」
    # 用户要求（2026-10-20）：菜单太杂，其余操作全部搬进控制台。
    # 托盘本身只负责「在后台运行」和「退出」；左键单击仍然直达控制台。
    # 退出会停掉桥接和 NapCat（纯 Shell 模式下 NapCat 就是本机的 QQ，没有单独的 QQ.exe）。
    $script:Menu = [System.Windows.Forms.ContextMenuStrip]::new()
    $script:Menu.ShowImageMargin = $false
    $null = Add-LauncherMenuItem -Collection $script:Menu.Items -Text '退出（停止桥接与 NapCat）' -OnClick { Invoke-MenuAction '退出' { Invoke-LauncherExit } }
    # --- 托盘图标
    $script:TrayIcon = [System.Windows.Forms.NotifyIcon]::new()
    $script:TrayIcon.Icon = $script:IconRed
    $script:TrayIcon.Text = 'QQ-DSH 启动器 · 正在初始化'
    $script:TrayIcon.ContextMenuStrip = $script:Menu
    $script:TrayIcon.Visible = $true

    # 左键单击托盘图标 = 直接打开控制台（用户要求：不经过菜单选择支）。
    # 双击会先触发两次单击事件，所以只绑单击、不再绑双击，避免弹出两个窗口。
    $script:TrayIcon.Add_MouseClick({
            param($sender, $eventArgs)
            try {
                if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
            } catch {
                return
            }
            Invoke-MenuAction '左键单击托盘' { Open-WebUiConsole }
        })

    # 先刷一次，让图标立刻反映真实状态
    $null = Update-LauncherState

    # 每 3 秒刷新图标颜色与状态摘要
    $script:Timer = [System.Windows.Forms.Timer]::new()
    $script:Timer.Interval = 3000
    $script:Timer.Add_Tick({
        try {
            $null = Update-LauncherState
        } catch {
            # 单次刷新失败不能让托盘崩掉
        }
    })
    $script:Timer.Start()

    Write-LauncherLog '托盘已就绪'

    [System.Windows.Forms.Application]::Run()
} catch {
    # 顶层兜底：用托盘气泡提示而不是崩溃
    $fatalMessage = '未知错误'
    try { $fatalMessage = $_.Exception.Message } catch { }
    try { Write-LauncherLog ('顶层异常：' + $fatalMessage) 'ERROR' } catch { }

    if ($null -ne $script:TrayIcon) {
        Show-Balloon 'QQ-DSH 启动器出现异常' ($fatalMessage + '（详见 state\launcher.log）') ([System.Windows.Forms.ToolTipIcon]::Error)
        Start-Sleep -Milliseconds 2500
    } else {
        try {
            $null = [System.Windows.Forms.MessageBox]::Show(
                ('启动器出现异常：' + "`r`n`r`n" + $fatalMessage),
                'QQ-DSH 启动器',
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error)
        } catch {
        }
    }
} finally {
    Invoke-LauncherCleanup
}
