# Docker 部署

镜像包含桥接和网页控制台，Compose 另起 NapCat。DSH 运行时与模型凭据需要单独准备。
验证范围和实际结果见 [Docker 验证报告](Docker验证报告.md)。

## 一、启动桥接与 NapCat

Linux：

```bash
cp .env.example .env
mkdir -p data/{config,state,logs,workspace,memory}
sudo chown -R 10001:10001 data/{config,state,logs,workspace,memory}
docker compose up -d --build
```

PowerShell（Docker Desktop 使用 Linux 容器）：

```powershell
Copy-Item .env.example .env
'config','state','logs','workspace','memory' | ForEach-Object {
  New-Item -ItemType Directory -Force -Path "data/$_" | Out-Null
}
docker compose up -d --build
```

启动前编辑 `.env`：`OWNER_QQ` 是聊天白名单，多个 QQ 号用英文逗号分隔。
`ADMIN_QQ_IDS` 才是电脑工具管理员，默认无人；需要时显式填写可信账号。
管理员也要符合聊天准入策略。设置自己的 `NAPCAT_WEBUI_TOKEN`。

- 控制台：`http://127.0.0.1:5830/`
- NapCat：`http://127.0.0.1:6099/webui/`，按面板提示登录 QQ。
- 宿主发布端口默认只绑定 `127.0.0.1`；服务器可用 SSH 转发访问。

只用现有 NapCat：将 `ONE_BOT_URL` 指向它的**正向 WebSocket**，再执行
`docker compose up -d --build bridge`。HTTP 或反向 WebSocket 地址不能替代它。
Docker Desktop 可用 `ws://host.docker.internal:3001` 连接宿主服务；
Linux 可填写实际可达地址或自行配置 host-gateway。

Linux 上 bind mount 会覆盖镜像原有目录权限，因此仅在镜像里 chown 不够。
上述五个目录须允许 UID/GID 10001 写入；不要给整个数据目录 `chmod 777`。
NapCat 自己的数据目录由其 `NAPCAT_UID`/`NAPCAT_GID` 管理，不与桥接目录混用。

未安装 DSH 时控制台和协议连接仍能启动，模型对话会失败。完整回复需继续准备运行时和凭据。

## 二、安装 DSH 运行时

不要直接挂载 Windows/macOS 的 npm 安装目录。运行时和 native 模块必须适配
Linux、CPU 架构以及 Alpine 的 musl。以下版本是本次实测版本，不表示最新版。

Linux：

```bash
mkdir -p data/dsh-runtime
docker run --rm \
  --mount "type=bind,source=$(pwd)/data/dsh-runtime,target=/opt/dsh" \
  node:22-alpine npm install --prefix /opt/dsh @deepseek-ai/dsh@0.2.0-rc.2
```

PowerShell：

```powershell
New-Item -ItemType Directory -Force data/dsh-runtime | Out-Null
$runtimePath = (Resolve-Path data/dsh-runtime).Path
docker run --rm --mount "type=bind,source=$runtimePath,target=/opt/dsh" `
  node:22-alpine npm install --prefix /opt/dsh @deepseek-ai/dsh@0.2.0-rc.2
```

新建本机 `compose.dsh.yml`：

```yaml
services:
  bridge:
    environment:
      DSH_COMMAND: /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
    volumes:
      - ./data/dsh-runtime:/opt/dsh:ro
```

`DSH_COMMAND` 只接受单个可执行文件或 JS 文件路径，**不要加 `node ` 前缀**，
也不要把 CLI 参数拼进去。JS 入口会由桥接使用容器内 Node 启动。
若第一节已经启动过桥接，先将 `data/config/config.json` 中的 `dsh.command`
改为 `/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`；已有配置不会从 overlay 环境变量重新生成。
设置好下一节的凭据后运行：

```bash
docker compose -f docker-compose.yml -f compose.dsh.yml up -d --build bridge
```

DSH 的 headless profile 首次启动会在 `DSH_HOME` 下初始化。
如需自定义模型和供应商，把配置放进容器的 DSH home，或将 Linux 可用的补丁文件挂载后设置
`DSH_PATCH`。补丁里的路径同样必须是容器内路径。空 `DSH_PATCH` 表示不附加补丁。

## 三、模型凭据

官方 API key 可直接填本机 `.env` 的 `DEEPSEEK_API_KEY`，不提交真实值。
也可以复用已有 DSH 凭据文件：

Linux：

```bash
cp ~/.dsh/.credentials.yaml data/dsh-credentials.yaml
sudo chown 10001:10001 data/dsh-credentials.yaml
sudo chmod 600 data/dsh-credentials.yaml
```

PowerShell：

```powershell
Copy-Item "$env:USERPROFILE/.dsh/.credentials.yaml" data/dsh-credentials.yaml
```

再给前面的 `compose.dsh.yml` 加上：

```yaml
services:
  bridge:
    environment:
      DSH_COMMAND: /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
      DSH_CREDENTIALS_FILE: /run/dsh-credentials.yaml
    volumes:
      - ./data/dsh-runtime:/opt/dsh:ro
      - ./data/dsh-credentials.yaml:/run/dsh-credentials.yaml:ro
