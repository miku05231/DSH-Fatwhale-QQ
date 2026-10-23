# =====================================================================
# ProcessControl.ps1
# QQ-DSH 启动器 —— 进程控制模块
#
# 职责：进程探测 / 启动 / 停止；NapCat 登录态判定；NapCat 日志读取；
#       安全的路径打开。
#
# 约定（务必保持）：
#   * 本文件只定义函数，没有任何顶层执行逻辑，可安全 dot-source。
#   * 目标运行时是 Windows PowerShell 5.1，只使用 .NET Framework 自带类型，
#     不使用 PowerShell 7 专有语法（?? / ?. / 三元运算符 / -AsByteStream /
#     -Encoding utf8NoBOM 等）。
#   * 每个函数都自行容错：进程不存在、文件缺失、HTTP 超时一律返回失败态
#     或空值，绝不向外抛未捕获异常。
#   * 本文件必须保存为 UTF-8 with BOM，否则 PS 5.1 读取中文字符串会乱码。
# =====================================================================


# =====================================================================
# 一、内部辅助函数（不属于对外契约，仅供本文件内的公开函数复用）
# =====================================================================

function Get-ProcessControlConfig {
    <#
    .SYNOPSIS
        返回本模块用到的全部路径与常量。
    .DESCRIPTION
        每次调用都返回一个新的哈希表副本，避免外部调用方改坏内部常量。
    #>
    # 全部路径都按「本文件往上两层」动态算，装到任何目录都能跑（封装成可分发应用的前提）。
    $root = $PSScriptRoot
    try {
        $root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    } catch {
        $root = $PSScriptRoot
    }

    # DSH 桌面端：优先 LOCALAPPDATA，其次 Program Files（不写死用户名）。
    $dshExe = ''
    $candidates = @()
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe') }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { $dshExe = $candidate; break }
    }
    if (-not $dshExe -and $candidates.Count -gt 0) { $dshExe = $candidates[0] }

    # 同时兼容 Shell 包的嵌套目录和普通安装目录。
    $webUiToken = ''
    $webUiBase = 'http://127.0.0.1:6099'
    try {
        foreach ($relative in @('napcat\napcat\config\webui.json', 'napcat\config\webui.json')) {
            $webUiFile = Join-Path $root $relative
            if (-not (Test-Path -LiteralPath $webUiFile)) { continue }
            $webUiJson = Get-Content -LiteralPath $webUiFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($webUiJson -and $webUiJson.token) { $webUiToken = [string]$webUiJson.token }
            if ($webUiJson.port) { $webUiBase = 'http://127.0.0.1:' + [string]$webUiJson.port }
            break
        }
    } catch {
        $webUiToken = ''
    }

    return @{
        Root          = $root
        NapCatDir     = Join-Path $root 'napcat'
        NapCatBat     = Join-Path $root 'napcat\napcat.bat'
        NapCatNode    = Join-Path $root 'napcat\node.exe'
        NapCatProcess = 'node.exe'
        # 'apcat.mjs' 也能匹配到 'napcat.mjs'，两种命名都能识别。
        NapCatMarker  = 'apcat.mjs'
        WebUiBase     = $webUiBase
        WebUiToken    = $webUiToken
        OneBotPort    = 3001
        HttpTimeoutMs = 3000
        DshExe        = $dshExe
        DshProcess    = 'DeepSeek Harness.exe'
        # 桥接进程：把 QQ 消息转换成 dsh headless 调用，再把回答发回 QQ。
        # marker 用「安装目录名 + src\index.js」拼出来，改名/换目录都能认。
        BridgeScript  = (Join-Path $root 'src\index.js')
        BridgeMarker  = ((Split-Path -Leaf $root) + '\src\index.js')
        BridgeConsole = 'bridge-console.log'
        # 桥接写出的运行时状态（连接状态 / 会话数 / 队列深度）
        StatusFile    = (Join-Path $root 'state\status.json')
        # 日志目录探测顺序：NapCat 自身日志优先，最后退到桥接层捕获的日志。
        LogDirs       = @(
            (Join-Path $root 'napcat\logs')
            (Join-Path $root 'napcat\napcat\logs')
            (Join-Path $root 'logs')
        )
    }
}

function Get-ProcessImagePath {
    <#
    .SYNOPSIS
        取 Win32_Process 的可执行文件完整路径。
    .DESCRIPTION
        ExecutablePath 在权限不足时会为空，此时退化为从命令行首段解析，
        解析不出来返回空字符串（不抛异常）。
    #>
    param($Process)

    try {
        if ($null -eq $Process) { return '' }

        $exePath = [string]$Process.ExecutablePath
        if (-not [string]::IsNullOrWhiteSpace($exePath)) { return $exePath }

        $commandLine = [string]$Process.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { return '' }

        $quoted = [regex]::Match($commandLine, '^\s*"([^"]+)"')
        if ($quoted.Success) { return $quoted.Groups[1].Value }

        $plain = [regex]::Match($commandLine, '^\s*(\S+)')
        if ($plain.Success) { return $plain.Groups[1].Value }

        return ''
    } catch {
        return ''
    }
}

