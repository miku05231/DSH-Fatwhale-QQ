#!/usr/bin/env node
// 最终审计：检查文件齐全、编码合规、无残留、配置自洽、关键实现点仍在。
// 任何一项失败都会让退出码非零。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasBom = (p) => {
  const b = fs.readFileSync(p);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
};
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\n[1] 必需文件');
for (const f of [
  'package.json', 'config.json', 'config.example.json', 'SPEC.md', 'SPEC-launcher.md', 'README.md',
  '一键启动.cmd', 'start-tray.cmd', 'install-napcat.cmd', 'setup.cmd',
  'patches/headless-model.yml',
  'tools/qq.mjs',
  'src/index.js', 'src/onebot.js', 'src/dsh.js', 'src/security.js',
  'src/sessions.js', 'src/config.js', 'src/logger.js', 'src/queue.js',
  'src/groupmem.js',
  'launcher/bootstrap.ps1', 'launcher/Launcher.ps1',
  'launcher/lib/ProcessControl.ps1', 'launcher/lib/UiWindows.ps1',
  'qq-workspace/AGENTS.md',
  'scripts/setup.ps1', 'scripts/install-napcat.ps1',
  'tests/smoke-test.mjs', 'tests/e2e-fake-napcat.mjs', 'tests/ws-harness.mjs',
  'tests/onebot-selftest.mjs', 'tests/real-config-check.mjs', 'tests/final-audit.mjs',
  'tests/group-whitelist.mjs', 'tests/groupmem-test.mjs', 'tests/perm-mode-check.mjs',
]) {
  check(f, fs.existsSync(path.join(ROOT, f)));
}

console.log('\n[2] 编码（SPEC §7：js/yml/json 无 BOM，ps1 必须有 BOM）');
for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter((x) => x.endsWith('.js'))) {
  check(`src/${f} 无 BOM`, !hasBom(path.join(ROOT, 'src', f)));
}
for (const f of fs.readdirSync(path.join(ROOT, 'launcher')).filter((x) => x.endsWith('.ps1'))) {
  check(`launcher/${f} 有 BOM`, hasBom(path.join(ROOT, 'launcher', f)));
}
for (const f of fs.readdirSync(path.join(ROOT, 'launcher', 'lib')).filter((x) => x.endsWith('.ps1'))) {
  check(`launcher/lib/${f} 有 BOM`, hasBom(path.join(ROOT, 'launcher', 'lib', f)));
}
for (const f of ['scripts/setup.ps1', 'scripts/install-napcat.ps1']) {
  check(`${f} 有 BOM`, hasBom(path.join(ROOT, f)));
}
check('AGENTS.md 无 BOM', !hasBom(path.join(ROOT, 'qq-workspace', 'AGENTS.md')));

console.log('\n[3] 无残留');
const strayTmp = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['napcat', 'node_modules', 'logs', 'state', '.git'].includes(e.name)) continue;
      walk(p);
    } else if (/\.tmp\.|_statecheck|_iconcheck|^_patch|^_fix|~$|\.bak-\d{8}/.test(e.name)) {
      strayTmp.push(path.relative(ROOT, p));
    }
  }
};
walk(ROOT);
check('无临时脚本残留', strayTmp.length === 0, strayTmp.join(', '));
check('无 .download 下载残留', !fs.existsSync(path.join(ROOT, '.download')));
check('无已废弃的 tray 目录', !fs.existsSync(path.join(ROOT, 'tray')));

console.log('\n[4] 配置自洽');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
check('config.json 是合法 JSON', true);
check('allowFrom 是数组', Array.isArray(cfg.security.allowFrom));
check('allowFrom 已填写', cfg.security.allowFrom.length > 0, `${cfg.security.allowFrom.length} 个`);
check('config.json 不含测试用户', !cfg.security.allowFrom.includes(123456789));
check('onebot.url 是本机地址', /^ws:\/\/127\.0\.0\.1:\d+/.test(cfg.onebot.url), cfg.onebot.url);
const patchAbs = path.isAbsolute(cfg.dsh.patchPath)
  ? cfg.dsh.patchPath
  : path.resolve(ROOT, cfg.dsh.patchPath);
