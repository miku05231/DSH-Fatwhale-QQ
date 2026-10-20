# qq-bridge 接口契约 (SPEC)

本文件是并行开发时唯一的接口真相来源。**实现只写自己负责的文件，导出签名必须与本文件一致。**

## 0. 环境事实（已实测，勿再假设）

| 项 | 值 |
|---|---|
| Node | v24.20.0（`/c/dev/nodejs-24.20.0/node`）|
| 依赖策略 | **零第三方依赖**。用 Node 内置 `WebSocket`（Node ≥22 全局可用）、`node:child_process`、`node:fs`、`node:path`、`node:events` |
| 模块格式 | **ESM**，`package.json` 里 `"type": "module"` |
| 平台 | Windows 10/11，路径含反斜杠，命令行是 `cmd` 语义 |
| 托盘运行时 | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -STA`（PowerShell 5.1，WinForms 可用）|
| DSH CLI | `dsh` 在 PATH（`/c/dev/nodejs/dsh`）|

## 1. 目录

```
D:\code\qq-bridge\
├─ package.json          # {"type":"module"}，无依赖
├─ config.example.json   # 模板
├─ config.json           # 运行时生成，含白名单，不入库
├─ SPEC.md
├─ src/
│  ├─ index.js           # 编排（由 lead 实现）
│  ├─ logger.js
│  ├─ config.js
│  ├─ onebot.js
│  ├─ security.js
│  ├─ queue.js
│  ├─ dsh.js
│  └─ sessions.js
├─ tray/TrayManager.ps1
├─ scripts/
│  ├─ setup.ps1
│  ├─ install-napcat.ps1
│  ├─ autostart.ps1
│  └─ smoke-test.js
├─ patches/headless-model.yml   # 已存在，勿改
├─ logs/                        # bridge-YYYY-MM-DD.log
└─ state/                       # status.json, sessions.json
```

## 2. 已验证的 DSH 调用协议

命令：

```
dsh --profile headless --patch <abs path to patches/headless-model.yml> \
    --json [--session-id <id>] <task text>
