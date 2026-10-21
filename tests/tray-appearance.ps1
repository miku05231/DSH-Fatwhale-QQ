param(
    [ValidateSet('Preview', 'ExitCancel', 'ExitConfirm', 'Responsive')]
    [string]$Mode = 'Preview',
    [string]$OutputDirectory = $env:TRAY_PREVIEW_DIR
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:Checks = [System.Collections.Generic.List[object]]::new()
$script:Previews = [System.Collections.Generic.List[object]]::new()
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Add-PreviewCheck {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $script:Checks.Add([PSCustomObject]@{
        name = $Name
        passed = $Passed
        detail = $Detail
    })
}

function Get-RequiredControl {
    param([System.Windows.Forms.Form]$Form, [string]$Name)
    $controls = @($Form.Controls.Find($Name, $true))
    if ($controls.Count -ne 1) {
        throw ('Expected one dialog control named ' + $Name + ', found ' + $controls.Count)
    }
    return $controls[0]
}

function Get-FormControlBounds {
    param([System.Windows.Forms.Form]$Form, [System.Windows.Forms.Control]$Control)
    $origin = $Form.PointToClient($Control.PointToScreen([System.Drawing.Point]::Empty))
    return [System.Drawing.Rectangle]::new($origin, $Control.Size)
}

function Set-PreviewMenuScale {
    param([System.Windows.Forms.ContextMenuStrip]$Menu, [single]$Factor)

    $originalScale = $Menu.LayoutScale
    $originalFont = $Menu.Font
    $originalPadding = $Menu.Padding
    $originalItemSize = $Menu.Items[0].Size
    $Menu.LayoutScale = $originalScale * $Factor
    $Menu.Scale([System.Drawing.SizeF]::new($Factor, $Factor))
    $Menu.Padding = [System.Windows.Forms.Padding]::new(
        [int]($originalPadding.Left * $Factor),
        [int]($originalPadding.Top * $Factor),
        [int]($originalPadding.Right * $Factor),
        [int]($originalPadding.Bottom * $Factor)
    )
    $Menu.Items[0].Size = [System.Drawing.Size]::new(
        [int]($originalItemSize.Width * $Factor),
        [int]($originalItemSize.Height * $Factor)
    )
    $Menu.Font = [System.Drawing.Font]::new(
        $originalFont.FontFamily,
        [single]($originalFont.Size * $Factor),
        $originalFont.Style
    )
    $originalFont.Dispose()
}

function Set-PreviewDialogScale {
    param([System.Windows.Forms.Form]$Form, [single]$Factor)

    $title = Get-RequiredControl $Form 'exitTitle'
    $originalFormFont = $Form.Font
    $originalTitleFont = $title.Font
    $Form.Scale([System.Drawing.SizeF]::new($Factor, $Factor))
    $Form.Font = [System.Drawing.Font]::new(
        $originalFormFont.FontFamily,
        [single]($originalFormFont.Size * $Factor),
        $originalFormFont.Style
    )
    $title.Font = [System.Drawing.Font]::new(
        $originalTitleFont.FontFamily,
        [single]($originalTitleFont.Size * $Factor),
        $originalTitleFont.Style
    )
    $Form.Tag = @($Form.Tag) + @($Form.Font, $title.Font)
}

function Test-MenuLayout {
    param(
        [System.Windows.Forms.ContextMenuStrip]$Menu,
        [string]$Theme,
        [int]$Scale
    )

    $label = $Theme + ' menu ' + $Scale + '%'
    $item = $Menu.Items[0]
    Add-PreviewCheck ($label + ' contains its exit item') ($Menu.ClientRectangle.Contains($item.Bounds)) $item.Bounds.ToString()
    if ($Menu.Renderer -is [System.Windows.Forms.ToolStripSystemRenderer]) { return }

    $titleSize = [System.Windows.Forms.TextRenderer]::MeasureText(
        $item.Text,
        $Menu.Font,
        [System.Drawing.Size]::Empty,
        ([System.Windows.Forms.TextFormatFlags]::SingleLine -bor [System.Windows.Forms.TextFormatFlags]::NoPadding)
    )
    $textWidth = $item.Width - [int](44 * $Menu.LayoutScale)
    Add-PreviewCheck ($label + ' fits its title') (($titleSize.Width -le $textWidth) -and ($titleSize.Height -le $item.Height)) $titleSize.ToString()
    Add-PreviewCheck ($label + ' stays compact') (($Menu.Width -le [int](140 * $Menu.LayoutScale)) -and ($Menu.Height -le [int](44 * $Menu.LayoutScale))) $Menu.Size.ToString()
}

function Save-RenderedPreview {
    param(
        [System.Windows.Forms.Control]$Control,
        $Palette,
        [string]$Theme,
        [string]$Kind,
        [int]$Scale
    )

    $rendered = [System.Drawing.Bitmap]::new($Control.Width, $Control.Height)
    $bitmap = $rendered
    try {
        $Control.DrawToBitmap($rendered, [System.Drawing.Rectangle]::new(0, 0, $rendered.Width, $rendered.Height))
        if ($Control -is [System.Windows.Forms.Form]) {
            # Native window chrome keeps host DPI; inspect the application's client area.
            $clientOrigin = $Control.PointToScreen([System.Drawing.Point]::Empty)
            $clientBounds = [System.Drawing.Rectangle]::new(
                ($clientOrigin.X - $Control.Left),
                ($clientOrigin.Y - $Control.Top),
                $Control.ClientSize.Width,
                $Control.ClientSize.Height
            )
            $bitmap = $rendered.Clone($clientBounds, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        }
        $colors = [System.Drawing.Color[]]@($Palette.BackColor, $Palette.ForeColor, $Palette.MutedColor)
        $counts = [QqDshLauncher.Tests.PixelProbe]::Count($bitmap, $colors)
        $pixels = $bitmap.Width * $bitmap.Height
        $label = $Theme + ' ' + $Kind + ' ' + $Scale + '%'
        Add-PreviewCheck ($label + ' renders its themed background') ($counts[0] -gt ($pixels * 0.10)) ($counts[0].ToString() + ' background pixels')
        Add-PreviewCheck ($label + ' renders readable text') (($counts[1] + $counts[2]) -gt 20) (($counts[1] + $counts[2]).ToString() + ' text pixels')
        Add-PreviewCheck ($label + ' is not a blank bitmap') ($counts[3] -ge 3) ($counts[3].ToString() + ' distinct colors')

        $fileName = $Theme.ToLowerInvariant() + '-' + $Kind + '-' + $Scale + '.png'
        $snapshotPath = Join-Path $OutputDirectory $fileName
        $bitmap.Save($snapshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $script:Previews.Add([PSCustomObject]@{
            theme = $Theme
            kind = $Kind
            scale = $Scale
            path = $snapshotPath
            width = $bitmap.Width
            height = $bitmap.Height
        })
    } finally {
        if ($bitmap -ne $rendered) { $bitmap.Dispose() }
        $rendered.Dispose()
    }
}

function Test-DialogLayout {
    param(
        [System.Windows.Forms.Form]$Form,
        [string]$Theme,
        [int]$Scale
    )

    $title = Get-RequiredControl $Form 'exitTitle'
    $body = Get-RequiredControl $Form 'exitBody'
    $cancelButton = Get-RequiredControl $Form 'cancelButton'
    $exitButton = Get-RequiredControl $Form 'exitButton'
    $label = $Theme + ' dialog ' + $Scale + '%'

    Add-PreviewCheck ($label + ' explains the unchanged shutdown behavior') (($body.Text -match 'NapCat') -and ($body.Text -match 'DSH')) $body.Text
    Add-PreviewCheck ($label + ' exit button confirms') ($exitButton.DialogResult -eq [System.Windows.Forms.DialogResult]::Yes)
    Add-PreviewCheck ($label + ' cancel button declines') ($cancelButton.DialogResult -eq [System.Windows.Forms.DialogResult]::No)
    Add-PreviewCheck ($label + ' Enter keeps services running') ($Form.AcceptButton -eq $cancelButton)
    Add-PreviewCheck ($label + ' Escape keeps services running') ($Form.CancelButton -eq $cancelButton)
    Add-PreviewCheck ($label + ' opens with cancel focused') ($Form.ActiveControl -eq $cancelButton)

    $bounds = @{}
    foreach ($control in @($title, $body, $cancelButton, $exitButton)) {
        $rect = Get-FormControlBounds $Form $control
        $bounds[$control.Name] = $rect
        Add-PreviewCheck ($label + ' contains ' + $control.Name) ($Form.ClientRectangle.Contains($rect)) $rect.ToString()
        if ($control -is [System.Windows.Forms.Label]) {
            $preferred = $control.GetPreferredSize([System.Drawing.Size]::new($control.Width, 0))
            Add-PreviewCheck ($label + ' fits text in ' + $control.Name) ($preferred.Height -le ($control.Height + 2)) ('required=' + $preferred.Height + ', available=' + $control.Height)
        } else {
            $textSize = [System.Windows.Forms.TextRenderer]::MeasureText(
                $control.Text,
                $control.Font,
                [System.Drawing.Size]::Empty,
                [System.Windows.Forms.TextFormatFlags]::SingleLine
            )
            Add-PreviewCheck ($label + ' fits text in ' + $control.Name) (($textSize.Width -le $control.Width) -and ($textSize.Height -le $control.Height)) ('text=' + $textSize + ', available=' + $control.Size)
        }
    }

    $pairs = @(
        @('exitTitle', 'exitBody'),
        @('exitBody', 'cancelButton'),
        @('exitBody', 'exitButton'),
        @('cancelButton', 'exitButton')
    )
    foreach ($pair in $pairs) {
        Add-PreviewCheck ($label + ' separates ' + $pair[0] + ' and ' + $pair[1]) (-not $bounds[$pair[0]].IntersectsWith($bounds[$pair[1]]))
    }
}

function Invoke-AppearancePreview {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
    . (Join-Path $projectRoot 'launcher\lib\TrayAppearance.ps1')
    $null = Initialize-LauncherAppearance

    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System.Collections.Generic;
using System.Drawing;

namespace QqDshLauncher.Tests {
    public static class PixelProbe {
        public static int[] Count(Bitmap bitmap, Color[] colors) {
            int[] result = new int[colors.Length + 1];
            HashSet<int> distinct = new HashSet<int>();
            for (int y = 0; y < bitmap.Height; y++) {
                for (int x = 0; x < bitmap.Width; x++) {
                    Color pixel = bitmap.GetPixel(x, y);
                    if (distinct.Count < 256) distinct.Add(pixel.ToArgb());
                    for (int i = 0; i < colors.Length; i++) {
                        Color expected = colors[i];
                        if (System.Math.Abs(pixel.R - expected.R) <= 6 &&
                            System.Math.Abs(pixel.G - expected.G) <= 6 &&
                            System.Math.Abs(pixel.B - expected.B) <= 6) result[i]++;
                    }
                }
            }
            result[colors.Length] = distinct.Count;
            return result;
        }
    }
}
'@

    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $OutputDirectory = Join-Path $projectRoot 'state\ui-preview'
    }
    $OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
    $null = [System.IO.Directory]::CreateDirectory($OutputDirectory)

    foreach ($theme in @('Light', 'Dark')) {
        $baselineMenu = $null
        $baselineDialog = $null
        $palette = Get-LauncherPalette -Theme $theme
        Add-PreviewCheck ($theme + ' palette has contrasting surface and text') ($palette.BackColor.ToArgb() -ne $palette.ForeColor.ToArgb())
        if (-not $palette.HighContrast) {
            Add-PreviewCheck ($theme + ' explicit theme is honored') (($theme -eq 'Light' -and $palette.BackColor.GetBrightness() -gt 0.5) -or ($theme -eq 'Dark' -and $palette.BackColor.GetBrightness() -lt 0.5))
        }

        foreach ($scale in @(100, 150)) {
            $hostForm = $null
            $menu = $null
            $dialog = $null
            try {
                $hostForm = [System.Windows.Forms.Form]::new()
                $hostForm.ShowInTaskbar = $false
                $hostForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
                $hostForm.Location = [System.Drawing.Point]::new(-16000, -16000)
                $hostForm.Opacity = 0
                $hostForm.Size = [System.Drawing.Size]::new(1000, 600)
                $menu = New-LauncherTrayMenu -Palette $palette
                Add-PreviewCheck ($theme + ' menu contains only exit') (($menu -is [System.Windows.Forms.ContextMenuStrip]) -and ($menu.Items.Count -eq 1))
                Add-PreviewCheck ($theme + ' menu has an accessible name') (-not [string]::IsNullOrWhiteSpace($menu.AccessibleName))
                Add-PreviewCheck ($theme + ' menu has a compact exit label') ($menu.Items[0].Text -eq '退出') $menu.Items[0].Text
                Add-PreviewCheck ($theme + ' menu preserves accessible exit text') ($menu.Items[0].AccessibleName -eq '退出（停止桥接与 NapCat）')
                Add-PreviewCheck ($theme + ' menu tooltip explains DSH behavior') (($menu.Items[0].ToolTipText -match 'DSH') -and ($menu.Items[0].ToolTipText -match '继续')) $menu.Items[0].ToolTipText
                $menu.TopLevel = $false
                $hostForm.Controls.Add($menu)
                $hostForm.Show()
                $menu.Show()
                [System.Windows.Forms.Application]::DoEvents()
                $menuLayoutScale = $menu.LayoutScale
                if ($scale -ne 100) {
                    Set-PreviewMenuScale $menu ([single]($scale / 100.0))
                }
                $menu.PerformLayout()
                [System.Windows.Forms.Application]::DoEvents()
                Test-MenuLayout $menu $theme $scale
                if ($scale -eq 100) {
                    $baselineMenu = [PSCustomObject]@{
                        Size = $menu.Size
                        FontSize = $menu.Font.Size
                        ItemSize = $menu.Items[0].Size
                    }
                } else {
                    Add-PreviewCheck ($theme + ' menu 150% enlarges its bitmap area') (($menu.Width -ge ($baselineMenu.Size.Width * 1.45)) -and ($menu.Height -ge ($baselineMenu.Size.Height * 1.45))) ($menu.Size.ToString() + ' versus ' + $baselineMenu.Size)
                    Add-PreviewCheck ($theme + ' menu 150% enlarges its text') ($menu.Font.Size -ge ($baselineMenu.FontSize * 1.45)) ($menu.Font.Size.ToString() + 'pt')
                    Add-PreviewCheck ($theme + ' menu 150% enlarges its exit item') (($menu.Items[0].Width -ge ($baselineMenu.ItemSize.Width * 1.45)) -and ($menu.Items[0].Height -ge ($baselineMenu.ItemSize.Height * 1.45))) $menu.Items[0].Size.ToString()
                    Add-PreviewCheck ($theme + ' menu 150% scales renderer offsets') ([math]::Abs($menu.LayoutScale - ($menuLayoutScale * 1.5)) -lt 0.01) $menu.LayoutScale.ToString()
                }
                Save-RenderedPreview $menu $palette $theme 'menu' $scale

                $dialog = New-LauncherExitDialog -Palette $palette
                Add-PreviewCheck ($theme + ' exit dialog is a form') ($dialog -is [System.Windows.Forms.Form])
                $dialog.ShowInTaskbar = $false
                $dialog.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
                $dialog.Location = [System.Drawing.Point]::new(-16000, -16000)
                $dialog.Opacity = 0
                if ($scale -ne 100) {
                    Set-PreviewDialogScale $dialog ([single]($scale / 100.0))
                }
                $dialog.Show()
                $dialog.PerformLayout()
                [System.Windows.Forms.Application]::DoEvents()
                Test-DialogLayout $dialog $theme $scale
                $title = Get-RequiredControl $dialog 'exitTitle'
                $body = Get-RequiredControl $dialog 'exitBody'
                if ($scale -eq 100) {
                    $baselineDialog = [PSCustomObject]@{
                        ClientSize = $dialog.ClientSize
                        FontSize = $dialog.Font.Size
                        TitleFontSize = $title.Font.Size
                    }
                } else {
                    Add-PreviewCheck ($theme + ' dialog 150% enlarges its bitmap area') (($dialog.ClientSize.Width -ge ($baselineDialog.ClientSize.Width * 1.45)) -and ($dialog.ClientSize.Height -ge ($baselineDialog.ClientSize.Height * 1.45))) ($dialog.ClientSize.ToString() + ' versus ' + $baselineDialog.ClientSize)
                    Add-PreviewCheck ($theme + ' dialog 150% enlarges its body text') (($dialog.Font.Size -ge ($baselineDialog.FontSize * 1.45)) -and ($body.Font.Size -eq $dialog.Font.Size)) ($body.Font.Size.ToString() + 'pt')
                    Add-PreviewCheck ($theme + ' dialog 150% enlarges its title') ($title.Font.Size -ge ($baselineDialog.TitleFontSize * 1.45)) ($title.Font.Size.ToString() + 'pt')
                }
                Save-RenderedPreview $dialog $palette $theme 'dialog' $scale
            } finally {
                if ($null -ne $dialog) { $dialog.Dispose() }
                if ($null -ne $menu) { $menu.Dispose() }
                if ($null -ne $hostForm) { $hostForm.Dispose() }
            }
        }
    }
}

function Invoke-ExitBehaviorCheck {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $launcherPath = Join-Path $projectRoot 'launcher\Launcher.ps1'
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw $parseErrors[0].Message }
    $functionAst = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-LauncherExit'
    }, $true) | Select-Object -First 1
    if ($null -eq $functionAst) { throw 'Invoke-LauncherExit is missing.' }
    if ($functionAst.Extent.Text -notmatch 'Show-LauncherExitConfirmation') {
        throw 'Invoke-LauncherExit does not use the styled confirmation helper.'
    }
    Invoke-Expression $functionAst.Extent.Text

    $script:Exiting = $false
    $script:Timer = $null
    $script:TrayIcon = $null
    $script:IconGreen = $null
    $script:Calls = [System.Collections.Generic.List[string]]::new()
    $script:ConfirmCalls = 0
    $script:ConfirmAnswer = [System.Windows.Forms.DialogResult]::No
    if ($Mode -eq 'ExitConfirm') { $script:ConfirmAnswer = [System.Windows.Forms.DialogResult]::Yes }

    function Show-LauncherExitConfirmation {
        param($Palette, $Icon)
        $script:ConfirmCalls += 1
        return $script:ConfirmAnswer
    }
    function Write-LauncherLog {
        param([string]$Message, [string]$Level = 'INFO')
    }
    function Invoke-LibFunction {
        param([string]$Name)
        $script:Calls.Add($Name)
        return $true
    }
    function Get-OkText {
        param([bool]$Value)
        return $Value.ToString()
    }

    Invoke-LauncherExit
    Add-PreviewCheck ($Mode + ' asks once before changing services') ($script:ConfirmCalls -eq 1)
    if ($Mode -eq 'ExitCancel') {
        Add-PreviewCheck 'Cancel does not stop any service' ($script:Calls.Count -eq 0) ($script:Calls -join ', ')
        Add-PreviewCheck 'Cancel leaves launcher active' (-not $script:Exiting)
    } else {
        Add-PreviewCheck 'Confirm stops bridge before NapCat and preserves DSH' (($script:Calls -join ',') -eq 'Stop-Bridge,Stop-NapCat') ($script:Calls -join ', ')
        Add-PreviewCheck 'Confirm marks launcher as exiting' $script:Exiting
        Invoke-LauncherExit
        Add-PreviewCheck 'Repeated exit cannot stop services again' (($script:ConfirmCalls -eq 1) -and ($script:Calls.Count -eq 2))
    }
}

