/**
 * Native tray appearance and shutdown regression checks.
 *
 * Run: node tests/tray-appearance-test.mjs
 * Keep preview PNGs: node tests/tray-appearance-test.mjs --preview
 *
 * Only the pure appearance helper and the extracted exit function are loaded.
 * The real launcher, autostart registration, and QQ connections never start.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'tray-appearance.ps1');
const HELPER = path.join(ROOT, 'launcher', 'lib', 'TrayAppearance.ps1');
const keepPreviews = process.argv.includes('--preview');
let passed = 0;
let failed = 0;

function check(condition, label, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? `: ${detail}` : ''}`);
}

function runHarness(mode, outputDirectory) {
  return new Promise((resolve) => {
    const child = spawn(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', HARNESS, '-Mode', mode],
      {
        cwd: ROOT,
        env: { ...process.env, TRAY_PREVIEW_DIR: outputDirectory },
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ mode, code: -1, stdout, stderr: error.message, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ mode, code, stdout, stderr, timedOut });
    });
  });
}

function isPng(file, width, height) {
  const bytes = fs.readFileSync(file);
  return bytes.length > 1000
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(16) === width
    && bytes.readUInt32BE(20) === height;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Native WinForms checks skipped: Windows PowerShell 5.1 is required.');
    console.log('通过 0 项，失败 0 项');
    return;
  }
  if (!fs.existsSync(HELPER)) throw new Error(`Appearance helper is missing: ${HELPER}`);
  for (const file of [HARNESS, HELPER]) {
    const bytes = fs.readFileSync(file);
    check(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${path.basename(file)} retains its PowerShell 5.1 UTF-8 BOM`);
  }

  const temporaryDirectory = keepPreviews || process.env.TRAY_PREVIEW_DIR
    ? null
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-tray-appearance-'));
  const outputDirectory = process.env.TRAY_PREVIEW_DIR
    ? path.resolve(process.env.TRAY_PREVIEW_DIR)
    : (temporaryDirectory ?? path.join(ROOT, 'state', 'ui-preview'));
  const removePreviews = temporaryDirectory && outputDirectory === temporaryDirectory;

  try {
    // Native dialogs share the desktop foreground; each harness needs exclusive focus.
    const runs = [];
    for (const mode of ['Preview', 'ExitCancel', 'ExitConfirm', 'Responsive']) {
      runs.push(await runHarness(mode, outputDirectory));
    }
    for (const run of runs) {
      console.log(`\n[${run.mode}]`);
      const line = run.stdout.split(/\r?\n/).find((entry) => entry.startsWith('TRAY_RESULT '));
      if (!line) {
        check(false, `${run.mode} returns structured evidence`, [run.stdout, run.stderr].filter(Boolean).join('\n').slice(-3500));
        continue;
      }
      const result = JSON.parse(line.slice('TRAY_RESULT '.length));
      for (const item of result.checks) check(item.passed, item.name, item.passed ? '' : item.detail);
      check(run.code === 0 && !run.timedOut, `${run.mode} isolated process exits cleanly`, run.code === 0 ? '' : run.stderr.trim().slice(-1200));
      if (run.mode === 'Preview') {
        check(result.previews.length === 8, 'Light and dark menu/dialog render at 100% and 150%', String(result.previews.length));
        for (const preview of result.previews) {
          check(fs.existsSync(preview.path) && isPng(preview.path, preview.width, preview.height), `${preview.theme} ${preview.kind} ${preview.scale}% produces a real PNG with matching dimensions`);
          if (!removePreviews) console.log(`    ${preview.path}`);
        }
        for (const theme of ['Light', 'Dark']) {
          for (const kind of ['menu', 'dialog']) {
            const normal = result.previews.find((preview) => preview.theme === theme && preview.kind === kind && preview.scale === 100);
            const enlarged = result.previews.find((preview) => preview.theme === theme && preview.kind === kind && preview.scale === 150);
            check(
              Boolean(normal && enlarged && enlarged.width >= normal.width * 1.45 && enlarged.height >= normal.height * 1.45),
              `${theme} ${kind} 150% PNG is physically larger than 100%`,
              normal && enlarged ? `${normal.width}x${normal.height} to ${enlarged.width}x${enlarged.height}` : 'missing preview',
            );
          }
        }
      }
    }
  } finally {
    if (removePreviews) await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exitCode = 1;
}

await main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
