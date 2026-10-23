# ============================================================
#  QQ-DSH 一键启动 · 引导脚本
#
#  职责：把 NapCat、桥接、控制台、DSH、托盘图标依次拉起来（已运行的跳过）。
#  由「一键启动.cmd」调用，也可以直接：
#      powershell -NoProfile -ExecutionPolicy Bypass -File launcher\bootstrap.ps1
#
#  注意：本文件必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 读中文乱码。
# ============================================================

$ErrorActionPreference = 'Continue'

$script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:LogPath     = Join-Path $script:ProjectRoot 'state\launcher.log'
$script:StateDir    = Join-Path $script:ProjectRoot 'state'

if (-not (Test-Path -LiteralPath $script:StateDir)) {
    $null = New-Item -ItemType Directory -Path $script:StateDir -Force -ErrorAction SilentlyContinue
}

function Write-BootLog {
    param([string]$Message)

    $line = '{0} [bootstrap] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $Message
    try {
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        # 日志写不进去也不能影响启动
    }
}

# 复用 lib 里的进程控制，避免两套启动逻辑（尤其是 -q 快速登录只在那里实现）
$script:LibPath = Join-Path $PSScriptRoot 'lib\ProcessControl.ps1'
if (Test-Path -LiteralPath $script:LibPath) {
    try {
        . $script:LibPath
    } catch {
        Write-BootLog ('加载 ProcessControl 失败：' + $_.Exception.Message)
    }
}

function Test-DshRunning {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction Stop
        return (@($procs).Count -gt 0)
    } catch {
        return $false
    }
}

# ---- 控制台（WebUI）辅助：端口 / 进程探测
#
# 控制台是可选组件（挂了 QQ 照常收发），所以这几个函数只返回布尔值或端口号，
# 任何异常都吞掉，绝不把整条启动链带崩。

