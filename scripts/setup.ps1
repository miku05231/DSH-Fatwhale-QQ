<#
.SYNOPSIS
    qq-bridge 环境初始化（幂等，可以反复运行）。

.DESCRIPTION
    1. 确保 config.json 存在（没有就从 config.example.json 复制；模板也不在时写内置默认值）
    2. 创建 logs\ 与 state\ 目录
    3. 校验 config.json 的 JSON 语法，并提示白名单是否为空
    4. 检查 node 是否可用
    5. 打印中文的下一步指引
    6. 可选 -Autostart：调用 scripts\autostart.ps1 -Enable 设置开机自启

    用法：
        powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
        powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Autostart

    重要：本文件必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 读取中文会乱码。
#>

[CmdletBinding()]
param(
    [switch]$Autostart
)

$ErrorActionPreference = 'Stop'

# 项目根 = 本脚本所在目录（scripts）的上一级
$script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$script:ConfigPath = Join-Path $script:ProjectRoot 'config.json'
$script:ExampleConfigPath = Join-Path $script:ProjectRoot 'config.example.json'

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

Write-Head 'qq-bridge 环境初始化'
Write-Item ('项目根目录：' + $script:ProjectRoot)
if (-not (Test-Path -LiteralPath $script:ProjectRoot -PathType Container)) {
    Write-Fail '项目根目录不存在，脚本可能被移动过。'
    return
}

# ---------------------------------------------------------------- 1. config.json

Write-Head '第 1 步 / 4：配置文件'

