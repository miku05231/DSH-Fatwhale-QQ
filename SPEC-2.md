# SPEC-2 —— 记忆、控制台、能力扩展

> 本文件是 `D:\code\qq-bridge\SPEC.md` 的增补契约（SPEC.md 仍然有效，冲突时以本文件为准）。
> 目标来自用户原话：「给它接入记忆系统（如果可以请使用本机已有 Obsidian 构建），优化托盘应用程序能够打开 UI 为原生安卓风格。赋予它所有 DSH 自带的原生能力（包括 MCP 和 skills），赋予它自启动、自学习的权限与能力。」

## 0. 铁律（违反即返工）

1. **零第三方 npm 依赖**。只用 Node 24 内置模块（`node:fs`、`node:http`、`node:path`、`node:zlib` 等）。ESM，`import` 必须带 `node:` 前缀。
2. **不碰** `C:\Users\you\Desktop\学习` 这个 Obsidian 库（那是用户的学习笔记）。
3. Windows 上写的 `.ps1` 必须是 **UTF-8 with BOM**；`.js/.mjs/.json/.md/.html/.css` 必须 **UTF-8 无 BOM**。
4. 所有新增函数必须容错：记忆/控制台挂了绝不能让 QQ 收发消息失败。
5. 中文界面、中文注释。不要用 `subagent` 之类的英文词当 UI 文案。
6. 不要打印任何 token / 密钥；日志里出现一律打码。
7. 测试要用可重复的假数据，不许往真实群/真实 QQ 里发东西（除 lead 明确说明的验收步骤）。
8. 做完必须能通过：`node --check <每个 js 文件>`。PowerShell 用 `[System.Management.Automation.PSParser]::Tokenize` 校验。

## 1. 环境事实（已实测，别猜）

| 项 | 值 |
|---|---|
| 项目根 | `D:\code\qq-bridge` |
| Node | v24.20.0（`node`），全局 `WebSocket`、`fetch` 可用 |
| DSH | 0.2.0-rc.2，命令 `dsh`（`C:\Program Files\nodejs\dsh.cmd`） |
| Obsidian | 1.13.7 已安装，当前**未运行** |
| 用户库1 | `C:\Users\you\Documents\Obsidian Vault`（几乎空的，只有 `欢迎.md`）← **我们用这个** |
| 用户库2 | `C:\Users\you\Desktop\学习`（174 个 md，**禁止写入**） |
| 图片浏览器 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（支持 `--app=` 无边框窗口） |
| NapCat | `D:\code\qq-bridge\napcat\node.exe index.js -q 1000000001`，OneBot 端口 **3001**，WebUI 6099 |
| 桥接 | `node src\index.js`，状态文件 `state\status.json` |
| 托盘点 | `launcher\Launcher.ps1`（PS 5.1 + WinForms），bootstrap 在 `launcher\bootstrap.ps1` |
| 工具 | `tools\qq.mjs`（调 OneBot 任意 action）、`src\groupmem.js`（群消息 JSONL 记忆） |
| 人格文件 | `qq-workspace\AGENTS.md`（DSH 按目录自动注入） |
| 会话映射 | `C:\Users\you\.dsh\media\onebot\chat-sessions.json` |
| 自启动目录 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` |

## 2. 记忆库（Obsidian）布局

根目录：`C:\Users\you\Documents\Obsidian Vault\YourBot\`

```
大肥鱼/
├── 大肥鱼.md                 # 索引页（图谱入口），含 [[链接]] 到各部分
├── 10-人物/<QQ号>.md          # 一人一页
├── 20-群聊/<群号>.md          # 一群一页
├── 30-日志/YYYY-MM-DD.md      # 每日流水，追加式
├── 40-知识/<标题>.md          # 学到的东西 / 结论 / 教程
├── 50-反思/YYYY-Www.md        # 自学习产物：阶段反思
└── .attachments/             # 图片等（可选）
```

**Markdown 约定**（Obsidian 原生语法，不装插件也能用）：

```markdown
---
tags: [人物, QQ]
qq: 1000000002
updated: 2026-10-20
---

# 主人（主人）

- 关系：主人 / 管理员
- 偏好：喜欢短句、讨厌啰嗦
- 备注：…

## 相关
- [[20-群聊/200000001|示例群]]
```

要求：
- 每页都有 YAML frontmatter（`tags` / `updated` 至少两项）。
- 页内交叉引用一律用 `[[相对路径|显示名]]`。
- 追加式文件（日志）在文件末尾追加 `## HH:MM` 小节，**不要重写整个文件**；超过 400 条时按月份切分。
- 所有写盘用 **临时文件 + rename** 保证原子性。

## 3. `src/memory.js` 契约

```js
export class ObsidianMemory {
  /**
   * @param {{root: string, log?: object, maxSearchResults?: number,
   *          injectMaxChars?: number, dailySoftLimit?: number}} opts
   */
  constructor(opts)

  /** 建目录、索引页、必要子目录。幂等，可在每次启动时调用。 */
  async ensure()

  /**
   * 每轮对话结束后调用：写当天日志 + 必要时更新人物页。
   * 必须吞掉所有异常（失败只 log.debug）。
   */
  async captureTurn({ userId, nickname, groupId, groupName, userText, replyText, ts })

  /** 追加一条日志（自定义文本），供工具/反思脚本用 */
  async appendDaily(text, { ts, heading } = {})

  /** 合并式创建/更新人物页；facts 是字符串数组 */
  async upsertPerson({ qq, nickname, facts = [] })

  /** 合并式创建/更新群页 */
  async upsertGroup({ groupId, name, topic, facts = [] })

  /** 新建/覆盖一篇知识或反思笔记 */
  async writeNote({ dir = '40-知识', title, body, tags = [] })

  /**
   * 关键词检索。中文按 2-gram 切，英文/数字按词切。
   * @returns {Promise<Array<{path, title, score, snippet}>>}
   */
  async search(query, { limit = 8 } = {})

  /** 最近 n 天的日志（新→旧） */
  async recentDaily(n = 3)

  /**
   * 给 DSH prompt 用的记忆块：相关笔记 + 当天日志摘要，
   * 总长度不超过 injectMaxChars，用中文小标题分段。空则返回 ''。
   */
  async buildContext(query, { userId, groupId, maxChars } = {})

  /** 统计：文件数、各类目数量、总字节、最近更新时间 */
  async stats()
}
```

检索算法（简单可靠即可）：把候选文件全文按 CJK 2-gram + `\w+` 切词，计算 query 词在文档中的出现次数并除以文档长度归一，标题命中加 3 倍权重，`updated` 越新加一点分。**不要**引入向量库。

## 4. `tools/memory.mjs` 命令行契约

```
node tools\memory.mjs search <关键词> [--limit 8] [--json]
node tools\memory.mjs recent [--days 3] [--json]
node tools\memory.mjs person <QQ号> [--name 昵称] [--fact "…"]… [--json]
node tools\memory.mjs group <群号> [--name 群名] [--fact "…"]… [--json]
node tools\memory.mjs note --title "标题" --body "正文" [--dir 40-知识] [--tag x]… [--json]
node tools\memory.mjs daily "要记的内容" [--json]
node tools\memory.mjs stats [--json]
node tools\memory.mjs path        # 打印记忆库绝对路径
```

