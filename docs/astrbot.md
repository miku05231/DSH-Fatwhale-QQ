# AstrBot 插件运行说明

v3.2.0 提供可选的 AstrBot 插件运行时。AstrBot 全局开关和新安装插件默认关闭；请只安装你信任来源与代码的插件。

## 安装与启用

1. 在控制台的“插件”页打开 AstrBot 管理区，由项目管理员安装可信插件、配置并查看任务状态。
2. 安装、更新或修改配置后，先检查配置和插件来源，再单独启用插件及 AstrBot 全局开关。
3. 在群策略中逐群选择允许使用的插件。群主或群管理员身份不会自动成为本项目管理员。
4. 每个群可使用现有 DSH 聊天或 AstrBot 插件 AI。AI 模式复用当前 DSH 模型设置，AstrBot 会话与原 DSH 会话分开保存。

## 权限与发送边界

- 群成员只能触发该群明确获准且已启用的插件；请求、工具执行和最终发送前都会重新检查适用权限。
- AstrBot 插件 AI 可使用获准的 AstrBot 插件工具，不继承 DSH 的本机电脑操作工具或项目管理员权限。
- 普通提醒的持久恢复仅覆盖 is_task=false 的提醒，并验证创建者和原会话来源；跨群或来源失效的投递会被拒绝。
- 天气每日推送仅适用于锁定样本中的 weather.daily 发送范围。项目管理员必须为具体插件与私聊或群聊目标创建主动授权；授权仅允许向该目标发送纯文本，不授予模型、工具或其他目标的权限。每次发送仍复核插件状态、群策略、目标与授权状态。
- 配置变更、插件生命周期变化或环境代际回退可能使已有调度来源或授权失效。提醒“任务”功能不在上述普通提醒范围内。

## 运行时与部署

- Windows 使用项目管理的独立便携 Python 与虚拟环境；不会注册系统 Python 或修改系统 PATH。
- NAS 使用可选的 astrbot Compose profile 和独立 sidecar。默认部署不会启动它；sidecar 的 RPC 不发布到宿主端口，并通过只读令牌挂载与容器权限限制保护边界。Compose 将 `QQ_NAPCAT_WEBUI_URL` 设为 `http://napcat:6099`，并将 `../data/napcat/config` 以只读方式挂载以读取 token；容器通过内部服务地址访问 NapCat，`localhost` 指向桥接容器自身。NAS 部署按项目的 [Docker 部署说明](Docker部署.md)操作。
- 回滚会恢复 AstrBot 整代环境快照，可能同时恢复共享依赖、插件配置和插件数据。执行前先考虑快照之后写入的数据。

## 版本、验证与兼容范围

当前锁定 AstrBot 4.29.3 和 Python 3.12.10。受控验证覆盖 Windows x64 与 NAS Linux amd64；其他操作系统和架构没有因此获得兼容承诺。DSH 0.2.1-rc.5 的 Windows/NAS 受控兼容检查通过，但生产 DSH 核心仍为 0.2.0-rc.2，未因这次检查升级。

四个固定上游样本和若干受控调度、日志场景的范围见 [v3.2.0 匿名验收摘要](releases/v3.2.0-verification.md)。它不等于真实 QQ 新适配投递、公开天气 API、真实模型供应商、从零安装或所有 AstrBot 插件均已验证。传递依赖没有全部哈希锁定；安装和镜像构建时仍会按上游元数据解析依赖。

Windows 进程和 NAS sidecar 用于隔离运行故障，不是抵御恶意 Python 插件的安全沙箱。仅安装可信插件。

## 许可

AstrBot、固定样本插件及其依赖按各自上游许可证使用。随项目分发的第三方声明见 [runtime/astrbot/THIRD_PARTY_NOTICES.md](../runtime/astrbot/THIRD_PARTY_NOTICES.md)；锁定版本与运行时清单见 [runtime/astrbot-lock.json](../runtime/astrbot-lock.json)。第三方声明不替代各插件自身许可证及其上游要求。
