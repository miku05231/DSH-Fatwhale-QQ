#!/bin/sh
# ============================================================
#  容器启动脚本
#
#  第一次启动时按环境变量生成 /app/config.json；之后再用就尊重卷里的那份配置
#  （想改配置：删掉 config/config.json 重新起，或者直接改挂出来的那个文件）。
#
#  环境变量：
#    OWNER_QQ        聊天白名单，多个 QQ 号用英文逗号分隔；空则拒绝所有人
#    ADMIN_QQ_IDS    电脑工具管理员，必须另行显式配置
#    ONE_BOT_URL     NapCat 的 OneBot 地址，默认 ws://napcat:3001
#    ONE_BOT_TOKEN   和 NapCat 那边配置的 token 一致；没设就空着
#    DSH_COMMAND     DSH 的可执行命令，默认 dsh（镜像里没有，要自己挂进来）
#    DSH_PROFILE     默认 headless
#    DSH_PATCH       可选，补丁文件的容器内路径；不设就不加 --patch
#    DSH_CWD         默认 /app/qq-workspace
#    DSH_TIMEOUT_MS  单次调用超时，默认 300000
#    MEMORY_ROOT     记忆库目录，默认 /app/memory
#    ALLOW_GROUPS    是否允许群聊，默认 true
#    WAKE_WORD       群里要不要叫名字才理人；空 = 不要求（靠 @）
# ============================================================
set -eu

APP_ROOT=/app
CONFIG_FILE="${QQ_CONFIG:-$APP_ROOT/config.json}"
DSH_WORKSPACE="${DSH_CWD:-$APP_ROOT/qq-workspace}"
export DSH_HOME="${DSH_HOME:-/home/bridge/.dsh}"
cd "$APP_ROOT"
mkdir -p "$APP_ROOT/state" "$APP_ROOT/logs" "$DSH_WORKSPACE" "$APP_ROOT/memory" "$DSH_HOME"
mkdir -p "$(dirname "$CONFIG_FILE")"
for dir in "$(dirname "$CONFIG_FILE")" "$APP_ROOT/state" "$APP_ROOT/logs" "$DSH_WORKSPACE" "$APP_ROOT/memory" "$DSH_HOME"; do
  if [ ! -w "$dir" ]; then
    echo "[entrypoint] 目录不可写：$dir；请给宿主挂载目录的 uid $(id -u) 写权限（见 docs/Docker部署.md）。" >&2
    exit 1
  fi
done

if [ -n "${DSH_CREDENTIALS_FILE:-}" ]; then
  node - "$DSH_CREDENTIALS_FILE" "$DSH_HOME/.credentials.yaml" <<'NODE'
const fs = require('node:fs');
const [source, target] = process.argv.slice(2);
const temporary = `${target}.tmp-${process.pid}`;
fs.writeFileSync(temporary, fs.readFileSync(source), { mode: 0o600, flag: 'wx' });
fs.renameSync(temporary, target);
NODE
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[entrypoint] 没找到 config.json，按环境变量生成一份"
  node - "$CONFIG_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const env = process.env;

function qqIds(value, name) {
  const ids = String(value || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error(`${name} 必须是英文逗号分隔的有效 QQ 号`);
  }
  return [...new Set(ids.map(Number))];
}
const allowFrom = qqIds(env.OWNER_QQ, 'OWNER_QQ');
if (!allowFrom.length) {
  console.warn('[entrypoint] 警告：没设 OWNER_QQ，白名单是空的 —— 机器人不会理任何人。');
}

