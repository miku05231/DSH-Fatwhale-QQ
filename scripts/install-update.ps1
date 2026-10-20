# Run only from state\updates\<jobId>; the running installer never overwrites itself.
param(
    [Parameter(Mandatory = $true)][string]$JobPath,
    [switch]$SkipProcessActions,
    [switch]$SkipRestart,
    [int]$TestFailAfterFiles = -1
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$script:ResultPath = ''
$script:ProjectRoot = ''
$script:Job = $null
$script:RestartNeeded = $false
$script:Applied = New-Object 'System.Collections.Generic.List[object]'
$script:Backups = New-Object 'System.Collections.Generic.List[object]'
$script:ZipStream = $null
$script:Archive = $null
$script:Mutex = $null
$script:OwnsMutex = $false
$script:StartedBootstrap = $null
$script:RestartAttempted = $false
$script:VersionPattern = '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-FullLocalPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]') {
        throw 'Updates require an absolute local drive path.'
    }
    if ($Value -match '[\x00-\x1f"*?<>|]' -or $Value.Substring(2).Contains(':')) {
        throw 'Invalid characters in update path.'
    }
    return [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
}

function Test-SamePath([string]$Left, [string]$Right) {
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function Test-Within([string]$Path, [string]$Directory) {
    return (Test-SamePath $Path $Directory) -or
        $Path.StartsWith($Directory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparse([string]$Path) {
    $probe = Get-FullLocalPath $Path
    while ($probe) {
        $item = Get-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw ('Update path traverses a symbolic link or junction: ' + $probe)
        }
        $parent = [IO.Path]::GetDirectoryName($probe)
        if (-not $parent -or (Test-SamePath $parent $probe)) { break }
        $probe = $parent
    }
}

function Assert-NotGitCheckout([string]$Root) {
    $probe = $Root
    while ($probe) {
        if ($null -ne (Get-Item -LiteralPath (Join-Path $probe '.git') -Force -ErrorAction SilentlyContinue)) {
            throw 'Git checkouts must be updated with git pull, not the portable installer.'
        }
        $parent = [IO.Path]::GetDirectoryName($probe)
        if (-not $parent -or (Test-SamePath $parent $probe)) { break }
        $probe = $parent
    }
}

function Read-JsonFile([string]$Path, [long]$MaxBytes = 4194304) {
    Assert-NoReparse $Path
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or $item.Length -gt $MaxBytes) { throw 'Invalid JSON file size or type.' }
    return ([IO.File]::ReadAllText($Path, $script:Utf8).TrimStart([char]0xfeff) | ConvertFrom-Json)
}

function Get-Field($Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    $current = $Value
    foreach ($part in $Name.Split('.')) {
        if ($null -eq $current -or $null -eq $current.PSObject.Properties[$part]) { return $null }
        $current = $current.PSObject.Properties[$part].Value
    }
    return $current
}

function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-Semver([string]$Value) {
    $match = [regex]::Match($Value, '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
    if (-not $match.Success) { throw 'Application versions must use semantic versioning.' }
    $pre = @()
    if ($match.Groups[4].Success) { $pre = @($match.Groups[4].Value.Split('.')) }
    foreach ($part in $pre) {
        if ($part -match '^0\d+$') { throw 'Numeric prerelease identifiers cannot have leading zeroes.' }
    }
    return [pscustomobject]@{
        Core = @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value)
        Pre = $pre
    }
}

function Compare-NumericPart([string]$Left, [string]$Right) {
    if ($Left.Length -ne $Right.Length) { return $Left.Length.CompareTo($Right.Length) }
    return [string]::CompareOrdinal($Left, $Right)
}

function Compare-Semver([string]$Left, [string]$Right) {
    $a = Get-Semver $Left
    $b = Get-Semver $Right
    for ($index = 0; $index -lt 3; $index++) {
        $difference = Compare-NumericPart $a.Core[$index] $b.Core[$index]
        if ($difference -ne 0) { return $difference }
    }
    if ($a.Pre.Count -eq 0 -and $b.Pre.Count -gt 0) { return 1 }
    if ($b.Pre.Count -eq 0 -and $a.Pre.Count -gt 0) { return -1 }
    for ($index = 0; $index -lt [Math]::Min($a.Pre.Count, $b.Pre.Count); $index++) {
        $leftNumber = $a.Pre[$index] -match '^\d+$'
        $rightNumber = $b.Pre[$index] -match '^\d+$'
        if ($leftNumber -and $rightNumber) { $difference = Compare-NumericPart $a.Pre[$index] $b.Pre[$index] }
        elseif ($leftNumber -and -not $rightNumber) { $difference = -1 }
        elseif ($rightNumber -and -not $leftNumber) { $difference = 1 }
        else { $difference = [string]::CompareOrdinal($a.Pre[$index], $b.Pre[$index]) }
        if ($difference -ne 0) { return $difference }
    }
    return $a.Pre.Count.CompareTo($b.Pre.Count)
}

function Write-Result([string]$Phase, [string]$Message) {
    if (-not $script:ResultPath) { return }
    Assert-NoReparse $script:ResultPath
    $at = [DateTime]::UtcNow.ToString('o')
    $result = [ordered]@{
        schemaVersion = 1
        jobId = [string]$script:Job.jobId
        version = [string]$script:Job.version
        phase = $Phase
        message = $Message
        at = $at
        completedAt = $at
    }
    if ($Phase -eq 'error') { $result.error = $Message }
    $temporary = $script:ResultPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($result | ConvertTo-Json -Depth 4), $script:Utf8)
        Assert-NoReparse $script:ResultPath
        if ([IO.File]::Exists($script:ResultPath)) {
            [IO.File]::Replace($temporary, $script:ResultPath, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $script:ResultPath)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Clear-JobLock {
    if (-not $script:ResultPath) { return }
    $lock = Join-Path $script:ProjectRoot 'state\updates\install.lock'
    Assert-NoReparse $lock
    if (-not [IO.File]::Exists($lock)) { return }
    $record = Read-JsonFile $lock 65536
    if ([string](Get-Field $record 'jobId') -ceq [string]$script:Job.jobId) {
        [IO.File]::Delete($lock)
    }
}

function Resolve-DataPath([string]$Value) {
    $expanded = $Value.Trim()
    if ($expanded -eq '~') { $expanded = $env:USERPROFILE }
    elseif ($expanded -match '^~[\\/]') { $expanded = Join-Path $env:USERPROFILE $expanded.Substring(2) }
    $expanded = [Environment]::ExpandEnvironmentVariables($expanded)
    $expanded = [regex]::Replace($expanded, '\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)', {
        param($match)
        $name = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -eq $value) { return $match.Value }
        return $value
    })
    if ($expanded -match '%[A-Za-z_][A-Za-z0-9_]*%|\$(?:\{|[A-Za-z_])') {
        throw 'A configured data path contains an unresolved environment variable.'
    }
    if (-not [IO.Path]::IsPathRooted($expanded)) { $expanded = Join-Path $script:ProjectRoot $expanded }
    return [IO.Path]::GetFullPath($expanded).TrimEnd('\', '/')
}

function Get-ProtectedPaths {
    $paths = New-Object 'System.Collections.Generic.List[string]'
    foreach ($relative in @('config.json', 'state', 'logs', 'data', 'memory', 'qq-workspace', 'napcat', '.dsh', '记忆库')) {
        $paths.Add((Join-Path $script:ProjectRoot $relative))
    }
    $configPath = Join-Path $script:ProjectRoot 'config.json'
    if ([IO.File]::Exists($configPath)) {
        $config = Read-JsonFile $configPath
        foreach ($field in @('stateDir', 'logDir', 'memory.root', 'persona.path', 'persona.dir', 'stickers.root', 'dsh.cwd', 'dsh.patchPath', 'plugins.dir')) {
            $raw = Get-Field $config $field
            if ($null -eq $raw -or [string]::IsNullOrWhiteSpace([string]$raw)) { continue }
            if ($raw -isnot [string]) { throw ('Invalid configured data path: ' + $field) }
            $resolved = Resolve-DataPath $raw
            # The default workspace is the application root; only its AGENTS.md is user data.
            if ($field -eq 'dsh.cwd' -and (Test-SamePath $resolved $script:ProjectRoot)) {
                $paths.Add((Join-Path $resolved 'AGENTS.md'))
                continue
            }
            if ($field -eq 'plugins.dir' -and (Test-SamePath $resolved (Join-Path $script:ProjectRoot 'src\plugins'))) {
                continue
            }
            if ($field -eq 'dsh.patchPath' -and (Test-SamePath $resolved (Join-Path $script:ProjectRoot 'patches\headless-model.yml'))) {
                continue
            }
            $paths.Add($resolved)
        }
    }
    return ,$paths
}

function Assert-ManagedName([string]$Relative, [bool]$IsDirectory) {
    $parts = $Relative.Split('/')
    foreach ($part in $parts) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or
            $part -match '[\x00-\x1f\\:*?"<>|]' -or $part -match '[. ]$' -or
            $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)') {
            throw ('Unsafe archive path: ' + $Relative)
        }
        if ($part -match '^(?i:config\.json|state|logs|data|memory|qq-workspace|napcat|node_modules|\.git|\.dsh)$' -or
            $part -match '(?i)\.local\.ya?ml$') {
            throw ('Archive contains local data: ' + $Relative)
        }
    }
    $directories = @('src', 'launcher', 'tools', 'scripts', 'assets', 'docs', 'docker', 'patches', 'tests')
    $rootFiles = @(
        'package.json', 'README.md', 'LICENSE', 'config.example.json', 'deepseek-waitou.png',
        'qq-bridge.exe', 'qq-bridge.cmd', '一键启动.cmd', 'start-tray.cmd', 'setup.cmd',
        'install-napcat.cmd', '初始化配置.cmd', 'start.sh', 'Dockerfile', 'docker-compose.yml',
        '.dockerignore', '.env.example', '打包信息.json', '快速开始.txt'
    )
    if ($directories -contains $parts[0] -and ($parts.Length -gt 1 -or $IsDirectory)) { return }
    if (-not $IsDirectory -and $parts.Length -eq 1 -and $rootFiles -contains $parts[0]) { return }
    throw ('Archive contains an unmanaged path: ' + $Relative)
}