```

- 任务文本必须作为**独立 argv**传入（不经 shell 拼接）。
- 输出是 NDJSON（每行一个 JSON）。**首行**固定为：
  `{"type":"session","sessionId":"session-<uuid>","cwd":"..."}`
- 中间事件：`{"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end",...}`、
  `{"type":"text","text":"..."}`
- **最后一行**：`{"type":"final","text":"<最终回答>"}`
- 报错行：`{"type":"error","message":"..."}`，同时进程 stderr 也有文本。
- `--session-id` **只能用于已存在的会话**：不存在的 id 会直接失败并输出
  `dsh: session "<id>" does not exist; omit --session-id to start a new Session`。
  因此新建会话必须先不带 `--session-id` 跑一次，从首行的 `sessionId` 取回并持久化。
- 已验证会话续传：同一 `--session-id` 第二次调用能正确回忆上一轮内容。

## 3. 配置文件 `config.json`

```json
{
  "onebot": { "url": "ws://127.0.0.1:3001", "accessToken": "" },
  "dsh": {
    "command": "dsh",
    "profile": "headless",
    "patchPath": "patches/headless-model.yml",
    "cwd": "C:\\D\\DSH\\qq-bridge",
    "timeoutMs": 300000
  },
  "security": {
    "allowFrom": [],
    "allowGroups": false,
    "rateLimitPerMinute": 10,
    "maxChars": 4000
  },
  "behavior": {
    "queuedNotice": "收到，正在处理…",
    "maxReplyChunk": 1200,
    "showErrors": true,
    "wakeWord": ""
  },
  "logDir": "logs",
  "stateDir": "state"
}
```

- `security.allowFrom` 为**空数组时拒绝一切消息**并打日志警告（安全默认，绝不默认放开）。
- `wakeWord` 非空时，私聊消息需以该词开头才触发（可选）。
- 相对路径一律相对**项目根目录**解析。

## 4. 模块签名

### src/logger.js
```js
export function createLogger(name, opts = {}) // opts: {logDir, level, echo=true}
// 返回 { info(...a), warn(...a), error(...a), debug(...a), child(sub) }
// 写 logs/bridge-YYYY-MM-DD.log（追加，UTF-8，行首带 ISO 时间戳与级别）
// 按天切换文件；保留最近 7 天，启动时清理更早的
```

### src/config.js
```js
export const DEFAULTS = { /* 上面那份默认值 */ }
export function loadConfig(projectRoot, { createIfMissing = true } = {})
// 返回 { config, path }；文件缺失且 createIfMissing 时写 config.example.json 的副本
// 校验失败抛 Error，message 必须是人能看懂的中文，指出哪个字段错了
export function saveConfig(path, config) // 原子写（先写 .tmp 再 rename）
export function resolvePath(projectRoot, p) // 绝对路径原样返回，相对路径拼到 projectRoot
```

### src/onebot.js
```js
export class OneBot extends EventEmitter {
  constructor({ url, accessToken = '', log, reconnect = true })
  connect()            // 建立 WS；断线指数退避重连（1s→2s→…上限 30s）
  close()              // 主动关闭，不再重连
  get connected()      // boolean
  call(action, params, { timeoutMs = 15000 } = {}) // Promise<data>，失败 reject
  // 事件：
  //   'ready'      ()                       握手成功
  //   'message'    (msg)                    已归一化的消息对象，见下
  //   'disconnect' (err?)                   连接断开
  //   'error'      (err)
}
```
- 客户端模式：主动连 NapCat 的 WS 服务端。
- 有 `accessToken` 时在请求头带 `Authorization: Bearer <token>`。
- 归一化后的 `msg`：
  ```js
  { messageType: 'private'|'group', userId: number, groupId: number|null,
    text: string, raw: object }
  ```
- `text` 由 `message` 数组里 `type:'text'` 片段拼接；`at` 片段转成 `@昵称`；其余类型忽略并记 debug 日志。
- `call` 用自增 `echo` 关联响应；超时 reject。

### src/security.js
```js
export function isAllowed(userId, cfg)      // userId 在 security.allowFrom 中（数字或字符串都兼容）
export function checkGroupAllowed(msg, cfg) // allowGroups=true 且 @ 了机器人（self_id 不在归一化里，靠调用方传）
export class RateLimiter {
  constructor({ perMinute })
  take(key)   // boolean，超限返回 false
}
export function sanitizeText(text, maxChars) // 去控制字符、截断，返回 string
```

### src/queue.js
```js
export class SerialQueue {
  enqueue(key, fn)  // 同 key 串行、不同 key 并行；返回 Promise<fn 的返回值>
  size(key)         // 当前排队数（含正在跑的）
  get total()       // 全局在途数
}
```

### src/dsh.js
```js
export function runDsh(text, { sessionId = null, cfg, cwd, log, signal } = {})
// 返回 Promise<{ sessionId, finalText, events }>
// 用 spawn 起子进程，逐行 parse NDJSON
// - 从首行 session 事件取 sessionId
// - finalText 取自 type==='final' 的 text
// - timeout：超过 cfg.dsh.timeoutMs 或 signal.abort → kill 进程树并 reject
// - 进程非 0 退出且没有 final → reject(error message 含 stderr 尾部)
// - Windows 下 kill 用 taskkill /pid <pid> /T /F
```

### src/sessions.js
```js
export class SessionStore {
  constructor(stateDir)   // 读写 <stateDir>/sessions.json
  get(qqId)               // string|null
  set(qqId, sessionId)
  remove(qqId)
  all()                   // object
}
```
- 原子写；启动时若 JSON 损坏则重建并记 warn。

## 5. 进程契约 `state/status.json`

桥接进程每 5 秒（以及状态变化时）覆盖写：

```json
{
  "pid": 12345,
  "startedAt": "2026-10-19T23:00:00.000Z",
  "updatedAt": "2026-10-19T23:00:05.000Z",
  "connected": true,
  "onebotUrl": "ws://127.0.0.1:3001",
  "sessions": 3,
  "inFlight": 0,
  "queueDepth": 0,
  "lastMessageAt": "2026-10-19T23:00:04.000Z",
  "lastError": null
}
```
托盘靠它判断状态。进程退出时尽量删除或标记 `pid: 0`。

## 6. 托盘契约（launcher\Launcher.ps1）

> 历史：早期版本是 `tray\TrayManager.ps1`，已被 `launcher\` 下的一键启动器取代。

- 用 `powershell.exe -STA -NoProfile -WindowStyle Hidden -File launcher\Launcher.ps1` 启动。
  非 STA 时脚本会带 `-STA` 重新拉起自己再退出。
- WinForms `System.Windows.Forms.NotifyIcon`，图标**程序内用 System.Drawing 画**（不依赖外部 .ico）：
  - 绿 = NapCat 已登录 + DSH 运行中 + 桥接运行中
  - 黄 = NapCat 在跑但未登录，或桥接没起来
  - 红 = NapCat 没运行（RequireDsh 模式下 DSH 没运行也算红）
- 单实例互斥体 `Global\qqdsh-launcher`，失败时回退 `Local\`；捕获 `AbandonedMutexException` 视为接管。
- 菜单项：状态标题（点击立即刷新）、一键启动全部、一键停止全部、NapCat（启动/停止/重启/日志/
  WebUI/重新扫码）、DSH（打开界面/插件设置/重启）、桥接（启动/停止/重启/日志）、人格设置…、
  会话管理…、开机自启（勾选态）、退出。
- 启动桥接 = `node src\index.js`，工作目录为项目根，输出写 `logs\bridge-console.log`。
- 托盘每 2 秒刷新状态与图标。
- 退出流程：确认对话框 → Stop-Bridge → Stop-NapCat → Stop-Dsh → 销毁图标 → 退出；
  `finally` 里再兜底清理一次。
- 开机自启 = 在 `shell:startup` 写快捷方式，勾选状态每 2 秒与真实文件同步。
- 所有路径相对脚本所在目录的上一级（项目根）解析。

## 7. 铁律

1. **不得**给 `security.allowFrom` 填默认放行；空即全部拒绝。
2. 不得把任何 API key 写进代码或日志。
3. 不得引入第三方 npm 依赖。
4. 所有中文提示写进代码，不要用英文报错给终端用户看。
5. 编码分两类，**不要搞混**：
   - `src\` 下的 `.js` / `.yml` / `.json`：UTF-8 **无** BOM。
   - `launcher\` 与 `scripts\` 下的 `.ps1`：UTF-8 **带** BOM。PowerShell 5.1 读无 BOM 文件会按 ANSI 解码，
     脚本里的中文会碎成乱码，连语法解析都会失败。
