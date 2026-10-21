# Docker 可行性验证报告

验证日期：2026-10-21（Asia/Shanghai）。基线提交：
`e94a86a3a6822155e032a893863f19e16176daa4`，本报告记录其问题及随后的修复复测。

**结论：修复后可在 Docker 中运行。** 镜像构建、宿主访问控制台、
隔离 OneBot 消息经过真实 DeepSeek 返回回复、容器重建后续聊均已通过。
镜像仍只包含桥接和控制台，完整部署必须另备 Linux 兼容的 DSH 运行时和模型凭据，
步骤见 [Docker 部署](Docker部署.md)。

## 环境

| 项目 | 实测值 |
| --- | --- |
| 宿主 | Windows，Docker Desktop，WSL2 Linux 引擎 |
| Docker Engine | 29.7.2，linux/amd64 |
| 基础镜像 | `node:22-alpine`，Node 22.23.2 |
| 容器用户 | `bridge`，UID/GID 10001 |
| 修复后测试镜像 | `qq-dsh-bridge:verify` |
| DSH | Linux 容器内安装 `@deepseek-ai/dsh@0.2.0-rc.2` |
| 真实协议端 | 已登录的 NapCat.Onebot 4.18.19 |

上述为实测版本，不表示最新版；未验证其他 CPU 架构或宿主系统。

## 修复与结果

| 原始问题 | 修复及复测证据 |
| --- | --- |
| WebUI 只监听容器 loopback，宿主映射端口不可达 | 镜像使用 `WEBUI_HOST=0.0.0.0`，Compose 发布到宿主 `127.0.0.1`；宿主请求返回 200 |
| `/config/config.json` 的相对路径令桥接与控制台读取不同状态 | 生成配置使用绝对 state/log/persona/sticker/plugin 路径；控制台显示 connected，内置插件成功加载 |
| 空补丁被解析为 `/config` 目录 | 桥接、WebUI 和反思工具保留空字符串语义；默认配置直接通过真实模型消息测试 |
| 文档把 `node 路径` 写成一个命令 | 示例改为实际 JS 入口绝对路径，复用现有解析器，无 shell 拆词 |
| Linux root:root/755 挂载目录不能写首次配置 | 镜像创建并授权 `/config`，文档说明 bind mount 的 UID 10001 权限准备；错误权限得到明确诊断，保持非 root |
| Node 22 WebSocket 握手失败只发 error，桥接退出且不重连 | error 进入既有关闭/重连路径；无服务启动保持存活，服务恢复后重新连接，迟到事件和主动关闭测试通过 |
| 只保留桥接绑定，DSH 会话在重建后丢失 | Compose 使用 `dsh-home` 命名卷；重建后真实模型使用同一会话绑定成功回复 |
| Windows 凭据挂载显示 777，DSH 拒绝读取 | 只读挂载凭据源，启动时原子复制到命名卷并设 600；实测权限和真实推理均通过 |
| 一个子进程异常退出后，容器仍可能运行 | 监控两进程并保留退出码；分别杀死控制台或桥接后容器退出 137，正常 SIGTERM 退出 0 |
| 反思超时使用 Windows 专属 taskkill | 复用现有跨平台 `killProcessTree`；反思工具支持 `QQ_CONFIG` 和空补丁 |

监督逻辑没有使用 Alpine `ash wait -n`：独立实测发现子进程被 SIGKILL 时它可能不返回。
使用 `kill -0` 每秒检查存活，再 `wait` 获取已退出进程状态。
另在临时容器验证两个进程分别退出 0、退出 7、被 SIGKILL，以及容器 SIGTERM，共 7 种情况。

