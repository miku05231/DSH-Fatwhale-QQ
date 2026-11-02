"""Bounded active-send diagnostics. Caller attribution never grants permission."""
from __future__ import annotations

import asyncio
import functools
import inspect
import json
import threading
import time
from pathlib import Path

from .context import current_principal

_destination: Path | None = None
_plugin_root: Path | None = None
_plugin_ids: frozenset[str] = frozenset()
_lock = threading.Lock()


def configure_send_diagnostics(root: Path, plugin_ids) -> None:
    global _destination, _plugin_root, _plugin_ids
    _destination = root / "manager/runtime.jsonl"
    _plugin_root = (root / "data/plugins").resolve()
    _plugin_ids = frozenset(plugin_ids)


def _caller_plugin() -> str | None:
    actor = current_principal.get()
    if actor is not None and actor.plugin_id in _plugin_ids:
        return actor.plugin_id
    # This labels logs only. It must never establish a sender or an ACL identity.
    frame = inspect.currentframe()
    try:
        for _ in range(32):
            if frame is None or _plugin_root is None:
                break
            try:
                relative = Path(frame.f_code.co_filename).resolve().relative_to(_plugin_root)
                if len(relative.parts) > 1 and relative.parts[0] in _plugin_ids:
                    return relative.parts[0]
            except (OSError, ValueError):
                pass
            frame = frame.f_back
    finally:
        del frame
    return None


def _record(status: str, code: str | None = None) -> None:
    if _destination is None:
        return
    try:
        plugin = _caller_plugin()
        item = {"at": int(time.time() * 1000), "stage": "active-send", "status": status,
                "principalPresent": current_principal.get() is not None}
        from .outbound import current_outbound
        scope = current_outbound()
        if scope is not None and scope.purpose == "weather.daily":
            item["authorizationKind"] = "explicit-outbound"
        if plugin:
            item["plugins"] = [plugin]
        if code:
            item["errorCode"] = code
        with _lock:
            _destination.parent.mkdir(parents=True, exist_ok=True)
            if _destination.exists() and _destination.stat().st_size > 2 * 1024 * 1024:
                _destination.replace(_destination.with_suffix(".previous.jsonl"))
            with _destination.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(item, ensure_ascii=False) + "\n")
    except Exception:
        # Diagnostics cannot change whether the original operation succeeds.
        pass


def _failure_code(error: Exception) -> str:
    if isinstance(error, PermissionError):
        if error.args == ("durable broker provenance is unavailable",):
            return "ASTRBOT_SEND_PROVENANCE_MISSING"
        return "ASTRBOT_SEND_PERMISSION_DENIED"
    if isinstance(error, ValueError):
        return "ASTRBOT_SEND_SESSION_INVALID"
    if isinstance(error, TimeoutError):
        return "ASTRBOT_SEND_TIMEOUT"
    # Only fixed, known framework codes may leave an exception object.
    code = getattr(error, "code", None)
    if isinstance(code, str) and code in {"ASTRBOT_PERMISSION_DENIED", "ASTRBOT_OUTBOUND_PERMISSION_DENIED", "ASTRBOT_CONTEXT_CANCELLED",
                "ASTRBOT_CALLBACK_UNAVAILABLE", "ASTRBOT_CALLBACK_FAILED"}:
        return code
    return "ASTRBOT_SEND_FAILED"


def install_send_diagnostics(context_class) -> None:
    original = context_class.send_message
    if getattr(original, "_qq_send_diagnostics", False):
        return

    @functools.wraps(original)
    async def send_message(context, session, message_chain):
        try:
            result = await original(context, session, message_chain)
        except asyncio.CancelledError:
            _record("cancelled", "ASTRBOT_CANCELLED")
            raise
        except Exception as error:
            try:
                code = _failure_code(error)
            except Exception:
                code = "ASTRBOT_SEND_FAILED"
            _record("failed", code)
            raise
        _record("sent" if result is True else "unrouted",
                None if result is True else "ASTRBOT_SEND_PLATFORM_UNMATCHED")
        return result

    send_message._qq_send_diagnostics = True
    context_class.send_message = send_message
