# v3.1.1 测试与未测试说明

验证日期：2026-10-23，Asia/Shanghai。

本版包含 [v3.1.0 专项验证](verification-v3.1.0.md) 中的模型、页面同步和 NapCat 检测修复，生产代码保持一致；此前 Electron 24/24、DSH Web + Edge 19/19、companion 55/55、独立宿主 13/13 等证据仍对应这些修复，不作为本次重新运行的全量测试计数。

## Windows 发布检查

v3.1.0 的自动发行在 Windows 进程控制测试的 15 秒子进程期限处失败。前置 Linux、模型、控制台、打包、升级和 EXE 检查已通过，正式 Release 未创建。该失败没有证据指向生产 QQ 身份失效。

后续云端探针中，首次内置命令查询耗时 31.17 秒，模块路径包含机器级 Azure、SQL Server 等目录；同一探针确认 fixture 的 `Get-CimInstance` 仍为 mock 函数。这支持测试环境中的模块发现耗时这一定位，没有证据要求修改生产 NapCat 逻辑。

本版先准备隔离 home，将测试子进程的 `PSModulePath` 限制为该 PowerShell 自带的模块目录，并在就绪信号前显式加载 Management、Utility。通过就绪信号分别限制启动与模块加载 60 秒、命令执行 15 秒。失败记录具体阶段、时间、退出信号和捕获的 PowerShell 错误；命令执行超时仍终止子进程。临时目录经 `fs.realpath` 统一为实际长路径，并断言与 .NET `GetFullPath` 一致；独立短路径模拟已复现并消除两处 fixture 匹配差异。进程控制本机 10/10 通过，包含新增的超时、模块隔离和路径一致性回归；云端由独立 Windows Process Control 与完整 Windows Release 工作流验证。

[Windows Process Control #39944738786](https://github.com/miku05231/DSH-Fatwhale-QQ/actions/runs/39944738786) 在提交 `535275c` 上通过全部 10 项，0 失败、0 跳过，约 7.9 秒。本机隔离目录复测包装 157/157、公开导出 109/109 通过。

发布工作流保留既有全部 Linux 和 Windows 检查、实际便携包构建以及当前和 v0.2.3 安装器的隔离升级检查。包装与公开导出要求包含本版说明，继续排除本机账号配置、状态、日志、调查记录及私人工具。正式资产和结果以 v3.1.1 标签的 GitHub Actions 为准。

## 验证边界

- 本版不新增真实 QQ 消息、语音或平台发布验收。
- NapCat 完整工作日、网络切换、休眠及 Windows 用户注销后的恢复仍待验证；短时在线和一次快速登录不证明永久免重新授权。
- 未新增真实 Docker、macOS 或 Linux 完整安装验证。
- 进程归属覆盖应用正常管理的启动方式；外部使用 Windows 8.3 短路径命令行启动同一安装时仍可能误判未运行。
- 生产数据保留和真实隔离模型验证范围详见 v3.1.0 说明。原始测试报告及生产调查记录留在维护者本机。

## 复测

在隔离源码目录运行：

```powershell
node tests/run-all.mjs --only 'NapCat Windows'
node tests/run-all.mjs --only 封装应用
node tests/run-all.mjs --only 公开导出
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-release.ps1
node tests/release-update-test.mjs
```

实际内核检查使用固定 DSH 0.2.0-rc.2、临时 home 和 localhost 模型，不连接真实 QQ 或在线模型。
