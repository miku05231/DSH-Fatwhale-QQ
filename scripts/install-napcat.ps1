<#
.SYNOPSIS
    从 GitHub 下载并安装 NapCatQQ（Windows）。

.DESCRIPTION
    从 https://github.com/NapNeko/NapCatQQ/releases 取最新（或指定版本）发行包的 zip，
    下载到临时目录后解压到项目根的 napcat\ 目录，然后用中文打印扫码登录与 OneBot 配置步骤。

    用法：
        powershell -ExecutionPolicy Bypass -File .\scripts\install-napcat.ps1
        powershell -ExecutionPolicy Bypass -File .\scripts\install-napcat.ps1 -Force          # 覆盖已装目录
        powershell -ExecutionPolicy Bypass -File .\scripts\install-napcat.ps1 -Version v4.2.8  # 指定版本

    重要：本文件必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 读取中文会乱码。
#>

[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# 项目根 = 本脚本所在目录（scripts）的上一级
$script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:NapCatDir = Join-Path $script:ProjectRoot 'napcat'
$script:RepoUrl = 'https://github.com/NapNeko/NapCatQQ'
$script:ReleasesUrl = 'https://github.com/NapNeko/NapCatQQ/releases'
$script:ApiBase = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases'

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('-' * 60) -ForegroundColor DarkCyan
}

function Write-Item {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host ('  · ' + $Text) -ForegroundColor $Color
}

function Write-Done {
    param([string]$Text)
    Write-Host ('  [完成] ' + $Text) -ForegroundColor Green
}

function Write-Tip {
    param([string]$Text)
    Write-Host ('  [提示] ' + $Text) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host ('  [错误] ' + $Text) -ForegroundColor Red
}

function Format-DateText {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return '未知' }

    $parsed = [datetime]::MinValue
    if ([datetime]::TryParse($Text, [ref]$parsed)) {
        if ($parsed.Kind -eq [System.DateTimeKind]::Utc) { $parsed = $parsed.ToLocalTime() }
        return $parsed.ToString('yyyy-MM-dd HH:mm')
    }
    return $Text
}

function Show-ManualFallback {
    param([string]$TargetDir)

    Write-Host ''
    Write-Host '手动安装方法：' -ForegroundColor Yellow
    Write-Host ('  1. 浏览器打开：' + $script:ReleasesUrl) -ForegroundColor Gray
    Write-Host '  2. 下载 NapCat.Shell.Windows.Node.zip（自带 Node，解压即可用）' -ForegroundColor Gray
    Write-Host '     或 NapCat.Shell.Windows.OneKey.zip（1 MB 引导器，运行后自动下载 QQ 和主体）' -ForegroundColor Gray
    Write-Host '     或 NapCat.Shell.zip（需要本机已安装 QQ 和 Node）' -ForegroundColor Gray
    Write-Host ('  3. 解压到：' + $TargetDir) -ForegroundColor Gray
    Write-Host '  4. 重新运行本脚本即可跳过下载（检测到目录已存在会提示）。' -ForegroundColor Gray
    Write-Host ''
}