```

必须先创建源文件，再启动 Compose；否则短语法可能创建同名目录。
entrypoint 将只读源复制到 `DSH_HOME/.credentials.yaml`，设置为 600 后再启动服务。
这也解决 Docker Desktop 文件共享把源文件显示成 777、DSH 拒绝读取的问题。
源文件需可被 UID 10001 读取；启动失败时查看日志，不要关闭 DSH 的权限校验。

每次启动都会重新导入已设置的凭据源；如改用 DSH 自身管理凭据，移除这项环境变量和只读挂载。
未提供 `DSH_CREDENTIALS_FILE` 时保留 DSH home 已有凭据。使用其他供应商还需对应的模型配置。
`.env` 和 `data/` 均已加入 Git 忽略列表。

## 四、环境变量和数据

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OWNER_QQ` | 空 | 聊天白名单；多个用逗号分隔，空则拒绝所有人 |
| `ADMIN_QQ_IDS` | 空 | 显式授予电脑工具权限的 QQ 账号，多个用逗号分隔 |
| `ONE_BOT_URL` | `ws://napcat:3001` | 正向 OneBot WebSocket 地址 |
| `ONE_BOT_TOKEN` | 空 | 与 NapCat 正向 WebSocket 的 token 一致 |
| `DSH_COMMAND` | `dsh` | 单个可执行文件或 JS 入口绝对路径 |
| `DSH_PROFILE` | `headless` | headless 配置档；容器生成配置关闭 desktop/companion |
| `DSH_PATCH` | 空 | 可选补丁；空表示不附加 |
| `DSH_CWD` | `/app/qq-workspace` | 工作区，须可写 |
| `DSH_HOME` | `/home/bridge/.dsh` | 使用命名卷 `dsh-home` 持久化 profiles、sessions、storages 和凭据 |
| `DSH_CREDENTIALS_FILE` | 空 | 可选只读凭据源，启动时导入并设置 600 |
| `DEEPSEEK_API_KEY` | 空 | 可选官方 API key，直接传给 DSH |
| `MEMORY_ROOT` | `/app/memory` | 记忆库目录 |
| `ALLOW_GROUPS` | `true` | 群聊开关；默认只有白名单用户能触发 |
| `WAKE_WORD` | 空 | 群唤醒词；空则靠 @ |
| `REFLECT_DAILY` / `REFLECT_TIME` | `true` / `04:00` | 每日反思设置 |
| `CONSOLE_PORT` / `NAPCAT_WEBUI_PORT` | `5830` / `6099` | 宿主发布端口 |
| `WEBUI_HOST` | 镜像中 `0.0.0.0` | 容器监听地址；直接本地运行仍默认 `127.0.0.1` |
| `TZ` | `Asia/Shanghai` | 运行时区 |

桥接配置字段只在**首次生成** `data/config/config.json` 时从环境变量写入。
后续编辑已有配置并重启桥接；不能通过更改 `.env` 覆盖旧配置。
端口映射、`WEBUI_HOST`、`DSH_HOME`、凭据源与 API key 是运行环境，
改动后用 `docker compose ... up -d --force-recreate bridge` 重建容器。

```text
data/
  config/config.json
  state/                 # 桥接会话绑定、人格库、表情包、反思状态
  logs/
  workspace/AGENTS.md
  memory/
  dsh-runtime/           # 可选的 Linux DSH 安装内容
  dsh-credentials.yaml   # 可选只读凭据源
  napcat/                # NapCat 配置和 QQ 登录态
```

DSH home 单独保存在 Docker 命名卷 `dsh-home`，实际卷名通常带 Compose 项目前缀。
它使用 Linux 文件权限，避免 Windows bind mount 将凭据显示为 777。
不要把 `DSH_HOME` 改到未持久化路径；需要修改时，也要同步修改卷挂载目标。

备份整个 `data/` **以及命名卷 `dsh-home` 的内容**，并保护其中凭据。
只备份桥接 `state/sessions.json` 无法恢复 DSH 对话。
`docker compose down` 保留命名卷；`docker compose down -v` 会删除 DSH 会话和凭据。
可用 `docker volume ls --filter label=com.docker.compose.volume=dsh-home` 查找实际卷名。

## 五、已有配置迁移

升级不会自动重写你的配置。旧容器已生成 `config.json` 时，先备份，
将以下字段改为容器绝对路径，再按需保留模型、名单和人格设置：

```json
{
  "stateDir": "/app/state",
  "logDir": "/app/logs",
  "dsh": { "mode": "headless", "companion": false, "patchPath": "", "cwd": "/app/qq-workspace" },
  "persona": { "path": "/app/qq-workspace/AGENTS.md", "dir": "/app/state/personas" },
  "stickers": { "root": "/app/state/stickers" },
  "plugins": { "dir": "/app/src/plugins" }
}
```

这只是迁移字段片段，不要用它覆盖整份配置。若原数据落在 `data/config/state`
或 `data/config/logs`，停服后将所需内容合并到 `data/state`、`data/logs` 并校验，
保留备份；不要直接删除旧目录。旧 DSH home 若尚在旧容器中，也应先复制出来再重建。

## 六、检查与停止

```bash
docker compose logs -f bridge
docker compose exec bridge node tools/cli.mjs status
docker compose restart bridge
docker compose down
```

使用 DSH overlay 时，管理容器的命令同样加
`-f docker-compose.yml -f compose.dsh.yml`。
容器中不使用托盘、桌面 companion 或 Windows 服务启停按钮；用 Compose 管理进程。

镜像 `HEALTHCHECK` 请求 `/api/overview`，`healthy` 只表示控制台 HTTP 可用，
不代表 NapCat 已登录或模型凭据有效。需要同时检查连接状态和实际回复。
默认发布端口限定本机；远程暴露控制台前需自行配置认证与访问边界。

```bash
node tests/docker-test.mjs
docker build -t qq-dsh-bridge:verify .
node tests/docker-runtime-test.mjs qq-dsh-bridge:verify
```

第一条只有静态校验；后两条真实构建、运行隔离容器，不向真实 QQ 联系人发送消息。
需要 Compose v2；NapCat 登录仍由真人完成。QQ 第三方协议有账号风险，请用测试账号验收。
