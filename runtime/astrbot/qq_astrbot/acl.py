from __future__ import annotations

import asyncio
from dataclasses import replace
import hashlib
import hmac
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from .context import AI_PRINCIPAL, DispatchIdentity, Principal, bind_principal, current_principal, require_principal, reset_principal

_LOG = logging.getLogger("qq_astrbot.acl")


def _identity_payload(identity: DispatchIdentity) -> dict[str, Any]:
    return {
        "contextId": identity.context_id,
        "messageId": identity.message_id,
        "userId": identity.user_id,
        "nickname": identity.nickname,
        "groupId": identity.group_id,
        "isGroup": identity.is_group,
        "isAdmin": identity.is_admin,
        "isWake": identity.is_wake,
        "pluginIds": sorted(identity.plugin_ids),
        "chatMode": identity.chat_mode,
        "allowAi": identity.allow_ai,
        "deadlineAt": identity.deadline_at,
        "text": "",
        "message": [],
    }


def _restore_identity(payload: dict[str, Any]) -> DispatchIdentity:
    params = {
        "contextId": payload.get("contextId"),
        "deadlineAt": payload.get("deadlineAt"),
        "event": {
            "messageId": payload.get("messageId"),
            "userId": payload.get("userId"),
            "nickname": payload.get("nickname", ""),
            "groupId": payload.get("groupId"),
            "isGroup": payload.get("isGroup"),
            "isAdmin": payload.get("isAdmin"),
            "isWake": payload.get("isWake"),
            "text": "",
            "message": [],
        },
        "policy": {
            "pluginIds": payload.get("pluginIds", []),
            "chatMode": payload.get("chatMode"),
            "allowAi": payload.get("allowAi"),
        },
    }
    return DispatchIdentity.from_params(params)