function Get-TargetPath([string]$Relative) {
    $target = Get-FullLocalPath (Join-Path $script:ProjectRoot $Relative.Replace('/', '\'))
    if (-not (Test-Within $target $script:ProjectRoot) -or (Test-SamePath $target $script:ProjectRoot)) {
        throw 'Archive destination escaped the application directory.'
    }
    Assert-NoReparse $target
    return $target
}

function Test-ProcessScript($Process, [string]$ScriptPath, [string[]]$Names) {
    if ($null -eq $Process -or $Names -notcontains [string]$Process.Name) { return $false }
    $line = ([string]$Process.CommandLine).Replace('/', '\')
    $pattern = '(?i)(?:^|[\s"])' + [regex]::Escape($ScriptPath) + '(?=$|[\s"])'
    return [regex]::IsMatch($line, $pattern)
}

function Get-AppProcesses {
    $matches = New-Object 'System.Collections.Generic.List[object]'
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'")
    $bridge = Join-Path $script:ProjectRoot 'src\index.js'
    $console = Join-Path $script:ProjectRoot 'src\webui\server.mjs'
    $tray = Join-Path $script:ProjectRoot 'launcher\Launcher.ps1'
    $bootstrap = Join-Path $script:ProjectRoot 'launcher\bootstrap.ps1'
    foreach ($process in $processes) {
        $kind = ''
        $scriptPath = ''
        $names = @('node.exe')
        if (Test-ProcessScript $process $bridge $names) { $kind = 'bridge'; $scriptPath = $bridge }
        elseif (Test-ProcessScript $process $console $names) { $kind = 'console'; $scriptPath = $console }
        elseif (Test-ProcessScript $process $tray @('powershell.exe', 'pwsh.exe')) {
            $kind = 'tray'; $scriptPath = $tray; $names = @('powershell.exe', 'pwsh.exe')
        } elseif (Test-ProcessScript $process $bootstrap @('powershell.exe', 'pwsh.exe')) {
            throw 'The application is still starting; wait for startup before updating.'
        }
        if ($kind) {
            $matches.Add([pscustomobject]@{ Process = $process; Kind = $kind; Script = $scriptPath; Names = $names })
        }
    }
    $consoleId = [int]$script:Job.consolePid
    if ($consoleId -gt 0) {
        $owner = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $consoleId)
        if ($null -ne $owner -and -not (Test-ProcessScript $owner $console @('node.exe'))) {
            throw 'Cannot verify the console process belongs to this installation; update manually.'
        }
    }
    return ,$matches
}

function Stop-AppProcesses {
    $processes = Get-AppProcesses
    foreach ($candidate in @($processes | Sort-Object @{ Expression = {
        switch ($_.Kind) { 'tray' { 0 }; 'bridge' { 1 }; default { 2 } }
    } })) {
        $processId = [int]$candidate.Process.ProcessId
        if ($processId -eq $PID) { throw 'The installer cannot stop itself.' }
        $live = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $processId)
        if ($null -eq $live) { continue }
        if (-not (Test-ProcessScript $live $candidate.Script $candidate.Names) -or
            $live.CreationDate -ne $candidate.Process.CreationDate) {
            throw 'An application process changed during update; no unrelated process was stopped.'
        }
        $script:RestartNeeded = $true
        Stop-Process -Id $processId -Force
        $remaining = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -ne $remaining -and -not $remaining.WaitForExit(8000)) { throw 'Application process did not stop.' }
    }
    if ((Get-AppProcesses).Count -gt 0) { throw 'Application processes are still running.' }
}