- 默认输出人读的中文；`--json` 输出机器可读。
- 退出码：0 成功，1 参数错误，2 运行错误。

## 5. 控制台（Material You / 原生安卓风格）

### 5.1 服务端 `src/webui/server.mjs`

```js
export function createWebUiServer({ config, configRoot, log, port = 5830 }) → {
  start(): Promise<{port:number}>,
  stop(): Promise<void>,
  url: string
}
```

- 监听 `127.0.0.1:5830`（被占用就 +1 顺延，最多试 10 个端口），**只绑本机**。
- 静态资源目录 `src/webui/public/`（`index.html`、`app.css`、`app.js`），零依赖手写。
- 全部响应 `Content-Type` 正确；JSON API 统一 `{ok:true,data}` / `{ok:false,error}`。
- **不提供任何写文件到任意路径的能力**，只暴露下列端点。

### 5.2 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 进程状态（复用 `state/status.json` + 端口探测）、NapCat 登录态、DSH 是否在跑、记忆库统计、今日消息数 |
| GET | `/api/logs?name=napcat\|bridge&lines=200` | 读 `logs\napcat-console.log` / `logs\bridge-console.log` 的尾部 |
| GET | `/api/memory/stats` | 同 `memory.stats()` |
| GET | `/api/memory/search?q=…&limit=8` | 同 `memory.search()` |
| GET | `/api/memory/note?path=…` | 读记忆库里的一篇 md（**路径必须限制在记忆根内**，防目录穿越） |
| POST | `/api/memory/note` | `{path, body}` 覆盖写一篇笔记（同样限制根内） |
| GET | `/api/persona` | 返回 `qq-workspace\AGENTS.md` 全文（UTF-8） |
| PUT | `/api/persona` | `{body}` 保存人格；保存前自动备份到 `state\persona-backup\AGENTS-<时间戳>.md` |
| GET | `/api/sessions` | 会话列表（读 `state\sessions.json` + `chat-sessions.json`） |
| DELETE | `/api/sessions/:key` | 清掉某个 QQ 号的会话映射（下一次对话重开） |
| POST | `/api/service/:name/:action` | name ∈ `napcat\|bridge\|dsh`，action ∈ `start\|stop\|restart` |
| GET | `/api/settings` / PUT | 读写 `config.json` 的**白名单/行为**字段（不含任何密钥） |
| GET | `/api/plugins` | 插件清单 + 开关 + 配置 + 加载失败（见 §14） |
| PUT | `/api/plugins/<name>` | `{enabled?, config?}`：写 `state/plugins.json` 与 `config.json` 的 `plugins.<name>` |
| POST | `/api/plugins/reload` | 重新扫描插件目录（返回 `applyHint` 说明要重启桥接才生效） |
| GET | `/api/model` | 模型快照：模式、桌面端模型、供应商清单、生效模型、runtime patch 路径（见 §11） |
| PUT | `/api/model` | `{mode:"follow"\|"manual", manual?:{provider, model, reasoningEffort}}`，写完立刻重算 runtime patch |
| GET | `/api/autostart` | `{enabled, shortcutPath, targetPath, arguments, bootstrapPath, available}`：读启动文件夹里的 `QQDshLauncher.lnk` |
| PUT | `/api/autostart` | `{enabled:boolean}`：创建/删除开机自启快捷方式（与托盘 `Enable-Autostart` 写同一份文件） |
| POST | `/api/open` | `{target:"memory"\|"memory-obsidian"\|"napcat-webui"}`：打开记忆库文件夹 / 用 Obsidian 打开索引页 / 用系统默认浏览器打开 NapCat WebUI（自动拼 `?token=` 登录，回传地址打码） |

服务实现要求：
- 进程控制复用 `launcher\lib\ProcessControl.ps1` 的能力时，**用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <临时脚本>`** 的方式调用，并把脚本写到 `state\webui\` 下；不要把 PowerShell 直接嵌进 JS 字符串里乱转义。
- 每个 action 60 秒超时，返回 `{ok, output}`。
- 日志里 token 一律打码（正则 `token[=:]\s*\S+` → `token=***`）。

### 5.3 前端（`src/webui/public/`）

必须做到「看起来像原生安卓 App」：

- Material You / Material 3：主色 `#6750A4`（深色 `#D0BCFF`），`--md-sys-color-*` CSS 变量，卡片圆角 28px，按钮 pill 形，FAB 56px，底部导航 80px 高、选中项有 pill 背景。
- 顶栏 `TopAppBar`（大标题 + 右侧状态点），底部 `NavigationBar` 七个页签：**概览 / 记忆 / 人格 / 会话 / 模型 / 插件 / 系统**（「模型」页是 §11 加的，「插件」页是 §14 加的）。
- 交互：点击有水波纹（ripple）、页面切换有 220ms 淡入位移、操作结果用 Snackbar 提示、下拉刷新。
- 概览页：三张状态卡（NapCat / 桥接 / DSH），每张有启动/停止按钮；下面「今日概览」显示记忆条目数与最近日志 5 行。
- 记忆页：搜索框 + 结果列表（点击展开正文）+ 编辑保存。
- 人格页：大文本框 + 保存按钮 + 「已备份」提示。
- 会话页：列表 + 清空按钮（要二次确认）。
- 系统页：端口、版本、日志查看（NapCat / 桥接切换）、打开 NapCat WebUI 的按钮（走 `POST /api/open {target:"napcat-webui"}`，用系统默认浏览器打开 `…/webui/?token=…`：后端从 `napcat\napcat\config\webui.json` 读 token 拼上，NapCat 的 `/web_login` 会直接登录；返回给前端的地址把 token 打码成 `***`，并带 `tokenAttached` 让界面提示「已带上登录 token」）。
- 深色模式跟随系统（`prefers-color-scheme`）。
- 单文件行数别太大：`index.html` ≤ 260 行、`app.css` ≤ 700 行、`app.js` ≤ 900 行。
- 不许引外部 CDN（离线可用），图标用内联 SVG。

## 6. DSH 原生能力（headless profile）

文件：`C:\Users\you\.dsh\profiles\headless\cordis.patch.yml`

现状：bundle = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`。已有 skill / subagent / workflow / goal / web 工具，**缺 MCP client**。

要补：
1. `@deepseek-ai/dsh-mcp-client` × 4（mempalace / duckduckgo / drawio / windows），配置照抄 desktop profile 的写法。
2. `skill-filesystem` 的 `customSkillDirs` 指向 `D:\code\qq-bridge\skills`。
3. 保留现有 `agent-default-model`（xianapi-ds）与 `llm-pi-ai` 注入，不能覆盖掉。
4. 改完必须验证：
   - `dsh --profile headless --dump-config` 能看到新条目
   - `dsh --profile headless --patch <我们的 patch> "一句话回答：你有哪些 MCP 工具？"` 能正常回答且不报错
   - 实测单次调用耗时，超过 40 秒要报告（聊天会卡）

## 7. 托盘 / 自启动集成

`launcher\Launcher.ps1` 增加：
- 右键菜单：「打开控制台」（用 msedge `--app=http://127.0.0.1:<port>/ --window-size=1180,820` 打开；端口从 `state\webui-port.txt` 读）
- 「记忆库」子菜单：打开 Obsidian 记忆库目录 / 在 Obsidian 里打开（若装了 Obsidian 就 `Start-Process obsidian://open?...`，否则打开文件夹）
- 自启动项默认**开启**，指向 `launcher\bootstrap.ps1`（隐藏窗口方式）