if (Test-Path -LiteralPath $script:ConfigPath -PathType Leaf) {
    Write-Done 'config.json 已存在，保留原文件（不覆盖你的白名单）'
} else {
    if (Test-Path -LiteralPath $script:ExampleConfigPath -PathType Leaf) {
        Copy-Item -LiteralPath $script:ExampleConfigPath -Destination $script:ConfigPath -Force
        Write-Done '已从 config.example.json 复制生成 config.json'
    } else {
        # 模板也不在时，写一份与 SPEC 第 3 节一致的内置默认配置
        $template = @'
{
  "onebot": {
    "url": "ws://127.0.0.1:3001",
    "accessToken": ""
  },
  "dsh": {
    "command": "dsh",
    "profile": "headless",
    "patchPath": "patches/headless-model.yml",
    "cwd": "__PROJECT_ROOT__",
    "timeoutMs": 300000
  },
  "security": {
    "allowFrom": [],
    "allowGroups": false,
    "rateLimitPerMinute": 10,
    "maxChars": 4000
  },
  "behavior": {
    "queuedNotice": "收到，正在处理…",
    "maxReplyChunk": 1200,
    "showErrors": true,
    "wakeWord": ""
  },
  "logDir": "logs",
  "stateDir": "state"
}
'@
        $jsonRoot = $script:ProjectRoot.Replace('\', '\\')
        $jsonText = $template.Replace('__PROJECT_ROOT__', $jsonRoot)
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($script:ConfigPath, $jsonText, $utf8NoBom)
        Write-Done '未找到 config.example.json，已写入内置默认配置'
        Write-Tip '建议之后从版本库恢复 config.example.json，保持模板与代码同步'
    }
}

# ---------------------------------------------------------------- 2. 目录

Write-Head '第 2 步 / 4：运行目录'

foreach ($dirName in @('logs', 'state')) {
    $dirPath = Join-Path $script:ProjectRoot $dirName
    if (Test-Path -LiteralPath $dirPath -PathType Container) {
        Write-Done ($dirName + '/ 已存在')
    } else {
        try {
            $null = New-Item -ItemType Directory -Path $dirPath -Force
            Write-Done ('已创建 ' + $dirName + '/')
        } catch {
            Write-Fail ('创建目录 ' + $dirPath + ' 失败：' + $_.Exception.Message)
        }
    }
}

# ---------------------------------------------------------------- 3. 配置校验

Write-Head '第 3 步 / 4：配置校验'

$configDoc = $null
try {
    $rawConfig = [System.IO.File]::ReadAllText($script:ConfigPath, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($rawConfig)) {
        Write-Fail 'config.json 是空文件，请删除后重新运行本脚本。'
    } else {
        $configDoc = $rawConfig | ConvertFrom-Json
        Write-Done 'config.json 的 JSON 语法正确'
    }
} catch {
    Write-Fail ('config.json 解析失败：' + $_.Exception.Message)
    Write-Tip '可以删除 config.json 后重新运行本脚本，用模板重新生成。'
}

if ($null -ne $configDoc) {
    $onebotUrl = ''
    try { $onebotUrl = [string]$configDoc.onebot.url } catch { $onebotUrl = '' }
    if ([string]::IsNullOrWhiteSpace($onebotUrl)) {
        Write-Tip 'onebot.url 为空，托盘和桥接都无法连接 NapCat，请填写 like ws://127.0.0.1:3001'
    } else {
        Write-Item ('NapCat 地址：' + $onebotUrl)
    }

    $allowList = @()
    try { $allowList = @($configDoc.security.allowFrom) } catch { $allowList = @() }
    $allowList = @($allowList | Where-Object { $null -ne $_ -and -not [string]::IsNullOrWhiteSpace([string]$_) })

    if ($allowList.Count -eq 0) {
        Write-Tip 'security.allowFrom 为空 —— 按安全默认，桥接会【拒绝所有消息】。'
        Write-Tip '请右键托盘 →「编辑白名单」，把你的 QQ 号填进去后重启桥接。'
    } else {
        Write-Done ('白名单里已有 ' + $allowList.Count + ' 个 QQ 号：' + ($allowList -join ', '))
    }

    $wakeWord = ''
    try { $wakeWord = [string]$configDoc.behavior.wakeWord } catch { $wakeWord = '' }
    if (-not [string]::IsNullOrWhiteSpace($wakeWord)) {
        Write-Item ('唤醒词：' + $wakeWord + '（私聊消息需以该词开头）')
    }
}

# 关键文件存在性提示
$indexJs = Join-Path $script:ProjectRoot 'src\index.js'
if (Test-Path -LiteralPath $indexJs -PathType Leaf) {
    Write-Done '入口文件 src\index.js 存在'
} else {
    Write-Tip '还没找到 src\index.js（桥接主程序尚未生成），启动桥接会失败。'
}

$patchFile = Join-Path $script:ProjectRoot 'patches\headless-model.yml'
if (-not (Test-Path -LiteralPath $patchFile -PathType Leaf)) {
    Write-Tip '缺少 patches\headless-model.yml，DSH 调用可能失败。'
}

# ---------------------------------------------------------------- 4. node

Write-Head '第 4 步 / 4：运行环境'

# 注意：PATH 里可能有多个 node.exe（例如版本管理器的目录），Get-Command 会返回多台，
# 必须取第一个，否则 $nodeCmd.Source 会变成数组，拼出来的命令是坏的。
$nodeMatches = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue)
if ($nodeMatches.Count -gt 0) {
    $nodeExe = [string]$nodeMatches[0].Source
    $nodeVersion = ''
    try { $nodeVersion = (& $nodeExe -v 2>$null | Out-String).Trim() } catch { $nodeVersion = '' }
    if ([string]::IsNullOrWhiteSpace($nodeVersion)) {
        Write-Done ('已找到 node：' + $nodeExe)
    } else {
        Write-Done ('Node 版本：' + $nodeVersion + '（' + $nodeExe + '）')
    }
    if ($nodeMatches.Count -gt 1) {
        Write-Tip ('PATH 里有 ' + $nodeMatches.Count + ' 个 node.exe，实际使用第一个：' + $nodeExe)
    }
    if ($nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -lt 22) {
        Write-Tip '建议使用 Node 22 或更高版本（内置 WebSocket 客户端）。'
    }
} else {
    Write-Fail 'PATH 里找不到 node.exe，请先安装 Node.js 22 或更高版本：https://nodejs.org/'
}

$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -ne $dshCmd) {
    Write-Done ('DSH CLI：' + $dshCmd.Source)
} else {
    Write-Tip 'PATH 里找不到 dsh，桥接将无法调用 DeepSeek Harness。'
}

# ---------------------------------------------------------------- 下一步指引

Write-Head '初始化完成，下一步'
Write-Host ''
Write-Host '  直接双击根目录的 一键启动.cmd 就行了。' -ForegroundColor White
Write-Host '  它会依次拉起 NapCat（快速登录）、桥接、DSH 和托盘图标，已运行的自动跳过。' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  白名单在 config.json 的 security.allowFrom，空数组会拒绝所有消息。' -ForegroundColor White
Write-Host ''
Write-Host '  开机自启：右键托盘图标 → 勾选「开机自启」。' -ForegroundColor White
Write-Host ''
Write-Host '  托盘颜色：绿 = 全部就绪，黄 = 桥接没起来，红 = NapCat 没运行。' -ForegroundColor DarkGray
Write-Host ''

