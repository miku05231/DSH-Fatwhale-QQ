# v3.1.2 测试与未测试说明

验证日期：2026-10-23，Asia/Shanghai。

本版包含 [v3.1.0 专项验证](verification-v3.1.0.md) 中的模型、页面同步和 NapCat 检测修复；此前 Electron 24/24、DSH Web + Edge 19/19、companion 55/55、独立宿主 13/13 等证据仍对应这些修复，不作为本次重新运行的全量测试计数。

## Windows 进程测试

v3.1.0 自动发行在 PowerShell 子进程期限处失败，未创建 Release。云端探针发现首次内置命令查询耗时 31.17 秒，模块路径包含机器级 Azure、SQL Server 等目录；fixture 的 `Get-CimInstance` 仍为 mock 函数。

测试子进程现先准备隔离 home，将 `PSModulePath` 限制为该 PowerShell 自带的模块目录，在就绪前加载 Management、Utility，分别限制启动与模块加载 60 秒、业务执行 15 秒。临时目录经 `fs.realpath` 统一为实际长路径，并断言与 .NET `GetFullPath` 一致。失败保留阶段、时间、退出信号和 PowerShell 错误，未放宽业务断言。

[Windows Process Control #39944738786](https://github.com/miku05231/DSH-Fatwhale-QQ/actions/runs/39944738786) 在提交 `535275c` 上通过全部 10 项，0 失败、0 跳过，约 7.9 秒；随后 v3.1.1 完整发行中的这组检查也通过。这些结果没有证明真实 QQ 登录能够永久保持。

## 托盘与完整发行

[v3.1.1 完整发行 #39945607564](https://github.com/miku05231/DSH-Fatwhale-QQ/actions/runs/39945607564) 的 Linux 和 Windows 前段模型、控制台、NapCat、包装与导出均通过，托盘首次状态池创建 1617ms、点击响应 2007ms 超过既有一秒断言，未创建 Release。

托盘现显式使用 `InitialSessionState.CreateDefault2()` 与四参数探测池工厂，避开旧运行配置的前台同步初始化。`BeginOpen`、后台实际状态查询、并发限制、池复用及退出清理保留。本机托盘两组复测通过，外观、退出与响应性 201/201；没有预热被测函数或放宽一秒断言。

完整预检 [Windows Release #39948029827](https://github.com/miku05231/DSH-Fatwhale-QQ/actions/runs/39948029827) 对提交 `51e7502` 运行，Linux 与 Windows 均通过。模型、控制台、NapCat、托盘、更新、EXE、管理员边界、对话语音与平台测试、四份资产构建和实际便携包隔离安装全部通过，发布步骤按 `verify_only` 设计跳过。最终正式资产与结果以 v3.1.2 标签的 GitHub Actions 为准。

v3.1.2 本机包装 159/159、公开导出 111/111 通过，实际生成便携包的隔离升级 66/66 通过，覆盖原版 v0.2.3 与当前安装器。包装与公开导出要求包含本版说明，继续排除本机账号配置、状态、日志、调查记录及私人工具。升级检查在临时安装目录中保留合成配置、会话、人格、记忆和自定义文件，不操作维护者运行中的安装。

## 验证边界

- 未新增真实 QQ 消息、语音或平台发布验收。
- NapCat 完整工作日、网络切换、休眠及 Windows 用户注销后的恢复仍待验证；短时在线和一次快速登录不证明永久免重新授权。
- 未新增真实 Docker、macOS 或 Linux 完整安装验证。
- 进程归属覆盖应用正常管理的启动方式；外部使用 Windows 8.3 短路径命令行启动同一安装时仍可能误判未运行。
- 原始测试报告及生产调查记录留在维护者本机。

## 复测

在隔离源码目录运行：

```powershell
node tests/run-all.mjs --only 'NapCat Windows'
node tests/run-all.mjs --only 托盘
node tests/run-all.mjs --only 封装应用
node tests/run-all.mjs --only 公开导出
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-release.ps1
node tests/release-update-test.mjs
```

实际内核检查使用固定 DSH 0.2.0-rc.2、临时 home 和 localhost 模型，不连接真实 QQ 或在线模型。