`launcher\bootstrap.ps1`：顺序 NapCat → 桥接 → **控制台** → DSH → 托盘；控制台起不来不能让整体失败。

## 8. 自学习

- `skills\记忆使用.md`、`skills\QQ工具.md`、`skills\自我改进.md`（DSH skill 格式：目录 + `SKILL.md`，带 frontmatter `name` / `description`）——注意确认格式，参考 `@deepseek-ai/dsh-skill` 的实现。
- `tools\reflect.mjs`：读最近 N 天日志 → 调 DSH 生成一份「反思笔记」→ 写入 `50-反思/`；幂等（同一天只写一次，除非 `--force`）。
- 桥接在每 N 轮对话后（`memory.reflectEvery`，默认 20）在后台触发一次反思，失败静默。
- 定时与手动（后加）：`src\reflect.js` 的 `createReflectScheduler` 每分钟读一次 `config.json`，按 `memory.reflectTime`（默认 `04:00`）一天触发一次，跨天补跑只补一次（`reflectCatchUp`）；写之前先把本周那篇备份成 `反思 YYYY-Www.md.bak-时间戳`（`reflectBackup`，保留最近 10 份）；跨进程用 `state\reflect-lock.json`（15 分钟僵尸锁可接管）避免桥接与命令行撞车；记账写 `state\reflect-state.json`。控制台记忆页「立即反思」= `POST /api/reflect`，状态 = `GET /api/reflect`，三个开关存 `memory.reflectDaily/reflectTime/reflectBackup`。

## 9. 测试与验收

新增 `tests\memory-test.mjs`（≥12 条断言）、`tests\webui-test.mjs`（≥10 条断言，含路径穿越攻击用例）、`tests\mcp-check.mjs`（检查 headless dump 里有 4 个 mcp 配置）。
所有测试必须能在无人值守下 `node tests\xxx.mjs` 跑完并打印 `通过 N 项，失败 0 项`。

**测试记账**：任何「需要真机/需要用户在场」的测试，一律先写进 `docs\测试清单.md` 的「待人工验证」表，不要擅自触发真实 QQ 消息。

---

## 10. 落地情况（2026-10-20 10:36 实测）

| 契约 | 落地文件 | 验证 |
|---|---|---|
| §2 记忆库布局 | `C:\Users\you\Documents\Obsidian Vault\YourBot`（9 文件 / 5 目录，`scripts\init-memory-vault.mjs` 幂等建库） | M01 |
| §3 `ObsidianMemory` | `src\memory.js`（54.6KB） | T08 100 项 |
| §4 `memory.mjs` | `tools\memory.mjs`（stats/search/recent/note/daily/path，均支持 `--json`） | T08 + M01–M03 |
| §5 控制台 | `src\webui\server.mjs` + `public\{index.html,app.css,app.js}`，默认 5830，端口写 `state\webui-port.txt` | T09（62 项）+ T10（30 项） |
| §6 原生能力 | `C:\Users\you\.dsh\profiles\headless\cordis.patch.yml` 注入 4 个 MCP + `customSkillDirs`；`skills\{memory-usage,qq-tools,self-improvement}\SKILL.md` | 手工 T17：39 个 MCP 工具 / 18 个 skill |
| §7 托盘 | `Launcher.ps1` 新增「打开控制台 / 记忆库」菜单（Edge `--app` 无边框）、自启首运行自动建；`bootstrap.ps1` 五步：NapCat → 桥接 → 控制台 → DSH → 托盘 | T12 审计 + M05–M07 |
| §8 自学习 | `tools\reflect.mjs`（读日志 → headless DSH 复盘 → 写 `50-反思`）；桥接每 `reflectEvery` 轮后台触发 | T15 + M09–M10 |
| §9 测试 | `tests\{memory-test,webui-test,e2e-memory,reflect-test,ui-cdp,run-all}.mjs`；`run-all` 记账到 `state\test-log\` | 13 项全过 / 180.9s |

**与契约的偏差（已修正并记录）**

1. `skills\*.md` 单文件形式行不通 —— DSH 的 skill 必须是「目录 + `SKILL.md`」，且 `name` 必须是 kebab-case（大写/中文会被静默丢弃）。改为 `skills\memory-usage\SKILL.md` 等三个目录。
2. `tests\mcp-check.mjs` 未实现 —— 校验 headless 的 MCP 需要真跑一次模型（12s 且有 token 成本），改为「手工 T17 + 审计脚本检查 patch 文件内容」双重覆盖。
3. `reflect.mjs` 需要「当天已存在就跳过」，但 `memory.mjs note` 并不支持 `--skip-if-exists`（原设计假设它支持）。改为在 `reflect.mjs` 里先查目标文件，查在就秒退（199ms），不再白烧一次模型调用。
4. `dsh` 在 Windows 上是 `dsh.cmd` 批处理，`spawn('dsh')` 会 ENOENT；且 dsh **没有** `--cwd` 选项。改为顺着 PATH 解析出 `node_modules\@deepseek-ai\dsh\lib\bin.js` 用当前 node 执行，工作目录靠 `spawn` 的 `cwd` 传。
5. 控制台端口不进 `config.json` —— 真相只有两处（服务端 `DEFAULT_PORT` 与启动器 `$ConsoleDefaultPort`），加第三份配置只会漂移；审计脚本改为校验两处一致。

---

## 11. 模型跟随 + 托盘左键直达（2026-10-20 12:36 落地）

用户要求原文（m02452）：「我想要能够跟随 dsh 的当前会话模型实时切换，同时我的想法是打开托盘图标直接跳转到控制台界面，而不是选择支，然后在控制台中能够进行操作」。

### 11.1 契约

| 项 | 契约 |
|---|---|
| 跟随源 | `C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml`（桌面端 profile 的补丁层，桌面端换模型就改它） |
| 解析方式 | **文本级抠块**，不引 YAML 库（零依赖铁律）：抠出 `llm-pi-ai.config.providers` 原文块 + `agent-default-model.config` 三行 + 供应商/模型清单 |
| 落地方式 | 生成 `state\model\runtime-model.yml`，作为**第二个 `--patch`** 叠在 `patches\headless-model.yml` 之后（后者在前、会被覆盖） |
| 生效时机 | 每条 QQ 消息**前**调用一次 `resolveModelPlan()` → 内容没变复用旧文件、变了才重写；**不需要重启桥接** |
| 兜底 | 桌面端文件缺失 / 结构不认识 / 写盘失败 → 返回空 patch 列表，自动回落到基础 patch 的固定模型，只记 warn，**不影响回消息** |
| 手动模式 | `state\model\model.json` 记 `{mode, manual, updatedAt}`；手动模式只认这里、不看桌面端；切回 follow 仍保留手动值，方便来回切 |
| 控制台 | 新增第 6 页「模型」：当前生效模型、模式分段开关（跟随 / 手动）、供应商 / 模型 / 思考强度三个下拉、重新读取、保存；`GET /api/model`、`PUT /api/model` |
| 托盘 | **左键单击 = 直接打开控制台**，不再绑双击（双击会先触发两次单击，弹两个窗口）；菜单项改名为「打开控制台（左键直达）」 |
| 命令行 | `tools\model.mjs`（show / follow / manual / providers / path，全部支持 `--json`） |

### 11.2 文件与字段

- 运行期生成物：`state\model\runtime-model.yml`（别手改）、`state\model\meta.json`（指纹 + 生效值 + 来源）、`state\model\model.json`（模式与手动值）
- `/api/model` 的 `data` = `{mode, manual, updatedAt, desktop, providers, effective, runtimePatch, generatedAt, reason, desktopLayer, efforts, basePatch}`
- 校验：`PUT /api/model` 的 `mode` 只能是 `follow` / `manual`；`manual` 模式下 provider/model 非空、无控制字符、长度受限，非法值一律 400

### 11.3 实测

- `node tools\model.mjs manual modian glm-5.3 high` 之后跑 `dsh --profile headless --patch patches\headless-model.yml --patch state\model\runtime-model.yml --dump-config`，输出里是 `provider: modian` / `model: glm-5.3`，确认 patch 覆盖顺序正确
- `PUT /api/model {mode:"follow"}` → 立刻恢复 `apikey-deepseek05/deepseek-flash`
- 测试：`tests\model-follow-test.mjs` 75 项（新增 `resolvePatchChain` 相关 7 项）、`tests\webui-test.mjs` 38 项（新增 5 项模型接口）、`tests\ui-cdp.mjs` 28 项（新增 8 项模型页）
- `dsh.js` 抽出 `resolvePatchChain()` 纯函数：相对路径按项目根解析、额外 patch 缺失静默跳过、顺序保证基础在前，均可单测

### 11.4 补强：真正在跑的进程也验过（2026-10-20 13:18）

- 控制台（PID 258564，5830）上直接打真接口：`GET /api/model` → `mode=follow`、`desktop=apikey-deepseek05/deepseek-flash`、6 个供应商；`PUT {mode:"manual", manual:{provider:"modian",model:"glm-5.3",reasoningEffort:"high"}}` → `state\model\runtime-model.yml` 末尾三行立刻变成 `modian / glm-5.3 / high`，再用**真的 dsh** `--profile headless --patch 基础 --patch runtime --dump-config` 看到 `provider: modian`、`model: glm-5.3`；`PUT {mode:"follow"}` → 全部回到 `apikey-deepseek05 / deepseek-flash / max`。即「控制台里操作 → 下一条消息生效」在真实环境闭环。
- 托盘进程 PID 249068 启动于 12:48:31，晚于 `Launcher.ps1` 的修改时间 12:29:02 → **运行中的托盘已经是带左键处理器的新代码**；AST 语法检查无错。
- 因为用户正在使用电脑（Windows MCP 返回 `USER_CONTROL`），没有真的用鼠标去点托盘，改用两层自动化代替：
  - 静态：`Add_MouseClick` 存在、处理器里有 `MouseButtons::Left` 判断、没有 `Add_DoubleClick`、处理器调用 `Open-WebUiConsole`（5 项）
  - 行为：把 `Open-WebUiConsole` 从 AST 里抽出来单独执行，Edge 换成一个记录参数的 `.cmd` 桩，断言参数是 `--app=http://127.0.0.1:5830/ --window-size=1180,820`；控制台没监听时只弹气泡、不开空窗口（7 项）
