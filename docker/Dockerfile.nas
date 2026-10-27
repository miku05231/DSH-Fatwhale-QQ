FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

ARG DSH_VERSION=0.2.0-rc.2
RUN apk add --no-cache bash git ripgrep python3 \
 && npm install --prefix /opt/dsh --omit=dev "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    WEBUI_HOST=0.0.0.0 \
    DSH_HOME=/home/bridge/.dsh \
    QQ_BRIDGE_ROOT=/app
WORKDIR /app
COPY package.json README.md ./
COPY src ./src
COPY tools ./tools
COPY patches ./patches
COPY assets ./assets
COPY docs ./docs
COPY docker ./docker
RUN addgroup -g 10001 bridge \
 && adduser -D -u 10001 -G bridge -h /home/bridge bridge \
 && mkdir -p /app/state /app/logs /app/qq-workspace /app/memory /config /home/bridge/.dsh \
 && chown -R bridge:bridge /app /config /home/bridge \
 && chmod +x /app/docker/entrypoint.sh
USER bridge
EXPOSE 5830
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5830/api/overview').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