function Test-ConsoleVersion([string]$ExpectedVersion) {
    $portFile = Join-Path $script:ProjectRoot 'state\webui-port.txt'
    Assert-NoReparse $portFile
    if (-not [IO.File]::Exists($portFile)) { return $false }
    if ((Get-Item -LiteralPath $portFile).Length -gt 64) { return $false }
    $portText = [IO.File]::ReadAllText($portFile, $script:Utf8).TrimStart([char]0xfeff).Trim()
    $port = 0
    if ($portText -notmatch '^\d{1,5}$' -or -not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        return $false
    }
    try {
        $request = [Net.HttpWebRequest]::Create(('http://127.0.0.1:' + $port + '/api/updates'))
        $request.Timeout = 1000
        $request.ReadWriteTimeout = 1000
        $request.Proxy = $null
        $response = $request.GetResponse()
        try {
            $reader = New-Object IO.StreamReader($response.GetResponseStream(), $script:Utf8)
            try {
                $text = New-Object Text.StringBuilder
                $buffer = New-Object char[] 4096
                while (($read = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    if ($text.Length + $read -gt 262144) { throw 'The restarted console returned an excessive status response.' }
                    [void]$text.Append($buffer, 0, $read)
                }
                $body = $text.ToString() | ConvertFrom-Json
            }
            finally { $reader.Dispose() }
        } finally { $response.Dispose() }
        return [string](Get-Field $body 'data.currentVersion') -ceq $ExpectedVersion
    } catch { return $false }
}

function Restart-App {
    param([switch]$VerifyVersion)
    if ($SkipRestart) { return }
    $bootstrap = Join-Path $script:ProjectRoot 'launcher\bootstrap.ps1'
    Assert-NoReparse $bootstrap
    if (-not [IO.File]::Exists($bootstrap)) { throw 'Cannot find the application bootstrap.' }
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $bootstrap + '"'
    $script:RestartAttempted = $true
    $script:StartedBootstrap = Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $script:ProjectRoot -WindowStyle Hidden -PassThru
    $null = $script:StartedBootstrap.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not $script:StartedBootstrap.WaitForExit(250)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Application bootstrap timed out during restart.' }
    }
    if ($script:StartedBootstrap.ExitCode -ne 0) {
        throw ('Application bootstrap failed with exit code ' + $script:StartedBootstrap.ExitCode + '.')
    }
    $script:StartedBootstrap = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ($true) {
        $running = Get-AppProcesses
        $hasBridge = @($running | Where-Object { $_.Kind -eq 'bridge' }).Count -gt 0
        $hasConsole = @($running | Where-Object { $_.Kind -eq 'console' }).Count -gt 0
        if ($hasBridge -and $hasConsole) {
            if (-not $VerifyVersion -or (Test-ConsoleVersion ([string]$script:Job.version))) { return }
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw 'Application bootstrap exited but its bridge or console version did not recover.'
        }
        Start-Sleep -Milliseconds 250
    }
}

