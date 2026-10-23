# v3.1.0 测试与未测试说明

验证日期：2026-10-23，Asia/Shanghai。以下为本版修复的针对性验证，不以 v3.0.0 全量测试计数替代本版验证，也不把模拟消息当成真实账号投递。

## 修复验证

| 范围 | 结果 | 证明内容 |
| --- | --- | --- |
| 模型能力与配置解析 | 87/87 | 按模型限制档位、未知能力、无思考模型、结构化 YAML 和手动目标保留 |
| 控制台接口 | 103/103 | 保存前校验、原配置保留、目标与实际及 pending/error 状态 |
| companion | 55/55 | 正确会话控制器、失败关闭、无重复回退、权限及重复 header 的实际回执 |
| 独立桌面宿主 | 13/13 | 恢复会话逐轮权限、取消和重复 header 的档位继承与清除 |
| 实际 Electron DSH | 24/24 | 隔离用户目录和本地模型，同一打开页面模型与档位同步、真实宿主退出和恢复 |
| 实际 DSH Web + Edge | 19/19 | 原会话、常开页面、未知能力拒绝、真实桥接排队及进程重启后 follow/manual/follow |
| 控制台 Edge 浏览器 | 64/64 | 登录状态更新、模型能力与回执展示及桌面/移动布局，无页面异常 |
| NapCat 健康检测 | 17/17 | 当前 WebUI 协议、缓存刷新、后备预算、鉴权冷却、OneBot 退出及脱敏轮转 |
| Windows 进程控制 | 8/8 | 安装归属、保存账号、日志保留、端口冲突与监听 owner、PS 5.1/7 兼容 |
| NapCat 控制台 | 8/8 | 真实状态和过期数据、检测器冷重建、两个隔离 Node 进程之间的日志与数据保留 |
| Windows EXE | 24/24 | 启动入口、已有服务、隔离 bootstrap 和路径兼容 |
| PowerShell 托盘响应 | 25/25 | 慢探测不阻塞界面，后台状态、runspace 复用与清理 |

Electron 使用 DSH 0.2.1-rc.2，Web 使用固定 DSH 0.2.0-rc.2。消息来自临时 OneBot，模型服务只监听 localhost；没有外部模型调用或真实 QQ 验收消息。非法选择拒绝、排队和重复 header 的新增断言在修复前真实失败，修复后通过。

生产仅验证正常重载 DSH 后新 companion 可用、协议及模型目录可读，关键配置、会话、人格、工作区、记忆、自定义工具和 NapCat 配置摘要保持不变。目标合法且等待下一轮时保留 pending，不伪造实际模型回执。NapCat 的一次真实重启后快速登录和超过一小时的在线采样只证明该观察范围。

## 发布验证

本机已完成包装 155/155、公开导出 107/107，生成 v3.1.0 便携包、源码包、EXE 和校验和；使用当前与 v0.2.3 安装器隔离安装该实际便携包，66/66 通过，原配置、会话、人格、记忆和用户文件均保留。

包装与公开导出检查会核对新版本说明、必要脚本、PS1 BOM 和本机数据排除。发行工作流在 Linux 检查固定内核，在 Windows 检查更新、EXE、包装、权限、模型和 NapCat 回归，生成三个安装文件与校验和，并用当前和 v0.2.3 安装器隔离安装实际便携包；全部通过后才发布。

本机测试原始报告与生产调查记录留在维护者本机，不进入 Git 或发行包。仓库没有独立 build、类型检查或 lint 命令，也未配置覆盖率百分比。

## 未完成的验收

- 本次部署后通过真实 QQ 发送消息、确认实际模型回执，以及真实文字/语音投递。
- NapCat 完整工作日、网络切换、休眠和 Windows 用户注销后的登录恢复。短时在线与一次快速登录不证明登录身份不会被服务端撤销。
- 本版真实 Docker 容器和 macOS/Linux 完整安装体验。Linux 内核兼容性检查不能代替这些验证。
- 长期真实群聊判定、QQ 定时推送、B站实际评论与 @。这些功能沿用 v3.0.0 的真实平台未验收边界。

## 复测入口

在没有真实配置的隔离源码目录运行，固定 DSH 0.2.0-rc.2：

```powershell
node tests/run-all.mjs --only NapCat --skip-net
node tests/model-follow-test.mjs
node tests/companion-test.mjs
node tests/desktop-permission-test.mjs
node tests/webui-test.mjs
node tests/package-test.mjs
node tests/export-public-test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-release.ps1
node tests/release-update-test.mjs
```

浏览器与 Electron 验证需要显式提供测试程序路径及对应 `QQ_TEST_REQUIRE_*` 环境变量；测试创建独立 DSH home 和浏览器资料目录，避免修改运行安装的数据。源码升级后，在任务空闲时正常重启 DSH 以加载新 companion。