- 新增两个用例并登记台账：`tests\e2e-model-patch.mjs`（20 项，拿真桥接的 dsh argv，并验证桌面端换模型后下一条消息立刻跟上）、`tests\model-patch-real-dsh.mjs`（9 项，两层补丁交给真 dsh 合并）、`tests\tray-click-target.mjs`（12 项）→ 全量 **18 组 / 174.3 秒全过**（`state\test-log\20261020-132941.md`）。

---

## 12. 唤醒词语义修正（2026-10-20 13:03 落地）

### 12.1 现场

用户报「发送了信息但是完全没回」。查 `logs\napcat-console.log` 与群记忆：12:54:24 群 200000001 里主人发了 `@大肥鱼 给我写首藏头诗`，消息**进了群记忆但没有回复**；`state\status.json` 的 `lastMessageAt` 有值、`lastError` 为空、队列为空。

### 12.2 根因

配置里 `behavior.wakeWord = "大肥鱼"`（12:16 在控制台设置页写入）。**旧逻辑**（`src\index.js`）在 `checkGroupAllowed` 通过（已 @）之后，又无条件要求「去掉 @ 后的正文必须以唤醒词开头」：

```js
if (wakeWord) {
  if (!text.startsWith(wakeWord)) return;   // ← @ 了也被这句拦掉，且只有 debug 日志
  text = text.slice(wakeWord.length).trim();
}
```

于是「@ 了但没说唤醒词」= 静默丢弃，QQ 那头看到的就是「完全没回」，info 日志里也查不到。

### 12.3 修正后的契约

| 场景 | 是否处理 |
|---|---|
| 私聊（在白名单） | ✅ 直接说话即可，唤醒词可带可不带 |
| 群里 @ 了 | ✅ 不看唤醒词（**本次回归点**）|
| 群里没 @、但正文以唤醒词开头 | ✅ 被动搭话，正文里去掉唤醒词再交给 DSH |
| 群里没 @、也没唤醒词 | ❌ 不回（只写群记忆），原因记进 `status.json` |

其它改动：
- `security.js` 的 `isAtSelf()` 导出，编排层直接判「有没有 @ 我」；群号白名单仍由 `isGroupWatched()` 先把关，两个判断不再混在 `checkGroupAllowed()` 里。
- 每条「收到但不回」的消息都写 `state\status.json` 的 `lastDrop` / `lastDropAt`（原因如「没 @ 也没唤醒词」「不在 allowFrom」「触发限流」），`GET /api/overview` 的 `bridge.lastDrop` 透出，控制台「系统 → 运行信息」新增一行「最近忽略」。
- 控制台唤醒词输入框提示改为「只有群里没 @ 时才需要用它开头」。

### 12.4 验证

- 新增 `tests\wake-word-test.mjs`（假 NapCat + 假 dsh，5 项）：私聊无唤醒词能回 / 群里 @ 无唤醒词能回 / 群里没 @ 也不带唤醒词不回且 `lastDrop` 有原因 / 群里没 @ 但带唤醒词能回
- 实测重启桥接后（PID 259060），13:02:22 那条没 @ 的群消息被正确记为 `lastDrop`：「群 200000001 的消息既没 @ 我，也没以唤醒词「大肥鱼」开头」

