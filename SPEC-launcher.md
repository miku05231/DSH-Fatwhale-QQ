# QQ-DSH 启动器 · 接口契约（SPEC-launcher）

本文件是启动器三个模块的**唯一真相来源**。实现必须严格匹配这里的函数签名与行为。

## 已确认的环境事实（不要臆测，直接用）

| 项 | 值 |
|---|---|
| 项目根 | `D:\code\qq-bridge` |
| NapCat 启动脚本 | `D:\code\qq-bridge\napcat\napcat.bat` |
| NapCat 进程特征 | 进程名 `node.exe`，命令行含 `napcat\apcat.mjs`（实际为 `napcat\napcat\apcat.mjs`） |
| NapCat WebUI | `http://127.0.0.1:6099`，token `change-me` |
| NapCat OneBot WS | `ws://127.0.0.1:3001`（NapCat 自己监听） |
| NapCat 数据目录 | `C:\Users\you\Documents\Tencent Files\NapCat\data` |
| DSH 可执行文件 | `C:\Users\you\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe` |
| DSH 进程名 | `DeepSeek Harness.exe` |
| DSH Web GUI | `http://127.0.0.1:5825` |
| 插件会话映射 | `C:\Users\you\.dsh\media\onebot\chat-sessions.json` |
| QQ 专用工作区 | `D:\code\qq-bridge\qq-workspace` |
| 人格文件 | `D:\code\qq-bridge\qq-workspace\AGENTS.md` |
| 机器人 QQ | `1000000001`（大肥鱼） |
| 用户 QQ | `1000000002`（主人） |
| PowerShell | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（5.1，**只能用 WinForms，不能依赖 PS7**） |
| 语言 | 所有界面文字用**简体中文** |

## 铁律

1. **零第三方依赖**：只用 .NET Framework 自带的 `System.Windows.Forms` / `System.Drawing` / `System.Net`。
2. **PowerShell 5.1 兼容**：不能用 `??`、`?.`、三元运算符、`Get-Content -AsByteStream`、`-Encoding utf8NoBOM`。用 `[System.IO.File]::ReadAllText()` 等 .NET 方法。
3. **源文件编码 UTF-8 with BOM**：PowerShell 5.1 读中文必须 BOM，否则乱码。写文件时用 `New-Object System.Text.UTF8Encoding($true)`。
4. **STA 线程**：WinForms 需要 STA。主脚本若检测到非 STA，用 `-STA` 重新拉起自己并退出（参考 `tray\TrayManager.ps1` 第 21-40 行）。
5. **单实例**：用命名 Mutex `Global\qqdsh-launcher` 防止双开。
6. **绝不写死密钥到日志**：NapCat token 只在内存里用于请求，打日志时打码。
7. **每个函数必须容错**：进程不存在、文件缺失、请求超时都不能抛未捕获异常，一律返回"未知/失败"状态。

## 模块划分与文件（严格不越界，避免并行冲突）

| 文件 | 负责 |
|---|---|
| `launcher\lib\ProcessControl.ps1` | 进程探测、启动、停止；NapCat 登录态判定；日志读取 |
| `launcher\lib\UiWindows.ps1` | 人格编辑窗口、会话管理窗口（两个 WinForms Form） |
| `launcher\Launcher.ps1` | 托盘图标、右键菜单、定时刷新、把所有功能接起来 |
| `一键启动.cmd` | 一键启动入口（lead 负责） |

后两个模块**只调用** ProcessControl 和 UiWindows 里声明的函数，不重新实现。

---

## `launcher\lib\ProcessControl.ps1`

只定义函数，不执行任何顶层逻辑（可安全 dot-source）。

```powershell
# 返回 PSCustomObject: @{ Running=[bool]; ProcessId=[int]; StartedAt=[datetime]|$null; Path=[string] }
function Get-NapCatProcess

# 返回 PSCustomObject: @{ Running=[bool]; ProcessId=[int]; StartedAt=[datetime]|$null }
function Get-DshProcess

# 启动 NapCat（若已在运行直接返回 $true）。用 Start-Process 调 napcat.bat，
# 工作目录设为 napcat 目录，窗口最小化。返回 [bool] 是否成功发起。
function Start-NapCat

# 停止 NapCat：先 Stop-Process 主进程，再清理残留的 node.exe（命令行含 apcat.mjs）。
# 返回 [bool]。
function Stop-NapCat

# 启动 DSH（若已在运行直接返回 $true）。返回 [bool]。
function Start-Dsh

# 停止 DSH。返回 [bool]。
function Stop-Dsh

# 探测 NapCat 登录态。
#   优先：对 WebUI 发 HTTP GET http://127.0.0.1:6099/api/QQLoginInfo （带 Authorization: Bearer <token>），
#   解析返回 JSON 判断是否已登录；失败则退化为"端口 3001 是否在监听"。
# 返回 PSCustomObject: @{ LoggedIn=[bool]; Account=[string]; Nickname=[string]; Detail=[string] }
function Get-NapCatLoginState

# 返回今天日志文件的完整路径（不存在返回 $null）。
# NapCat 日志可能在 napcat\logs\ 下；找不到就返回 $null。
function Get-NapCatLogPath

# 返回日志最后 N 行（字符串数组）。读不到返回空数组。
function Get-NapCatLogTail([int]$Lines = 80)

# 在资源管理器里打开路径（不存在则提示）。无返回值。
function Open-PathSafely([string]$Path)
```

