# 只验证图标绘制：从 Launcher.ps1 里抠出 New-AppStateIcon 与 New-LetterIcon，不启动托盘主程序
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$launcher = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\launcher\Launcher.ps1') -Raw -Encoding UTF8

foreach ($name in @('New-AppStateIcon', 'New-LetterIcon')) {
    $pattern = '(?s)function ' + [regex]::Escape($name) + '\s*\{.*?\n\}\r?\n'
    $match = [regex]::Match($launcher, $pattern)
    if (-not $match.Success) { throw "抠不出函数：$name" }
    Invoke-Expression $match.Value
}

$script:CanDestroyIcon = $false
$script:ColorGreen = [System.Drawing.Color]::FromArgb(46, 204, 113)
$script:ColorYellow = [System.Drawing.Color]::FromArgb(241, 196, 15)
$script:ColorRed = [System.Drawing.Color]::FromArgb(231, 76, 60)

$png = Join-Path $PSScriptRoot '..\assets\app-icon.png'
$script:AppIconImage = [System.Drawing.Image]::FromFile((Resolve-Path $png))

$outDir = Join-Path $env:TEMP 'qqdsh-icon-check'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 三种状态 × 两种尺寸，放大 6 倍拼成一张对照图（32/16 原始像素 → 192/96 展示）
$canvas = [System.Drawing.Bitmap]::new(3 * 200 + 8, 8 + 192 + 8 + 96 + 34)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.Clear([System.Drawing.Color]::FromArgb(32, 32, 36))

$states = @('green', 'yellow', 'red')
$x = 8
foreach ($state in $states) {
    $icon = New-AppStateIcon -State $state -Size 32
    if ($null -eq $icon) { throw "New-AppStateIcon 返回空：$state" }
    $bmp = $icon.ToBitmap()
    $g.DrawImage($bmp, [System.Drawing.Rectangle]::new($x, 8, 192, 192))
    $small = New-AppStateIcon -State $state -Size 16
    $g.DrawImage($small.ToBitmap(), [System.Drawing.Rectangle]::new($x, 208, 96, 96))
    $bmp.Save((Join-Path $outDir ("icon-$state-32.png")), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $small.Dispose(); $icon.Dispose()
    $x += 200
}

$font = [System.Drawing.Font]::new('Microsoft YaHei', 11)
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$g.DrawString('上排 32×32（托盘实际大小）  下排 16×16（125% 缩放下的小图）', $font, $brush, 8, 200)
$canvas.Save((Join-Path $outDir 'states.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# 兜底：图像没加载时应当返回 $null
$script:AppIconImage = $null
$fallback = New-AppStateIcon -State 'green' -Size 32
$fallbackOk = $null -eq $fallback
$legacy = New-LetterIcon -Color $script:ColorGreen -Letter 'Q' -Size 32
$legacyOk = $null -ne $legacy
$legacy.Dispose()

$g.Dispose(); $canvas.Dispose(); $brush.Dispose(); $font.Dispose()
$script:AppIconImage = [System.Drawing.Image]::FromFile((Resolve-Path $png))
$script:AppIconImage.Dispose()

Write-Host ("对照图：" + (Join-Path $outDir 'states.png'))
Write-Host ("缺图时返回空：" + $fallbackOk)
Write-Host ("缺图时字母兜底可用：" + $legacyOk)
if (-not $fallbackOk -or -not $legacyOk) { exit 1 }
