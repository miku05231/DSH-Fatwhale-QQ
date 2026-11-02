from __future__ import annotations

import base64
import binascii
import json
import os
import threading
from contextvars import ContextVar
from pathlib import Path
from urllib.parse import unquote, urlsplit

import aiohttp

from .context import AI_PRINCIPAL, Principal, require_principal

MAX_MEDIA_BYTES = 8 * 1024 * 1024
MAX_RPC_BYTES = 16 * 1024 * 1024
SUPPORTED = {"text", "image", "record", "video", "file", "at", "reply", "face"}


class CallbackError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _extension(path: str, fallback: str) -> str:
    ext = Path(path).suffix.lstrip(".").lower() or fallback
    return ext if ext.isascii() and ext.isalnum() and len(ext) <= 8 else fallback


def _local_path(value: str) -> Path:
    parts = urlsplit(value)
    if parts.scheme == "file":
        if parts.netloc not in {"", "localhost"}:
            raise CallbackError("ASTRBOT_MEDIA_INVALID")
        value = unquote(parts.path)
        if os.name == "nt" and value.startswith("/") and len(value) > 2 and value[2] == ":":
            value = value[1:]
    return Path(value)


def _read_local(value: str, kind: str, roots: tuple[Path, ...]) -> tuple[bytes, str]:
    fallback = {"image": "png", "record": "wav", "audio": "wav", "video": "mp4", "file": "bin"}[kind]
    if value.startswith("base64://"):
        encoded = value[9:]
        if len(encoded) > MAX_MEDIA_BYTES * 4 // 3 + 8:
            raise CallbackError("ASTRBOT_MEDIA_TOO_LARGE")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise CallbackError("ASTRBOT_MEDIA_INVALID") from exc
        if not raw or len(raw) > MAX_MEDIA_BYTES:
            raise CallbackError("ASTRBOT_MEDIA_TOO_LARGE")
        return raw, fallback
    path = _local_path(value)
    try:
        resolved = path.resolve(strict=True)
        if not any(resolved == root or root in resolved.parents for root in roots):
            raise CallbackError("ASTRBOT_MEDIA_INVALID")
        stat = resolved.stat()
        if not resolved.is_file() or stat.st_size <= 0 or stat.st_size > MAX_MEDIA_BYTES:
            raise CallbackError("ASTRBOT_MEDIA_TOO_LARGE")
        raw = resolved.read_bytes()
    except OSError as exc:
        raise CallbackError("ASTRBOT_MEDIA_UNAVAILABLE") from exc
    if not raw or len(raw) > MAX_MEDIA_BYTES:
        raise CallbackError("ASTRBOT_MEDIA_TOO_LARGE")
    return raw, _extension(str(resolved), fallback)


class _EffectCollector:
    def __init__(self, context_id: str):
        self.context_id = context_id
        self._lock = threading.Lock()
        self._closed = False
        self._values = {"sent": False, "toolUsed": False}
        self._final: dict[str, bool] | None = None

    def record(self, name: str) -> None:
        if name not in self._values:
            return
        with self._lock:
            if not self._closed:
                self._values[name] = True

    def snapshot(self) -> dict[str, bool]:
        with self._lock:
            return dict(self._final if self._final is not None else self._values)

    def close(self) -> dict[str, bool]:
        with self._lock:
            if not self._closed:
                self._closed = True
                self._final = dict(self._values)
            return dict(self._final or {"sent": False, "toolUsed": False})


class _EffectScopeToken:
    def __init__(self, variable, context_token, collector: _EffectCollector):
        self.variable = variable
        self.context_token = context_token
        self.collector = collector