## `launcher\lib\UiWindows.ps1`

只定义函数，不执行任何顶层逻辑。

```powershell
# 打开人格编辑窗口（模态）。读 qq-workspace\AGENTS.md，允许编辑并保存。
# 保存前自动把旧文件备份为 AGENTS.md.bak-<yyyyMMdd-HHmmss>。
# 窗口内提供「恢复默认人格」按钮（写入 DEFAULT_PERSONA 常量）。
# 返回 [bool] 是否保存过。
function Show-PersonaWindow

# 打开会话管理窗口（模态）。
# 上半部分 DataGridView 列出会话：QQ号 | 类型(私聊/群) | 会话ID | 最后活跃。
#   数据来源：读取 chat-sessions.json（键形如 "private:<qq>"），
#   并关联 DSH 会话目录里该会话的最后修改时间（找不到就显示"—"）。
# 按钮：「刷新」「重置选中会话」「打开工作区」「清空全部会话映射」。
#   「重置选中会话」= 从 chat-sessions.json 删除该键（下次聊天自动新建会话）。
# 返回 $null（无返回值要求）。
function Show-SessionWindow

# 默认人格文本常量（供 Show-PersonaWindow 使用），导出为 $script:DEFAULT_PERSONA
```

`DEFAULT_PERSONA` 内容：一段中文说明，告诉 agent 它现在通过 QQ 和主人聊天，要求：回复简短口语化、不用 Markdown 语法（QQ 不渲染）、不要输出代码围栏除非必要、默认用中文。

## `launcher\Launcher.ps1`

托盘主程序，可以执行顶层逻辑。

**图标**：用 `assets\app-icon.png`（648×648 头像）缩放成 32×32，状态用一个右下角小圆点表达：
- 不画点 = NapCat 已登录 + DSH 运行中（一切正常）
- 黄色 `#F1C40F` = 进程在但不满足绿色条件
- 红色 `#E74C3C` = NapCat 未运行 或 DSH 未运行

实现是 `New-AppStateIcon -State green|yellow|red -Size 32`：加载一次 png（`$script:AppIconImage`），每个状态各画一张位图再 `GetHicon()`，HICON 逐个 `DestroyIcon`；小圆点带白色描边，直径 `Size*0.34`，内缩 `Size*0.04`。开机自启快捷方式的 `IconLocation` 指向 `assets\app-icon.ico`（多分辨率 ico），`Sync-AutostartIcon` 在每次启动时把旧快捷方式改成新图标。**缺文件兜底**：png/ico 缺失时退回旧的 `New-LetterIcon`（实心圆 + 字母 Q），只记一条 WARN，不影响启动。人格窗口与会话管理窗口也换成这个图标（`$form.Icon = $script:IconGreen`）。

（DSH 未运行不一定算错——加一个 `$script:RequireDsh = $true` 开关；为 `$false` 时 DSH 状态不影响颜色。）

**右键菜单**（只有一项）：

```
退出（停止桥接与 NapCat）        ← 退出前弹确认框；DSH 不受影响
```

设计变更（2026-10-20，用户要求）：菜单不再承载任何操作，启动/停止/重启/日志/扫码/人格/会话/记忆库/开机自启全部在控制台里。托盘只负责常驻托盘 + 左键单击直达控制台 + 退出。

- 左键单击托盘 → `Open-WebUiConsole`（Edge `--app=` 打开控制台）；不绑双击，避免弹出两个窗口
- 退出时必须先 `Stop-Bridge`、`Stop-NapCat`，再销毁图标退出；**不再** `Stop-Dsh`
- 纯 Shell 模式下 NapCat 就是本机的 QQ，没有独立的 `QQ.exe`，停 NapCat 即等于退出 NTQQ

**刷新**：每 3 秒刷新图标颜色与状态文字（用 `System.Windows.Forms.Timer`）。
**日志**：写 `D:\code\qq-bridge\state\launcher.log`，保留最近 500 行。
**异常**：顶层 try/catch 包住，出错弹气泡而不是崩掉。

---

## 验收清单

1. `powershell -STA -File launcher\Launcher.ps1` 能在托盘出现图标，右键菜单只有「退出」。
2. 左键单击托盘 → 控制台窗口打开（Edge `--app=`）；控制台没起来时弹气泡提示。
3. 点「退出」→ 桥接与 NapCat 进程都消失，图标消失；DSH 仍在运行。
4. 控制台「人格」页能编辑、保存，`qq-workspace\AGENTS.md` 内容变化且生成 .bak。
5. 控制台「会话」页能列出 `private:1000000002`，重置后 `chat-sessions.json` 变空对象。
6. 控制台「系统」页能开关开机自启，快捷方式落在启动文件夹。
6. 所有模块文件均为 UTF-8 with BOM，中文不乱码。