class CronProvenanceStore:
    """HMAC-authenticated durable jobId -> immutable broker identity mapping."""

    def __init__(self, path: Path | None, token: str):
        self.path = path
        self._key = token.encode("utf-8")
        self._lock = threading.RLock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self.healthy = True
        self.error: str | None = None
        self._load()

    def _canonical(self, payload: dict[str, Any]) -> bytes:
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    def _load(self) -> None:
        if self.path is None:
            return
        if not self.path.exists():
            return
        try:
            envelope = json.loads(self.path.read_text("utf-8"))
            payload = envelope["payload"]
            signature = envelope["hmac"]
            expected = hmac.new(self._key, self._canonical(payload), hashlib.sha256).hexdigest()
            if not isinstance(signature, str) or not hmac.compare_digest(signature, expected):
                raise ValueError("cron provenance signature mismatch")
            if payload.get("version") != 1 or not isinstance(payload.get("jobs"), dict):
                raise ValueError("invalid cron provenance document")
            validated = {}
            for job_id, record in payload["jobs"].items():
                if not isinstance(job_id, str) or not isinstance(record, dict):
                    raise ValueError("invalid cron provenance entry")
                identity = _restore_identity(record.get("identity", {}))
                plugin_id = record.get("pluginId")
                if not isinstance(plugin_id, str):
                    raise ValueError("invalid cron provenance principal")
                if plugin_id == AI_PRINCIPAL:
                    if not identity.allow_ai:
                        raise ValueError("stored AI cron principal is not allowed")
                elif plugin_id not in identity.plugin_ids:
                    raise ValueError("stored plugin cron principal is outside its allowlist")
                validated[job_id] = {"identity": _identity_payload(identity), "pluginId": plugin_id}
            self._jobs = validated
        except Exception as exc:
            self.healthy = False
            self.error = type(exc).__name__
            self._jobs = {}
            _LOG.error("Persistent cron provenance failed validation; scheduled callbacks are disabled.")

    def _persist(self) -> None:
        if self.path is None:
            return
        payload = {"version": 1, "jobs": self._jobs}
        envelope = {
            "payload": payload,
            "hmac": hmac.new(self._key, self._canonical(payload), hashlib.sha256).hexdigest(),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(envelope, stream, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)

    def bind_current(self, job_id: str) -> None:
        principal = require_principal()
        record = {"identity": _identity_payload(principal.identity), "pluginId": principal.plugin_id}
        with self._lock:
            if not self.healthy:
                raise RuntimeError("persistent reminder provenance is unavailable")
            self._jobs[job_id] = record
            self._persist()

    def resolve(self, job_id: str) -> Principal | None:
        with self._lock:
            if not self.healthy:
                return None
            record = self._jobs.get(job_id)
            if record is None:
                return None
            try:
                identity = _restore_identity(record["identity"])
                plugin_id = record["pluginId"]
                if plugin_id == AI_PRINCIPAL:
                    if not identity.allow_ai:
                        return None
                elif plugin_id not in identity.plugin_ids:
                    return None
                else:
                    identity = replace(
                        identity,
                        plugin_ids=frozenset({plugin_id}),
                        allow_ai=False,
                    )
                return Principal(identity, plugin_id)
            except Exception:
                return None

    def remove(self, job_id: str) -> None:
        with self._lock:
            if job_id in self._jobs:
                self._jobs.pop(job_id, None)
                if self.healthy:
                    self._persist()

    def bind_job(self, job_id: str) -> None:
        """Record provenance before APScheduler persists/activates the job."""
        principal = current_principal.get()
        if principal is None:
            if self.resolve(job_id) is None:
                raise RuntimeError("scheduled job has no verified broker provenance")
            return
        self.bind_current(job_id)


def install_cron_provenance(manager_class, store: CronProvenanceStore) -> None:
    original_schedule = manager_class._schedule_job
    original_run = manager_class._run_job
    original_delete = manager_class.delete_job

    def guarded_schedule(self, job):
        store.bind_job(str(job.job_id))
        return original_schedule(self, job)

    async def guarded_run(self, job_id, *args, **kwargs):
        principal = store.resolve(str(job_id))
        if principal is None:
            _LOG.error("Refusing cron job without verified persistent broker provenance.")
            raise RuntimeError("scheduled job provenance is unavailable")
        from astrbot.core.platform.astr_message_event import current_message_event

        # APScheduler inherits ContextVars when the job is registered. Its old
        # event contains broader permissions and message content than the
        # persisted, narrowed principal; scheduled effects use only that principal.
        token = current_principal.set(principal)
        event_token = current_message_event.set(None)
        try:
            return await original_run(self, job_id, *args, **kwargs)
        finally:
            current_message_event.reset(event_token)
            current_principal.reset(token)

    async def guarded_delete(self, job_id):
        result = await original_delete(self, job_id)
        store.remove(str(job_id))
        return result

    manager_class._schedule_job = guarded_schedule
    manager_class._run_job = guarded_run
    manager_class.delete_job = guarded_delete


def install_native_guards(callback_client) -> None:
    """Enforce plugin ownership at native handler and tool execution boundaries."""
    import inspect
    import copy
    import dataclasses
    import traceback
    import sys

    from astrbot.core import astrbot_config, logger
    from astrbot.core.platform.astr_message_event import current_message_event
    from astrbot.core.pipeline import context_utils
    from astrbot.core.pipeline.waking_check.stage import WakingCheckStage
    from astrbot.core.star.star_handler import star_handlers_registry, star_map
    from .provider import (
        _admin_only_tool,
        _native_module_owner,
        _native_tool_owner,
        _native_tool_permissions_allowed,
    )

    def is_bridge_event(event) -> bool:
        return getattr(event, "_qq_bridge_event", False) is True

    def event_identity(event) -> DispatchIdentity | None:
        if not is_bridge_event(event):
            return None
        identity = getattr(event, "identity", None)
        if not isinstance(identity, DispatchIdentity):
            return None
        principal = current_principal.get()
        if principal is not None:
            if principal.identity != identity:
                return None
            if principal.plugin_id == AI_PRINCIPAL and not identity.allow_ai:
                return None
            if principal.plugin_id != AI_PRINCIPAL and principal.plugin_id not in identity.plugin_ids:
                return None
        return identity

    original_waking = WakingCheckStage.process
    if not getattr(original_waking, "_qq_guarded", False):
        async def guarded_waking(stage, event):
            identity = event_identity(event)
            if identity is not None and identity.is_wake:
                # The Node bridge also supports keyword wake-up. Native AstrBot
                # recomputes waking from prefixes, so give this event a local
                # empty-prefix fallback without changing its message or the
                # shared stage/configuration used by concurrent sessions.
                stage = copy.copy(stage)
                config = dict(stage.ctx.astrbot_config)
                config["wake_prefix"] = [*config.get("wake_prefix", []), ""]
                stage.ctx = dataclasses.replace(stage.ctx, astrbot_config=config)
            return await original_waking(stage, event)

        guarded_waking._qq_guarded = True
        WakingCheckStage.process = guarded_waking

    def callable_owner(handler) -> str | None:
        registered_owners = set()
        for metadata in getattr(star_handlers_registry, "_handlers", ()):
            if getattr(metadata, "handler", None) is handler:
                owner = _native_module_owner(getattr(metadata, "handler_module_path", None))
                if owner is not None:
                    registered_owners.add(owner)
        if len(registered_owners) == 1:
            return next(iter(registered_owners))
        if len(registered_owners) > 1:
            return None
        seen = set()
        while handler is not None and id(handler) not in seen:
            seen.add(id(handler))
            module_path = getattr(handler, "__module__", None)
            owner = _native_module_owner(module_path)
            if owner is not None:
                return owner
            function = getattr(handler, "__func__", None)
            if function is not None:
                handler = function
                continue
            wrapped = getattr(handler, "__wrapped__", None)
            if wrapped is not None:
                handler = wrapped
                continue
            underlying = getattr(handler, "func", None)
            if underlying is not None:
                handler = underlying
                continue
            instance = getattr(handler, "__self__", None)
            if instance is not None:
                owner = _native_module_owner(getattr(type(instance), "__module__", None))
                if owner is not None:
                    return owner
            break
        return None

    def registry_plugin_names(identity: DispatchIdentity, requested_names) -> list[str]:
        if requested_names is None:
            requested = None
        else:
            if isinstance(requested_names, str):
                requested_names = [requested_names]
            try:
                requested = {str(name) for name in requested_names}
            except TypeError:
                return []
            if "*" in requested:
                requested = None

        names = set()
        plugins = {id(plugin): plugin for plugin in star_map.values()}.values()
        for plugin in plugins:
            if getattr(plugin, "reserved", False) or not getattr(plugin, "activated", False):
                continue
            root_dir_name = getattr(plugin, "root_dir_name", None)
            plugin_name = getattr(plugin, "name", None)
            if not isinstance(root_dir_name, str) or root_dir_name not in identity.plugin_ids:
                continue
            if not isinstance(plugin_name, str) or not plugin_name:
                continue
            aliases = {
                plugin_name,
                root_dir_name,
                str(getattr(plugin, "plugin_id", "")),
            }
            if requested is None or aliases.intersection(requested):
                names.add(plugin_name)
        return sorted(names)

    original_registry = star_handlers_registry.get_handlers_by_event_type
    if not getattr(original_registry, "_qq_guarded", False):
        def guarded_get_handlers_by_event_type(event_type, *args, **kwargs):
            event = current_message_event.get(None)
            if not is_bridge_event(event):
                return original_registry(event_type, *args, **kwargs)
            identity = event_identity(event)
            if identity is None:
                return []
            only_activated = kwargs.get("only_activated", args[0] if args else True)
            requested_names = kwargs.get("plugins_name", args[1] if len(args) > 1 else None)
            allowed_names = registry_plugin_names(identity, requested_names)
            if not allowed_names:
                return []
            handlers = original_registry(
                event_type,
                only_activated=only_activated,
                plugins_name=allowed_names,
            )
            return [
                handler
                for handler in handlers
                if _native_module_owner(handler.handler_module_path) in identity.plugin_ids
            ]

        guarded_get_handlers_by_event_type._qq_guarded = True
        star_handlers_registry.get_handlers_by_event_type = guarded_get_handlers_by_event_type

    original_handler = context_utils.call_handler
    if not getattr(original_handler, "_qq_guarded", False):
        async def guarded_call_handler(event, handler, *args, **kwargs):
            if not is_bridge_event(event):
                async for result in original_handler(event, handler, *args, **kwargs):
                    yield result
                return
            owner = callable_owner(handler)
            identity = event_identity(event)
            if owner is None or identity is None or owner not in identity.plugin_ids:
                if False:
                    yield None
                return
            token = bind_principal(identity, owner)
            try:
                async for result in original_handler(event, handler, *args, **kwargs):
                    yield result
            finally:
                current_principal.reset(token)

        guarded_call_handler._qq_guarded = True
        context_utils.call_handler = guarded_call_handler
        for module in tuple(sys.modules.values()):
            if module is not None and getattr(module, "call_handler", None) is original_handler:
                setattr(module, "call_handler", guarded_call_handler)

    original_hook = context_utils.call_event_hook
    if not getattr(original_hook, "_qq_guarded", False):
        async def guarded_call_event_hook(event, hook_type, *args, **kwargs):
            if not is_bridge_event(event):
                return await original_hook(event, hook_type, *args, **kwargs)
            identity = event_identity(event)
            if identity is None:
                return False
            handlers = star_handlers_registry.get_handlers_by_event_type(
                hook_type, plugins_name=event.plugins_name
            )
            handler_category = "llm_tool" if hook_type.name == "OnCallingFuncToolEvent" else "hook"
            for handler in handlers:
                plugin = star_map.get(handler.handler_module_path)
                owner = _native_module_owner(handler.handler_module_path)
                if owner is None or owner not in identity.plugin_ids:
                    continue
                plugin_name = getattr(plugin, "name", handler.handler_module_path)
                display_name = getattr(plugin, "display_name", None) or plugin_name
                trace_fields = {
                    "kind": "plugin_handler",
                    "plugin": plugin_name,
                    "plugin_display_name": display_name,
                    "handler": handler.handler_name,
                    "handler_full_name": handler.handler_full_name,
                    "handler_type": handler.event_type.name,
                    "handler_category": handler_category,
                    "hook": hook_type.name,
                }
                event.trace.record("handler_start", status="running", **trace_fields)
                token = bind_principal(identity, owner)
                try:
                    filters_passed = True
                    for filter_ in handler.event_filters or ():
                        result = filter_.filter(event, astrbot_config)
                        if inspect.isawaitable(result):
                            result = await result
                        if not result:
                            filters_passed = False
                            break
                    if filters_passed:
                        assert inspect.iscoroutinefunction(handler.handler)
                        await handler.handler(event, *args, **kwargs)
                except BaseException:
                    logger.error(traceback.format_exc())
                    event.trace.record("handler_end", status="error", **trace_fields)
                else:
                    if filters_passed:
                        event.trace.record("handler_end", status="success", **trace_fields)
                    else:
                        event.trace.record("handler_end", status="skipped", **trace_fields)
                finally:
                    current_principal.reset(token)
                if event.is_stopped():
                    return True
            return event.is_stopped()

        guarded_call_event_hook._qq_guarded = True
        context_utils.call_event_hook = guarded_call_event_hook
        for module in tuple(sys.modules.values()):
            if module is not None and getattr(module, "call_event_hook", None) is original_hook:
                setattr(module, "call_event_hook", guarded_call_event_hook)

    from astrbot.core.cron.events import CronMessageEvent

    original_cron_init = CronMessageEvent.__init__
    if not getattr(original_cron_init, "_qq_guarded", False):
        def guarded_cron_init(self, *args, **kwargs):
            result = original_cron_init(self, *args, **kwargs)
            origin_event = current_message_event.get(None)
            active = current_principal.get()
            origin_is_bridge = is_bridge_event(origin_event)
            identity = active.identity if active is not None else event_identity(origin_event)
            if origin_is_bridge or active is not None:
                self._qq_bridge_event = True
                if origin_is_bridge and active is not None and event_identity(origin_event) != active.identity:
                    identity = None
                self._qq_bridge_identity = identity
                if identity is not None:
                    self.identity = identity
                    self.plugins_name = sorted(identity.plugin_ids)
            return result

        guarded_cron_init._qq_guarded = True
        CronMessageEvent.__init__ = guarded_cron_init

    original_cron_is_admin = CronMessageEvent.is_admin
    if not getattr(original_cron_is_admin, "_qq_guarded", False):
        def guarded_cron_is_admin(self):
            if is_bridge_event(self):
                identity = getattr(self, "_qq_bridge_identity", None)
                return bool(isinstance(identity, DispatchIdentity) and identity.is_admin)
            return original_cron_is_admin(self)

        guarded_cron_is_admin._qq_guarded = True
        CronMessageEvent.is_admin = guarded_cron_is_admin

    from astrbot.core.astr_agent_tool_exec import FunctionToolExecutor

    original_execute = FunctionToolExecutor.execute
    if not getattr(original_execute, "_qq_guarded", False):
        async def guarded_execute(cls, tool, run_context, **tool_args):
            principal = current_principal.get()
            event = current_message_event.get(None)
            if principal is None and not is_bridge_event(event):
                async for result in original_execute(tool, run_context, **tool_args):
                    yield result
                return
            identity = principal.identity if principal is not None else event_identity(event)
            owner = _native_tool_owner(tool)
            allowed = identity is not None and owner is not None and owner in identity.plugin_ids
            if principal is not None:
                allowed = allowed and principal.identity == identity
                if principal.plugin_id == AI_PRINCIPAL:
                    allowed = allowed and identity.allow_ai
                else:
                    allowed = allowed and principal.plugin_id == owner
            else:
                allowed = allowed and identity.allow_ai
            if allowed:
                allowed = _native_tool_permissions_allowed(tool, event)
            if allowed and _admin_only_tool(tool) and not identity.is_admin:
                allowed = False
            owner_token = None
            try:
                if allowed:
                    owner_token = bind_principal(identity, owner)
                    allowed = await callback_client.authorize_tool(str(getattr(tool, "name", "")))
                if not allowed:
                    import mcp
                    yield mcp.types.CallToolResult(
                        content=[mcp.types.TextContent(type="text", text="Permission denied.")],
                        isError=True,
                    )
                    return
                async for result in original_execute(tool, run_context, **tool_args):
                    yield result
            finally:
                if owner_token is not None:
                    current_principal.reset(owner_token)

        guarded_execute._qq_guarded = True
        FunctionToolExecutor.execute = classmethod(guarded_execute)
