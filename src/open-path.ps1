param(
    [Parameter(Mandatory = $true)]
    [string]$Target,
    [switch]$SelectFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class QQBridgeFolderWindow {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetLongPathName(string path, StringBuilder result, uint capacity);
}
'@

    function Get-ComparablePath([string]$Value) {
        $full = [IO.Path]::GetFullPath($Value)
        $buffer = New-Object Text.StringBuilder 32768
        $length = [QQBridgeFolderWindow]::GetLongPathName($full, $buffer, $buffer.Capacity)
        if ($length -gt 0 -and $length -lt $buffer.Capacity) {
            $full = $buffer.ToString()
        }
        return $full.TrimEnd([char[]]@('\', '/'))
    }

    function Find-TargetWindow($Shell, [string]$ExpectedPath) {
        $hidden = $null
        foreach ($candidate in @($Shell.Windows())) {
            try {
                $candidatePath = Get-ComparablePath ([string]$candidate.Document.Folder.Self.Path)
                if (-not [string]::Equals($candidatePath, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
                    continue
                }
                if ([bool]$candidate.Visible) { return $candidate }
                if ($null -eq $hidden) { $hidden = $candidate }
            } catch {
                # Ignore shell views that are closing or are not filesystem folders.
            }
        }
        return $hidden
    }

    $targetPath = [IO.Path]::GetFullPath($Target)
    if ($SelectFile) {
        if (-not [IO.File]::Exists($targetPath)) { throw 'The selected file does not exist.' }
        $directory = [IO.Path]::GetDirectoryName($targetPath)
    } else {
        if (-not [IO.Directory]::Exists($targetPath)) { throw 'The requested folder does not exist.' }
        $directory = $targetPath
    }

    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.NameSpace($directory)
    if ($null -eq $folder) { throw 'Windows Shell could not resolve the folder.' }
    $expectedPath = Get-ComparablePath ([string]$folder.Self.Path)
    $window = Find-TargetWindow $shell $expectedPath
    if ($null -eq $window) {
        [void]$shell.Open($directory)
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $window = Find-TargetWindow $shell $expectedPath
            if ($null -ne $window) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
    }
    if ($null -eq $window) { throw 'Windows Shell did not create a folder window.' }

    # Restore only this one exact folder match, including a previously hidden window.
    $currentPath = Get-ComparablePath ([string]$window.Document.Folder.Self.Path)
    if (-not [string]::Equals($currentPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The folder window navigated elsewhere before it could be shown.'
    }
    $handle = [IntPtr][long]$window.HWND
    if ($handle -eq [IntPtr]::Zero) { throw 'Windows Shell did not provide a folder window handle.' }
    $window.Visible = $true
    $showCommand = if ([QQBridgeFolderWindow]::IsIconic($handle)) { 9 } else { 5 }
    [void][QQBridgeFolderWindow]::ShowWindowAsync($handle, $showCommand)
    [void][QQBridgeFolderWindow]::SetForegroundWindow($handle)

    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $visible = [bool]$window.Visible -and
            [QQBridgeFolderWindow]::IsWindowVisible($handle) -and
            -not [QQBridgeFolderWindow]::IsIconic($handle)
        if ($visible) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $visible) { throw 'Windows Shell could not make the folder window visible.' }

    if ($SelectFile) {
        $item = $window.Document.Folder.ParseName([IO.Path]::GetFileName($targetPath))
        if ($null -eq $item) { throw 'Windows Shell could not resolve the selected file.' }
        [void]$window.Document.SelectItem($item, 29)
        $selected = $false
        foreach ($entry in @($window.Document.SelectedItems())) {
            if ([string]::Equals((Get-ComparablePath ([string]$entry.Path)),
                    (Get-ComparablePath $targetPath), [StringComparison]::OrdinalIgnoreCase)) {
                $selected = $true
                break
            }
        }
        if (-not $selected) { throw 'Windows Shell did not select the requested file.' }
    }

    @{ visible = $true } | ConvertTo-Json -Compress
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
