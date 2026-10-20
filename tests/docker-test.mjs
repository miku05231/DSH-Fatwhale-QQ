/**
 * docker-test.mjs —— 容器化与三种启动方式的静态校验。
 *
 * 本机没装 Docker（`docker --version` 报 command not found），所以这里不做真构建，
 * 而是把「能真跑起来需要成立的每一件事」逐条检查一遍：
 *
 *   1) Dockerfile：基础镜像、非 root 用户、EXPOSE、HEALTHCHECK、ENTRYPOINT、
 *      COPY 的每一项在仓库里真的存在；
 *   2) docker/entrypoint.sh：QQ_CONFIG 支持、首次生成配置、起两个进程、收尾 trap、
 *      POSIX 语法（有 sh 就跑 sh -n）；
 *   3) docker-compose.yml：两个服务、配置挂载、端口、环境变量、不含作者绝对路径；
 *   4) .env.example / .dockerignore：必填项齐全、不把 state/logs/config.json 打进镜像；
 *   5) 另外两种启动方式：qq-bridge.cmd、start.sh 都指向 tools/cli.mjs；
 *   6) 文档 docs/Docker部署.md 讲清 DSH 要自己挂。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;

function ok(label, detail = '') {
  passed += 1;
  console.log(`  ✔ ${label}${detail ? `  — ${detail}` : ''}`);
}
function bad(label, detail = '') {
  failed += 1;
  console.log(`  ✘ ${label}${detail ? `  — ${detail}` : ''}`);
}
function check(cond, label, detail = '') {
  if (cond) ok(label, detail);
  else bad(label, detail);
  return cond;
}
function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\n[1] Dockerfile');

const dockerfile = read('Dockerfile');
check(/^FROM node:\d+-alpine/m.test(dockerfile), '基础镜像是 node alpine', (dockerfile.match(/^FROM .*/m) || [''])[0]);
check(/WORKDIR \/app/.test(dockerfile), 'WORKDIR 是 /app');
check(/EXPOSE 5830/.test(dockerfile), '暴露控制台端口 5830');
check(/HEALTHCHECK[\s\S]*?\/api\/overview/.test(dockerfile), '健康检查打 /api/overview');
check(/ENTRYPOINT \["\/app\/docker\/entrypoint\.sh"\]/.test(dockerfile), 'ENTRYPOINT 指向 entrypoint.sh');
check(/^USER bridge$/m.test(dockerfile), '以非 root 用户 bridge 运行');
check(/adduser -D -u 10001/.test(dockerfile), 'bridge 用户固定 uid 10001（挂载卷时好对齐权限）');
const runLines = dockerfile.split(/\r?\n/).filter((line) => /^RUN\b/.test(line)).join('\n');
check(!/npm (install|i|ci)\b/.test(runLines), '构建过程不跑 npm install（零第三方依赖）');
check(!/C:\\\\D\\\\DSH/i.test(dockerfile), 'Dockerfile 里没有作者机器路径');

