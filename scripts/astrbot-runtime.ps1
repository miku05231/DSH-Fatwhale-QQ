[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$StateRoot,

    [Parameter(Mandatory = $true)]
    [string]$LockPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-PythonChecked {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    & $PythonExe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function Assert-PythonBase {
    param([Parameter(Mandatory = $true)][string]$PythonExe)

    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
        throw 'The portable Python interpreter was not extracted.'
    }

    & $PythonExe -I -c "import importlib.metadata as m, sys, venv, ensurepip; assert sys.version_info[:3] == (3, 12, 10); assert m.version('pip')"
    if ($LASTEXITCODE -ne 0) {
        throw 'The portable Python distribution validation failed.'
    }
}

function Assert-PythonVenv {
    param([Parameter(Mandatory = $true)][string]$PythonExe)

    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
        throw 'The managed AstrBot venv interpreter is missing.'
    }

    & $PythonExe -I -c "import importlib.metadata as m, sys; assert sys.version_info[:3] == (3, 12, 10); assert sys.prefix != sys.base_prefix; assert m.version('AstrBot') == '4.29.3'; assert m.version('APScheduler') == '3.11.3'; import aiohttp"
    if ($LASTEXITCODE -ne 0) {
        throw 'The managed AstrBot venv validation failed.'
    }
}

function Remove-PrivateStage {
    param(
        [Parameter(Mandatory = $true)][string]$StagePath,
        [Parameter(Mandatory = $true)][string]$RuntimeRoot
    )

    if (-not [IO.Directory]::Exists($StagePath)) {
        return
    }

    $stageFull = [IO.Path]::GetFullPath($StagePath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $runtimeFull = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $runtimePrefix = $runtimeFull + [IO.Path]::DirectorySeparatorChar
    if (-not $stageFull.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove a stage outside the AstrBot runtime directory.'
    }

    $item = Get-Item -LiteralPath $stageFull -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing to remove a reparse point from the AstrBot runtime directory.'
    }
    [IO.Directory]::Delete($stageFull, $true)
}

if ($Action -ne 'Install') {
    throw 'Unsupported AstrBot runtime action.'
}

$lockFullPath = [IO.Path]::GetFullPath($LockPath)
$stateFullPath = [IO.Path]::GetFullPath($StateRoot)
$lock = Get-Content -LiteralPath $lockFullPath -Raw | ConvertFrom-Json

if ($lock.schemaVersion -ne 1 -or
    $lock.python.version -ne '3.12.10' -or
    $lock.python.architecture -ne 'x86_64-pc-windows-msvc') {
    throw 'The AstrBot runtime lock is missing or unsupported.'
}
if ($lock.astrbot.version -ne '4.29.3' -or
    $lock.astrbot.source -ne 'https://codeload.github.com/AstrBotDevs/AstrBot/zip/refs/tags/v4.29.3' -or
    $lock.astrbot.sha256 -ne '4f7187273a3fa3e9bea327e1338dcff7567af5ab095c4847da12452ad22d8508' -or
    $lock.astrbot.releaseCommit -ne 'f61a7f4') {
    throw 'The AstrBot source pin is missing or invalid.'
}

$expectedArchiveUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/20250529/cpython-3.12.10%2B20250529-x86_64-pc-windows-msvc-install_only.tar.gz'
$expectedArchiveHash = '3e0fd10e4bd60e66baad8be2a0e60775bb389e97e4f4a07138c34599c356aaed'
$expectedAstrbotRequirement = 'astrbot @ ' + $lock.astrbot.source + '#sha256=' + $lock.astrbot.sha256
$requirements = [string[]]@($lock.python.packages)
if ($lock.python.archive.url -ne $expectedArchiveUrl -or
    $lock.python.archive.sha256 -ne $expectedArchiveHash -or
    $lock.python.archive.fileName -ne 'cpython-3.12.10+20250529-x86_64-pc-windows-msvc-install_only.tar.gz' -or
    $lock.python.baseExecutable -ne 'runtime/python/python.exe' -or
    $lock.python.managedExecutable -ne 'runtime/venv/Scripts/python.exe' -or
    $requirements.Count -ne 3 -or
    $requirements[0] -ne $expectedAstrbotRequirement -or
    $requirements[1] -ne 'aiohttp>=3.11.18,<4' -or
    $requirements[2] -ne 'APScheduler==3.11.3') {
    throw 'The Python runtime lock contains an unsupported archive, path, or package requirement.'
}