---

## 13. 群成员唤不动它（2026-10-20 13:45 修正）

### 13.1 现场

用户在群里看到别人喊「大肥鱼」没反应（群 200000001，13:36–13:37 有多条这类发言），而主人自己说话没事。`state\status.json` 的 `lastDrop` 为空、消息**已经进了群记忆**（`state\groupmem\200000001.jsonl`），说明被静默丢弃的是「权限层」而不是「唤醒词层」。

### 13.2 根因

`config.json` 里 `security.allowGroupMembers = false`，而群友 QQ 不在 `security.allowFrom`（只有主人 1000000002）。`src\index.js` 的开启判定是：

```js
if (isGroup && !isOwner && config?.security?.allowGroupMembers !== true) {
  noteDrop(`群成员 ${userId} 不在 allowFrom，且 allowGroupMembers=false`);
  return;
}
```

即：**群友连「算不算在叫它」都进不去**，私聊主人不受影响。另外旧唤醒词只认 `startsWith`，而群友习惯把「大肥鱼」放在句子中间（「为什么大肥鱼不理我」）。

### 13.3 修正

| 配置 | 语义 |
| --- | --- |
| `security.allowGroupMembers` | `true` 允许非白名单群成员唤起它；`false` 只认 `allowFrom` 里的人。控制台「系统 → 行为设置」有同名开关 |
| `behavior.wakeWordMatch` | `contains`（默认）正文里出现唤醒词就算，整句原样交给 DSH；`prefix` 要求开头且把它剥掉 |

配套：
- `isGroupWatched()` 仍然先用 `allowGroupIds` / `allowGroups` 把关（群本身不准，谁喊都没用）。
- 群友触发的对话照样走群记忆 + 群会话（`g:<群号>`），不会污染主人的私聊记忆。
- 被忽略时 `lastDrop` 写明是哪一层挡的（群不在白名单 / 群成员不允许 / 没 @ 也没唤醒词 / 限流）。
- 控制台设置页新增两个开关：`#setWakeAnywhere`（唤醒词出现在句中就算）、`#setAllowGroupMembers`（群里所有人都能唤它）。

### 13.4 验证

- 新增 `tests\group-members-test.mjs`：两个真桥接实例对照（A：`allowGroupMembers=false` + `prefix`；B：`true` + `contains`），9 项全过。
- 全量 `run-all` 现为 21 组（见 `docs\测试清单.md` T23–T25）。

---

## 14. 插件系统（2026-10-20 14:10 落地）

参考 AstrBot 的插件模型：**插件 = 元数据 + 事件钩子 + 配置 schema + 控制台卡片**。完整设计见 [`docs\控制台架构.md`](docs/控制台架构.md)。

### 14.1 契约

| 文件 | 职责 |
| --- | --- |
| `src\plugins.js` | `PluginHost`：扫描 `src/plugins/*.js` → 校验 `meta` → 收集钩子 → 跑钩子（异常只记日志） |
| `src\plugins\<name>.js` | 一个插件；`meta.name` 必须等于文件名（`^[a-z0-9][a-z0-9-]*$`） |
| `state\plugins.json` | 每个插件的 `{enabled}` |
| `config.json` → `plugins.<name>` | 插件配置；`plugins.enabled=false` 关掉整套系统；`plugins.dir` 换目录 |

钩子与返回值：

| 钩子 | 时机 | 返回值 |
| --- | --- | --- |
| `onMessage` | 白名单/唤醒词判定之后、调 dsh 之前 | `{handled:true}` 接管本轮（不再调 dsh）/ `{text}` 改文本 |
| `beforeReply` | 同上，`onMessage` 之后 | 同上 |
| `afterReply` | dsh 回完、发送之前 | `{text}` 修饰最终回复 |

`ctx` = `{text,userId,nickname,isGroup,groupId,isOwner,message,reply(text),log,config,meta}`。插件按文件名排序，**上一个的输出是下一个的输入**。

### 14.2 控制台接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugins` | 插件清单（元数据 + 钩子 + 开关 + 合并后的配置 + 失败清单） |
| PUT | `/api/plugins/<name>` | `{enabled?, config?}`，写 `state/plugins.json` 与 `config.json` 的 `plugins.<name>` |
| POST | `/api/plugins/reload` | 重新扫描目录（不重启桥接；**桥接里的插件仍要重启桥接才变**，接口会如实返回 `applyHint`） |

### 14.3 落地与限制

- 自带示例 `src\plugins\ping.js`：私聊或 @ 它发 `/ping` → 立刻回 `pong 🐟`，不消耗 dsh 调用。
- 桥接启动时打印「插件已加载 N 个」，`status.json` 里有 `plugins` 数组与 `pluginsFailed`。
- 控制台「插件」页按 `configSchema` 自动生成表单（`string/text/bool/int/select`），开关与保存都即时落盘。
- **限制**：插件变更要重启桥接才生效（控制台提示，不假装热加载）；插件不能注入自己的前端页面（需要时再做静态资源白名单）。

---

## 15. 公开源码导出（2026-10-20 14:20 落地）

### 15.1 为什么要专门写个导出器

私有目录里混着：真实 QQ 号（`config.json`、`state/`、`logs/`、文档示例）、个人路径（`C:\Users\you`、Obsidian 库）、私有中转端点、WebUI token、NapCat 缓存（数百 MB）。直接 zip 一定会泄漏，所以做成**白名单 + 脱敏 + 自检**的脚本，可重复执行。

### 15.2 `tools/export-public.mjs` 契约

| 环节 | 行为 |
| --- | --- |
| 白名单 | `src/`、`launcher/`、`tools/`、`tests/`、`docs/控制台架构.md`、`docs/测试清单.md`、`README.md` |
| 黑名单 | `config.json`、`state/`、`logs/`、`napcat/`、`node_modules/`、`.credentials*` 目录/文件一律跳过 |
| 脱敏 | 见下表；同一路径的三种写法（原生 `C:\DSH`、JS 字符串 `C:\\D\\DSH`、小写化）都要换 |
| 生成 | `README.md`、`LICENSE`(MIT)、`.gitignore`、`.gitattributes`、`config.example.json`、`patches/example-headless-model.yml` |
| 自检 | 扫产物全部文本文件，命中 `1000000001`/`1000000002`/`200000001`/`Users\you`/`api.example.com`/`api.example.com`/`sk-xxxx`/WebUI token 即报错，退出码 1 |

替换表（关键几条）：`C:\Users\you` → `C:\Users\you`；`D:\code\qq-bridge` → `D:\code\qq-bridge`；机器人/主人/群号 → `1000000001`/`1000000002`/`200000001`；`api.example.com`、`api.example.com` → `api.example.com`；`modian` → `relay-a`。

`.ps1` 保持 UTF-8 + BOM 原样（`.gitattributes` 里 `*.ps1 -text`，不做换行转换；本机 git 缺 iconv，`working-tree-encoding=UTF-8-BOM` 会报 `failed to encode`）。

