/**
 * tray-click-target.mjs —— 托盘「左键直达控制台」的可回归证据。
 *
 * 分两层，都不需要真的用鼠标点托盘（那样会打扰正在用电脑的人）：
 *
 *   A. 静态：Launcher.ps1 里必须绑的是左键单击（Add_MouseClick + MouseButtons::Left），
 *      并且不再绑双击（双击会先触发两次单击，弹两个窗口）。
 *   B. 行为：把 Launcher.ps1 里的 Open-WebUiConsole 函数单独抽出来执行，
 *      把 Edge 换成一个记录参数的 .cmd 桩，断言它真的拼出
 *      `--app=http://127.0.0.1:5830/ --window-size=1180,820`；
 *      控制台没监听时必须弹气泡而不是开空窗口。
 *
 * 用法：node tests\tray-click-target.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LAUNCHER = path.join(ROOT, 'launcher', 'Launcher.ps1');

let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed += 1;
  console.log(`  ✔ ${name}${detail ? `  — ${detail}` : ''}`);
}

function bad(name, detail = '') {
  failed += 1;
  console.log(`  ✘ ${name}${detail ? `  — ${detail}` : ''}`);
}

function runPowerShell(scriptPath, env) {
  return new Promise((resolve) => {
    const child = spawn(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, env: { ...process.env, ...env } },
    );
    let out = '';
    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
    });
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: -1, out: String(err?.message ?? err) }));
  });
}

const HARNESS = `param(
  [string]$Mode
)
$ErrorActionPreference = 'Stop'
# Launcher.ps1 在真机上启动时会加载 WinForms，这里抽函数出来跑，得自己补上
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$launcherPath = $env:TRAY_LAUNCHER
$src = [System.IO.File]::ReadAllText($launcherPath, [System.Text.Encoding]::UTF8)
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
  Write-Output ('PARSE-FAIL: ' + $parseErrors[0].Message)
  exit 2
}
$fn = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Open-WebUiConsole'
  }, $true) | Select-Object -First 1
if (-not $fn) {
  Write-Output 'FUNC-MISSING'
  exit 3
}
Invoke-Expression $fn.Extent.Text

$script:argsFile = $env:TRAY_ARGS_FILE
$script:balloonFile = $env:TRAY_BALLOON_FILE
$script:listening = ($env:TRAY_LISTENING -eq '1')
$script:EdgeX86Path = $env:TRAY_EDGE_STUB
$script:EdgeX64Path = ''

function Write-LauncherLog {
  param([string]$Message, [string]$Level = 'INFO')
}
function Get-ConsolePort { return '5830' }
function Test-ConsoleListening {
  param($Port)
  return $script:listening
}
function Show-Balloon {
  param($Title, $Body, $Icon)
  if ($script:balloonFile) { Set-Content -Path $script:balloonFile -Value ($Title + ' | ' + $Body) -Encoding UTF8 }
}

Open-WebUiConsole
Write-Output 'CALL-DONE'
`;

const EXIT_MENU_TEXT = '退出（停止桥接与 NapCat）';

async function main() {
  section('A. 静态：绑的是「左键单击」，且没有双击');
  const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');

  if (/Add_MouseClick/.test(launcherSrc)) ok('Launcher.ps1 绑定了 Add_MouseClick');
  else bad('没找到 Add_MouseClick');

  if (/MouseButtons\]::Left/.test(launcherSrc)) ok('处理器里有「只认左键」的判断');
  else bad('没找到 MouseButtons]::Left 判断');

  if (!/Add_DoubleClick/.test(launcherSrc)) ok('没有 Add_DoubleClick（避免双击弹两个窗口）');
  else bad('还残留 Add_DoubleClick');

  if (launcherSrc.includes(EXIT_MENU_TEXT)) ok('菜单只保留退出项', EXIT_MENU_TEXT);
  else bad('菜单里没有退出项', EXIT_MENU_TEXT);

  // 菜单精简：这些项必须已经从托盘菜单里消失（功能搬到控制台）
  for (const removed of ['一键启动全部', '一键停止全部', '打开控制台（左键直达）', '人格设置…', '会话管理…', '开机自启']) {
    if (!launcherSrc.includes(`-Text '${removed}'`)) ok(`菜单项已移除：${removed}`);
    else bad(`菜单项还在：${removed}`);
  }

  const handlerMatch = launcherSrc.match(/Add_MouseClick\(\{[\s\S]{0,400}?Open-WebUiConsole[\s\S]{0,40}?\}\)/);
  if (handlerMatch) ok('左键处理器调用的就是 Open-WebUiConsole');
  else bad('左键处理器没有调用 Open-WebUiConsole');

  section('B. 行为：Open-WebUiConsole 真的拼出 Edge --app 参数');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tray-click-'));
  const scriptPath = path.join(tmpRoot, 'harness.ps1');
  const stubPath = path.join(tmpRoot, 'edge-stub.cmd');
  const argsFile = path.join(tmpRoot, 'edge-args.txt');
  const balloonFile = path.join(tmpRoot, 'balloon.txt');

  // PS 5.1 必须吃带 BOM 的 UTF-8，否则中文全乱、语法直接过不去
  await fsp.writeFile(scriptPath, `\uFEFF${HARNESS}`, 'utf8');
  await fsp.writeFile(stubPath, '@echo off\r\necho %* > "%TRAY_ARGS_FILE%"\r\n', 'utf8');

  // 情况 1：控制台在监听 → 应该拉起 Edge 桩，参数里带 --app 与窗口尺寸
  const first = await runPowerShell(scriptPath, {
    TRAY_LAUNCHER: LAUNCHER,
    TRAY_EDGE_STUB: stubPath,
    TRAY_ARGS_FILE: argsFile,
    TRAY_BALLOON_FILE: balloonFile,
    TRAY_LISTENING: '1',
  });

  if (first.code === 0 && first.out.includes('CALL-DONE')) ok('抽出来的函数能正常执行');
  else bad('函数执行失败', first.out.trim().split('\n').slice(-4).join(' / '));

  // Start-Process 是异步的，给桩进程一点时间写文件
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !fs.existsSync(argsFile)) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const edgeArgs = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim() : '';
  if (edgeArgs.includes('--app=http://127.0.0.1:5830/')) ok('Edge 参数里是控制台地址', '--app=http://127.0.0.1:5830/');
  else bad('Edge 参数里没有控制台地址', edgeArgs || '（参数文件没生成）');

  if (edgeArgs.includes('--window-size=1180,820')) ok('Edge 带上了窗口尺寸', '1180,820');
  else bad('Edge 没带窗口尺寸', edgeArgs);

  if (!fs.existsSync(balloonFile) || !fs.readFileSync(balloonFile, 'utf8').includes('还没启动')) {
    ok('控制台在监听时不弹「还没启动」气泡');
  } else {
    bad('控制台在监听却弹了气泡', fs.readFileSync(balloonFile, 'utf8'));
  }

  // 情况 2：控制台没监听 → 只弹气泡，不开空窗口
  const argsFile2 = path.join(tmpRoot, 'edge-args-2.txt');
  const balloonFile2 = path.join(tmpRoot, 'balloon-2.txt');
  const second = await runPowerShell(scriptPath, {
    TRAY_LAUNCHER: LAUNCHER,
    TRAY_EDGE_STUB: stubPath,
    TRAY_ARGS_FILE: argsFile2,
    TRAY_BALLOON_FILE: balloonFile2,
    TRAY_LISTENING: '0',
  });

  if (second.code === 0) ok('没监听时函数不抛异常');
  else bad('没监听时函数抛异常', second.out.trim().split('\n').slice(-3).join(' / '));

  if (fs.existsSync(balloonFile2) && fs.readFileSync(balloonFile2, 'utf8').includes('还没启动')) {
    ok('没监听时提示「控制台还没启动」');
  } else {
    bad('没监听时没有提示');
  }

  if (!fs.existsSync(argsFile2)) ok('没监听时不会打开空窗口');
  else bad('没监听时居然还开窗口', fs.readFileSync(argsFile2, 'utf8'));

  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(60));
  if (failed > 0) process.exitCode = 1;
}

function section(title) {
  console.log(`\n[${title}]`);
}

await main();