function Invoke-ResponsivenessCheck {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    . (Join-Path $projectRoot 'launcher\lib\TrayAppearance.ps1')
    Initialize-LauncherAppearance

    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $projectRoot 'launcher\Launcher.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw $parseErrors[0].Message }
    foreach ($name in @('Get-LauncherStatus', 'Start-LauncherStatusRefresh', 'Receive-LauncherStatusRefresh', 'Invoke-LauncherCleanup')) {
        $definition = $ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true) | Select-Object -First 1
        if ($null -eq $definition) { throw ('Missing function: ' + $name) }
        Invoke-Expression $definition.Extent.Text
    }

    $fixtureDir = Join-Path ([System.IO.Path]::GetTempPath()) ('qq-tray-status-' + [Guid]::NewGuid().ToString('N'))
    $null = [System.IO.Directory]::CreateDirectory($fixtureDir)
    $script:ProcessControlPath = Join-Path $fixtureDir 'ProcessControl.ps1'
    [System.IO.File]::WriteAllText($script:ProcessControlPath, @'
function Get-NapCatProcess {
    Start-Sleep -Milliseconds 1500
    [pscustomobject]@{ Running = $true; ProcessId = 101 }
}
function Get-NapCatLoginState { [pscustomobject]@{ LoggedIn = $true; Account = ''; Nickname = 'fixture'; Detail = '' } }
function Get-DshProcess { [pscustomobject]@{ Running = $true; ProcessId = 102 } }
function Get-BridgeProcess { [pscustomobject]@{ Running = $true; ProcessId = 103; Sessions = 2; InFlight = 0 } }
'@)
    $script:Exiting = $false
    $script:RequireDsh = $true
    $script:StatusWorker = $null
    $script:StatusRequest = $null
    $script:NextStatusRefresh = [DateTime]::MinValue
    $script:ReceivedStatus = $null
    $script:StatusUiThread = 0
    $script:ClickCount = 0
    $script:ClickMilliseconds = -1
    $script:ProbeErrors = [System.Collections.Generic.List[string]]::new()
    $uiThread = [System.Threading.Thread]::CurrentThread.ManagedThreadId
    function Update-LauncherState {
        param($Status)
        $script:ReceivedStatus = $Status
        $script:StatusUiThread = [System.Threading.Thread]::CurrentThread.ManagedThreadId
    }
    function Write-LauncherLog {
        param([string]$Message, [string]$Level)
        $script:ProbeErrors.Add($Message)
    }
    function Set-FixtureForeground {
        param([System.Windows.Forms.Form]$Form)

        if (-not $Form.Visible) { $Form.Show() }
        $activationWatch = [System.Diagnostics.Stopwatch]::StartNew()
        do {
            $Form.BringToFront()
            $Form.Activate()
            [System.Windows.Forms.Application]::DoEvents()
            $current = $foregroundMethod.Invoke($null, @())
            if ($current -eq $Form.Handle) { return $true }
            [System.Threading.Thread]::Sleep(20)
        } while ($activationWatch.ElapsedMilliseconds -lt 3000)
        return $false
    }
    $menu = $null
    $clickTimer = $null
    $overflow = $null
    $otherWindow = $null
    $stoppingWorker = $null
    try {
        $menu = New-LauncherTrayMenu
        $foregroundMethod = $menu.GetType().GetMethod('GetForegroundWindow', [System.Reflection.BindingFlags]'Static,NonPublic')
        $menu.Items[0].Add_Click({
            $script:ClickCount += 1
            $script:ClickMilliseconds = $script:ClickWatch.ElapsedMilliseconds
        })
        $clickTimer = [System.Windows.Forms.Timer]::new()
        $clickTimer.Interval = 50
        $clickTimer.Add_Tick({
            $clickTimer.Stop()
            $menu.Items[0].PerformClick()
        })
        $script:ClickWatch = [System.Diagnostics.Stopwatch]::StartNew()
        Start-LauncherStatusRefresh
        $startMs = $script:ClickWatch.ElapsedMilliseconds
        Add-PreviewCheck 'Slow status probe starts without blocking the UI' ($startMs -lt 1000) ($startMs.ToString() + 'ms')
        $worker = $script:StatusWorker
        Start-LauncherStatusRefresh
        Add-PreviewCheck 'Only one status probe runs at a time' ([object]::ReferenceEquals($worker, $script:StatusWorker))
        $clickTimer.Start()
        $pumps = 0
        while ($null -eq $script:ReceivedStatus -and $script:ClickWatch.ElapsedMilliseconds -lt 10000) {
            [System.Windows.Forms.Application]::DoEvents()
            Receive-LauncherStatusRefresh
            $pumps += 1
            [System.Threading.Thread]::Sleep(10)
        }
        Add-PreviewCheck 'Exit click is processed during the slow status probe' (($script:ClickCount -eq 1) -and ($script:ClickMilliseconds -lt 1000)) ($script:ClickMilliseconds.ToString() + 'ms')
        Add-PreviewCheck 'UI continues pumping while the status probe runs' ($pumps -gt 20) ($pumps.ToString() + ' cycles')
        Add-PreviewCheck 'Background status probe returns the service state' (($null -ne $script:ReceivedStatus) -and $script:ReceivedStatus.Level -eq 'green' -and $script:ReceivedStatus.BridgeSessions -eq 2) ($script:ProbeErrors -join ', ')
        Add-PreviewCheck 'Status updates are applied on the UI thread' ($script:StatusUiThread -eq $uiThread)
        Add-PreviewCheck 'Completed status probe releases its runspace' ($null -eq $script:StatusWorker)

        $overflow = [System.Windows.Forms.Form]::new()
        $overflow.ShowInTaskbar = $false
        $overflow.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $overflow.Location = [System.Drawing.Point]::new(-16000, -16000)
        $overflow.Opacity = 0
        $overflow.Show()
        $menu.Show([System.Drawing.Point]::new(0, 0))
        [System.Windows.Forms.Application]::DoEvents()
        $flags = [System.Reflection.BindingFlags]'Instance,NonPublic'
        $timerField = $menu.GetType().GetField('dismissTimer', $flags)
        Add-PreviewCheck 'Opening the native menu starts its dismissal timer' ($timerField.GetValue($menu).Enabled)
        $overflowField = $menu.GetType().GetField('overflowWindow', $flags)
        $overflowField.SetValue($menu, $overflow.Handle)
        $dismissWatch = [System.Diagnostics.Stopwatch]::StartNew()
        while ($dismissWatch.ElapsedMilliseconds -lt 250) {
            [System.Windows.Forms.Application]::DoEvents()
            [System.Threading.Thread]::Sleep(10)
        }
        Add-PreviewCheck 'An idle native menu stays open across dismissal ticks' $menu.Visible
        $overflow.Hide()
        $dismissWatch.Restart()
        while ($menu.Visible -and $dismissWatch.ElapsedMilliseconds -lt 1500) {
            [System.Windows.Forms.Application]::DoEvents()
            [System.Threading.Thread]::Sleep(10)
        }
        Add-PreviewCheck 'Hiding the overflow closes the native menu' (-not $menu.Visible) ($dismissWatch.ElapsedMilliseconds.ToString() + 'ms')

        $ownerActivated = Set-FixtureForeground -Form $overflow
        Add-PreviewCheck 'The first focus fixture becomes the native foreground window' $ownerActivated
        $beforeForeground = $foregroundMethod.Invoke($null, @())
        $menu.Show([System.Drawing.Point]::new(0, 0))
        $otherWindow = [System.Windows.Forms.Form]::new()
        $otherWindow.ShowInTaskbar = $false
        $otherWindow.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $otherWindow.Location = [System.Drawing.Point]::new(-16000, -16000)
        $otherWindow.Opacity = 0
        $otherActivated = Set-FixtureForeground -Form $otherWindow
        $afterForeground = $foregroundMethod.Invoke($null, @())
        Add-PreviewCheck 'The focus test actually switches native foreground windows' (
            $ownerActivated -and $otherActivated -and
            $beforeForeground -eq $overflow.Handle -and
            $afterForeground -eq $otherWindow.Handle -and
            $beforeForeground -ne $afterForeground
        ) ('before=' + $beforeForeground + ', after=' + $afterForeground + ', target=' + $otherWindow.Handle)
        $dismissWatch.Restart()
        while ($menu.Visible -and $dismissWatch.ElapsedMilliseconds -lt 1500) {
            [System.Windows.Forms.Application]::DoEvents()
            [System.Threading.Thread]::Sleep(10)
        }
        Add-PreviewCheck 'Changing the foreground closes the native menu' (-not $menu.Visible) ($dismissWatch.ElapsedMilliseconds.ToString() + 'ms')
        Add-PreviewCheck 'Closed menus stop their dismissal timer' (-not $timerField.GetValue($menu).Enabled)

        [System.IO.File]::WriteAllText($script:ProcessControlPath, @'
function Get-NapCatProcess {
    [System.Threading.Thread]::Sleep(1800)
    [pscustomobject]@{ Running = $false }
}
function Get-DshProcess { [pscustomobject]@{ Running = $false } }
function Get-BridgeProcess { [pscustomobject]@{ Running = $false } }
'@)
        $script:NextStatusRefresh = [DateTime]::MinValue
        Start-LauncherStatusRefresh
        $stoppingWorker = $script:StatusWorker
        [System.Threading.Thread]::Sleep(100)
        $script:Timer = $null
        $script:TrayIcon = $null
        $script:Menu = $null
        $script:IconGreen = $null
        $script:IconYellow = $null
        $script:IconRed = $null
        $script:AppIconImage = $null
        $script:Mutex = $null
        $cleanupWatch = [System.Diagnostics.Stopwatch]::StartNew()
        Invoke-LauncherCleanup
        Add-PreviewCheck 'Cleanup does not wait for a native background probe' ($cleanupWatch.ElapsedMilliseconds -lt 1000) ($cleanupWatch.ElapsedMilliseconds.ToString() + 'ms')
        Add-PreviewCheck 'Cleanup releases launcher references to the status worker' ($null -eq $script:StatusWorker)
    } finally {
        if ($null -ne $script:StatusWorker) {
            $script:StatusWorker.Stop()
            $script:StatusWorker.Dispose()
        }
        if ($null -ne $clickTimer) { $clickTimer.Dispose() }
        if ($null -ne $menu) { $menu.Dispose() }
        if ($null -ne $overflow) { $overflow.Dispose() }
        if ($null -ne $otherWindow) { $otherWindow.Dispose() }
        if ($null -ne $stoppingWorker) { $stoppingWorker.Dispose() }
        [System.IO.File]::Delete($script:ProcessControlPath)
        [System.IO.Directory]::Delete($fixtureDir)
    }
}

try {
    if ($Mode -eq 'Preview') {
        Invoke-AppearancePreview
    } elseif ($Mode -eq 'Responsive') {
        Invoke-ResponsivenessCheck
    } else {
        Invoke-ExitBehaviorCheck
    }
} catch {
    Add-PreviewCheck ($Mode + ' harness completes') $false ($_.Exception.Message + ' at ' + $_.ScriptStackTrace)
}

$result = [PSCustomObject]@{
    mode = $Mode
    checks = @($script:Checks.ToArray())
    previews = @($script:Previews.ToArray())
}
Write-Output ('TRAY_RESULT ' + (ConvertTo-Json -InputObject $result -Depth 7 -Compress))
if (@($script:Checks | Where-Object { -not $_.passed }).Count -gt 0) { exit 1 }