function Stop-StartedBootstrap {
    if ($null -eq $script:StartedBootstrap) { return }
    try {
        if (-not $script:StartedBootstrap.HasExited) {
            $processId = $script:StartedBootstrap.Id
            $live = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $processId)
            $bootstrap = Join-Path $script:ProjectRoot 'launcher\bootstrap.ps1'
            if (-not (Test-ProcessScript $live $bootstrap @('powershell.exe', 'pwsh.exe'))) {
                throw 'Cannot verify the bootstrap process created for restart.'
            }
            $script:StartedBootstrap.Kill()
            if (-not $script:StartedBootstrap.WaitForExit(8000)) { throw 'The bootstrap process could not be stopped.' }
        }
    } finally { $script:StartedBootstrap = $null }
}

function Copy-Atomic([string]$Source, [string]$Target) {
    Assert-NoReparse $Source
    Assert-NoReparse $Target
    $parent = [IO.Path]::GetDirectoryName($Target)
    [void][IO.Directory]::CreateDirectory($parent)
    Assert-NoReparse $parent
    $temporary = $Target + '.update-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::Copy($Source, $temporary, $false)
        Assert-NoReparse $Target
        if ([IO.File]::Exists($Target)) { [IO.File]::Replace($temporary, $Target, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Target) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Undo-Overlay {
    $errors = New-Object 'System.Collections.Generic.List[string]'
    for ($index = $script:Applied.Count - 1; $index -ge 0; $index--) {
        $item = $script:Applied[$index]
        try {
            $target = Get-TargetPath $item.Relative
            if ($item.Existed) { Copy-Atomic $item.Backup $target }
            elseif ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }
        } catch { $errors.Add([string]$_.Exception.Message) }
    }
    if ($errors.Count -gt 0) { throw ('Rollback needs manual recovery from the backup: ' + ($errors -join '; ')) }
}

try {
    if ($TestFailAfterFiles -ge 0 -and -not ($SkipProcessActions -and $SkipRestart)) {
        throw 'The failure injection hook requires both isolated-test switches.'
    }
    $jobFile = Get-FullLocalPath $JobPath
    Assert-NoReparse $jobFile
    $script:Job = Read-JsonFile $jobFile 65536
    if ((Get-Field $script:Job 'schemaVersion') -ne 1) { throw 'Unsupported update job schema.' }
    $jobId = [string](Get-Field $script:Job 'jobId')
    $version = [string](Get-Field $script:Job 'version')
    if ($jobId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$' -or $version -notmatch $script:VersionPattern) {
        throw 'Invalid update job identifier or version.'
    }
    $script:ProjectRoot = Get-FullLocalPath ([string](Get-Field $script:Job 'projectRoot'))
    if ($script:ProjectRoot.Length -le 3 -or -not [IO.Directory]::Exists($script:ProjectRoot)) {
        throw 'Invalid application directory.'
    }
    Assert-NoReparse $script:ProjectRoot
    Assert-NotGitCheckout $script:ProjectRoot
    $updates = Join-Path $script:ProjectRoot 'state\updates'
    $jobDirectory = Join-Path $updates $jobId
    $expectedJob = Join-Path $jobDirectory 'job.json'
    $expectedScript = Join-Path $jobDirectory 'install-update.ps1'
    $package = Get-FullLocalPath ([string](Get-Field $script:Job 'packagePath'))
    $result = Get-FullLocalPath ([string](Get-Field $script:Job 'resultPath'))
    if (-not (Test-SamePath $jobFile $expectedJob) -or -not (Test-SamePath $PSCommandPath $expectedScript) -or
        -not (Test-SamePath ([IO.Path]::GetDirectoryName($package)) $jobDirectory) -or
        [IO.Path]::GetExtension($package) -ne '.zip' -or
        -not (Test-SamePath $result (Join-Path $updates 'result.json'))) {
        throw 'Update job, installer, package and result must use the expected state directory.'
    }
    foreach ($path in @($updates, $jobDirectory, $package, $result, $expectedScript)) { Assert-NoReparse $path }
    $rootHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $rootHash = [BitConverter]::ToString($rootHasher.ComputeHash($script:Utf8.GetBytes($script:ProjectRoot.ToLowerInvariant()))).Replace('-', '')
    } finally { $rootHasher.Dispose() }
    $script:Mutex = New-Object Threading.Mutex($false, ('Local\QQBridgeUpdater-' + $rootHash))
    try { $script:OwnsMutex = $script:Mutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $script:OwnsMutex = $true }
    if (-not $script:OwnsMutex) { throw 'Another updater is already installing this application.' }
    $script:ResultPath = $result
    $installLock = Join-Path $updates 'install.lock'
    Assert-NoReparse $installLock
    if ([IO.File]::Exists($installLock)) {
        $lockRecord = Read-JsonFile $installLock 65536
        if ([string](Get-Field $lockRecord 'jobId') -cne $jobId) {
            throw 'The update download lock belongs to a different job.'
        }
    }
    foreach ($relative in @('package.json', 'qq-bridge.exe', 'launcher\bootstrap.ps1', 'launcher\Launcher.ps1', 'src\index.js', 'src\webui\server.mjs')) {
        $marker = Join-Path $script:ProjectRoot $relative
        Assert-NoReparse $marker
        if (-not [IO.File]::Exists($marker)) { throw ('This is not a complete portable installation: ' + $relative) }
    }
    $installedPackage = Read-JsonFile (Join-Path $script:ProjectRoot 'package.json')
    if ([string](Get-Field $installedPackage 'name') -ne 'qq-bridge') { throw 'Application package name does not match.' }
    if ((Compare-Semver $version ([string](Get-Field $installedPackage 'version'))) -le 0) {
        throw 'The requested update must be newer than the installed application.'
    }
    $consoleNumber = 0
    if (-not [int]::TryParse([string](Get-Field $script:Job 'consolePid'), [ref]$consoleNumber) -or $consoleNumber -lt 0) {
        throw 'Invalid console process identifier.'
    }
    $protected = Get-ProtectedPaths
    $expectedHash = [string](Get-Field $script:Job 'expectedSha256')
    if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid SHA256 digest.' }
    $zipItem = Get-Item -LiteralPath $package -Force
    if ($zipItem.PSIsContainer -or $zipItem.Length -le 0 -or $zipItem.Length -gt 262144000) {
        throw 'Portable ZIP exceeds the 250 MB download limit.'
    }
    $script:ZipStream = [IO.File]::Open($package, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($script:ZipStream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    if ($actualHash -ne $expectedHash.ToLowerInvariant()) { throw 'Portable ZIP SHA256 verification failed.' }
    $script:ZipStream.Position = 0
    Add-Type -AssemblyName System.IO.Compression
    $script:Archive = New-Object IO.Compression.ZipArchive($script:ZipStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    if ($script:Archive.Entries.Count -gt 15000) { throw 'Portable ZIP has too many entries.' }
    $files = New-Object 'System.Collections.Generic.List[object]'
    $names = New-Object 'System.Collections.Generic.Dictionary[string,bool]' ([StringComparer]::OrdinalIgnoreCase)
    $archiveRoot = 'qq-bridge-' + $version
    $total = [long]0
    foreach ($entry in $script:Archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        $isDirectory = $name.EndsWith('/')
        if ($isDirectory) { $name = $name.Substring(0, $name.Length - 1) }
        $segments = $name.Split('/')
        if ($segments.Length -eq 1 -and $name -ceq $archiveRoot -and $isDirectory) { continue }
        if ($segments.Length -lt 2 -or $segments[0] -cne $archiveRoot) { throw 'Portable ZIP must contain exactly one versioned application root.' }
        $relative = $name.Substring($archiveRoot.Length + 1)
        Assert-ManagedName $relative $isDirectory
        $unixType = (($entry.ExternalAttributes -shr 16) -band 0xf000)
        if (($entry.ExternalAttributes -band 0x400) -ne 0 -or
            ($unixType -ne 0 -and $unixType -ne 0x8000 -and $unixType -ne 0x4000) -or
            ($unixType -eq 0x4000 -and -not $isDirectory) -or ($unixType -eq 0x8000 -and $isDirectory)) {
            throw ('Portable ZIP contains a link or special file: ' + $relative)
        }
        if ($names.ContainsKey($relative)) { throw ('Duplicate portable ZIP path: ' + $relative) }
        $names.Add($relative, $isDirectory)
        if ($entry.Length -gt 134217728 -or $entry.Length -lt 0 -or
            ($entry.Length -gt 1048576 -and $entry.Length -gt ([Math]::Max(1, $entry.CompressedLength) * 250))) {
            throw 'Portable ZIP has an excessive entry size or compression ratio.'
        }
        $total += $entry.Length
        if ($total -gt 1073741824) { throw 'Portable ZIP expands beyond the 1 GB limit.' }
        $target = Get-TargetPath $relative
        foreach ($dataPath in $protected) {
            if ((Test-Within $target $dataPath) -or (Test-Within $dataPath $target)) {
                throw ('Update conflicts with a configured data path: ' + $relative)
            }
        }
        if ($isDirectory) {
            if ([IO.File]::Exists($target)) { throw ('Archive directory conflicts with a local file: ' + $relative) }
        } else {
            if ([IO.Directory]::Exists($target)) { throw ('Archive file conflicts with a local directory: ' + $relative) }
            $files.Add([pscustomobject]@{ Entry = $entry; Relative = $relative; Target = $target })
        }
    }
    foreach ($key in $names.Keys) {
        $parent = $key
        while ($parent.Contains('/')) {
            $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
            if ($names.ContainsKey($parent) -and -not $names[$parent]) { throw 'Portable ZIP has a file/directory collision.' }
        }
    }
    foreach ($required in @('package.json', 'qq-bridge.exe', 'launcher/bootstrap.ps1', 'launcher/Launcher.ps1', 'src/index.js', 'src/webui/server.mjs')) {
        if (-not $names.ContainsKey($required) -or $names[$required]) { throw ('Portable ZIP is incomplete: ' + $required) }
    }
    $staging = Join-Path $jobDirectory 'staging'
    $backup = Join-Path $jobDirectory 'backup'
    foreach ($directory in @($staging, $backup)) {
        Assert-NoReparse $directory
        if (Test-Path -LiteralPath $directory) { throw 'This update job has already been staged; create a new job to retry.' }
        [void][IO.Directory]::CreateDirectory($directory)
    }
    # Extract only individually validated files, never ZipFile.ExtractToDirectory.
    foreach ($file in $files) {
        $source = Join-Path $staging $file.Relative.Replace('/', '\')
        Assert-NoReparse $source
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($source))
        $inputStream = $file.Entry.Open()
        $outputStream = [IO.File]::Open($source, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try {
            $buffer = New-Object byte[] 65536
            $written = [long]0
            while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $written += $read
                if ($written -gt $file.Entry.Length) { throw 'ZIP entry expanded beyond its declared size.' }
                $outputStream.Write($buffer, 0, $read)
            }
            if ($written -ne $file.Entry.Length) { throw 'ZIP entry length does not match its metadata.' }
        } finally { $inputStream.Dispose(); $outputStream.Dispose() }
        $file | Add-Member -NotePropertyName Source -NotePropertyValue $source
    }
    $newPackage = Read-JsonFile (Join-Path $staging 'package.json')
    if ([string](Get-Field $newPackage 'name') -ne 'qq-bridge' -or [string](Get-Field $newPackage 'version') -cne $version) {
        throw 'Portable ZIP package.json does not match the requested application version.'
    }
    foreach ($file in $files) {
        $target = Get-TargetPath $file.Relative
        $backupPath = Join-Path $backup $file.Relative.Replace('/', '\')
        $existed = [IO.File]::Exists($target)
        if ($existed) {
            Assert-NoReparse $backupPath
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backupPath))
            [IO.File]::Copy($target, $backupPath, $false)
            if ((Get-FileSha256 $target) -ne (Get-FileSha256 $backupPath)) { throw 'Backup verification failed.' }
        }
        $script:Backups.Add([pscustomobject]@{ Relative = $file.Relative; Existed = $existed; Backup = $backupPath })
    }
    $manifest = Join-Path $jobDirectory 'backup-manifest.json'
    Assert-NoReparse $manifest
    if (Test-Path -LiteralPath $manifest) { throw 'Backup manifest already exists.' }
    [IO.File]::WriteAllText($manifest, ($script:Backups.ToArray() | ConvertTo-Json -Depth 4), $script:Utf8)
    if (-not $SkipProcessActions) { Stop-AppProcesses }
    $completed = 0
    foreach ($file in $files) {
        if ($TestFailAfterFiles -eq $completed) { throw 'Isolated test: injected overlay failure.' }
        $item = $script:Backups[$completed]
        Copy-Atomic $file.Source (Get-TargetPath $file.Relative)
        $script:Applied.Add($item)
        $completed++
    }
    Restart-App -VerifyVersion
    Write-Result 'complete' 'Update installed. Local configuration, personas and memory were preserved.'
    try { Clear-JobLock } catch { }
    exit 0
} catch {
    $message = [string]$_.Exception.Message + ' (installer line ' + $_.InvocationInfo.ScriptLineNumber + ')'
    $canRestart = $script:Applied.Count -eq 0
    if ($script:Applied.Count -gt 0) {
        try {
            if ($script:RestartAttempted) { Stop-StartedBootstrap; Stop-AppProcesses }
            Undo-Overlay
            $message += ' Previous application files were restored.'
            $canRestart = $true
        }
        catch { $message += ' ' + [string]$_.Exception.Message }
    }
    if ($canRestart -and ($script:RestartNeeded -or $script:RestartAttempted)) {
        try { Restart-App } catch {
            $message += ' Restart failed; start the application manually.'
            try { Stop-StartedBootstrap } catch { }
        }
    }
    try {
        Write-Result 'error' $message
        try { Clear-JobLock } catch { }
    } catch { $message += ' Could not write update result.' }
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($null -ne $script:Archive) { $script:Archive.Dispose() }
    if ($null -ne $script:ZipStream) { $script:ZipStream.Dispose() }
    if ($null -ne $script:Mutex) {
        if ($script:OwnsMutex) { try { $script:Mutex.ReleaseMutex() } catch { } }
        $script:Mutex.Dispose()
    }
}