class NodeCallbackClient:
    def __init__(self, callback_url: str, token: str, allowed_local_roots: tuple[Path, ...] = ()):
        parts = urlsplit(callback_url)
        self.endpoint = callback_url if parts.path.rstrip("/").endswith("/rpc/callback") else callback_url.rstrip("/") + "/rpc/callback"
        self._headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
        self._session: aiohttp.ClientSession | None = None
        code_root = Path(
            os.environ.get("QQ_ASTRBOT_ROOT", Path(__file__).resolve().parents[1])
        ).resolve()
        state_value = os.environ.get("QQ_ASTRBOT_STATE_ROOT")
        state_root = (
            Path(state_value).resolve()
            if state_value
            else (code_root.parents[1] / "state" / "astrbot").resolve()
        )
        intended_media_roots = {
            (state_root / name).resolve() for name in ("media", "inbox", "outbox")
        }
        intended_media_roots.update(
            Path(value.strip()).resolve()
            for value in os.environ.get("QQ_ASTRBOT_MEDIA_ROOTS", "").split(os.pathsep)
            if value.strip()
        )
        roots = set()
        for root in allowed_local_roots:
            resolved = Path(root).resolve()
            if resolved in intended_media_roots:
                roots.add(resolved)
        try:
            from astrbot.core.utils.astrbot_path import (
                get_astrbot_plugin_data_path,
                get_astrbot_temp_path,
            )

            roots.add(Path(get_astrbot_plugin_data_path()).resolve())
            roots.add(Path(get_astrbot_temp_path()).resolve())
        except Exception:
            pass

        generation_value = os.environ.get("QQ_ASTRBOT_GENERATION_ROOT")
        if generation_value:
            generation_root = Path(generation_value).resolve()
            if state_root in generation_root.parents:
                roots.add((generation_root / "data" / "plugin_data").resolve())

        self.allowed_local_roots = tuple(sorted(roots, key=str))
        self._effect_collector: ContextVar[_EffectCollector | None] = ContextVar(
            f"qq_astrbot_effects_{id(self)}",
            default=None,
        )

    def begin_effects(self, context_id: str) -> _EffectScopeToken:
        """Start an isolated effect collector for one dispatch scope."""
        if not isinstance(context_id, str) or not context_id:
            raise ValueError("effect scope requires a context ID")
        collector = _EffectCollector(context_id)
        token = self._effect_collector.set(collector)
        return _EffectScopeToken(self._effect_collector, token, collector)

    def effects(self, context_id: str) -> dict[str, bool]:
        """Return a non-consuming snapshot for the active matching scope."""
        if not isinstance(context_id, str) or not context_id:
            return {"sent": False, "toolUsed": False}
        collector = self._effect_collector.get()
        if collector is None or collector.context_id != context_id:
            return {"sent": False, "toolUsed": False}
        return collector.snapshot()

    def end_effects(self, token: _EffectScopeToken) -> dict[str, bool]:
        """Close a dispatch scope, snapshot effects, and restore its parent scope."""
        if not isinstance(token, _EffectScopeToken) or token.variable is not self._effect_collector:
            raise ValueError("effect scope token does not belong to this callback client")
        result = token.collector.close()
        if self._effect_collector.get() is token.collector:
            try:
                self._effect_collector.reset(token.context_token)
            except ValueError:
                # A copied async context may share the collector but cannot reset
                # the ContextVar token created by its parent context.
                pass
        return result

    def _record_effect(self, context_id: str, name: str) -> None:
        collector = self._effect_collector.get()
        if collector is not None and collector.context_id == context_id:
            collector.record(name)

    async def start(self) -> None:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=150, connect=5, sock_read=150),
                headers=self._headers,
            )

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def call(self, method: str, params: dict, principal: Principal | None = None) -> dict:
        active = require_principal()
        if principal is not None and principal != active:
            raise CallbackError("ASTRBOT_PERMISSION_DENIED")
        actor = active
        if actor.plugin_id != AI_PRINCIPAL and actor.plugin_id not in actor.identity.plugin_ids:
            raise CallbackError("ASTRBOT_PERMISSION_DENIED")
        if actor.plugin_id == AI_PRINCIPAL and method == "tools.authorize":
            raise CallbackError("ASTRBOT_PERMISSION_DENIED")
        await self.start()
        body = {
            "version": 1,
            "method": method,
            "params": params,
            "contextId": actor.identity.context_id,
            "pluginId": actor.plugin_id,
        }
        return await self._request(body)

    async def send_outbound(self, scope, target: dict, message: list) -> dict:
        from .context import current_principal
        from .outbound import current_outbound

        if scope is None or current_outbound() is not scope or current_principal.get() is not None:
            raise CallbackError("ASTRBOT_OUTBOUND_PERMISSION_DENIED")
        if scope.purpose != "weather.daily":
            raise CallbackError("ASTRBOT_OUTBOUND_PERMISSION_DENIED")
        return await self._request({
            "version": 1, "method": "outbound.send", "pluginId": scope.plugin_id,
            "params": {"purpose": scope.purpose, "sourceSHA256": scope.source_sha256,
                       "target": target, "message": message},
        })

    async def _request(self, body: dict) -> dict:
        await self.start()
        try:
            async with self._session.post(self.endpoint, json=body, allow_redirects=False) as response:
                raw = await response.content.read(MAX_RPC_BYTES + 1)
                if len(raw) > MAX_RPC_BYTES:
                    raise CallbackError("ASTRBOT_RPC_TOO_LARGE")
                try:
                    result = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    raise CallbackError("ASTRBOT_CALLBACK_FAILED") from exc
                if response.status >= 400:
                    error = result.get("error", {}) if isinstance(result, dict) else {}
                    raise CallbackError(error.get("code", "ASTRBOT_CALLBACK_FAILED"))
                if not isinstance(result, dict) or result.get("version") != 1 or "result" not in result:
                    raise CallbackError("ASTRBOT_CALLBACK_FAILED")
                return result["result"]
        except aiohttp.ClientError as exc:
            raise CallbackError("ASTRBOT_CALLBACK_UNAVAILABLE") from exc

    async def authorize_tool(self, name: str, *, record_use: bool = True) -> bool:
        actor = require_principal()
        if actor.plugin_id == AI_PRINCIPAL:
            return False
        result = await self.call(
            "tools.authorize",
            {"name": name, "recordUse": bool(record_use)},
            actor,
        )
        allowed = isinstance(result, dict) and result.get("allowed") is True
        if allowed and record_use:
            self._record_effect(actor.identity.context_id, "toolUsed")
            from astrbot.core.platform.astr_message_event import current_message_event

            event = current_message_event.get(None)
            if (
                getattr(event, "_qq_bridge_event", False)
                and getattr(event, "identity", None) == actor.identity
            ):
                mark_claim = getattr(event, "_qq_mark_plugin_claim", None)
                if callable(mark_claim):
                    mark_claim()
        return allowed

    async def upload(self, raw: bytes, extension: str) -> str:
        if not raw or len(raw) > MAX_MEDIA_BYTES:
            raise CallbackError("ASTRBOT_MEDIA_TOO_LARGE")
        ext = _extension("media." + extension, "bin")
        result = await self.call("media.put", {
            "base64": base64.b64encode(raw).decode("ascii"),
            "extension": ext,
        })
        handle = result.get("file") if isinstance(result, dict) else None
        if not isinstance(handle, str) or not handle.startswith("astrbot-media://"):
            raise CallbackError("ASTRBOT_MEDIA_INVALID")
        return handle

    def read_local_base64(self, value: str, kind: str) -> str:
        raw, _ = _read_local(value, kind, self.allowed_local_roots)
        return "base64://" + base64.b64encode(raw).decode("ascii")

    async def materialize_local(self, value: str, kind: str) -> str:
        raw, ext = _read_local(value, kind, self.allowed_local_roots)
        return await self.upload(raw, ext)

    async def send(
        self,
        target: dict,
        message: list[dict],
        principal: Principal | None = None,
    ) -> dict:
        actor = require_principal()
        if principal is not None and principal != actor:
            raise CallbackError("ASTRBOT_PERMISSION_DENIED")
        if target != actor.identity.target():
            raise CallbackError("ASTRBOT_PERMISSION_DENIED")
        if not message or len(message) > 100:
            raise CallbackError("ASTRBOT_MESSAGE_INVALID")
        for part in message:
            if not isinstance(part, dict) or not isinstance(part.get("data"), dict):
                raise CallbackError("ASTRBOT_SEGMENT_UNSUPPORTED")
            kind, data = part.get("type"), part["data"]
            if kind not in SUPPORTED:
                raise CallbackError("ASTRBOT_SEGMENT_UNSUPPORTED")
            if kind == "text":
                if not isinstance(data.get("text"), str) or len(data["text"]) > 16000:
                    raise CallbackError("ASTRBOT_MESSAGE_INVALID")
            elif kind == "at":
                qq = data.get("qq")
                if qq == "all" and not actor.identity.is_admin:
                    raise CallbackError("ASTRBOT_PERMISSION_DENIED")
                if qq != "all" and not str(qq).isdigit():
                    raise CallbackError("ASTRBOT_MESSAGE_INVALID")
            elif kind == "reply":
                if data.get("id") is None:
                    raise CallbackError("ASTRBOT_MESSAGE_INVALID")
            elif kind == "face":
                if isinstance(data.get("id"), bool) or not str(data.get("id", "")).isdigit():
                    raise CallbackError("ASTRBOT_MESSAGE_INVALID")
            else:
                value = data.get("file") or data.get("url")
                if not isinstance(value, str):
                    raise CallbackError("ASTRBOT_MEDIA_INVALID")
                parts = urlsplit(value)
                if not (value.startswith("astrbot-media://") or parts.scheme in {"http", "https"}):
                    raise CallbackError("ASTRBOT_MEDIA_INVALID")
        result = await self.call("send", {"target": target, "message": message}, actor)
        self._record_effect(actor.identity.context_id, "sent")
        return result if isinstance(result, dict) else {"result": result}