function Test-TcpEndPoint {
    <#
    .SYNOPSIS
        在指定超时内测试 TCP 端口是否可连接（不会无限期阻塞）。
    #>
    param(
        [string]$ComputerName,
        [int]$Port,
        [int]$TimeoutMs
    )

    $client = $null
    try {
        if ([string]::IsNullOrWhiteSpace($ComputerName)) { return $false }
        if ($Port -le 0 -or $Port -gt 65535) { return $false }
        if ($TimeoutMs -le 0) { $TimeoutMs = 3000 }

        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        $finished = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $finished) { return $false }

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

function Get-JsonTextValue {
    <#
    .SYNOPSIS
        从 ConvertFrom-Json 得到的对象里，按候选属性名依次取第一个非空文本值。
    #>
    param($InputObject, [string[]]$Names)

    try {
        if ($null -eq $InputObject) { return '' }
        if ($null -eq $Names) { return '' }

        foreach ($name in $Names) {
            $property = $null
            try { $property = $InputObject.PSObject.Properties[$name] } catch { $property = $null }
            if ($null -eq $property) { continue }

            $value = $property.Value
            if ($null -eq $value) { continue }

            $text = [string]$value
            if (-not [string]::IsNullOrWhiteSpace($text)) { return $text }
        }

        return ''
    } catch {
        return ''
    }
}

function Read-SharedLogFileLines {
    <#
    .SYNOPSIS
        以共享方式读取被占用中的日志文件，返回行数组。
    .DESCRIPTION
        NapCat / 桥接层的日志被写入进程独占打开，普通读取会报
        “文件正由另一进程使用”，所以必须用 FileShare.ReadWrite 打开。
        编码优先按 UTF-8 严格解码，失败再退回系统 ANSI 编码。
        任何失败都返回空数组。
    #>
    param([string]$Path)

    $stream = $null
    $buffer = $null
    try {
        if ([string]::IsNullOrWhiteSpace($Path)) { return @() }
        if (-not [System.IO.File]::Exists($Path)) { return @() }

        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)

        $buffer = New-Object System.IO.MemoryStream
        $chunk = New-Object byte[] 8192
        while ($true) {
            $read = $stream.Read($chunk, 0, $chunk.Length)
            if ($read -le 0) { break }
            $buffer.Write($chunk, 0, $read)
        }

        $bytes = $buffer.ToArray()
        if ($null -eq $bytes -or $bytes.Length -eq 0) { return @() }

        $text = $null
        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        try {
            $text = $strictUtf8.GetString($bytes)
        } catch {
            # 不是合法 UTF-8，按系统 ANSI 编码再试一次（中文日志常见）
            $text = [System.Text.Encoding]::Default.GetString($bytes)
        }

        if ([string]::IsNullOrEmpty($text)) { return @() }

        return @($text -split "\r?\n")
    } catch {
        return @()
    } finally {
        if ($null -ne $stream) {
            try { $stream.Dispose() } catch { }
        }
        if ($null -ne $buffer) {
            try { $buffer.Dispose() } catch { }
        }
    }
}

function Show-SafeMessage {
    <#
    .SYNOPSIS
        弹一个提示框；没有图形界面时退化为 Write-Warning。绝不抛异常。
    #>
    param([string]$Text, [string]$Title)

    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop | Out-Null
        [void][System.Windows.Forms.MessageBox]::Show(
            $Text,
            $Title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information)
    } catch {
        try { Write-Warning ($Title + '：' + $Text) } catch { }
    }
}