$runtimeRoot = Join-Path $stateFullPath 'runtime'
$pythonRoot = Join-Path $runtimeRoot 'python'
$pythonExe = Join-Path $pythonRoot 'python.exe'
$venvRoot = Join-Path $runtimeRoot 'venv'
$venvExe = Join-Path $venvRoot 'Scripts\python.exe'
$inventoryPath = Join-Path $runtimeRoot 'dependency-inventory.json'
$adapterRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\runtime\astrbot'))
[void][IO.Directory]::CreateDirectory($runtimeRoot)

if ([IO.Directory]::Exists($pythonRoot)) {
    $pythonItem = Get-Item -LiteralPath $pythonRoot -Force
    if (($pythonItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The portable Python path must not be a reparse point.'
    }
    Assert-PythonBase -PythonExe $pythonExe
}
else {
    $stageRoot = Join-Path $runtimeRoot ('.python-staging-' + [Guid]::NewGuid().ToString('N'))
    $stagePythonRoot = Join-Path $stageRoot 'python'
    $archivePath = Join-Path $stageRoot $lock.python.archive.fileName
    [void][IO.Directory]::CreateDirectory($stageRoot)

    try {
        Invoke-WebRequest -Uri $expectedArchiveUrl -OutFile $archivePath -TimeoutSec 900 -UseBasicParsing
        $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($archiveHash -ne $expectedArchiveHash) {
            throw 'The standalone Python archive SHA-256 does not match the runtime lock.'
        }

        $tar = Get-Command -Name 'tar.exe' -CommandType Application -ErrorAction Stop
        & $tar.Source -xzf $archivePath -C $stageRoot
        if ($LASTEXITCODE -ne 0) {
            throw 'The standalone Python archive could not be extracted.'
        }

        $stagedPythonExe = Join-Path $stagePythonRoot 'python.exe'
        Assert-PythonBase -PythonExe $stagedPythonExe
        if ([IO.Directory]::Exists($pythonRoot)) {
            throw 'The AstrBot portable Python target appeared during setup; refusing to replace it.'
        }
        [IO.Directory]::Move($stagePythonRoot, $pythonRoot)
        Assert-PythonBase -PythonExe $pythonExe
    }
    finally {
        Remove-PrivateStage -StagePath $stageRoot -RuntimeRoot $runtimeRoot
    }
}

if ([IO.Directory]::Exists($venvRoot)) {
    $venvItem = Get-Item -LiteralPath $venvRoot -Force
    if (($venvItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The managed AstrBot venv path must not be a reparse point.'
    }
    Assert-PythonVenv -PythonExe $venvExe
}
$venvCreatedByThisRun = $false
$previousPythonPath = $env:PYTHONPATH
try {
    if (-not [IO.Directory]::Exists($venvRoot)) {
        $venvCreatedByThisRun = $true
        Invoke-PythonChecked -PythonExe $pythonExe -Arguments @('-I', '-m', 'venv', '--copies', $venvRoot) -FailureMessage 'The private AstrBot venv could not be created.'
        $installArguments = @(
            '-I', '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
            '--no-cache-dir', '--no-warn-script-location'
        ) + $requirements
        Invoke-PythonChecked -PythonExe $venvExe -Arguments $installArguments -FailureMessage 'AstrBot runtime dependency installation failed.'
        Invoke-PythonChecked -PythonExe $venvExe -Arguments @('-I', '-m', 'pip', 'check') -FailureMessage 'AstrBot runtime dependency validation failed.'
        Assert-PythonVenv -PythonExe $venvExe
    }

    $env:PYTHONPATH = $adapterRoot
    Invoke-PythonChecked -PythonExe $venvExe -Arguments @(
        '-m', 'qq_astrbot.inventory', '--output', $inventoryPath
    ) -FailureMessage 'The AstrBot dependency inventory could not be written.'
}
catch {
    if ($venvCreatedByThisRun -and [IO.Directory]::Exists($venvRoot)) {
        Remove-PrivateStage -StagePath $venvRoot -RuntimeRoot $runtimeRoot
    }
    throw
}
finally {
    if ($null -eq $previousPythonPath) {
        Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    }
    else {
        $env:PYTHONPATH = $previousPythonPath
    }
}