function Test-WebUiPortOpen {
    param([int]$Port, [int]$ExpectedProcessId)

    $client = $null
    try {
        if ($Port -le 0 -or $Port -gt 65535 -or $ExpectedProcessId -le 0) { return $false }
        $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        $owned = @($listeners | Where-Object { [int]$_.OwningProcess -eq $ExpectedProcessId })
        if ($owned.Count -eq 0) { return $false }
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(600, $false)) { return $false }
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

function Get-WebUiPortNumber {
    param([int]$Fallback = 5830)

    try {
        $portFile = Join-Path $script:StateDir 'webui-port.txt'
        if (-not [System.IO.File]::Exists($portFile)) { return $Fallback }

        $text = [System.IO.File]::ReadAllText($portFile, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($text)) { return $Fallback }

        $text = $text.Trim()
        if ($text -notmatch '^\d{1,5}$') { return $Fallback }

        $port = 0
        if (-not [int]::TryParse($text, [ref]$port)) { return $Fallback }
        if ($port -lt 1 -or $port -gt 65535) { return $Fallback }
        return $port
    } catch {
        return $Fallback
    }
}

function Test-WebUiProcessRunning {
    try {
        $entry = [System.IO.Path]::GetFullPath((Join-Path $script:ProjectRoot 'src\webui\server.mjs'))
        $escapedEntry = [regex]::Escape($entry.Replace('/', '\'))
        $entryArgument = '"' + $escapedEntry + '"'
        if ($entry -notmatch '\s') { $entryArgument += '|' + $escapedEntry }
        # Managed launches put the entry directly after node.exe.
        $entryPattern = '(?i)^\s*(?:"[^"]+"|[^\s"]+)\s+(?:' + $entryArgument + ')(?:\s|$)'
        $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 3 -ErrorAction SilentlyContinue
        foreach ($process in @($processes)) {
            $commandLine = [string]$process.CommandLine
            if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
            if ([regex]::IsMatch($commandLine.Replace('/', '\'), $entryPattern)) { return $true }
        }
        return $false
    } catch {
        return $false
    }
}

Write-BootLog '启动流程开始'

# ---------------------------------------------------------------- 1) NapCat
#
# 走 Start-NapCat（带上 -q 尝试恢复已有 QQ 身份）。
# 只有拿不到 lib 时才退回直接跑 napcat.bat。

$napcatRunning = $false
try {
    $probe = Get-NapCatProcess
    if ($null -ne $probe) { $napcatRunning = [bool]$probe.Running }
} catch {
    $napcatRunning = $false
}

if ($napcatRunning) {
    Write-BootLog 'NapCat 已在运行，跳过'
    Write-Host '[=] NapCat 已在运行'
} else {
    $started = $false
    try {
        $started = [bool](Start-NapCat)
    } catch {
        Write-BootLog ('Start-NapCat 异常：' + $_.Exception.Message)
    }

    if ($started) {
        Write-BootLog 'NapCat 进程已启动，正在尝试恢复登录'
        Write-Host '[+] NapCat 进程已启动，正在尝试恢复登录；需要时请在登录页确认'
        # 给 NapCat 一点时间起来，避免托盘一上来就是红的
        Start-Sleep -Seconds 4
    } else {
        $napcatBat = Join-Path $script:ProjectRoot 'napcat\napcat.bat'
        if (-not (Test-Path -LiteralPath $napcatBat)) {
            Write-BootLog "找不到 NapCat 启动脚本：$napcatBat"
            Write-Host "[!] 找不到 NapCat：$napcatBat" -ForegroundColor Red
            Write-Host '    请先运行 install-napcat.cmd 安装。' -ForegroundColor Yellow
            exit 2
        }

        Write-BootLog "退回批处理启动 NapCat：$napcatBat"
        try {
            Start-Process -FilePath $napcatBat `
                -WorkingDirectory (Join-Path $script:ProjectRoot 'napcat') `
                -WindowStyle Hidden -ErrorAction Stop | Out-Null
            Write-Host '[+] NapCat 已启动（批处理模式，可能需要扫码）'
        } catch {
            Write-BootLog ('NapCat 启动失败：' + $_.Exception.Message)
            Write-Host ('[!] NapCat 启动失败：' + $_.Exception.Message) -ForegroundColor Red
            exit 3
        }

        Start-Sleep -Seconds 4
    }
}

# ---------------------------------------------------------------- 2) 桥接
#
# 桥接是 QQ 消息 → dsh headless → QQ 回复 的那一环，少了它消息到不了 DSH。

$bridgeRunning = $false
try {
    $bridgeProbe = Get-BridgeProcess
    if ($null -ne $bridgeProbe) { $bridgeRunning = [bool]$bridgeProbe.Running }
} catch {
    $bridgeRunning = $false
}

if ($bridgeRunning) {
    Write-BootLog '桥接已在运行，跳过'
    Write-Host '[=] 桥接已在运行'
} else {
    $bridgeStarted = $false
    try {
        $bridgeStarted = [bool](Start-Bridge)
    } catch {
        Write-BootLog ('Start-Bridge 异常：' + $_.Exception.Message)
    }

    if ($bridgeStarted) {
        Write-BootLog '桥接已启动'
        Write-Host '[+] 桥接已启动'
    } else {
        Write-BootLog '桥接启动失败'
        Write-Host '[!] 桥接启动失败，可在托盘菜单「桥接」里重试' -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------- 3) 控制台
#
# 控制台是给桌面/手机看的 Material You 面板（src\webui\server.mjs）。
# 它是可选组件：起不来只记日志，绝不能让整条启动链失败 —— QQ 收发不依赖它。

$consolePort = Get-WebUiPortNumber -Fallback 5830
$consoleRunning = $false

try {
    if (Test-WebUiProcessRunning) { $consoleRunning = $true }
} catch {
    $consoleRunning = $false
}
if ($consoleRunning) {
    Write-BootLog ('控制台已在运行（端口 ' + $consolePort + '），跳过')
    Write-Host '[=] 控制台已在运行'
} else {
    $webUiScript = Join-Path $script:ProjectRoot 'src\webui\server.mjs'

    if (-not (Test-Path -LiteralPath $webUiScript -PathType Leaf)) {
        Write-BootLog ('跳过控制台：找不到 ' + $webUiScript)
        Write-Host '[!] 控制台服务端还没装好（src\webui\server.mjs 不存在），本次跳过' -ForegroundColor Yellow
    } else {
        try {
            # 用 Resolve-NodeExe 统一解析 node（和桥接同一套逻辑）；拿不到再退回 PATH
            $nodeExe = ''
            try {
                if ($null -ne (Get-Command -Name 'Resolve-NodeExe' -CommandType Function -ErrorAction SilentlyContinue)) {
                    $nodeExe = [string](Resolve-NodeExe)
                }
            } catch {
                $nodeExe = ''
            }
            if ([string]::IsNullOrWhiteSpace($nodeExe)) {
                $nodeCommand = Get-Command -Name 'node' -ErrorAction SilentlyContinue
                if ($null -ne $nodeCommand) { $nodeExe = [string]$nodeCommand.Source }
            }
            if ([string]::IsNullOrWhiteSpace($nodeExe)) { throw '找不到可用的 node.exe' }

            $logDirectory = Join-Path $script:ProjectRoot 'logs'
            if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
                $null = New-Item -ItemType Directory -Path $logDirectory -Force -ErrorAction SilentlyContinue
            }

            $consoleLog = Join-Path $logDirectory 'webui-console.log'
            $consoleErr = Join-Path $logDirectory 'webui-console.err.log'
            $argumentLine = '"' + $webUiScript + '"'

            $consoleProcess = Start-Process -FilePath $nodeExe `
                -ArgumentList $argumentLine `
                -WorkingDirectory $script:ProjectRoot `
                -WindowStyle Hidden `
                -RedirectStandardOutput $consoleLog `
                -RedirectStandardError $consoleErr `
                -PassThru `
                -ErrorAction Stop

            Write-BootLog ('控制台已启动：' + $nodeExe + ' ' + $argumentLine)

            # 等它把端口绑上（最多 6 秒）；绑不上也只提示，不失败
            $consoleReady = $false
            $deadline = (Get-Date).AddSeconds(6)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 400
                if ($consoleProcess.HasExited) { break }
                if (Test-WebUiPortOpen -Port (Get-WebUiPortNumber -Fallback $consolePort) -ExpectedProcessId $consoleProcess.Id) {
                    $consoleReady = $true
                    break
                }
            }

            if ($consoleReady) {
                $readyPort = Get-WebUiPortNumber -Fallback $consolePort
                Write-BootLog ('控制台已就绪：http://127.0.0.1:' + $readyPort + '/')
                Write-Host ('[+] 控制台已启动：http://127.0.0.1:' + $readyPort + '/')
            } else {
                Write-BootLog '控制台 6 秒内没有监听端口，可能启动失败（详见 logs\webui-console.err.log）'
                Write-Host '[!] 控制台没能在 6 秒内就绪（不影响 QQ 收发），详见 logs\webui-console.err.log' -ForegroundColor Yellow
            }
        } catch {
            Write-BootLog ('控制台启动失败（已忽略，不影响 QQ 收发）：' + $_.Exception.Message)
            Write-Host ('[!] 控制台启动失败（已忽略）：' + $_.Exception.Message) -ForegroundColor Yellow
        }
    }
}

# ---------------------------------------------------------------- 4) DSH

if (Test-DshRunning) {
    Write-BootLog 'DSH 已在运行，跳过'
    Write-Host '[=] DSH 已在运行'
} else {
    $dshExe = ''
    if ($env:LOCALAPPDATA) { $dshExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe' }
    if ((-not $dshExe) -or (-not (Test-Path -LiteralPath $dshExe))) {
        if ($env:ProgramFiles) {
            $candidate = Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'
            if (Test-Path -LiteralPath $candidate) { $dshExe = $candidate }
        }
    }
    if (-not (Test-Path -LiteralPath $dshExe)) {
        Write-BootLog "找不到 DSH：$dshExe"
        Write-Host "[!] 找不到 DSH：$dshExe" -ForegroundColor Red
        exit 4
    }

    Write-BootLog "启动 DSH：$dshExe"
    try {
        Start-Process -FilePath $dshExe -ErrorAction Stop | Out-Null
        Write-Host '[+] DSH 已启动'
    } catch {
        Write-BootLog ('DSH 启动失败：' + $_.Exception.Message)
        Write-Host ('[!] DSH 启动失败：' + $_.Exception.Message) -ForegroundColor Red
        exit 5
    }
}

# ---------------------------------------------------------------- 5) 托盘

$trayScript = Join-Path $script:ProjectRoot 'launcher\Launcher.ps1'
if (-not (Test-Path -LiteralPath $trayScript)) {
    Write-BootLog "找不到托盘脚本：$trayScript"
    Write-Host "[!] 找不到托盘脚本：$trayScript" -ForegroundColor Red
    exit 6
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }

Write-BootLog '启动托盘'
try {
    Start-Process -FilePath $psExe `
        -ArgumentList @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $trayScript + '"')) `
        -WindowStyle Hidden -ErrorAction Stop | Out-Null
} catch {
    Write-BootLog ('托盘启动失败：' + $_.Exception.Message)
    Write-Host ('[!] 托盘启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 7
}

Write-BootLog '启动流程完成'
Write-Host ''
Write-Host '[✓] 已就绪 —— 看任务栏右下角的托盘图标（绿色 = 一切正常）' -ForegroundColor Green
Write-Host '    左键打开控制台，右键退出；退出时停止桥接和 NapCat，DSH 保持运行。' -ForegroundColor DarkGray
Write-Host ''

exit 0