### 15.3 产物

- 输出目录 `D:\code\qq-bridge-public`（可用 `--out` 改），60 个文件、0.84 MB。
- 已 `git init -b main` + 首个 commit（`feat: initial public release of qq-dsh-bridge`），推 GitHub 前只需要换成自己的 remote。
- 在产物目录里单跑 `node tests\plugins-test.mjs` → 39 项全过，证明导出的是**能跑的源码**，不是快照垃圾。

### 15.4 验证

`tests\export-public-test.mjs`（28 项）：导出退出码 0 + 脚本自检通过；14 个必需文件存在；7 个私有目录/文件都不存在；产物里没有 QQ 号/个人路径/私有端点/token/密钥；产物 `src/plugins.js` 语法正确；README 有项目名、MIT、NapCat 风险提示。
---

## 16. 托盘菜单精简（2026-10-20）

用户反馈：右键菜单太长太丑，只需要「退出」；其余操作都在控制台里。

### 16.1 现状

```text
退出（停止桥接与 NapCat）     ← 唯一菜单项，点击弹确认框
```

- 「退出」= `Stop-Bridge` → `Stop-NapCat` → 销毁图标；**不再**停止 DSH（DSH 是桌面端，用户可能正在用）。
- 纯 Shell 模式下 NapCat 就是本机的 QQ（`napcat\node.exe`），没有独立 `QQ.exe`，停 NapCat 即「退出 NTQQ」。
- 左键单击托盘仍直达控制台（`Add_MouseClick` + Left 判断；不绑双击）。

### 16.2 原来在菜单里、现在在哪里

| 原菜单项 | 现在的位置 |
|---|---|
| 一键启动 / 停止全部 | 控制台「概览」页的服务卡片 |
| NapCat：启动/停止/重启 | 控制台「概览」页 NapCat 卡片 |
| NapCat：查看日志 | 控制台「系统」页的日志查看（切换到 NapCat） |
| NapCat：打开 WebUI / 重新扫码 | 控制台「系统」页「打开 NapCat WebUI」（`POST /api/open`，系统默认浏览器，自动带 `?token=` 登录） |
| DSH：打开界面 | 桌面端自己的窗口 / 控制台 |
| DSH：重启 | 控制台「概览」页 DSH 卡片 |
| 桥接：启动/停止/重启 | 控制台「概览」页桥接卡片（`POST /api/service/bridge/...`） |
| 桥接：查看日志 | 控制台「系统」页日志（切换到桥接） |
| 打开控制台 | 左键单击托盘；或直接访问 `http://127.0.0.1:5830` |
| 记忆库 | 控制台「记忆」页：打开文件夹 / 用 Obsidian 打开（`POST /api/open`） |
| 人格设置 | 控制台「人格」页 |
| 会话管理 | 控制台「会话」页 |
| 开机自启 | 控制台「系统」页「启动」卡（`GET/PUT /api/autostart`） |

### 16.3 新增的控制台能力

- `GET /api/autostart`：读 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QQDshLauncher.lnk` 的 TargetPath/Arguments，返回 `{enabled, shortcutPath, targetPath, arguments, bootstrapPath, available}`。
- `PUT /api/autostart {enabled}`：用 WScript.Shell 创建/删除同一份快捷方式（TargetPath = powershell.exe，Arguments = `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<bootstrap.ps1>"`，WindowStyle=7）。
- `POST /api/open {target:"memory"|"memory-obsidian"}`：`explorer.exe <记忆库>` 或 `cmd /c start "" "obsidian://open?path=..."`；目标不存在返回 404。
- 控制台前端：「系统」页新增「启动」卡（`#setAutostart` 开关 + 提示已启用路径），「记忆」页新增「打开文件夹」「用 Obsidian 打开」两个按钮；「系统」页的「最近忽略」一行显示桥接 `status.json` 的 `lastDrop`。

### 16.4 测试与验证

- `tests/tray-click-target.mjs`（18 项）：只保留退出项 + 6 个旧菜单项断言已消失 + `Open-WebUiConsole` 的 Edge `--app=` 参数（用 cmd 桩，不真点鼠标）。
- `tests/final-audit.mjs`：切换 `Invoke-LauncherExit` 函数体断言（只停桥接与 NapCat，不含 `Stop-Dsh`）；断言人格/会话编辑窗口代码仍在（只是入口从托盘换到控制台）。
- `tests/webui-test.mjs`（53 项）：`GET /api/autostart` 形状、`PUT` 非法 body 400、`POST /api/open` 非法 target 400、`normalizeNapcatWebUi` 五种输入归一化、概览里 `ports.napcatWebui` 是完整的 `…/webui/` 地址。
- 实测：控制台重启后 `GET /api/autostart` 返回 `enabled=true`（指向系统 powershell.exe）；`PUT true→false→true` 三次均成功回显；托盘重启后新 PID 321432，日志「托盘已就绪」；`ui-cdp` 28/28 无 JS 报错。
---

## 17. 黑白名单与群策略（2026-10-20 16:20 落地）

### 17.1 契约

| 配置 | 语义 |
|---|---|
| `security.denyFrom: [QQ号]` | 黑名单，**压过 `allowFrom`**：同时在两边也按拒绝处理；不进白名单逻辑 |
| `security.denyGroupIds: [群号]` | 同上，作用于群：被拉黑的群连「记群记忆」都不做 |
| `security.privatePolicy: "allowlist" \| "blacklist"` | 私聊策略：`allowlist`（默认）= 只有 `allowFrom` 里的人能聊（**`allowFrom` 为空 = 拒绝一切**）；`blacklist` = 除 `denyFrom` 外谁都能聊 |
| `security.allowGroups` | 兼容旧配置的总开关：`false` 时所有群消息直接丢（优先于白名单） |

判定顺序（`src/security.js`）：私聊 **`denyFrom` → `privatePolicy=blacklist` 放行 → `allowFrom` 命中才放行**；群 **`denyGroupIds` → 群总开关 `allowGroups` → `allowGroupIds` 白名单（非空时）**。任何一关不过都只 `noteDrop(reason)`，写进 `status.json` 的 `lastDrop`，QQ 侧不回复、不建会话、不写群记忆。

### 17.2 代码位置

- `D:\code\qq-bridge\src\security.js`：`denyListOf/denyGroupIdsOf/isUserBlocked/isGroupBlocked/privatePolicyOf/isAllowed/isGroupWatched`（后五个导出）。
- `D:\code\qq-bridge\src\index.js`：`rememberGroupMessage` 之前先 `isDeniedGroup`（被拉黑的群一个字都不记）；私聊/群聊主流程先 `isDenied`。
- 控制台：`SETTINGS_SPEC` 增加 `security.denyFrom`(csv)、`security.denyGroupIds`(csv)、`security.privatePolicy`(select：allowlist/blacklist)，前端「系统」页「私聊策略」「私聊黑名单」「群黑名单」三处可改。

### 17.3 验证