function Show-LoginGuide {
    param([string]$LauncherPath)

    Write-Head '接下来扫码登录'
    Write-Host ''
    Write-Host '  1) 启动 NapCat' -ForegroundColor White
    if (-not [string]::IsNullOrWhiteSpace($LauncherPath)) {
        Write-Host ('       双击：' + $LauncherPath) -ForegroundColor DarkGray
    } else {
        Write-Host '       双击 napcat 目录里的 NapCatWinBootMain.exe（或 start.bat）' -ForegroundColor DarkGray
    }
    Write-Host '       也可以右键托盘图标 →「打开 NapCat 目录」，进去后双击启动。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  2) 用手机 QQ 扫码登录' -ForegroundColor White
    Write-Host '       首次启动会弹出二维码窗口，用【要和 DSH 对接的那个 QQ 号】扫码。' -ForegroundColor DarkGray
    Write-Host '       扫码后手机上点确认，NapCat 控制台出现“登录成功”字样即可。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  3) 在 NapCat 里开启 OneBot v11 的 WebSocket 服务端' -ForegroundColor White
    Write-Host '       登录后打开 WebUI（默认 http://127.0.0.1:6099，端口以控制台输出为准），' -ForegroundColor DarkGray
    Write-Host '       进入【网络配置】→ 新建 → WebSocket 服务端，填：' -ForegroundColor DarkGray
    Write-Host '           地址：127.0.0.1      端口：3001' -ForegroundColor DarkGray
    Write-Host '           如勾选 Token，要把同一串 token 填进 config.json 的 onebot.accessToken' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '       地址和端口必须与 config.json 里的 onebot.url 完全一致（默认 ws://127.0.0.1:3001）。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  4) 回到本项目启动桥接' -ForegroundColor White
    Write-Host '       node src\index.js' -ForegroundColor DarkGray
    Write-Host '       或右键托盘图标 →「启动桥接」，图标变绿说明已经连上 NapCat。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  5) 用白名单里的手机号私聊机器人发一句话测试。' -ForegroundColor White
    Write-Host '       白名单为空时桥接会拒绝所有消息，记得先「编辑白名单」。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host ('  手动下载地址（备用）：' + $script:ReleasesUrl) -ForegroundColor DarkGray
    Write-Host ''
}

# ---------------------------------------------------------------- 环境准备

# GitHub 走 TLS 1.2（Windows PowerShell 5.1 默认可能还是 TLS 1.0）
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
} catch {
    Write-Tip '无法设置 TLS 1.2，下载可能失败。'
}

$headers = @{
    'User-Agent' = 'qq-bridge-installer/1.0 (+https://github.com/NapNeko/NapCatQQ)'
    'Accept'     = 'application/vnd.github+json'
}

Write-Head 'NapCatQQ 安装程序'
Write-Item ('项目根目录：' + $script:ProjectRoot)
Write-Item ('安装目标：  ' + $script:NapCatDir)

# ---------------------------------------------------------------- 已安装检查

if (Test-Path -LiteralPath $script:NapCatDir -PathType Container) {
    $existing = @(Get-ChildItem -LiteralPath $script:NapCatDir -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0 -and (-not $Force)) {
        Write-Host ''
        Write-Tip 'napcat 目录已存在且不是空的，为避免覆盖你的登录配置，本次不下载。'
        Write-Item ('目录：' + $script:NapCatDir)
        Write-Item ('里面有 ' + $existing.Count + ' 个顶层项目。')
        Write-Host ''
        Write-Host '  想强制重新安装请加 -Force 参数：' -ForegroundColor White
        Write-Host '    powershell -ExecutionPolicy Bypass -File scripts\install-napcat.ps1 -Force' -ForegroundColor DarkGray

        # 已经装过了，直接给扫码登录指引，别让用户再翻文档
        $existingLauncher = ''
        foreach ($launcherName in @('NapCatWinBootMain.exe', 'NapCat.Shell.exe', 'start.bat')) {
            try {
                $hit = Get-ChildItem -LiteralPath $script:NapCatDir -Filter $launcherName -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($null -ne $hit) { $existingLauncher = [string]$hit.FullName; break }
            } catch { }
        }
        Show-LoginGuide -LauncherPath $existingLauncher
        return
    }
}

# ---------------------------------------------------------------- 查询发行版信息

Write-Head '第 1 步 / 3：查询最新版本'

$apiUrl = $script:ApiBase + '/latest'
if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -ne 'latest') {
    $apiUrl = $script:ApiBase + '/tags/' + $Version.Trim()
}
Write-Item ('接口：' + $apiUrl) 'DarkGray'

