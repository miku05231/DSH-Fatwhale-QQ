ARG ASTRBOT_BASE_IMAGE=python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
FROM ${ASTRBOT_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    HOME=/tmp \
    TMPDIR=/tmp \
    QQ_ASTRBOT_HOST=0.0.0.0 \
    QQ_ASTRBOT_PORT=5831 \
    QQ_ASTRBOT_ROOT=/app/qq-astrbot \
    QQ_ASTRBOT_STATE_ROOT=/app/state/astrbot \
    QQ_ASTRBOT_CALLBACK_URL=http://bridge:5832/rpc/callback \
    QQ_ASTRBOT_ALLOW_NETWORK_BIND=1

WORKDIR /app
COPY runtime/astrbot /app/qq-astrbot
COPY runtime/astrbot-lock.json /app/astrbot-lock.json
COPY runtime/astrbot-lock.json /tmp/astrbot-runtime-lock.json

RUN python -c "import json,pathlib; p=json.loads(pathlib.Path('/tmp/astrbot-runtime-lock.json').read_text('utf-8'))['python']['packages']; pathlib.Path('/tmp/astrbot-requirements.txt').write_text(chr(10).join(p)+chr(10), encoding='utf-8')" \
 && python -c "import sys; assert sys.version_info[:3] == (3, 12, 10)" \
 && python -m pip install --no-input --disable-pip-version-check --no-cache-dir --no-warn-script-location --requirement /tmp/astrbot-requirements.txt \
 && python -m pip check \
 && python -c "import importlib.metadata as m; assert m.version('AstrBot') == '4.29.3'; assert m.version('APScheduler') == '3.11.3'; import aiohttp" \
 && mkdir -p /usr/share/qq-astrbot \
 && PYTHONPATH=/app/qq-astrbot python -m qq_astrbot.inventory --output /usr/share/qq-astrbot/dependency-inventory.json \
 && chmod 0644 /usr/share/qq-astrbot/dependency-inventory.json \
 && rm -f /tmp/astrbot-runtime-lock.json /tmp/astrbot-requirements.txt

RUN groupadd --gid 10001 astrbot \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin astrbot \
 && printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'token_file=/run/secrets/qq-astrbot-rpc-token' \
    'if [ ! -f "$token_file" ] || [ ! -r "$token_file" ]; then' \
    '    echo "AstrBot RPC token file is unavailable." >&2' \
    '    exit 1' \
    'fi' \
    'token=$(cat "$token_file")' \
    'if [ -z "$token" ]; then' \
    '    echo "AstrBot RPC token is empty." >&2' \
    '    exit 1' \
    'fi' \
    'export QQ_ASTRBOT_TOKEN="$token"' \
    'exec python -m qq_astrbot' \
    > /usr/local/bin/qq-astrbot-entrypoint \
 && chmod 0755 /usr/local/bin/qq-astrbot-entrypoint

USER 10001:10001
WORKDIR /app/qq-astrbot
ENTRYPOINT ["/usr/local/bin/qq-astrbot-entrypoint"]