function Get-NapCatAccountFromConfig {
    <#
    .SYNOPSIS
        读取已保存的自动登录账号，未设置时再查找账号配置。
    .DESCRIPTION
        配置中的账号仅用于尝试恢复登录，不是当前在线的证据。
    #>
    param($Config)

    try {
        if ($null -eq $Config) { return '' }

        $configDir = ''
        foreach ($relative in @('napcat\config', 'config')) {
            $directory = Join-Path $Config.NapCatDir $relative
            if (-not [System.IO.Directory]::Exists($directory)) { continue }
            if (-not $configDir) { $configDir = $directory }
            $webuiFile = Join-Path $directory 'webui.json'
            if (-not [System.IO.File]::Exists($webuiFile)) { continue }
            try {
                $webui = [System.IO.File]::ReadAllText($webuiFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                $account = [string]$webui.autoLoginAccount
                if ($account -match '^\d{5,20}$') { return $account }
            } catch { }
        }
        if (-not $configDir) { return '' }

        $files = @([System.IO.Directory]::GetFiles($configDir, 'napcat_*.json'))
        if ($files.Count -eq 0) { return '' }

        # 严格匹配的优先（napcat_<QQ>.json）；不匹配的（如 napcat_protocol_<QQ>.json）
        # 只在没有严格匹配项时才拿来兜底，避免"最新的那个恰好是另一种文件名"导致取不到号。
        $strict = @()
        $loose = @()
        foreach ($file in $files) {
            if ([regex]::IsMatch([System.IO.Path]::GetFileName($file), '^napcat_(\d+)\.json$')) {
                $strict += $file
            } else {
                $loose += $file
            }
        }

        $candidates = $strict
        if ($candidates.Count -eq 0) { $candidates = $loose }
        if ($candidates.Count -eq 0) { return '' }

        $newest = $null
        $newestTime = [datetime]::MinValue
        foreach ($file in $candidates) {
            try {
                $written = [System.IO.File]::GetLastWriteTime($file)
                if ($null -eq $newest -or $written -gt $newestTime) {
                    $newest = $file
                    $newestTime = $written
                }
            } catch { }
        }

        if ([string]::IsNullOrEmpty($newest)) { return '' }

        $name = [System.IO.Path]::GetFileName($newest)
        $match = [regex]::Match($name, '^napcat_(\d+)\.json$')
        if ($match.Success) { return $match.Groups[1].Value }

        # 兜底：文件名里任意一段 5 位以上的连续数字，通常就是 QQ 号
        $looseMatch = [regex]::Match($name, '(\d{5,})')
        if ($looseMatch.Success) { return $looseMatch.Groups[1].Value }

        return ''
    } catch {
        return ''
    }
}

function Remove-AnsiEscape {
    <#
    .SYNOPSIS
        去掉日志行里的 ANSI 颜色控制码，方便在记事本里阅读。
    #>
    param([string]$Text)

    try {
        if ([string]::IsNullOrEmpty($Text)) { return '' }

        $escape = [string][char]27
        $result = [regex]::Replace($Text, [regex]::Escape($escape) + '\[[0-9;]*[A-Za-z]', '')
        # 有些场景 ESC 已被剥离，只剩 [32m 这样的残留，一并清掉
        $result = [regex]::Replace($result, '\[[0-9]{1,2}(;[0-9]{1,2})*m', '')
        return $result
    } catch {
        return $Text
    }
}


# =====================================================================
# 二、NapCat 进程
# =====================================================================

function Test-NapCatOwnedProcess {
    param($Process, $Config)
    try {
        $commandLine = ([string]$Process.CommandLine).Replace('/', '\')
        if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
        $directory = [System.IO.Path]::GetFullPath($Config.NapCatDir).TrimEnd('\') + '\'
        foreach ($relative in @('index.js', 'napcat\napcat.mjs', 'napcat.mjs', 'napcat\apcat.mjs', 'apcat.mjs')) {
            $entry = $directory + $relative
            if ([regex]::IsMatch($commandLine, '(?i)(?:^|[\s"])' + [regex]::Escape($entry) + '(?:[\s"]|$)')) { return $true }
        }
        # 相对入口只有在此安装的 node.exe 下才可归属，防止命中其他安装。
        $image = (Get-ProcessImagePath -Process $Process).Replace('/', '\')
        if (-not $image.StartsWith($directory, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        return [regex]::IsMatch($commandLine, '(?i)(?:^|[\s"])(?:\.\\)?(?:index\.js|(?:napcat\\)?n?apcat\.mjs)(?:[\s"]|$)')
    } catch { return $false }
}

function Save-NapCatConsoleLogs {
    param([string]$LogDirectory)
    # Move first: if preservation fails, the caller must not truncate evidence.
    $archive = Join-Path $LogDirectory 'archive\napcat'
    foreach ($name in @('napcat-console.log', 'napcat-console.err.log')) {
        $source = Join-Path $LogDirectory $name
        if (-not [System.IO.File]::Exists($source)) { continue }
        if ((Get-Item -LiteralPath $source -ErrorAction Stop).Length -eq 0) { continue }
        $null = [System.IO.Directory]::CreateDirectory($archive)
        $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
        $destination = Join-Path $archive ($name.Replace('.log', '') + '-' + $suffix + '.log')
        [System.IO.File]::Move($source, $destination)
    }
}

function Get-NapCatProcess {
    <#
    .SYNOPSIS
        探测 NapCat 主进程。
    .DESCRIPTION
        只识别当前安装的入口或 worker；worker 重启时入口进程仍算运行。
        返回 PSCustomObject：
            Running   [bool]
            ProcessId [int]      未运行时为 0
            StartedAt [datetime] 未运行时为 $null
            Path      [string]   未运行时为空字符串
        探测失败同样返回“未运行”的默认对象，不抛异常。
    #>
    $result = [PSCustomObject]@{
        Running   = $false
        ProcessId = 0
        StartedAt = $null
        Path      = ''
    }

    try {
        $config = Get-ProcessControlConfig
        $filter = "Name='" + $config.NapCatProcess + "'"

        $candidates = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -OperationTimeoutSec 3 -ErrorAction Stop)
        if ($candidates.Count -eq 0) { return $result }

        $matched = @()
        foreach ($process in $candidates) {
            $commandLine = [string]$process.CommandLine
            if ([string]::IsNullOrEmpty($commandLine)) { continue }
            if (Test-NapCatOwnedProcess -Process $process -Config $config) {
                $matched += $process
            }
        }
        if ($matched.Count -eq 0) { return $result }

        # 正常情况下只有一个；万一有异常残留，取启动时间最早的视为主进程。
        $main = $matched | Sort-Object -Property CreationDate | Select-Object -First 1

        $result.Running = $true
        try { $result.ProcessId = [int]$main.ProcessId } catch { $result.ProcessId = 0 }
        if ($null -ne $main.CreationDate) {
            try { $result.StartedAt = [datetime]$main.CreationDate } catch { $result.StartedAt = $null }
        }
        $result.Path = Get-ProcessImagePath -Process $main

        return $result
    } catch {
        return $result
    }
}

function Start-NapCat {
    <#
    .SYNOPSIS
        启动 NapCat；已在运行则直接返回 $true。
    .DESCRIPTION
        用 Start-Process 异步拉起 napcat.bat（该批处理会前台阻塞地运行 node，
        绝不能用 & 调用）。返回是否成功发起。
    #>
    try {
        $config = Get-ProcessControlConfig

        $current = Get-NapCatProcess
        if ($null -ne $current -and $current.Running) { return $true }

        # 优先“无窗口 + 输出重定向”启动：
        # napcat.bat 会拉起一个可见的 cmd 控制台，一旦用户在里面点了一下
        # （QuickEdit 进入“选择/标记”模式），整个控制台进程会被挂起，
        # NapCat 就永远卡住、日志也停止写入。直接跑 node.exe 并重定向可以彻底避免，
        # 同时把 NapCat 的 stdout 落到文件里，托盘的“查看日志”才有内容可看。
        $nodeExe = [System.IO.Path]::Combine($config.NapCatDir, 'node.exe')
        $entryJs = [System.IO.Path]::Combine($config.NapCatDir, 'index.js')

        if ([System.IO.File]::Exists($nodeExe) -and [System.IO.File]::Exists($entryJs)) {
            # 用 LogDirs 的最后一项（qq-bridge\logs）作为落盘目录：
            # 它同时也在日志探测列表里，托盘的“查看日志”能直接读到。
            $logDirectory = [string]$config.LogDirs[$config.LogDirs.Count - 1]
            if (-not [System.IO.Directory]::Exists($logDirectory)) {
                $null = [System.IO.Directory]::CreateDirectory($logDirectory)
            }

            $consoleLog = [System.IO.Path]::Combine($logDirectory, 'napcat-console.log')
            $errorLog = [System.IO.Path]::Combine($logDirectory, 'napcat-console.err.log')
            Save-NapCatConsoleLogs -LogDirectory $logDirectory

            # 快速登录仅尝试恢复已有身份；被 QQ 撤销后仍需重新授权。
            # 账号从 napcat_<QQ号>.json 里读；读不到就不加参数，退回扫码流程。
            $quickAccount = Get-NapCatAccountFromConfig -Config $config
            $argumentLine = '"' + $entryJs + '"'
            if (-not [string]::IsNullOrEmpty($quickAccount)) {
                $argumentLine = $argumentLine + ' -q ' + $quickAccount
            }

            $null = Start-Process -FilePath $nodeExe `
                -ArgumentList $argumentLine `
                -WorkingDirectory $config.NapCatDir `
                -WindowStyle Hidden `
                -RedirectStandardOutput $consoleLog `
                -RedirectStandardError $errorLog `
                -PassThru `
                -ErrorAction Stop

            return $true
        }

        # 兜底：没有 node.exe / index.js 时退回批处理。
        $batchFile = $config.NapCatBat
        if (-not [System.IO.File]::Exists($batchFile)) { return $false }

        $workingDirectory = $config.NapCatDir
        if (-not [System.IO.Directory]::Exists($workingDirectory)) {
            $workingDirectory = [System.IO.Path]::GetDirectoryName($batchFile)
        }

        $null = Start-Process -FilePath $batchFile `
            -WorkingDirectory $workingDirectory `
            -WindowStyle Hidden `
            -PassThru `
            -ErrorAction Stop

        return $true
    } catch {
        return $false
    }
}

function Stop-NapCat {
    <#
    .SYNOPSIS
        停止 NapCat，并清理残留的 node.exe。
    .DESCRIPTION
        顺序：先结束主进程（命令行含 apcat.mjs），再反复扫描清理
              1) 所有命令行含 apcat.mjs 的 node.exe；
              2) napcat 目录下运行 index.js 的包装进程（它是 NapCat 的拉起器，
                 不结束会留下残留甚至把 NapCat 又拉起来）。
        QQ.exe 本身不属于本模块职责，不做处理。
        返回结束后 NapCat 是否确实已停止。
    #>
    try {
        $config = Get-ProcessControlConfig

        # ---- 1) 主进程 ----
        $current = Get-NapCatProcess
        if ($null -ne $current -and $current.Running -and $current.ProcessId -gt 0) {
            try { Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop } catch { }
        }

        # ---- 2) 清扫残留（最多 5 轮，防止包装进程反复拉起） ----
        $filter = "Name='" + $config.NapCatProcess + "'"

        for ($round = 1; $round -le 5; $round++) {
            $procs = @()
            try {
                $procs = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)
            } catch {
                $procs = @()
            }

            $hit = 0
            foreach ($process in $procs) {
                if (-not (Test-NapCatOwnedProcess -Process $process -Config $config)) { continue }

                $hit++
                try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch { }
            }

            if ($hit -eq 0) { break }
            Start-Sleep -Milliseconds 250
        }

        # ---- 3) 复核 ----
        $after = Get-NapCatProcess
        if ($null -ne $after -and $after.Running) { return $false }

        return $true
    } catch {
        return $false
    }
}


# =====================================================================
# 三、DSH 进程
# =====================================================================

function Get-DshProcess {
    <#
    .SYNOPSIS
        探测 DSH 主进程。
    .DESCRIPTION
        DSH 是 Electron 应用，运行时会同时存在多个同名进程
        （主进程 + 渲染/GPU/工具子进程）。这里挑“父进程不属于 DSH 的”
        作为候选，再取其中启动最早的一个作为代表。
        返回 PSCustomObject：Running / ProcessId / StartedAt。
    #>
    $result = [PSCustomObject]@{
        Running   = $false
        ProcessId = 0
        StartedAt = $null
    }

    try {
        $config = Get-ProcessControlConfig
        $filter = "Name='" + $config.DshProcess + "'"

        $all = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -OperationTimeoutSec 3 -ErrorAction Stop)
        if ($all.Count -eq 0) { return $result }

        $ids = @{}
        foreach ($process in $all) {
            try { $ids[[int]$process.ProcessId] = $true } catch { }
        }

        $roots = @()
        foreach ($process in $all) {
            $parentId = -1
            try { $parentId = [int]$process.ParentProcessId } catch { $parentId = -1 }
            if (-not $ids.ContainsKey($parentId)) { $roots += $process }
        }

        $candidates = $all
        if ($roots.Count -gt 0) { $candidates = $roots }

        $main = $candidates | Sort-Object -Property CreationDate | Select-Object -First 1

        $result.Running = $true
        try { $result.ProcessId = [int]$main.ProcessId } catch { $result.ProcessId = 0 }
        if ($null -ne $main.CreationDate) {
            try { $result.StartedAt = [datetime]$main.CreationDate } catch { $result.StartedAt = $null }
        }

        return $result
    } catch {
        return $result
    }
}

function Start-Dsh {
    <#
    .SYNOPSIS
        启动 DSH；已在运行则直接返回 $true。
    #>
    try {
        $config = Get-ProcessControlConfig

        $current = Get-DshProcess
        if ($null -ne $current -and $current.Running) { return $true }

        $executable = $config.DshExe
        if (-not [System.IO.File]::Exists($executable)) {
            # 兜底：按当前用户的 LOCALAPPDATA 再找一次
            $localAppData = [string]$env:LOCALAPPDATA
            if (-not [string]::IsNullOrWhiteSpace($localAppData)) {
                $fallback = $localAppData.TrimEnd('\') + '\Programs\DeepSeek Harness\DeepSeek Harness.exe'
                if ([System.IO.File]::Exists($fallback)) { $executable = $fallback }
            }
        }
        if (-not [System.IO.File]::Exists($executable)) { return $false }

        $workingDirectory = [System.IO.Path]::GetDirectoryName($executable)

        $null = Start-Process -FilePath $executable `
            -WorkingDirectory $workingDirectory `
            -PassThru `
            -ErrorAction Stop

        return $true
    } catch {
        return $false
    }
}

function Stop-Dsh {
    <#
    .SYNOPSIS
        停止 DSH（含其全部 Electron 子进程）。
    .DESCRIPTION
        先结束子进程，最后结束主进程，避免主进程退出后子进程残留。
        返回结束后 DSH 是否确实已停止。
    #>
    try {
        $config = Get-ProcessControlConfig
        $filter = "Name='" + $config.DshProcess + "'"

        for ($round = 1; $round -le 10; $round++) {
            $procs = @()
            try {
                $procs = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)
            } catch {
                $procs = @()
            }

            if ($procs.Count -eq 0) { return $true }

            $ids = @{}
            foreach ($process in $procs) {
                try { $ids[[int]$process.ProcessId] = $true } catch { }
            }

            $children = @()
            $roots = @()
            foreach ($process in $procs) {
                $parentId = -1
                try { $parentId = [int]$process.ParentProcessId } catch { $parentId = -1 }
                if ($ids.ContainsKey($parentId)) {
                    $children += $process
                } else {
                    $roots += $process
                }
            }

            foreach ($process in @($children) + @($roots)) {
                try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch { }
            }

            Start-Sleep -Milliseconds 300
        }

        $after = Get-DshProcess
        if ($null -ne $after -and $after.Running) { return $false }

        return $true
    } catch {
        return $false
    }
}


# =====================================================================
# 四、NapCat 登录态
# =====================================================================

function Get-NapCatNicknameFromLog {
    <#
    .SYNOPSIS
        从 NapCat 日志的收发记录里反推机器人自己的昵称（仅作展示用）。
    .DESCRIPTION
        日志形如：10-20 00:53:13 [info] 大肥鱼 | 接收 <- 私聊 (1000000002) 你好
        正则只依赖 ASCII 的日志骨架（级别标记 + 竖线），不依赖中文关键词，
        避免脚本编码差异导致匹配失败。从末尾往前找最后一条，取竖线左边的昵称。
        找不到返回空字符串。
    #>
    try {
        $path = Get-NapCatLogPath
        if ([string]::IsNullOrEmpty($path)) { return '' }

        $lines = @(Get-NapCatLogTail -Lines 300)
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
            $line = [string]$lines[$i]
            if ([string]::IsNullOrEmpty($line)) { continue }

            $m = [regex]::Match($line, '\[(?:info|debug|warn)\]\s+([^|\s][^|]*?)\s+\|')
            if ($m.Success) {
                $nick = $m.Groups[1].Value.Trim()
                if (-not [string]::IsNullOrEmpty($nick) -and $nick.Length -le 40) { return $nick }
            }
        }

        return ''
    } catch {
        return ''
    }
}
function Get-NapCatLoginState {
    <#
    .SYNOPSIS
        探测 NapCat 是否已登录 QQ。
    .DESCRIPTION
        与控制台共用 Node 检测器，使用已鉴权的 WebUI 或 OneBot 在线状态。
        短期 WebUI 凭据只在当前 runspace 内存中缓存，经 stdin 传递给子进程。
        兼容原有字段，并增加 State / Known / Phase；检测失败返回未知状态。
    #>
    $result = [PSCustomObject]@{
        LoggedIn = $false
        Account  = ''
        Nickname = ''
        Detail   = '暂时无法确认 QQ 登录状态'
        State    = 'unknown'
        Known    = $false
        Phase    = ''
    }

    $child = $null
    try {
        $config = Get-ProcessControlConfig
        $process = Get-NapCatProcess
        $runningFlag = '--stopped'
        if ($null -ne $process -and $process.Running) { $runningFlag = '--running' }
        $helper = Join-Path $config.Root 'scripts\napcat-health.mjs'
        if (-not [System.IO.File]::Exists($helper)) { return $result }
        $node = Resolve-NodeExe
        if ([string]::IsNullOrWhiteSpace($node)) { return $result }

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $node
        $startInfo.Arguments = '"' + $helper + '" --root "' + $config.Root.TrimEnd('\') + '" ' + $runningFlag + ' --exchange-session'
        $startInfo.WorkingDirectory = $config.Root
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardInput = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        $child = New-Object System.Diagnostics.Process
        $child.StartInfo = $startInfo
        $null = $child.Start()
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        $cachedSession = $null
        $variable = Get-Variable -Name 'NapCatHealthSession' -Scope Script -ErrorAction SilentlyContinue
        if ($null -ne $variable) { $cachedSession = $variable.Value }
        $child.StandardInput.WriteLine((@{ session = $cachedSession } | ConvertTo-Json -Depth 5 -Compress))
        $child.StandardInput.Close()
        if (-not $child.WaitForExit(4500)) {
            try { $child.Kill() } catch { }
            $result.Detail = 'QQ 登录状态检测超时'
            return $result
        }
        if ($child.ExitCode -ne 0) { return $result }
        $payload = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
        $script:NapCatHealthSession = $payload.session
        $health = $payload.health
        if ($null -eq $health) { return $result }
        $result.LoggedIn = ($health.loggedIn -eq $true -and $health.state -eq 'online')
        $result.Account = [string]$health.account
        $result.Nickname = [string]$health.nickname
        $result.Detail = [string]$health.detail
        $result.State = [string]$health.state
        $result.Known = [bool]$health.known
        $result.Phase = [string]$health.phase
        return $result
    } catch {
        # Do not expose child output: it can contain a cached WebUI credential.
        return $result
    } finally {
        if ($null -ne $child) { $child.Dispose() }
    }
}


# =====================================================================
# 五、NapCat 日志
# =====================================================================

function Get-NapCatLogPath {
    <#
    .SYNOPSIS
        返回“当天”NapCat 日志文件的完整路径。
    .DESCRIPTION
        依次探测以下目录（先到先得）：
            napcat\logs\           —— 约定位置
            napcat\napcat\logs\    —— NapCat 自身运行目录（fileLog 打开时才有）
            qq-bridge\logs\        —— 桥接层捕获的 NapCat 输出
        每个目录内优先取“当天修改过”的最新 .log；当天没有则退而取该目录里
        最新的 .log；全都没有返回 $null。
    #>
    try {
        $config = Get-ProcessControlConfig
        $today = (Get-Date).Date

        $newestAny = $null
        $newestAnyTime = [datetime]::MinValue

        foreach ($directory in $config.LogDirs) {
            if ([string]::IsNullOrWhiteSpace($directory)) { continue }
            if (-not [System.IO.Directory]::Exists($directory)) { continue }

            $files = @()
            try {
                $files = @(Get-ChildItem -LiteralPath $directory -Filter '*.log' -File -ErrorAction Stop)
            } catch {
                $files = @()
            }
            if ($files.Count -eq 0) { continue }

            $todayFiles = @()
            foreach ($file in $files) {
                try {
                    if ($file.LastWriteTime.Date -eq $today) { $todayFiles += $file }
                } catch { }
            }

            if ($todayFiles.Count -gt 0) {
                $best = $todayFiles | Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1
                if ($null -ne $best) { return $best.FullName }
            }

            foreach ($file in $files) {
                try {
                    if ($file.LastWriteTime -gt $newestAnyTime) {
                        $newestAnyTime = $file.LastWriteTime
                        $newestAny = $file
                    }
                } catch { }
            }
        }

        if ($null -ne $newestAny) { return $newestAny.FullName }

        return $null
    } catch {
        return $null
    }
}

function Get-NapCatLogTail([int]$Lines = 80) {
    <#
    .SYNOPSIS
        返回 NapCat 日志最后 N 行（字符串数组）。
    .DESCRIPTION
        日志文件通常被写入进程独占，这里以共享方式读取；读不到返回空数组。
        顺带清掉 ANSI 颜色控制码，方便在记事本里查看。
    #>
    try {
        if ($Lines -le 0) { $Lines = 80 }

        $logPath = Get-NapCatLogPath
        if ([string]::IsNullOrWhiteSpace($logPath)) { return @() }
        if (-not [System.IO.File]::Exists($logPath)) { return @() }

        $allLines = Read-SharedLogFileLines -Path $logPath
        if ($null -eq $allLines -or $allLines.Count -eq 0) { return @() }

        # 去掉文件末尾换行产生的空行
        $lastIndex = $allLines.Count - 1
        while ($lastIndex -ge 0 -and [string]::IsNullOrEmpty([string]$allLines[$lastIndex])) {
            $lastIndex--
        }
        if ($lastIndex -lt 0) { return @() }

        $startIndex = $lastIndex - $Lines + 1
        if ($startIndex -lt 0) { $startIndex = 0 }

        $tail = @()
        for ($index = $startIndex; $index -le $lastIndex; $index++) {
            $tail += Remove-AnsiEscape -Text ([string]$allLines[$index])
        }

        return $tail
    } catch {
        return @()
    }
}


# =====================================================================
# 六、通用
# =====================================================================

function Open-PathSafely([string]$Path) {
    <#
    .SYNOPSIS
        在资源管理器里打开路径；路径不存在时给出提示。
    .DESCRIPTION
        目录：直接打开该目录。
        文件：打开所在目录并选中该文件。
        路径为空或不存在：弹提示（无图形界面时退化为 Write-Warning）。
        无返回值，任何异常都被吞掉。
    #>
    try {
        if ([string]::IsNullOrWhiteSpace($Path)) {
            Show-SafeMessage -Text '没有可打开的路径。' -Title 'QQ-DSH 启动器'
            return
        }

        $target = $Path.Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($target)) {
            Show-SafeMessage -Text '没有可打开的路径。' -Title 'QQ-DSH 启动器'
            return
        }

        if (-not (Test-Path -LiteralPath $target)) {
            $message = '路径不存在：' + [Environment]::NewLine + $target
            Show-SafeMessage -Text $message -Title 'QQ-DSH 启动器'
            return
        }

        $isDirectory = $false
        try { $isDirectory = [bool](Test-Path -LiteralPath $target -PathType Container) } catch { $isDirectory = $false }

        if ($isDirectory) {
            Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $target.TrimEnd('\') + '"') -ErrorAction Stop | Out-Null
        } else {
            Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + $target + '"') -ErrorAction Stop | Out-Null
        }
    } catch {
        try {
            Show-SafeMessage -Text ('打开路径失败：' + $_.Exception.Message) -Title 'QQ-DSH 启动器'
        } catch { }
    }
}


function Resolve-NodeExe {
    <#
    .SYNOPSIS
        找到可用的 node.exe（桥接需要 Node >= 18，优先用 PATH 里的）。
    #>
    try {
        $commands = @(Get-Command 'node' -ErrorAction Stop)
        foreach ($command in $commands) {
            $path = [string]$command.Source
            if (-not [string]::IsNullOrWhiteSpace($path) -and [System.IO.File]::Exists($path)) {
                return $path
            }
        }
    } catch {
    }

    # 退而求其次：NapCat 自带的 node.exe（版本较旧，但能跑）
    $config = Get-ProcessControlConfig
    if ([System.IO.File]::Exists($config.NapCatNode)) { return $config.NapCatNode }

    return ''
}

function Get-BridgeProcess {
    <#
    .SYNOPSIS
        探测桥接进程（src\index.js）是否在运行。
    .DESCRIPTION
        返回 @{ Running; ProcessId; Sessions; Connected; InFlight; QueueDepth }。
        Sessions/Connected 等来自 state\status.json，读不到就是 0/$false。
    #>
    try {
        $config = Get-ProcessControlConfig
        $result = @{
            Running    = $false
            ProcessId  = 0
            Sessions   = 0
            Connected  = $false
            InFlight   = 0
            QueueDepth = 0
            Account    = ''
        }

        $entryPattern = '(?i)(?:^|[\s"])' + [regex]::Escape(([string]$config.BridgeScript).Replace('/', '\')) + '(?:[\s"]|$)'

        $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 3 -ErrorAction SilentlyContinue
        foreach ($process in @($processes)) {
            $commandLine = [string]$process.CommandLine
            if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
            if (-not [regex]::IsMatch($commandLine.Replace('/', '\'), $entryPattern)) { continue }

            $result.Running = $true
            try { $result.ProcessId = [int]$process.ProcessId } catch { }
            break
        }

        # status.json 是桥接自己写的，能反映会话数与连接状态
        $statusPath = [string]$config.StatusFile
        if ([System.IO.File]::Exists($statusPath)) {
            try {
                $text = [System.IO.File]::ReadAllText($statusPath, [System.Text.Encoding]::UTF8)
                if (-not [string]::IsNullOrWhiteSpace($text)) {
                    $status = $text | ConvertFrom-Json
                    try { $result.Sessions = [int]$status.sessions } catch { }
                    try {
                        # PS 7 converts ISO JSON timestamps to DateTime; keep its Kind.
                        if ($status.updatedAt -is [datetime] -or $status.updatedAt -is [DateTimeOffset]) {
                            $updated = [DateTimeOffset]$status.updatedAt
                        } else {
                            $updated = [DateTimeOffset]::Parse([string]$status.updatedAt)
                        }
                        $age = ([DateTimeOffset]::UtcNow - $updated).TotalSeconds
                        $result.Connected = ($result.Running -and [int]$status.pid -eq $result.ProcessId -and
                            $age -ge -5 -and $age -lt 20 -and $status.connected -eq $true)
                    } catch { $result.Connected = $false }
                    try { $result.InFlight = [int]$status.inFlight } catch { }
                    try { $result.QueueDepth = [int]$status.queueDepth } catch { }
                }
            } catch {
            }
        }

        return $result
    } catch {
        return @{ Running = $false; ProcessId = 0; Sessions = 0; Connected = $false; InFlight = 0; QueueDepth = 0; Account = '' }
    }
}

function Get-BridgeLogPath {
    <#
    .SYNOPSIS
        返回桥接控制台日志的完整路径。
    #>
    $config = Get-ProcessControlConfig
    $logDirectory = [string]$config.LogDirs[$config.LogDirs.Count - 1]
    return [System.IO.Path]::Combine($logDirectory, [string]$config.BridgeConsole)
}

function Start-Bridge {
    <#
    .SYNOPSIS
        启动桥接进程；已在运行则直接返回 $true。
    .DESCRIPTION
        用绝对路径把 src\index.js 传给 node.exe，这样进程命令行里一定带有
        qq-bridge\src\index.js 标记，便于 Get-BridgeProcess 精确识别
        （不会和 NapCat 自己的 index.js 混淆）。输出重定向到 logs\bridge-console.log。
    #>
    try {
        $config = Get-ProcessControlConfig

        $current = Get-BridgeProcess
        if ($null -ne $current -and $current.Running) { return $true }

        if (-not [System.IO.File]::Exists($config.BridgeScript)) { return $false }

        $nodeExe = Resolve-NodeExe
        if ([string]::IsNullOrWhiteSpace($nodeExe)) { return $false }

        $logDirectory = [string]$config.LogDirs[$config.LogDirs.Count - 1]
        if (-not [System.IO.Directory]::Exists($logDirectory)) {
            $null = [System.IO.Directory]::CreateDirectory($logDirectory)
        }

        $consoleLog = [System.IO.Path]::Combine($logDirectory, [string]$config.BridgeConsole)
        $errorLog = [System.IO.Path]::Combine($logDirectory, 'bridge-console.err.log')

        $argumentLine = '"' + $config.BridgeScript + '"'

        $null = Start-Process -FilePath $nodeExe `
            -ArgumentList $argumentLine `
            -WorkingDirectory $config.Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $consoleLog `
            -RedirectStandardError $errorLog `
            -PassThru `
            -ErrorAction Stop

        return $true
    } catch {
        return $false
    }
}

function Stop-Bridge {
    <#
    .SYNOPSIS
        停止桥接进程，返回结束后是否确实已停止。
    #>
    try {
        $config = Get-ProcessControlConfig
        $marker = [string]$config.BridgeMarker

        for ($round = 0; $round -lt 4; $round++) {
            $alive = @()
            $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
            foreach ($process in @($processes)) {
                $commandLine = [string]$process.CommandLine
                if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
                if ($commandLine.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
                $alive += $process
            }

            if ($alive.Count -eq 0) { return $true }

            foreach ($process in $alive) {
                try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop } catch { }
            }

            Start-Sleep -Milliseconds 400
        }

        $after = Get-BridgeProcess
        return (-not $after.Running)
    } catch {
        return $false
    }
}
