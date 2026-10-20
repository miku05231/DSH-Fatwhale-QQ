# Docker 部署

目标：一条命令在服务器 / NAS / 小主机上跑起来，不用装 Node、不用点托盘。

> 动手前先看清「三块东西」分别在哪：
>
> | 组件 | 作用 | 在容器里吗 |
> | --- | --- | --- |
> | **桥接 + 控制台** | 收 QQ 消息、调 DSH、网页管理 | ✅ 就是本镜像 |
> | **NapCat** | QQ 协议端，负责登录和收发 | ✅ 本仓库的 compose 带了一个（也可以换外部的） |
> | **DSH** | 真正生成回复的模型执行端 | ❌ 镜像里没有，要自己挂进来 |

---

## 一、最短路径

```bash
cp .env.example .env          # 填 OWNER_QQ（你的 QQ 号）
mkdir -p data/{config,state,logs,workspace,memory}
docker compose up -d
```

然后：

- 控制台：<http://127.0.0.1:5830/>
- NapCat 面板：<http://127.0.0.1:6099/webui/>（token 看 `.env` 里的 `NAPCAT_WEBUI_TOKEN`，默认 `qqdsh`）
- 扫码登录：NapCat 面板里扫，登录成功后桥接日志会出现「已连上 NapCat」

只想跑桥接（NapCat 用别处现成的）：`docker compose up -d bridge`，再把 `ONE_BOT_URL` 指到那台 NapCat。

## 二、DSH 怎么进去

镜像里不打包 DSH（它是模型执行端的运行时，体积大、更新频繁）。两种接法：

**A. 挂宿主机的 DSH（推荐）**

```yaml
# docker-compose.yml 的 bridge 段
services:
  bridge:
    volumes:
      - "/path/to/DeepSeek Harness:/opt/dsh:ro"
    environment:
      DSH_COMMAND: node /opt/dsh/lib/bin.js
```

`.env` 里 `DSH_COMMAND=node /opt/dsh/lib/bin.js`。

**B. 在镜像里自己装一层**

```dockerfile
FROM qq-dsh-bridge:0.1.0
USER root
# 按 DSH 的发行方式安装，然后回到 bridge 用户
USER bridge
```

> 没接 DSH 也能跑：控制台、收消息、记忆、表情包都正常，只是机器人不会回话。
> 启动日志会明确提醒「没找到 DSH 命令」。

## 三、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OWNER_QQ` | 空 | **必填**，你的 QQ 号；留空等于谁都不理 |
| `ONE_BOT_URL` | `ws://napcat:3001` | OneBot 地址 |
| `ONE_BOT_TOKEN` | 空 | 和 NapCat 的 token 一致 |
| `DSH_COMMAND` | `dsh` | DSH 可执行命令，可以是 `node /opt/dsh/lib/bin.js` |
| `DSH_PROFILE` | `headless` | DSH 配置档 |
| `DSH_PATCH` | 空 | 补丁文件路径；空 = 不套补丁 |
| `DSH_CWD` | `/app/qq-workspace` | DSH 的工作目录（人格文件 AGENTS.md 在这） |
| `MEMORY_ROOT` | `/app/memory` | 记忆库目录 |
| `ALLOW_GROUPS` | `true` | 是否允许群聊 |
| `WAKE_WORD` | 空 | 群里要不要叫名字；空 = 只靠 @ |
| `REFLECT_DAILY` | `true` | 每天自动反思 |
| `REFLECT_TIME` | `04:00` | 反思时间 |
| `CONSOLE_PORT` | `5830` | 宿主机映射的控制台端口 |
| `TZ` | `Asia/Shanghai` | 时区（定时反思靠它） |

这些变量**只在容器第一次启动、还没生成配置时**生效（生成 `data/config/config.json`）。
之后改配置：编辑 `data/config/config.json`（桥接每 5 秒读一次，热生效），或在控制台「设置」页改。

## 四、目录与数据

全部落在宿主机的 `./data/`，删容器不丢：

```
data/
├── config/config.json     # 配置（挂到容器 /config，QQ_CONFIG 指这里）
├── state/                 # 会话、队列、人格库、表情包索引、反思记账、锁
├── logs/                  # 日志（按天切）
├── workspace/AGENTS.md    # 人格文件（第一次启动自动生成一份极简的）
├── memory/                # 记忆库（等价于 Obsidian 的那套 markdown）
└── napcat/                # NapCat 的配置和 QQ 登录态
```

备份就备份 `data/` 整个目录。

## 五、常用命令

```bash
docker compose logs -f bridge        # 看桥接日志
docker compose restart bridge        # 改完配置重启（一般不用，配置热生效）
docker compose exec bridge node tools/cli.mjs status   # 容器内看状态
docker compose down                  # 停
```

健康检查：镜像自带 `HEALTHCHECK`，打 `/api/overview`。
`docker ps` 里看到 `healthy` 就说明控制台起来了。

## 六、坑与限制

1. **NapCat 的 QQ 号需要真手机扫码**，容器里没有图形界面，用 NapCat 的网页面板扫。
2. **NapCat 的 QQ 协议端封号风险自担**，别拿主号试。
3. **DSH 的权限**：容器里的 DSH 以 `bridge` 用户跑，需要写 `qq-workspace`、`state`、`logs`，
   这三个目录已经在镜像里建好并 chown 过；挂载宿主目录时注意 uid 10001 有写权限。
4. **`docker compose` 版本**：本文件用 `name:` 顶层键，需要 Compose v2.20+；
   老版本删掉 `name:` 一行即可。
5. **本机没装 Docker 怎么验**：`node tests/docker-test.mjs` 做静态校验（Dockerfile 指令、
   compose YAML 结构、entrypoint 语法、健康检查路径），不真构建。