check('patch 文件按项目根可解析到', fs.existsSync(patchAbs), patchAbs);
check('dsh.cwd 指向 qq-workspace（否则人格不生效）',
  path.resolve(ROOT, cfg.dsh.cwd) === path.join(ROOT, 'qq-workspace'), cfg.dsh.cwd);
check('config.json 与 example 顶层字段一致',
  JSON.stringify(Object.keys(cfg).sort()) === JSON.stringify(Object.keys(example).sort()));

console.log('\n[5] 关键实现点（桥接）');
const dshSrc = fs.readFileSync(path.join(ROOT, 'src', 'dsh.js'), 'utf8');
check('runDsh 接收 patchPath 参数', /patchPath: explicitPatchPath/.test(dshSrc));
check('相对 patchPath 按 projectRoot 解析', /projectRoot \|\| base/.test(dshSrc));
check('dsh.js 暴露 resolvePatchChain 供单测', /export function resolvePatchChain/.test(dshSrc));
check('额外 patch 缺失时静默跳过', /skipped\.push/.test(dshSrc));
const idxSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
check('index.js 把模型 runtime patch 传给 dsh', /modelPlan|extraPatchPaths/.test(idxSrc));
check('index.js 传入 projectRoot', /projectRoot: configRoot/.test(idxSrc));
check('index.js 自己判「有没有 @ 我」（isAtSelf）', /isAtSelf\(/.test(idxSrc));
check('index.js 里唤醒词不再是硬门槛（只在没 @ 时要求）', /byWakeWord/.test(idxSrc) && /!atSelf && !byWakeWord/.test(idxSrc));
check('inFlight 与 queueDepth 分开统计', /queueDepth: Math\.max/.test(idxSrc));
check('dsh.js 把 permissionMode 传给子进程',
  /DSH_PERMISSION_MODE/.test(dshSrc) && /permissionMode/.test(dshSrc));
check('config.json 开了 danger-full-access（否则 QQ 里没有 shell）',
  cfg.dsh?.permissionMode === 'danger-full-access', String(cfg.dsh?.permissionMode));
check('index.js 有群记忆', /GroupMemory/.test(idxSrc));
check('群记忆先记再判断要不要回', idxSrc.indexOf('rememberGroupMessage(msg)') < idxSrc.indexOf('!atSelf && !byWakeWord'));
check('被忽略的消息会写 lastDrop（排查「没回」用）', /lastDrop/.test(idxSrc) && /noteDrop\(/.test(idxSrc));
check('群里带上下文喂 DSH', /buildGroupPrompt/.test(idxSrc));
check('会话键区分私聊/群', /p:\$\{userId\}|`p:/.test(idxSrc) && /`g:/.test(idxSrc));

console.log('\n[6] 关键实现点（启动器）');
const bootSrc = fs.readFileSync(path.join(ROOT, 'launcher', 'bootstrap.ps1'), 'utf8');
check('bootstrap 用 -q 快速登录', /-q/i.test(bootSrc) || /QuickLogin|-q\b/.test(bootSrc));
const pcSrc = fs.readFileSync(path.join(ROOT, 'launcher', 'lib', 'ProcessControl.ps1'), 'utf8');
check('ProcessControl 探测 OneBot 端口', /3001|OneBotPort/.test(pcSrc));
const uiSrc = fs.readFileSync(path.join(ROOT, 'launcher', 'lib', 'UiWindows.ps1'), 'utf8');
check('UiWindows 读写 AGENTS.md', /AGENTS\.md/.test(uiSrc));
check('UiWindows 保存前备份', /bak-|备份/.test(uiSrc));
const launcherSrc = fs.readFileSync(path.join(ROOT, 'launcher', 'Launcher.ps1'), 'utf8');
check('托盘菜单只留退出项', /退出（停止桥接与 NapCat）/.test(launcherSrc) && !/-Text '一键启动全部'/.test(launcherSrc));
check('人格/会话编辑窗口代码仍在（改成可由控制台/代码调用）', /Show-PersonaEditor/.test(launcherSrc) && /Show-SessionManager/.test(launcherSrc));
const exitBody = (launcherSrc.split('function Invoke-LauncherExit')[1] || '').split('function ')[0];
check('退出时只停桥接与 NapCat（不停 DSH）', /Stop-Bridge/.test(exitBody) && /Stop-NapCat/.test(exitBody) && !/Stop-Dsh/.test(exitBody));
check('托盘单实例互斥体', /Global\\qqdsh-launcher/.test(launcherSrc));
check('托盘非 STA 时自我重启', /-STA/.test(launcherSrc));
check('托盘/窗口图标用 assets 里的头像，缺图退回字母图标',
  /New-AppStateIcon/.test(launcherSrc) && launcherSrc.includes('app-icon.png') && /New-LetterIcon -Color/.test(launcherSrc));
check('开机自启快捷方式指向 app-icon.ico', launcherSrc.includes('app-icon.ico'));
check('图标文件齐全（png + ico）',
  fs.existsSync(path.join(ROOT, 'assets', 'app-icon.png')) &&
  fs.existsSync(path.join(ROOT, 'assets', 'app-icon.ico')));
check('人格/会话两个窗口都换成应用图标',
  (uiSrc.match(/form\.Icon = \$script:IconGreen/g) || []).length === 2);
check('控制台网页 favicon 用 app-icon.png',
  /href="\/app-icon\.png"/.test(fs.readFileSync(path.join(ROOT, 'src', 'webui', 'public', 'index.html'), 'utf8')));

console.log('\n[7] 关键实现点（记忆 / 控制台 / 自学习）');
for (const f of [
  'src/memory.js', 'tools/memory.mjs', 'tools/reflect.mjs',
  'src/webui/server.mjs', 'src/webui/public/index.html',
  'src/webui/public/app.css', 'src/webui/public/app.js',
  'tests/memory-test.mjs', 'tests/webui-test.mjs', 'tests/ui-cdp.mjs',
  'tests/e2e-memory.mjs', 'tests/reflect-test.mjs', 'tests/run-all.mjs',
  'skills/memory-usage/SKILL.md', 'skills/qq-tools/SKILL.md', 'skills/self-improvement/SKILL.md',
  'docs/测试清单.md',
]) {
  check(f, fs.existsSync(path.join(ROOT, f)));
}

const memCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
check('config 有 memory 段', Boolean(memCfg.memory), memCfg.memory?.root ?? '');
check('memory.enabled 为真', memCfg.memory?.enabled === true);
check('记忆库根目录指向 Obsidian', String(memCfg.memory?.root ?? '').includes('Obsidian'));
const exCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
check('config.example 也含 memory 段', Boolean(exCfg.memory));
// 控制台端口由「服务端 DEFAULT_PORT + 启动器 $ConsoleDefaultPort + state/webui-port.txt」三者约定，
// 不放进 config.json（避免多一份会漂移的真相）。
check('控制台端口两处都是 5830', /DEFAULT_PORT\s*=\s*5830/.test(fs.readFileSync(path.join(ROOT, 'src', 'webui', 'server.mjs'), 'utf8')) && /ConsoleDefaultPort\s*=\s*5830/.test(launcherSrc));

const idx2 = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
check('桥接会召回长期记忆', /recallMemory/.test(idx2));
check('桥接会写回长期记忆', /captureToMemory/.test(idx2));
check('每 N 轮触发一次反思', /triggerReflection/.test(idx2) && /reflectEvery/.test(idx2));

const reflectSrc = fs.readFileSync(path.join(ROOT, 'tools', 'reflect.mjs'), 'utf8');
check('反思读取 items 字段', /parsed\.items|parsed\?\.items/.test(reflectSrc));
check('反思用 spawn cwd 而非 --cwd', /cwd:\s*WORKSPACE/.test(reflectSrc) && !/['"]--cwd['"]/.test(reflectSrc));
check('反思在调模型前先查重', reflectSrc.indexOf('fs.existsSync(targetPath)') < reflectSrc.indexOf('调 DSH'));

const webSrc = fs.readFileSync(path.join(ROOT, 'src', 'webui', 'server.mjs'), 'utf8');
// 记忆反思：手动按键 + 每天定时 + 覆盖前备份（SPEC-2 §8 后加）
const schedSrc = fs.readFileSync(path.join(ROOT, 'src', 'reflect.js'), 'utf8');
check('桥接装了反思定时器', /createReflectScheduler/.test(idx2) && /reflectScheduler\.start\(\)/.test(idx2));
check('反思定时默认 04:00', /reflectTime:\s*'04:00'/.test(fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8')));
check('重写前会备份这一周的反思', /backupReflectionFile/.test(schedSrc) && /\.bak-/.test(schedSrc));
check('跨进程反思锁（防桥接与命令行撞车）', /'reflect\.lock'/.test(schedSrc) && /acquireReflectLock/.test(schedSrc));
check('控制台有反思接口', /pathname === '\/api\/reflect'/.test(webSrc));

check('控制台导出 createWebUiServer', /export[^\n]*createWebUiServer/.test(webSrc));
check('控制台响应会脱敏', /redactSecrets/.test(webSrc));
check('控制台设置白名单化', /SETTINGS_SPEC/.test(webSrc));
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'webui', 'public', 'index.html'), 'utf8');
check('界面有八个页面（含模型页、插件页与表情包页）', (htmlSrc.match(/id="page-/g) ?? []).length === 8);
check('表情包页有网格与迁移按钮', /id="stickerGrid"/.test(htmlSrc) && /id="stickerMigrate"/.test(htmlSrc));
// 多套人格（SPEC-2 §21）
const personasSrc = fs.readFileSync(path.join(ROOT, 'src', 'personas.js'), 'utf8');
check('人格库模块有解析与指令', /export function resolvePersonaFor/.test(personasSrc) && /export function parsePersonaCommand/.test(personasSrc));
check('人格选择按会话优先', /chats\[key\]/.test(personasSrc));
check('人格 active.json 原子写', /writeState/.test(personasSrc) && /rename\(tmp/.test(personasSrc));
check('人格页有人格库列表与新建按钮', /id="personaList"/.test(htmlSrc) && /id="personaNew"/.test(htmlSrc));
check('人格页有输入弹层（不用 window.prompt）', /id="promptScrim"/.test(htmlSrc) && /promptDialog/.test(fs.readFileSync(path.join(ROOT, 'src', 'webui', 'public', 'app.js'), 'utf8')));
check('控制台有人格库接口', /pathname === '\/api\/personas'/.test(webSrc) && /\/api\/personas\/active/.test(webSrc));
check('桥接支持 /人格 指令', /personaCmd/.test(idx2) && /handlePersonaCommand/.test(idx2));
check('模型页有模式开关与保存按钮', /modelModeSwitch/.test(htmlSrc) && /modelSave/.test(htmlSrc));
check('界面有底部导航与 FAB', /id="navBar"/.test(htmlSrc) && /id="fab"/.test(htmlSrc));
const cssSrc = fs.readFileSync(path.join(ROOT, 'src', 'webui', 'public', 'app.css'), 'utf8');
check('FAB 定位没被 .ripple 覆盖', /\.fab\.ripple\s*\{[^}]*position:\s*fixed/.test(cssSrc));
check('有深色模式', /prefers-color-scheme:\s*dark/.test(cssSrc));

check('左键单击托盘直达控制台', /Add_MouseClick/.test(launcherSrc) && /Open-WebUiConsole/.test(launcherSrc));
check('菜单含记忆库', /Open-MemoryFolder|记忆库/.test(launcherSrc));
check('bootstrap 会拉起控制台', /Test-WebUiPortOpen|webui/i.test(bootSrc));
const startupLnk = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'QQDshLauncher.lnk');
check('开机自启动快捷方式存在', fs.existsSync(startupLnk), startupLnk);
check('托盘支持自启开关', /Test-AutostartEnabled|Enable-Autostart/.test(launcherSrc));

console.log(`\n${'='.repeat(56)}`);
console.log(fail === 0 ? '最终审计：全部通过' : `最终审计：${fail} 项失败`);
console.log('='.repeat(56));
process.exitCode = fail === 0 ? 0 : 1;