聊天名单和电脑权限分开配置：`OWNER_QQ` 支持逗号分隔并校验账号，
`ADMIN_QQ_IDS` 才授予电脑工具权限，默认无人。旧配置不会自动重写，升级须按部署文档迁移。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| Dockerfile 镜像构建 | 成功 |
| Docker 静态检查及首次配置生成 | 104 通过，0 失败 |
| 真实容器，fixture DSH + 合成 OneBot | 15 通过，0 失败 |
| 真实容器，真实 DSH/DeepSeek + 合成 OneBot | 16 通过，0 失败 |
| OneBot 重连回归及原有自测 | 3 + 15 通过；本机 Node 24、容器 Node 22 各执行一次 |
| WebUI、模型跟随、Agent runner、管理员准入、工具隔离、反思调度、CLI | 397 通过，0 失败 |
| Compose 配置渲染及文档 YAML/JSON 示例 | 通过 |

运行时测试使用原始 entrypoint 生成配置，未事后改写配置来规避缺陷。
覆盖 HTTP、挂载状态、插件、消息回复、会话重建、凭据 600、断线存活、
正常关闭、两个子进程异常退出和 Linux 权限错误。工具隔离回归使用真实 DSH 内核及本地假模型。

基线镜像曾得到 fixture 5 通过/6 失败、真实 DSH 5 通过/7 失败；
上表为修复后的结果。回归范围限于本次相关模块，未声称整个仓库测试全部执行。

## 真实 NapCat 与验收边界

在用户授权下临时暂停 AstrBot，备份现有 NapCat OneBot 配置，
增加带随机 token 的临时正向 WebSocket，验证真实桥接连接、
`get_version_info`、`get_status`；QQ 状态 online/good 均为 true。

没有向真实联系人或群发送消息。结束后恢复配置并确认 SHA-256 一致，
删除临时配置项和备份，恢复 NapCat、AstrBot 运行。
后续修复测试均使用独立合成 OneBot，无需暂停这些服务。

真实协议连接与真实模型回复链路分别成立；真人从 QQ 发送消息并接收回复，
以及长期运行稳定性，仍需部署者实际验收。容器 HTTP healthy 只证明控制台可用。

## DeepSeek 复核

使用实际 `dsh headless` DeepSeek 进程进行 7 个独立审查任务，
覆盖 Docker 生命周期、DSH 凭据、部署文档、测试矩阵、结果边界和重连修复。
主代理执行构建、容器操作和最终复测；模型建议均经过代码或运行证据核对。
其中关于 `wait -n` 可正确监督 SIGKILL 的建议被实测推翻，未采用。

## 复现

不需要 QQ 登录或模型凭据的检查：

```powershell
node tests/docker-test.mjs
docker build --progress=plain -t qq-dsh-bridge:verify .
node tests/docker-runtime-test.mjs qq-dsh-bridge:verify
node tests/onebot-reconnect-test.mjs
```

真实模型测试先在 Linux 容器中安装运行时到一个 Docker 卷，例如：

```powershell
docker volume create qq-dsh-verify-dsh-runtime
docker run --rm --mount type=volume,source=qq-dsh-verify-dsh-runtime,target=/opt/dsh `
  node:22-alpine npm install --prefix /opt/dsh @deepseek-ai/dsh@0.2.0-rc.2
$env:DSH_VERIFY_RUNTIME_VOLUME = 'qq-dsh-verify-dsh-runtime'
$env:DSH_VERIFY_CREDENTIALS_FILE = Join-Path $env:USERPROFILE '.dsh/.credentials.yaml'
node tests/docker-runtime-test.mjs qq-dsh-bridge:verify
Remove-Item Env:DSH_VERIFY_RUNTIME_VOLUME
Remove-Item Env:DSH_VERIFY_CREDENTIALS_FILE
```

真实测试需要有效凭据，会产生模型 API 调用。凭据内容不会写入结果或仓库。
脚本清理自己创建的容器和临时 DSH home 卷，保留安装运行时的卷；
fixture 和真实模型结果分别写入被 Git 忽略的
`state/docker-fixture-results.json`、`state/docker-runtime-results.json`。