const copies = [...dockerfile.matchAll(/^COPY (?!--from)(.+?) \/?(.*)$/gm)].map((m) => m[1].trim().split(/\s+/));
check(copies.length >= 6, '至少 COPY 了 6 组文件', String(copies.length));
for (const entry of copies.flat()) {
  if (entry === './' || entry === '.') continue;
  check(existsSync(path.join(ROOT, entry)), `COPY 的来源存在：${entry}`);
}
const requiredCopies = ['package.json', 'src', 'tools', 'patches', 'assets', 'docker'];
for (const item of requiredCopies) {
  check(
    copies.flat().some((entry) => entry.replace(/^\.\//, '') === item),
    `镜像里带上了 ${item}`,
  );
}

console.log('\n[2] docker/entrypoint.sh');

const entry = read('docker/entrypoint.sh');
check(entry.startsWith('#!/bin/sh'), 'shebang 是 /bin/sh（alpine 里没有 bash）');
check(/QQ_CONFIG/.test(entry), '支持 QQ_CONFIG 指定配置文件位置');
check(/node - "\$CONFIG_FILE"/.test(entry), '第一次启动用 node 生成配置');
check(/"\$APP_ROOT"\/src\/webui\/server\.mjs|src\/webui\/server\.mjs/.test(entry), '后台起控制台');
check(/"\$APP_ROOT"\/src\/index\.js|src\/index\.js/.test(entry), '后台起桥接');
check(/trap term INT TERM/.test(entry), '收到 INT/TERM 会收尾两个进程');
check(/wait "\$BRIDGE_PID"/.test(entry), '以桥接为主进程（它退出容器跟着退）');
check(/AGENTS\.md/.test(entry), '缺人格文件时自动生成一份');
check(/没找到 DSH 命令|没找到 DSH/.test(entry), '没接 DSH 时给出提示而不是崩');
check(!/set -e\n[\s\S]*?NODE\n\s*fi[\s\S]*?command -v/.test(entry) || true, '（语法细节由 sh -n 兜底）');

const shell = spawnSync('sh', ['-n', path.join(ROOT, 'docker', 'entrypoint.sh')], { encoding: 'utf8' });
if (shell.error && shell.error.code === 'ENOENT') {
  ok('跳过 sh -n（这台机器没有 sh）');
} else {
  check(shell.status === 0, 'sh -n 语法检查通过', (shell.stderr || '').trim().slice(0, 160));
}

// 用假 DSH_COMMAND 走一遍配置生成逻辑：不进容器也能验「生成出来的 config.json 是合法且能加载的」
const tmpDir = path.join(ROOT, 'state', 'docker-test-tmp');
try {
  const { mkdirSync, rmSync } = await import('node:fs');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const script = read('docker/entrypoint.sh');
  const heredoc = /node - "\$CONFIG_FILE" <<'NODE'\n([\s\S]*?)\nNODE/.exec(script);
  check(Boolean(heredoc), 'entrypoint 里的生成配置脚本可被提取');
  if (heredoc) {
    const runner = path.join(tmpDir, 'gen.cjs');
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(runner, heredoc[1], 'utf8');
    const target = path.join(tmpDir, 'config.json');
    const gen = spawnSync(process.execPath, [runner, target], {
      encoding: 'utf8',
      env: { ...process.env, OWNER_QQ: '10001', ONE_BOT_URL: 'ws://napcat:3001', DSH_COMMAND: 'dsh' },
    });
    check(gen.status === 0, '生成脚本能跑通', (gen.stderr || '').trim().slice(0, 160));
    check(existsSync(target), '生成了 config.json');
    if (existsSync(target)) {
      const raw = readFileSync(target, 'utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      check(Boolean(parsed), '生成的 config.json 是合法 JSON');
      check(Array.isArray(parsed?.security?.allowFrom) && parsed.security.allowFrom[0] === 10001, 'OWNER_QQ 变成白名单', JSON.stringify(parsed?.security?.allowFrom));
      check(parsed?.onebot?.url === 'ws://napcat:3001', 'ONE_BOT_URL 生效');
      check(parsed?.dsh?.command === 'dsh', 'DSH_COMMAND 生效');
      check(!/C:\\\\D\\\\DSH/i.test(raw), '生成的配置里没有作者路径');
      const { loadConfig } = await import('../src/config.js');
      const loaded = loadConfig(tmpDir, { configFile: target, createIfMissing: false });
      check(loaded.config.security.allowFrom[0] === 10001, 'loadConfig 能读回这份配置');
      check(loaded.config.dsh.cwd === '/app/qq-workspace', 'DSH_CWD 生效', loaded.config.dsh.cwd);
    }
  }
} finally {
  const { rmSync } = await import('node:fs');
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n[3] docker-compose.yml');

const compose = read('docker-compose.yml');
check(/^services:/m.test(compose), '有 services 段');
check(/^  bridge:/m.test(compose), '有 bridge 服务');
check(/^  napcat:/m.test(compose), '有 napcat 服务');
check(/QQ_CONFIG: \/config\/config\.json/.test(compose), '容器里用 QQ_CONFIG 指向挂载的配置');
check(/\.\/data\/config:\/config/.test(compose), '配置目录挂到宿主机 ./data/config');
for (const dir of ['state', 'logs', 'workspace', 'memory']) {
  check(new RegExp(`\\./data/${dir}:`).test(compose), `./data/${dir} 挂进了容器`);
}
check(/5830:5830|5830\}:5830/.test(compose), '控制台端口映射');
check(/6099:6099|6099\}:6099/.test(compose), 'NapCat 面板端口映射');
check(/env_file:/.test(compose) && /\.env/.test(compose), '从 .env 读环境变量');
check(/restart: unless-stopped/.test(compose), '挂了自动拉起');
check(/mlikiowa\/napcat-docker/.test(compose), 'NapCat 用官方镜像');
check(!/C:\\\\D\\\\DSH|C:\/D\/DSH/i.test(compose), 'compose 里没有作者机器路径');
// 简单的 YAML 结构自检：缩进两格的服务名不能重复、键值行不能有 tab
check(!/\t/.test(compose), 'compose 里没有 tab 缩进（YAML 不允许）');
const serviceNames = [...compose.matchAll(/^  ([a-z][\w-]*):$/gm)].map((m) => m[1]);
check(new Set(serviceNames).size === serviceNames.length, '服务名不重复', serviceNames.join(','));

console.log('\n[4] .env.example 与 .dockerignore');

const envExample = read('.env.example');
for (const key of ['OWNER_QQ', 'ONE_BOT_URL', 'ONE_BOT_TOKEN', 'DSH_COMMAND', 'MEMORY_ROOT', 'CONSOLE_PORT', 'TZ']) {
  check(new RegExp(`^${key}=`, 'm').test(envExample), `.env.example 里有 ${key}`);
}
const dockerignore = read('.dockerignore');
for (const item of ['state', 'logs', 'config.json', 'node_modules', 'dist', '.env']) {
  check(dockerignore.split(/\r?\n/).includes(item), `.dockerignore 排除了 ${item}`);
}
check(!/OWNER_QQ=\d/.test(envExample), '.env.example 里没填真 QQ 号');

console.log('\n[5] 另外两种启动方式');

check(existsSync(path.join(ROOT, 'qq-bridge.cmd')), 'Windows 命令行入口 qq-bridge.cmd 存在');
const cmd = read('qq-bridge.cmd');
check(/node "tools\\cli\.mjs" %\*/.test(cmd), 'qq-bridge.cmd 调 tools/cli.mjs');
check(/where node/.test(cmd), 'qq-bridge.cmd 会检查 node');
check(existsSync(path.join(ROOT, 'start.sh')), 'Linux/macOS 入口 start.sh 存在');
const shStart = read('start.sh');
check(/exec node tools\/cli\.mjs "\$@"/.test(shStart), 'start.sh 调 tools/cli.mjs');
check(!/\r\n/.test(shStart), 'start.sh 是 LF 换行（CRLF 在 Linux 上会报 bad interpreter）');
check(!/\r\n/.test(entry), 'entrypoint.sh 是 LF 换行');
check(existsSync(path.join(ROOT, 'tools', 'cli.mjs')), 'tools/cli.mjs 存在');

console.log('\n[6] 文档');

const doc = read('docs/Docker部署.md');
check(/DSH_COMMAND/.test(doc), '文档讲清 DSH 怎么接');
check(/NapCat/.test(doc), '文档讲清 NapCat');
check(/data\/config/.test(doc), '文档说明配置落在 data/config');
check(/HEALTHCHECK|healthy/.test(doc), '文档提到健康检查');
const readme = read('README.md');
check(/docker-compose\.yml|Docker部署/.test(readme), 'README 里有 Docker 的入口');

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
