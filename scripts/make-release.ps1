# 生成 Windows 发行文件，无需 npm 或 dotnet SDK。
#   powershell -ExecutionPolicy Bypass -File scripts\make-release.ps1
# 产物默认在 dist\release\；自定义 OutDir 必须是工程 dist 下的子目录。
#   qq-bridge-<ver>-portable-win64.zip   完整便携包（另需 Node.js 22+）
#   qq-bridge-<ver>-source.zip           脱敏源代码包
#   qq-bridge-launcher-<ver>.exe         桌面 / 命令行启动器
#   SHA256SUMS.txt                       三个文件的校验和

param(
  [string]$Version = '',
  [string]$OutDir = 'dist\release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = [IO.Path]::GetFullPath((Join-Path $Root 'dist'))
$stageRoot = ''

function Assert-SafeDistDirectory {
  param([string]$Path)

  $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $prefix = $distRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('发行目录必须是工程 dist 下的子目录：' + $resolved)
  }
  # 拒绝 junction / symlink，避免递归清理越出已经检查的 dist。
  $probe = $resolved
  while ($probe.Length -ge $distRoot.Length) {
    if (Test-Path -LiteralPath $probe) {
      $item = Get-Item -LiteralPath $probe -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('发行目录不能经过符号链接或 junction：' + $probe)
      }
    }
    if ($probe.Equals($distRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
    $probe = [IO.Path]::GetDirectoryName($probe)
  }
  return $resolved
}

function Get-ReleaseSha256 {
  param([string]$Path)

  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

Push-Location $Root
try {
  $pkg = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $packageVersion = [string]$pkg.version
  if (-not $Version) { $Version = $packageVersion }
  $versionPattern = '^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]+)?$'
  if ($Version -notmatch $versionPattern -or $packageVersion -notmatch $versionPattern) {
    throw 'package.json 与发行版本号必须是 major.minor.patch（可带第四段、预发布或构建标识）。'
  }
  $outPath = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $Root $OutDir }
  $out = Assert-SafeDistDirectory $outPath

  # 打包器按 package.json 命名源目录；-Version 只覆盖发行标签与 exe 版本。
  $srcDir = Join-Path $distRoot "qq-dsh-bridge-$packageVersion"
  $srcZip = Join-Path $distRoot "qq-dsh-bridge-$packageVersion.zip"
  $exe = Join-Path $distRoot 'qq-bridge.exe'
  if ($out.Equals($srcDir, [StringComparison]::OrdinalIgnoreCase) -or
      $out.StartsWith($srcDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '发行目录不能覆盖源代码打包目录。'
  }
  Write-Host "版本：$Version"

  if (-not $SkipBuild) {
    Write-Host '→ 打包源代码 …'
    & node (Join-Path $Root 'tools\package.mjs') --force
    if ($LASTEXITCODE -ne 0) { throw "tools\package.mjs 退出码 $LASTEXITCODE" }

    Write-Host '→ 编译启动器 exe …'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\build-exe.ps1') -Version $Version
    if ($LASTEXITCODE -ne 0) { throw "scripts\build-exe.ps1 退出码 $LASTEXITCODE" }
  }

  foreach ($artifact in @($srcDir, $srcZip, $exe)) {
    if (-not (Test-Path -LiteralPath $artifact)) { throw "缺少构建产物：$artifact" }
  }
  $exeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
  if (-not [string]::Equals($exeVersion, $Version, [StringComparison]::Ordinal)) {
    throw ("启动器版本与发行版本不符（exe={0}，发行={1}）。请去掉 -SkipBuild 重新构建。" -f $exeVersion, $Version)
  }

  $out = Assert-SafeDistDirectory $out
  if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $out | Out-Null

  $stageRoot = Assert-SafeDistDirectory (Join-Path $distRoot ("_stage-" + $Version + '-' + [Guid]::NewGuid().ToString('N')))
  $stage = Join-Path $stageRoot "qq-bridge-$Version"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Get-ChildItem -LiteralPath $srcDir -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force
  }
  Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'qq-bridge.exe') -Force

  $readme = @"
QQ-DSH $Version 便携版（Windows x64）
========================================

推荐：由 DSH 完整插件运行桥接
  1. 准备宿主 DSH 与可用 Node.js。桥接本体要求 Node.js 22 或以上；
     DSH 0.2.2 CLI 要求 Node.js 24.9.0 或以上，Desktop 使用其自带运行时。
  2. 按 README.md 准备 config.json，只在首次安装时复制 config.example.json，
     不覆盖已有配置。设置宿主可达的 OneBot 地址、聊天准入与管理员。
  3. 单独部署并登录 NapCat（可使用 Docker），启用 OneBot 11 正向 WebSocket。
     DSH 与桥接不需要放进容器。
  4. 在 DSH 插件管理中安装本目录 src\companion 的完整 bundle，启用并重启宿主；
     Desktop 与 Web 的具体安装命令、旧 server-only 迁移见 README.md。
  5. 从插件面板管理自动启动的进程内桥接，点击“打开完整控制台”进入浏览器。
     使用插件方式时，不要再运行 qq-bridge.exe 或其他入口启动同一桥接。

包内入口
  src\companion       推荐的 DSH 完整插件；保留完整解压目录，不单独搬移该子目录
  src\ tools\ ...      完整工程源码与维护工具
  qq-bridge.exe        可选旧桌面 / 命令行启动器，不单独包含 Node、NapCat 或 DSH
  一键启动.cmd        可选旧独立组件启动流程，不与插件方式同时使用
  qq-bridge.cmd        可选独立命令行入口

旧独立启动方式（兼容入口）
  无参数双击 qq-bridge.exe 会启动托盘及独立组件，不是插件运行方式。
  仅在明确选择独立方式且已准备本地组件时使用 setup.cmd、install-napcat.cmd。
  qq-bridge.exe status              查看独立服务状态
  qq-bridge.exe logs bridge         查看桥接日志
  qq-bridge.exe stop                停止命令行启动的独立服务
  qq-bridge.exe start --no-console  按旧配置启动独立服务

本机数据
  config.json、state\、logs\、qq-workspace\ 均为本机数据，不会被打进包。
  升级前备份已有配置与数据；完整安装、迁移、权限及验证范围见 README.md 与 docs\。
"@
  $utf8Bom = New-Object System.Text.UTF8Encoding($true)
  [IO.File]::WriteAllText((Join-Path $stage '快速开始.txt'), $readme, $utf8Bom)

  $portable = Join-Path $out "qq-bridge-$Version-portable-win64.zip"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $portable, [IO.Compression.CompressionLevel]::Optimal, $true)

  $sourceOut = Join-Path $out "qq-bridge-$Version-source.zip"
  Copy-Item -LiteralPath $srcZip -Destination $sourceOut -Force
  $exeOut = Join-Path $out "qq-bridge-launcher-$Version.exe"
  Copy-Item -LiteralPath $exe -Destination $exeOut -Force

  $files = @($portable, $sourceOut, $exeOut)
  $lines = foreach ($file in $files) {
    $hash = Get-ReleaseSha256 $file
    "$hash  $([IO.Path]::GetFileName($file))"
  }
  [IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS.txt'), $lines, $utf8Bom)

  Write-Host ''
  Write-Host '产物：'
  Get-ChildItem -LiteralPath $out | ForEach-Object {
    Write-Host ("  {0,-42} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB))
  }
  Write-Host ''
  Write-Host 'SHA256SUMS.txt：'
  $lines | ForEach-Object { Write-Host "  $_" }
} finally {
  if ($stageRoot -and (Test-Path -LiteralPath $stageRoot)) {
    $stageRoot = Assert-SafeDistDirectory $stageRoot
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
  Pop-Location
}
