# ============================================================
#  QQ-DSH 桥接 · 容器镜像
#
#  这个镜像只装「桥接 + 控制台」（纯 Node，零第三方依赖，不用 npm install）。
#  NapCat 和 DSH 不在这里：
#    · NapCat 用另一个容器（见 docker-compose.yml）或宿主机上现成的；
#    · DSH 是模型执行端，镜像里没有，需要把宿主机的 DSH 挂进来并设置 DSH_COMMAND。
#
#  构建：docker build -t qq-dsh-bridge:0.1.0 .
#  运行：docker compose up -d       （先复制 .env.example 成 .env 改 OWNER_QQ）
# ============================================================
FROM node:22-alpine

LABEL org.opencontainers.image.title="QQ-DSH Bridge" \
      org.opencontainers.image.description="QQ ↔ DSH 桥接 + 网页控制台（零第三方依赖）" \
      org.opencontainers.image.version="0.1.0"

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    QQ_BRIDGE_ROOT=/app

WORKDIR /app

# 只拷运行需要的：没有 napcat/（那是外部服务）、没有 state/logs（挂卷）
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY patches ./patches
COPY assets ./assets
COPY docs ./docs
COPY docker ./docker
COPY README.md ./

RUN mkdir -p /app/state /app/logs /app/qq-workspace /app/memory /app/config \
 && addgroup -g 10001 bridge \
 && adduser -D -u 10001 -G bridge -h /home/bridge bridge \
 && mkdir -p /home/bridge/.dsh \
 && chown -R bridge:bridge /app /home/bridge \
 && chmod +x /app/docker/entrypoint.sh

USER bridge

# 控制台（网页）端口；OneBot 不需要在这里暴露，桥接是去连 NapCat 的
EXPOSE 5830

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5830/api/overview').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
