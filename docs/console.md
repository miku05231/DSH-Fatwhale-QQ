# 控制台使用

本版主流程是让 DSH 在宿主常驻，由完整 `qq-bridge-companion` 插件管理桥接与控制台；NapCat 可在 Docker 中运行，通过宿主可达的 OneBot WebSocket 接入。安装后从插件面板管理桥接，无需另外启动独立桥接和控制台终端。

## 选择入口

| 入口 | 地址与模式 | 用途 |
| --- | --- | --- |
| DSH 插件页 | 宿主同源 `/qq-bridge/?mode=embed` | 日常状态、桥接控制、人格／模型／表情快捷操作、日志 |
| 插件「打开完整控制台」 | 后端生成本机动态端口，`?mode=full` | 完整九页；一次性授权进入 |
| 旧版独立控制台 | 默认 `http://127.0.0.1:5830/` | 保留的托盘／独立部署入口，不作为插件主流程 |

没有显式模式时根据是否在 iframe 内选择界面。功能页 hash 为 `overview`、`memory`、`stickers`、`persona`、`sessions`、`model`、`plugins`、`automation`、`system`；旧 `memes` 别名转到 `stickers`。

## 安装完整 DSH bundle

需要 DSH 0.2.2 插件管理功能，并保留完整桥接目录，不单独复制 companion 文件夹。

**Desktop**：打开原生插件管理页，添加本地目录，选择本项目的 `src/companion`，安装并启用，完全退出再打开应用。Desktop profile 由 Electron 管理，不使用普通 CLI 命令直接安装进 desktop profile。

**Web**：在桥接根目录执行：

```powershell
$companionPath = (Resolve-Path src/companion).Path
dsh plugin --profile web add ("file:" + $companionPath.Replace('\', '/'))
# 完成后重新启动使用该 profile 的 dsh web
```

若宿主插件管理界面提供启用开关，安装后还需启用。插件页应出现 `qq-bridge-companion` 详情与面板；只有服务端 discovery 文件不代表已安装客户端。

### 从旧 server-only 安装迁移

`node tools/install-companion.mjs` 的旧安装方式只往 profile 的 `cordis.patch.yml` 写服务端 `insert` 标记块，不登记完整客户端 bundle。

先备份相应 profile。安装完整 bundle 前删除旧脚本管理的标记块，或将它改为已有 `qq-bridge-companion` 的配置 override；不要保留第二个 `insert`。旧脚本的 `--remove` 只移除自己的标记块，不能代替宿主的完整 bundle 卸载操作。

源码与数据分开放置时，在相应 profile 的配置 override 中指定：

```yaml
- id: qq-bridge-companion
  config:
    runMode: embedded
    projectRoot: '<完整桥接源码根目录>'
    configFile: '<本机配置文件绝对路径>'
    workspacePath: '<QQ工作目录绝对路径>'
    sessionMapPath: '<本机state目录>/sessions.json'
```

用自己的路径替换占位符。不要把真实 profile、配置或 discovery 文件提交到仓库。

## 面板语义

- 完整 bundle 默认 `runMode: embedded`，启用后自动启动宿主进程内桥接；停止或禁用插件不退出 DSH。重启等待停止收尾后再启动，启动失败留在状态中。
- 管理员请求直接使用同一 DSH 宿主；普通成员仍走隔离 chat-only 子进程。启停不扩大工具授权。
- 未指定运行模式的旧 server-only／独立入口继续按 `standalone` 兼容。插件显式运行模式优先于配置文件；不要同时通过其它入口启动第二份桥接。
- 全局默认人格不会覆盖群／会话已指定的人格。
- 模型保存的是后续请求目标；最近实际使用项由运行结果更新，当前请求不会中途切换。
- 表情发送频率为 0 时暂停自动发送；表情库总开关关闭时，先去完整设置页启用所需功能。
- 清空日志只清当前显示，后续新记录继续追加，磁盘文件不变。

## 本机授权与排错

「打开完整控制台」只接受现有功能页名称。链接中的授权码 60 秒有效且仅可使用一次，成功后从浏览器地址中移除；会话最多 8 小时，并随控制台作用域退出失效。它不依赖复制 DSH 登录 Cookie。

链接过期时回插件页重新打开。插件停用／DSH 退出后，原动态端口关闭。不要把这个地址配置成固定服务端口，也不要把授权链接发给别人。

面板 404：检查完整 bundle 已启用、宿主已重启、源码根目录与配置路径正确。宿主没有 Web／认证服务时不挂载控制台。启动失败时阅读面板错误和本机日志，不通过放宽 CSP 或改成无认证 HTTP iframe 绕过问题。

NapCat／DSH 状态卡在内嵌页只读。完整系统维护动作可能影响共享协议端或整个 DSH 宿主，执行前确认当前环境。