- `tests/blacklist-test.mjs` 20 项：黑名单压白名单、私聊拉黑后静默、`privatePolicy=blacklist` 放行陌生人、群整体拉黑连群记忆都不写、`allowGroupIds` 之外的群静默、配置自洽。
- 控制台接口/界面：`tests/webui-test.mjs` 覆盖设置读写；`tests/ui-cdp.mjs` 覆盖设置页渲染。

## 18. 封装成应用（2026-10-20 17:30 落地）

### 18.1 为什么要单独做

「导出可公开源码」是给人看仓库的，**不是给人跑的**：它不带 `tests/` 之外的一些脚本、README 也不写首次运行流程。封装应用（`tools/package.mjs`）的目标是：一个目录，拷到任何机器、任何路径，双击就能用。

### 18.2 产物契约

| 进入 | 不进入 |
|---|---|
| `src/ launcher/ tools/ tests/ docs/ patches/` | `config.json`、`state/`、`logs/`、`napcat/`、`qq-workspace/`、`node_modules/`、`dist/`、`.git/` |
| `README.md config.example.json package.json 一键启动.cmd start-tray.cmd setup.cmd install-napcat.cmd` | `tools/export-public.mjs`（开发用，含私有清单） |
| 生成物：`初始化配置.cmd`、`打包信息.json`、`<目录>.zip` | — |

- 文本脱敏沿用公开导出那套（QQ 号 / `C:\Users\you` / 私有端点 / WebUI token），并额外覆盖「JS 字符串里的双反斜杠写法」与「小写化写法」。
- 所有路径改为相对项目根：`launcher\lib\ProcessControl.ps1` 用 `$PSScriptRoot` 往上推，`tools/*.mjs` 用 `import.meta.url`；`.ps1` 保持 UTF-8 BOM。
- `初始化配置.cmd`（纯 ASCII，避免 code page 问题）：`config.json` 不存在时从 `config.example.json` 拷一份，然后打印下一步。

### 18.3 验证

`tests/package-test.mjs` **46 项**：必需文件 19 个存在、私有物 9 个不存在、文本零个人信息、`打包信息.json` 版本/时间戳/文件数、产物 `src/*.js` 语法检查、**真跑产物里的 `tests/blacklist-test.mjs`（退出码 0，证明拷贝后可执行）**、`.ps1` BOM、`ProcessControl.ps1` 无写死路径、`$PSScriptRoot` 定位、zip 生成且体积合理。

### 18.4 与公开仓库的关系

- 公开仓库 = `tools\export-public.mjs` → `D:\code\qq-bridge-public`（本地 git）
- 应用包 = `tools\package.mjs` → `D:\code\qq-bridge\dist\qq-dsh-bridge-<版本>\`
两者都不含私有信息，前者给贡献者读，后者给使用者跑。

---

## 19. 自定义路径：人格 / 记忆库 / 工作区（2026-10-20 18:20 落地）

### 19.1 契约

| 配置项 | 默认 | 含义 |
|---|---|---|
| `persona.enabled` | `true` | 关掉后不注入人格，完全靠 DSH 自己读工作区 `AGENTS.md` |
| `persona.path` | `qq-workspace\AGENTS.md` | 人格 Markdown 文件，任意位置 |
| `persona.maxChars` | `8000` | 注入上限，超出截断并标注 |
| `memory.root` | `记忆库` | Obsidian 记忆库根目录（不存在会自动建库） |
| `dsh.cwd` | 项目根 / `qq-workspace` | 传给 dsh 子进程的工作目录 |

路径写法：绝对路径原样；相对路径按**项目根**解析；`~` 展开成用户主目录；`%NAME%` / `$NAME` 按环境变量展开（不认识的原样保留，解析时报错）。解析实现集中在 `src/persona.js`：`expandPath` / `resolvePersonaPath` / `resolveMemoryRoot` / `resolveWorkspace`。

### 19.2 人格注入

- 桥接启动时建 `PersonaLoader`，每条消息前 `loadBlock()`，把 `[人格设定]\n<正文>\n\n` 拼在 prompt 最前面（私聊：`personaBlock + memoryBlock + text`；群聊：作为 `buildGroupPrompt` 的第三段，同样在群上下文之后、原消息之前）。
- 按 `mtime + size` 缓存，文件没变不重复读盘；文件缺失、不可读、被停用一律退化为空串，**不影响回话**。
- 去重规则：人格文件解析后若等于 `<dsh.cwd>\AGENTS.md`，标记 `skipped='dsh-auto'` 且不注入——DSH 自己会读工作区的 `AGENTS.md`，重复注入会让模型看到两份。

### 19.3 控制台接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/paths` | 三条路径的 `{raw, resolved, exists, isFile, isDir, bytes, updatedAt}`，外加 `requiresBridgeRestart:true` |
| POST | `/api/paths/check` | `{path}` → 解析结果与存在性，不落盘；前端失焦时即时提示 |
| PUT | `/api/settings` | 新增白名单字段 `persona.path`、`memory.root`、`dsh.cwd`，类型 `path`（空/超长/控制字符一律 400） |
| POST | `/api/open` | 新增 `target: "workspace"` / `"persona"`，打开工作区或人格文件所在目录 |

系统页新增「路径」卡：三个输入框、每个下方一行「解析为：…（存在 / 还不存在）」、「保存路径」与「保存并重启桥接」。

### 19.4 验证

`tests/persona-test.mjs` **24 项**：`~` / `%VAR%` / 相对 / 绝对解析、默认值、`PersonaLoader` 注入包装、BOM 去除、mtime 缓存、文件变更重读、超长截断、缺失文件退化、停用跳过、工作区 `AGENTS.md` 去重；真桥接 + 假 dsh 段验证 **dsh 的 cwd 就是配置的工作区**、**记忆库落在配置的根目录（`大肥鱼.md` 存在）**、**prompt 里有 `[人格设定]` 与原文**。

`tests/webui-test.mjs` 增至 **77 项**（新增 `/api/paths` 形状、`/api/paths/check` 对 `~` 的解析、空路径 400、三条路径保存与回读、人格页写入配置指定的文件）；测试会先快照真实 `config.json`，结束时原样写回，避免污染机器人配置。`tests/ui-cdp.mjs` 增至 **35 项**（路径卡三个输入框、解析提示、重新读取不报错）。

---

## 20. 表情包库（2026-10-20 20:10 落地）

### 20.1 目标与口径

三个诉求：**自动采集对话里的表情包并打标签**、**自定义存放位置并可迁移**、**手动更新索引**。落成 `src/stickers.js`（纯函数 + 文件操作，不认 HTTP / OneBot）、桥接里一个采集器、一个 CLI、控制台第 8 个页签。

### 20.2 存储契约

