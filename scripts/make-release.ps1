# 生成 GitHub Release 用的安装文件（Windows 侧执行）
#   powershell -ExecutionPolicy Bypass -File scripts\make-release.ps1
# 产物在 dist\release\：
#   qq-bridge-<ver>-portable-win64.zip   解压即用（内含 qq-bridge.exe + 完整工程，需要 Node 18+）
#   qq-bridge-<ver>-source.zip           纯源代码包（dist\qq-dsh-bridge-<ver>.zip 改名）
#   qq-bridge-launcher-<ver>.exe         单独的命令行/双击启动器
#   SHA256SUMS.txt                       三个文件的校验和

param(
  [string]$Version = '',
  [string]$OutDir = 'dist\release',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$Root = [IO.Path]::GetFullPath((Join-Path $scriptDir '..'))
Push-Location $Root
try {
  if (-not $Version) {
    $pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'package.json') | ConvertFrom-Json
    $Version = $pkg.version
  }
  if (-not $Version) { throw '读不到版本号（package.json 里没有 version）' }
  Write-Host "版本：$Version"

  if (-not $SkipBuild) {
    Write-Host '→ 打包源代码 …'
    & node (Join-Path $Root 'tools\package.mjs') --force
    if ($LASTEXITCODE -ne 0) { throw "tools\package.mjs 退出码 $LASTEXITCODE" }

    Write-Host '→ 编译启动器 exe …'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\build-exe.ps1')
    if ($LASTEXITCODE -ne 0) { throw "scripts\build-exe.ps1 退出码 $LASTEXITCODE" }
  }

  $srcDir = Join-Path $Root "dist\qq-dsh-bridge-$Version"
  $srcZip = Join-Path $Root "dist\qq-dsh-bridge-$Version.zip"
  $exe    = Join-Path $Root 'dist\qq-bridge.exe'
  foreach ($p in @($srcDir, $srcZip, $exe)) {
    if (-not (Test-Path $p)) { throw "缺少构建产物：$p" }
  }

  $out = Join-Path $Root $OutDir
  if (Test-Path $out) { Remove-Item -Recurse -Force $out }
  New-Item -ItemType Directory -Force -Path $out | Out-Null

  # 1) 便携包：工程 + exe + 快速开始
  $stageRoot = Join-Path $Root ("dist\_stage-" + $Version)
  if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
  $stage = Join-Path $stageRoot "qq-bridge-$Version"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item -Recurse -Force (Join-Path $srcDir '*') $stage
  Copy-Item -Force $exe (Join-Path $stage 'qq-bridge.exe')

  $readme = @"
qq-bridge $Version 便携版（Windows x64）
========================================

这个包里是什么
  qq-bridge.exe        启动器（双击 = 启动服务并打开控制台；也能当命令行用）
  qq-bridge.cmd        命令行入口（qq-bridge.cmd start / stop / status / logs）
  src\ tools\ ...      完整工程源码

第一次跑
  1. 装 Node.js 18 或更新版本（ https://nodejs.org/ ）——本项目零第三方依赖，不用 npm install
  2. 双击 qq-bridge.exe
     或者在本目录开命令行：qq-bridge.cmd start
  3. 浏览器打开 http://127.0.0.1:5830 进控制台
  4. 首次启动会问要连的 NapCat / OneBot 地址，填完保存，然后重启桥接

常用命令
  qq-bridge.exe status              看服务状态
  qq-bridge.exe logs bridge         看桥接日志
  qq-bridge.exe stop                停服务
  qq-bridge.exe start --no-console  只起桥接，不起控制台

Docker
  解压后进入目录，把 .env.example 复制成 .env 填好，然后：
  docker compose up -d --build

说明
  模型调用需要能访问 DeepSeek 接口（或你自己的中转），在 config.json 的 dsh 段配置。
  config.json、state\、logs\、qq-workspace\ 都是本机数据，不会被打进包。
"@
  $utf8Bom = New-Object System.Text.UTF8Encoding($true)
  [IO.File]::WriteAllText((Join-Path $stage '快速开始.txt'), $readme, $utf8Bom)

  $portable = Join-Path $out "qq-bridge-$Version-portable-win64.zip"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $portable, [IO.Compression.CompressionLevel]::Optimal, $true)
  Remove-Item -Recurse -Force $stageRoot

  # 2) 纯源码包 + 3) 单独启动器
  $sourceOut = Join-Path $out "qq-bridge-$Version-source.zip"
  Copy-Item -Force $srcZip $sourceOut
  $exeOut = Join-Path $out "qq-bridge-launcher-$Version.exe"
  Copy-Item -Force $exe $exeOut

  # 4) 校验和
  $files = @($portable, $sourceOut, $exeOut)
  $lines = foreach ($f in $files) {
    $h = (Get-FileHash -Algorithm SHA256 -Path $f).Hash.ToLower()
    "$h  $([IO.Path]::GetFileName($f))"
  }
  [IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS.txt'), $lines, $utf8Bom)

  Write-Host ''
  Write-Host '产物：'
  Get-ChildItem $out | ForEach-Object {
    Write-Host ("  {0,-42} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB))
  }
  Write-Host ''
  Write-Host "SHA256SUMS.txt："
  $lines | ForEach-Object { Write-Host "  $_" }
} finally {
  Pop-Location
}