$release = $null
try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers -TimeoutSec 60
} catch {
    $reason = ''
    try {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq 403) {
            $reason = 'GitHub API 限流（未登录时每小时只有 60 次），请过一会儿再试。'
        } elseif ($statusCode -eq 404) {
            $reason = '找不到该版本，请确认 -Version 参数（例如 v4.2.8）。'
        } else {
            $reason = 'HTTP ' + $statusCode
        }
    } catch {
        $reason = $_.Exception.Message
    }

    Write-Fail ('无法获取 NapCatQQ 发行版信息：' + $reason)
    Write-Tip '请检查网络（能打开 github.com 吗），或使用下面的手动方式。'
    Show-ManualFallback -TargetDir $script:NapCatDir
    return
}

$releaseName = [string]$release.tag_name
if ([string]::IsNullOrWhiteSpace($releaseName)) { $releaseName = [string]$release.name }
Write-Done ('目标版本：' + $releaseName)
if (-not [string]::IsNullOrWhiteSpace([string]$release.published_at)) {
    Write-Item ('发布时间：' + (Format-DateText ([string]$release.published_at)))
}

# 在 assets 里挑一个 zip。
# 实测 v4.18.x 的四个文件：
#   NapCat.Shell.Windows.Node.zip   118 MB  Shell + 自带 Node，解压即可跑（首选）
#   NapCat.Shell.zip                 34 MB  Shell，依赖系统已装 Node
#   NapCat.Shell.Windows.OneKey.zip 0.9 MB  只是个引导器，运行后才去下 QQ + 主体
#   NapCat.Framework.zip             35 MB  只有框架，要自己写加载器
# 所以优先 Node 版；OneKey 排在后面，避免解压出来只有一个 1 MB 的下载器。
$asset = $null
$assetPatterns = @(
    '(?i)^NapCat\.Shell\.Windows\.Node\.zip$',
    '(?i)Shell\.Windows\.Node.*\.zip$',
    '(?i)^NapCat\.Shell\.zip$',
    '(?i)Shell.*\.zip$',
    '(?i)\.zip$'
)
$allAssets = @($release.assets)
foreach ($pattern in $assetPatterns) {
    $matched = @($allAssets | Where-Object { $null -ne $_ -and -not [string]::IsNullOrWhiteSpace([string]$_.name) -and ([string]$_.name -match $pattern) })
    if ($matched.Count -gt 0) {
        # 同名多项时优先 Windows 版本
        $winMatched = @($matched | Where-Object { [string]$_.name -match '(?i)windows' })
        if ($winMatched.Count -gt 0) { $asset = $winMatched[0] } else { $asset = $matched[0] }
        break
    }
}

if ($null -eq $asset) {
    Write-Fail ('版本 ' + $releaseName + ' 里没有可用的 zip 发行包。')
    Write-Tip ('可安装的文件列表：' + (($allAssets | ForEach-Object { [string]$_.name }) -join ', '))
    Show-ManualFallback -TargetDir $script:NapCatDir
    return
}

$assetName = [System.IO.Path]::GetFileName([string]$asset.name)
$assetSizeMb = 0
try { $assetSizeMb = [math]::Round(([double]$asset.size) / 1MB, 1) } catch { $assetSizeMb = 0 }
Write-Done ('已选中：' + $assetName + ('（约 ' + $assetSizeMb + ' MB）'))
Write-Item ('下载地址：' + [string]$asset.browser_download_url) 'DarkGray'
if ($assetName -match '(?i)onekey') {
    Write-Tip '选中的是 OneKey 引导包，它本身很小，首次运行时才会去下载 QQ 和 NapCat 主体。'
    Write-Tip '如果希望离线解压即用，请手动下载 NapCat.Shell.Windows.Node.zip。'
}

# ---------------------------------------------------------------- 下载