const config = {
  onebot: {
    url: env.ONE_BOT_URL || 'ws://napcat:3001',
    accessToken: env.ONE_BOT_TOKEN || '',
  },
  dsh: {
    command: env.DSH_COMMAND || 'dsh',
    mode: 'headless',
    companion: false,
    profile: env.DSH_PROFILE || 'headless',
    patchPath: env.DSH_PATCH || '',
    cwd: env.DSH_CWD || '/app/qq-workspace',
    timeoutMs: Number(env.DSH_TIMEOUT_MS || 300000),
    permissionMode: 'danger-full-access',
  },
  persona: {
    enabled: true,
    path: (env.DSH_CWD || '/app/qq-workspace') + '/AGENTS.md',
    maxChars: 8000,
    dir: '/app/state/personas',
    active: '',
  },
  security: {
    allowFrom,
    adminUserIds: qqIds(env.ADMIN_QQ_IDS, 'ADMIN_QQ_IDS'),
    allowGroups: String(env.ALLOW_GROUPS || 'true') !== 'false',
    allowGroupMembers: false,
    allowGroupIds: [],
    rateLimitPerMinute: 10,
    maxChars: 4000,
  },
  behavior: {
    queuedNotice: '收到，马上回复。',
    maxReplyChunk: 1200,
    showErrors: true,
    wakeWord: env.WAKE_WORD || '',
    wakeWordMatch: 'contains',
    groupContextCount: 40,
  },
  groupMemory: { limit: 300 },
  memory: {
    enabled: true,
    root: env.MEMORY_ROOT || '/app/memory',
    capture: true,
    reflectEvery: 20,
    maxInjectChars: 1200,
    reflectDaily: String(env.REFLECT_DAILY || 'true') !== 'false',
    reflectTime: env.REFLECT_TIME || '04:00',
    reflectForce: true,
    reflectDays: 3,
    reflectBackup: true,
    reflectCatchUp: true,
  },
  stickers: {
    enabled: true,
    root: '/app/state/stickers',
    autoCollect: true,
    autoTag: true,
    maxBytes: 5242880,
    minBytes: 200,
    maxPerMessage: 3,
    perMinute: 20,
  },
  plugins: { enabled: true, dir: '/app/src/plugins' },
  logDir: '/app/logs',
  stateDir: '/app/state',
};

fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`[entrypoint] 配置已写入 ${file}`);
NODE
fi

if [ ! -f "$DSH_WORKSPACE/AGENTS.md" ]; then
  cat > "$DSH_WORKSPACE/AGENTS.md" <<'MD'
# 人格

你是一个在 QQ 上聊天的助手。

## 说话风格
- 简短、口语化，像真人发消息
- 不用 Markdown、不列表格（QQ 不渲染）
- 默认中文

## 人设
（在这里补充身份、口头禅、擅长什么、不聊什么……）
MD
  echo "[entrypoint] 生成了一份默认人格：qq-workspace/AGENTS.md（挂载你自己的会被直接使用）"
fi

node --input-type=module - "$CONFIG_FILE" <<'NODE'
import fs from 'node:fs';
import { resolveCommandPlan } from '/app/src/dsh.js';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const command = config.dsh?.command || 'dsh';
const plan = resolveCommandPlan(command, config.dsh?.cwd || '/app');
if (plan.error) {
  console.warn(`[entrypoint] 提醒：没找到 DSH 命令（${command}）：${plan.error}`);
  console.warn('[entrypoint] 控制台仍可用；请挂载 DSH，DSH_COMMAND 填入口文件路径，不要加 node 前缀。');
}
NODE

echo "[entrypoint] 启动控制台（:5830）与桥接…"
node "$APP_ROOT/src/webui/server.mjs" &
CONSOLE_PID=$!

node "$APP_ROOT/src/index.js" &
BRIDGE_PID=$!

term() {
  echo "[entrypoint] 收到退出信号，正在停止…"
  kill -TERM "$BRIDGE_PID" "$CONSOLE_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" 2>/dev/null || true
  wait "$CONSOLE_PID" 2>/dev/null || true
  exit 0
}
trap term INT TERM

# Alpine ash 的 wait -n 可能漏掉被信号终止的子进程。
while kill -0 "$BRIDGE_PID" 2>/dev/null && kill -0 "$CONSOLE_PID" 2>/dev/null; do
  sleep 1
done
STATUS=0
if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
  wait "$BRIDGE_PID" || STATUS=$?
else
  wait "$CONSOLE_PID" || STATUS=$?
fi
echo "[entrypoint] 子进程退出了（code=$STATUS），容器跟着退出"
kill -TERM "$BRIDGE_PID" "$CONSOLE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
wait "$CONSOLE_PID" 2>/dev/null || true
exit "$STATUS"
