#!/bin/sh
# ============================================================
#  QQ-DSH 桥接 · 命令行入口（Linux / macOS）
#
#    ./start.sh start              起控制台 + 桥接（后台）
#    ./start.sh start --no-console 只起桥接
#    ./start.sh status             看状态
#    ./start.sh logs bridge --follow
#    ./start.sh stop               全停
#
#  Windows 用同目录下的 qq-bridge.cmd；想跑容器见 docs/Docker部署.md。
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node，请先安装 Node.js 20 或更高版本。" >&2
  exit 1
fi

exec node tools/cli.mjs "$@"