- 根目录 = `resolvePath(configRoot, expandPath(stickers.root))`，默认 `state/stickers`；配置 `stickers` 块见 `config.js` 的 `DEFAULTS` 与 `config.example.json`。
- 图片路径 `YYYY-MM/<sha256 前 16 位><ext>`，扩展名由**图片头嗅探**决定（PNG / GIF / WebP / JPEG / BMP），不信任 QQ 给的文件名。
- 索引 `<root>/index.json`（`{version, updatedAt, items:[…]}`），tmp+rename 原子写；读取时 JSON 坏掉就改名 `index.json.bad-<ts>` 并退回空库里重建，不让桥接挂掉。
- 写锁 `<root>/.lock`（`wx` 独占创建，30 秒僵尸锁可接管，5 秒拿不到抛 `STICKER_BUSY`）。
- 体积门槛默认 200 B–5 MB；同一 sha256 重复出现只 `seen+1` 并补标签，不重复落盘。

### 20.3 标签

自动标签：`来源:群|私聊`、`群:<id>`、`用户:<昵称>`、`关键词:<词>`（去掉 CQ 码/URL/[图片]，汉字 2–4 字、口语前缀丢弃）、`标记:<QQ summary>`、`类型:动图|静态`、`尺寸:小图|中图|大图`（长边 ≤64 / ≤240）、`月份:YYYY-MM`。手工标签与自动标签同一个数组，`updateTags` 按增删合并去重（≤24 字）。

### 20.4 采集

`createStickerCollector({root,config,log,settings,fetchImpl,target})`：串行队列、每分钟上限、一条消息最多 N 张、`push()` 永不抛异常；`target()` 每张图前现问一次目录 → 控制台改目录/迁移后桥接 15 秒内自动跟上。桥接在**准入链之后、唤醒词判断之前**调 `push(msg)`，所以群里没人 @ 时的刷图也能收。prompt 里用 `stickerPromptHint()` 注入 `[表情包库] 攒了 N 张（动图 M 张），常用标签：…`，让它自己知道库里有货。

### 20.5 控制台（第 8 页「表情」）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/stickers` | 快照：`settings/root/count/bytes/animated/tags/lastAt/items`，支持 `tag`、`q`、`limit`(≤200)、`offset` |
| GET | `/api/stickers/file?id=` | 原图（`Cache-Control: private, max-age=60` + ETag）；文件没了 404、路径越界 400 |
| POST | `/api/stickers/rebuild` | 扫盘重建索引（同 sha 从旧索引继承标签/来源/首次时间） |
| POST | `/api/stickers/tag` | `{id, add?, remove?}`，缺 id / 空增删 400，找不到 404 |
| POST | `/api/stickers/delete` | 删索引项并删文件 |
| POST | `/api/stickers/migrate` | `{to}` 逐张复制校验 → 改写 `config.json` 的 `stickers.root` → 30 秒后补搬切换窗口内新写进旧目录的图；旧目录不删 |
| POST | `/api/open` | 新增 `target: "stickers"` |

`PUT /api/settings` 新增 `stickers` 组（`enabled/root/autoCollect/autoTag/maxBytes/minBytes/maxPerMessage/perMinute`）。

### 20.6 CLI

`tools/stickers.mjs`：`list / tags / pick / add / tag / delete / rebuild / stats / migrate / open`，全局 `--root`、`--json`、`--help`；`pick` 人读模式第一行只打绝对路径，方便 DSH 拿到路径直接发图；`migrate` 复制后改写 config，可 `--no-config` / `--delete-source`。

### 20.7 验证

`tests/stickers-test.mjs` **90 项**：嗅探（PNG 宽高、GIF 动图判定、非图片 null）、标签归一化与自动标签、入库/去重/seen、太小与非图片拒绝、改标签、筛选与搜索、索引重建、路径穿越、搬家校验、坏索引自愈、采集器（注入 fetch 不联网）、`/api/stickers` 全套。已登记 `tests/run-all.mjs`。

## 21. 多套人格（2026-10-20 21:30 落地）

### 21.1 目标与口径

以前只认一个文件（`persona.path`）。现在要能存多套、随时切，还能让不同的群用不同人格；老的单文件配置必须继续能用。

### 21.2 存储契约

- 人格库目录：`persona.dir`（默认 `state/personas`，相对路径按项目根）。
- 一套人格 = 一个 `<名字>.md`；名字 ≤40 字，不能含 `\ / : * ? " < > |`，不能只有点。
- 当前选择：`<dir>/active.json` → `{ "active": "名字", "chats": { "g:<群号>": "名字", "p:<QQ号>": "名字" } }`。
- 所有写操作走「临时文件 + rename」；`active.json` 坏掉时改名 `.bad-<时间戳>` 后当空状态，绝不让桥接起不来。
- 解析顺序（`resolvePersonaFor`）：会话覆盖 → `active.json` 的 active → `config.persona.active` → 老的 `persona.path` 单文件（`source` 分别为 `chat` / `global` / `config`）。

### 21.3 在线生效

`PersonaLoader` 每条消息前 stat 一次 `active.json`（stamp = mtime+size，没变不读），变了立刻换文件，不需要重启桥接；文件内容本身仍按 `file|mtime:size` 缓存。

### 21.4 /人格 指令

`/人格`、`/人格 <名字>`、`/人格 全局 <名字>`、`/人格 重置`、`/人格 全局 重置`、`/人格 新建 <名字>`；名字匹配顺序：精确 → 忽略大小写 → 唯一前缀。指令在唤醒词判断之前处理（群里不 @ 也认），但只有主人（`allowFrom`）能改。解析与文案在 `src/personas.js`（`parsePersonaCommand` / `buildPersonaListText` / `matchPersonaName` / `defaultPersonaTemplate`）。

### 21.5 控制台接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/personas` | 库快照：`dir` / `active` / `chats` / `mode`（library\|single）/ `resolution` / `items`（带 `active`、`preview`、`size`、`updatedAt`） |
| POST | `/api/personas` | 新建一套 `{name, body?}`；重名 409、名字非法 400 |
| DELETE | `/api/personas?name=` | 删除并清掉引用，返回 `{name, wasActive, clearedChats}` |
| PUT | `/api/personas/active` | 切全局当前 `{name}`；空串 = 取消 |
| PUT | `/api/personas/chat` | 按会话指定 `{chatKey, name}`；`name` 空 = 清掉该会话覆盖 |
| POST | `/api/personas/seed` | 把 `persona.path` 那份导入库（库非空则 `created:false`） |
| GET | `/api/persona?name=` | 读某一套（不传 name 用当前生效的）；不存在 404 |
| PUT | `/api/persona` | 保存 `{name?, body}`；保存前把旧内容备份到 `state/persona-backup/` |

### 21.6 界面

「人格」页拆成两张卡：**人格库**（名字首字方块 + 名字/预览/大小 + 用这套 / 编辑 / 删除，底部新建与导入按钮，右上角「当前：X」）与**人格内容**（标题标明在编哪套、文件路径、字节数、正文、重新载入 / 保存、备份提示）。新建走输入框弹层（`#promptScrim`），不用 `window.prompt`。

### 21.7 验证

`tests/personas-test.mjs` 144 项：名字清洗与目录解析、建读改删、全局/会话选择与解析回退、坏状态自愈、导入、加载器热切换与 `disabled`/`dsh-auto`/`missing` 三种跳过、指令解析与清单文案、`/api/personas` 全套（含备份与 400/404/409）。

