# NapCat Docker 与宿主插件

本版的部署主线是：**Docker 只运行 NapCat，DSH 在宿主常驻，桥接由 DSH 插件承载和管理。** 不需要为桥接或 DSH 构建容器，也不把 Docker／NAS 开发、构建或验收作为本版发布要求。

| 组件 | 运行位置与入口 |
| --- | --- |
| NapCat | 可在 Docker 中单独运行；自行按其说明准备、登录 QQ 并启用 OneBot 11 正向 WebSocket |
| DSH | 在宿主运行，提供插件管理与面板 |
| QQ 桥接 | 安装完整 DSH bundle 后由插件管理；本版完整 bundle 默认在 DSH 宿主进程内运行桥接核心 |
| 完整控制台 | 从插件面板点击「打开完整控制台」，在宿主的默认浏览器中打开 |

在桥接的 `onebot.url` 中填写**宿主 DSH 可达的 NapCat 正向 WebSocket 地址**，并保持 token 与 NapCat 配置一致。容器内服务名、容器内回环地址和 NapCat 管理页面地址不能直接当作宿主连接地址；具体地址取决于 NapCat 的网络与端口发布配置。

若发送文件需要共享目录，应使用 NapCat 容器可见的挂载路径，并单独确认读取权限；宿主的 Windows 路径不能直接当作容器内路径。

宿主准备与完整 bundle 的 Desktop／Web 安装步骤见 [README](../README.md#插件方式快速开始) 和 [控制台使用](console.md)。当前候选不包含 3.4 测试版的宿主内嵌桥接运行模式；不要仅凭“插件管理”将其理解为桥接已与 DSH 同进程运行。

仓库中已有的 `Dockerfile`、`docker-compose.yml` 和 `docker/` 材料保留为旧版可选材料，不属于当前主流程，也不代表本版对桥接或 DSH 容器部署作出验证承诺。本轮未安排 Docker／NAS 构建与运行验收；历史结果不能作为当前候选通过记录。候选验证边界见 [v3.3.0 验证记录](releases/v3.3.0-verification.md)。
