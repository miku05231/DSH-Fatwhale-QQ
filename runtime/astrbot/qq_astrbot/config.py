from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class RuntimeConfig:
    host: str
    port: int
    token: str
    callback_url: str
    code_root: Path
    state_root: Path
    generation_root: Path | None
    network_bind_enabled: bool
    media_roots: tuple[Path, ...]

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        host = os.environ.get("QQ_ASTRBOT_HOST", "127.0.0.1")
        port = int(os.environ.get("QQ_ASTRBOT_PORT", "5831"))
        token = os.environ.get("QQ_ASTRBOT_TOKEN", "")
        callback_url = os.environ.get("QQ_ASTRBOT_CALLBACK_URL", "")
        code_root = Path(os.environ.get("QQ_ASTRBOT_ROOT", Path(__file__).resolve().parents[1])).resolve()
        state_value = os.environ.get("QQ_ASTRBOT_STATE_ROOT")
        state_root = Path(state_value).resolve() if state_value else (code_root.parents[1] / "state" / "astrbot").resolve()
        generation_value = os.environ.get("QQ_ASTRBOT_GENERATION_ROOT")
        generation_root = Path(generation_value).resolve() if generation_value else None
        if generation_root is not None and state_root not in generation_root.parents:
            raise ValueError("QQ_ASTRBOT_GENERATION_ROOT must be under QQ_ASTRBOT_STATE_ROOT")
        network_bind_enabled = os.environ.get("QQ_ASTRBOT_ALLOW_NETWORK_BIND") == "1"
        if not 1 <= port <= 65535:
            raise ValueError("QQ_ASTRBOT_PORT must be a valid TCP port")
        if not token or len(token) < 24:
            raise ValueError("QQ_ASTRBOT_TOKEN must contain at least 24 characters")
        try:
            from ipaddress import ip_address
            loopback = host == "localhost" or ip_address(host).is_loopback
        except ValueError:
            loopback = False
        if not loopback and not network_bind_enabled:
            raise ValueError("non-loopback bind requires QQ_ASTRBOT_ALLOW_NETWORK_BIND=1 and QQ_ASTRBOT_TOKEN")
        parts = urlsplit(callback_url)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError("QQ_ASTRBOT_CALLBACK_URL must be an absolute HTTP(S) URL")
        roots = [state_root / "media", state_root / "inbox", state_root / "outbox"]
        for value in os.environ.get("QQ_ASTRBOT_MEDIA_ROOTS", "").split(os.pathsep):
            if value.strip():
                roots.append(Path(value.strip()).resolve())
        return cls(
            host, port, token, callback_url, code_root, state_root, generation_root,
            network_bind_enabled, tuple(path.resolve() for path in roots),
        )