Write-Head '第 2 步 / 3：下载安装包'

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('qqbridge-napcat-' + [System.Guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempDir $assetName

$progressWasSet = $false
$oldProgress = 'SilentlyContinue'
try {
    $null = New-Item -ItemType Directory -Path $tempDir -Force
    $progressWasSet = $true
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'

    Write-Item ('临时文件：' + $zipPath) 'DarkGray'
    $downloadTimer = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri ([string]$asset.browser_download_url) -OutFile $zipPath -UseBasicParsing -Headers $headers -TimeoutSec 900
    $downloadTimer.Stop()

    if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
        throw '下载完成后没有找到文件。'
    }
    $downloadedBytes = (Get-Item -LiteralPath $zipPath).Length
    if ($downloadedBytes -lt 1024) {
        throw ('下载到的文件只有 ' + $downloadedBytes + ' 字节，可能不是有效的 zip。')
    }

    Write-Done ('下载完成：' + [math]::Round($downloadedBytes / 1MB, 1) + ' MB，用时 ' + [math]::Round($downloadTimer.Elapsed.TotalSeconds, 1) + ' 秒')
} catch {
    Write-Fail ('下载失败：' + $_.Exception.Message)
    Write-Tip '常见原因：网络连不上 github.com / 需要代理 / 下载被中断。'
    Show-ManualFallback -TargetDir $script:NapCatDir
    if (Test-Path -LiteralPath $tempDir) { try { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue } catch { } }
    return
} finally {
    if ($progressWasSet) { $ProgressPreference = $oldProgress }
}

# ---------------------------------------------------------------- 解压

Write-Head '第 3 步 / 3：解压到 napcat\'

try {
    if (-not (Test-Path -LiteralPath $script:NapCatDir -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $script:NapCatDir -Force
    }
    if ($Force) {
        Write-Tip '因为指定了 -Force，先清空 napcat 目录里的旧文件。'
        $oldItems = @(Get-ChildItem -LiteralPath $script:NapCatDir -Force -ErrorAction SilentlyContinue)
        foreach ($oldItem in $oldItems) {
            try { Remove-Item -LiteralPath $oldItem.FullName -Recurse -Force -ErrorAction Stop } catch {
                Write-Tip ('有旧文件删不掉（可能正被占用）：' + $oldItem.Name)
            }
        }
    }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $script:NapCatDir -Force
    Write-Done ('已解压到 ' + $script:NapCatDir)
} catch {
    Write-Fail ('解压失败：' + $_.Exception.Message)
    Write-Tip ('可以手动把 ' + $zipPath + ' 解压到 ' + $script:NapCatDir)
    return
} finally {
    try {
        if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
    } catch { }
}

# ---------------------------------------------------------------- 结果定位

$launcherNames = @('NapCatWinBootMain.exe', 'NapCat.Shell.exe', 'start.bat', 'napcat.mjs', 'app.js')
$foundLauncher = $null
foreach ($launcherName in $launcherNames) {
    if ($null -ne $foundLauncher) { break }
    try {
        $hit = Get-ChildItem -LiteralPath $script:NapCatDir -Filter $launcherName -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $hit) { $foundLauncher = $hit }
    } catch { }
}

Write-Host ''
if ($null -ne $foundLauncher) {
    Write-Done ('启动文件：' + $foundLauncher.FullName)
    $installRoot = $foundLauncher.DirectoryName
    if ($installRoot -ne $script:NapCatDir) {
        Write-Tip ('注意：实际安装目录在下一层 —— ' + $installRoot)
        Write-Tip '托盘里的“打开 NapCat 目录”打开的是 napcat\，请在这里再进一层。'
    }
} else {
    Write-Tip '没在解压结果里找到已知的启动文件，请手动查看目录内容。'
}

# ---------------------------------------------------------------- 扫码登录指引

$launcherPath = ''
if ($null -ne $foundLauncher) { $launcherPath = [string]$foundLauncher.FullName }
Show-LoginGuide -LauncherPath $launcherPath
