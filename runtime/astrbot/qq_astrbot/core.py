"""Native AstrBot lifecycle, confined to one disposable generation process.

No AstrBot import is allowed before configure_paths(): its package globals open
the database and resolve plugin paths at import time.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import re
import sys
import time
from pathlib import Path

from .context import AI_PRINCIPAL, DispatchIdentity, bind_principal, current_principal, reset_principal


def configure_paths(root: Path) -> Path:
    root = root.resolve(strict=True)
    os.environ["ASTRBOT_ROOT"] = str(root)
    for relative in ("data/plugins", "data/plugin_data", "data/site-packages", "data/config", "manager"):
        directory = root / relative
        directory.mkdir(parents=True, exist_ok=True)
        if not directory.resolve().is_relative_to(root):
            raise ValueError("generation directory escapes its root")
    sys.path.insert(0, str(root / "data/site-packages"))
    sys.path.insert(0, str(root))
    # Namespace imports such as data.plugins.<directory>.main resolve here.
    os.chdir(root)
    return root


def manifest_plugins(root: Path) -> dict:
    manifest = root / "manager/plugins.json"
    value = json.loads(manifest.read_text(encoding="utf-8"))
    plugins = value.get("plugins")
    if not isinstance(plugins, dict):
        raise ValueError("generation plugin manifest is invalid")
    for plugin_id, plugin in plugins.items():
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", plugin_id)
                or plugin_id.lower() in {"__ai__", "__proto__", "constructor", "prototype"}):
            raise ValueError("generation plugin identifier is invalid")
        if not isinstance(plugin, dict) or plugin.get("id", plugin_id) != plugin_id:
            raise ValueError("generation plugin record is invalid")
    return plugins


class ProvenanceQueue(asyncio.Queue):
    """Synthetic events retain the creator, never an event's asserted admin role."""

    def put_nowait(self, event):
        principal = current_principal.get()
        if principal is None:
            raise PermissionError("synthetic events require broker provenance")
        identity = principal.identity
        from astrbot.core.platform.message_type import MessageType
        message = event.message_obj
        is_group = message.type == MessageType.GROUP_MESSAGE
        if is_group != identity.is_group or str(event.session_id) != str(identity.group_id if is_group else identity.user_id):
            raise PermissionError("synthetic events cannot change the origin session")
        # Keep the plugin's synthesized content in memory only; identity remains immutable.
        super().put_nowait((principal, event))


class NativeCore:
    def __init__(self, root: Path, config=None, *, validation: bool = False):
        self.root = configure_paths(root)
        self.config = config
        self.validation = validation
        self.plugins = manifest_plugins(self.root)
        self.loaded_ids = set(self.plugins) if validation else {
            key for key, value in self.plugins.items() if value.get("enabled") is True
        }
        self.lifecycle = None
        self.callback = None
        self.run_task = None
        self.tasks: dict[str, asyncio.Task] = {}
        self.accepting = False

    async def initialize(self):
        import astrbot.core as native
        from astrbot.core.config.default import VERSION
        from astrbot.core.core_lifecycle import AstrBotCoreLifecycle
        import astrbot.core.core_lifecycle as lifecycle_module
        from astrbot.core.star.star_manager import PluginManager
        from astrbot.core.cron import CronJobManager
        from .callback import NodeCallbackClient
        from .acl import CronProvenanceStore, install_cron_provenance, install_native_guards
        from .diagnostics import configure_send_diagnostics, install_send_diagnostics
        from .executor import install_scheduler_context_guard
        from astrbot.core.star.context import Context
        from . import platform, provider

        if VERSION != "4.29.3":
            raise RuntimeError("ASTRBOT_CORE_VERSION_MISMATCH")
        configure_send_diagnostics(self.root, self.loaded_ids)
        install_send_diagnostics(Context)
        install_scheduler_context_guard()
        cfg = native.astrbot_config
        cfg.update({
            "platform": [{"type": "qq_bridge", "enable": True, "id": "qq_bridge"}],
            "provider": [{"type": "qq_astrbot_node", "id": "qq_astrbot_node", "enable": True,
                          "provider_type": "chat_completion", "key": [""], "model": "dsh-selected"}],
            "provider_sources": [], "admins_id": [], "wake_prefix": ["/"],
            # Native names differ from broker directory IDs; the registry guard
            # applies the immutable broker allowlist before any handler filter.
            "plugin_set": ["*"], "disable_builtin_commands": True,
            "trace_enable": False, "log_file_enable": False, "log_level": "CRITICAL",
            "http_proxy": "", "subagent_orchestrator": {"enable": False},
        })
        settings = cfg.setdefault("provider_settings", {})
        settings.update({"enable": True, "computer_use_runtime": "none", "web_search": False,
                         "streaming_response": False, "request_max_retries": 0})
        settings.setdefault("proactive_capability", {})["add_cron_tools"] = False
        cfg.setdefault("platform_settings", {}).update({"enable_id_white_list": False,
                                                       "no_permission_reply": False})
        runner = cfg.setdefault("agent_runner", {})
        runner["runner_type"] = "local"
        runner.setdefault("config", {}).setdefault("model", {}).update({
            "provider_id": "qq_astrbot_node", "fallback_provider_ids": [], "request_max_retries": 1,
        })
        runner["config"].setdefault("misc", {}).update({"max_steps": 16, "tool_call_timeout": 120})
        cfg.save_config()
        # Configs are copied with the whole generation. Only the manager is authoritative.
        for plugin_id in self.loaded_ids:
            config = self.plugins[plugin_id].get("config", {})
            if not isinstance(config, dict):
                raise ValueError("plugin configuration must be an object")
            destination = self.root / "data/config" / f"{plugin_id}_config.json"
            destination.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")

        callback_url = self.config.callback_url if self.config else "http://127.0.0.1:1/rpc/callback"
        token = self.config.token if self.config else "validation-no-effects-allowed-000000"
        media_roots = (self.root / "data",) + (self.config.media_roots if self.config else ())
        self.callback = NodeCallbackClient(callback_url, token, media_roots)
        platform.set_callback_client(self.callback)
        provider.set_callback_client(self.callback)
        install_native_guards(self.callback)
        provenance_path = None if self.validation else self.root / "manager/cron-provenance.json"
        install_cron_provenance(CronJobManager, CronProvenanceStore(provenance_path, token))
        from apscheduler.schedulers.base import BaseScheduler
        from .scheduled import install_aps_provenance
        from .scheduled_profiles import ScheduledProfiles
        profiles = ScheduledProfiles(self.root, self.plugins)
        scheduled_path = None if self.validation else self.root / "manager/aps-provenance.json"
        install_aps_provenance(BaseScheduler, CronProvenanceStore(scheduled_path, token),
                               profiles.owner, profiles.arguments, profiles.execution_scope)

        allowed_ids = self.loaded_ids

        def modules(manager):
            # Never import disabled, untracked or bundled command plugins.
            return [item for item in manager._get_modules(manager.plugin_store_path)
                    if item["pname"] in allowed_ids]

        PluginManager._get_plugin_modules = modules

        async def forbid_install(*args, **kwargs):
            raise RuntimeError("dependencies must be installed through a staged generation")

        native.pip_installer.install = forbid_install
        async def no_metadata_download():
            return None
        lifecycle_module.update_llm_metadata = no_metadata_download
        self.lifecycle = AstrBotCoreLifecycle(native.LogBroker(), native.db_helper)
        await self.lifecycle.initialize()
        actual = {getattr(star, "root_dir_name", None) for star in self.lifecycle.star_context.get_all_stars()}
        if self.lifecycle.plugin_manager.failed_plugin_dict or not self.loaded_ids.issubset(actual):
            raise RuntimeError("ASTRBOT_PLUGIN_NATIVE_LOAD_FAILED")
        if not self.lifecycle.provider_manager.provider_insts:
            raise RuntimeError("ASTRBOT_PROVIDER_NATIVE_LOAD_FAILED")
        self.lifecycle.event_queue = ProvenanceQueue(maxsize=100)
        self.lifecycle.star_context._event_queue = self.lifecycle.event_queue
        for instance in self.lifecycle.platform_manager.get_insts():
            instance._event_queue = self.lifecycle.event_queue
        self.lifecycle.event_bus.dispatch = self._dispatch_synthetic
        if not self.validation:
            await self.callback.start()
            self.run_task = asyncio.create_task(self.lifecycle.start(), name="astrbot-native-lifecycle")
            await asyncio.sleep(0)
            if self.run_task.done():
                await self.run_task
                raise RuntimeError("ASTRBOT_NATIVE_LIFECYCLE_STOPPED")
            self.accepting = True

    async def _dispatch_synthetic(self):
        queue = self.lifecycle.event_queue
        while True:
            principal, source = await queue.get()
            try:
                # Preserve synthesized text while stripping fabricated sender/role/policy.
                identity = dataclasses.replace(principal.identity, text=str(source.message_str),
                                               message=(), is_wake=True, deadline_at=0,
                                               plugin_ids=frozenset({principal.plugin_id}), allow_ai=False)
                event = self._platform().create_bridge_event(identity)
                event.message_obj.message = source.message_obj.message
                event.plugins_name = [principal.plugin_id]
                token = bind_principal(identity, principal.plugin_id)
                effects_token = self.callback.begin_effects(identity.context_id)
                try:
                    await self._execute(event)
                finally:
                    self.callback.end_effects(effects_token)
                    reset_principal(token)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.diagnostic("synthetic", "failed")
            finally:
                queue.task_done()

    def _platform(self):
        for instance in self.lifecycle.platform_manager.get_insts():
            if instance.meta().id == "qq_bridge":
                return instance
        raise RuntimeError("ASTRBOT_PLATFORM_UNAVAILABLE")

    async def _execute(self, event):
        scheduler = self.lifecycle.pipeline_scheduler_mapping["default"]
        await scheduler.execute(event)

    async def dispatch(self, params):
        if not self.accepting:
            raise RuntimeError("ASTRBOT_RUNTIME_FROZEN")
        identity = DispatchIdentity.from_params(params)
        if identity.context_id in self.tasks:
            raise RuntimeError("ASTRBOT_DUPLICATE_CONTEXT")
        remaining = (identity.deadline_at - time.time() * 1000) / 1000
        if not 0 < remaining <= 185:
            raise ValueError("dispatch deadline is expired or invalid")
        task = asyncio.current_task()
        self.tasks[identity.context_id] = task
        event = self._platform().create_bridge_event(identity)
        token = bind_principal(identity, AI_PRINCIPAL) if identity.allow_ai else None
        effects_token = self.callback.begin_effects(identity.context_id)
        started = time.monotonic()
        try:
            async with asyncio.timeout(remaining):
                await self._execute(event)
            # WakingCheck stops non-wake messages too; that alone is not a claim.
            effects = self.callback.end_effects(effects_token)
            effects_token = None
            handled = bool(getattr(event, "_qq_plugin_claimed", False)
                           or effects["sent"] or effects["toolUsed"]
                           or getattr(event, "_has_send_oper", False))
            self.diagnostic("dispatch", "handled" if handled else "unhandled", started=started,
                            plugins=self.event_plugins(event))
            return {"handled": handled, "status": "handled" if handled else "unhandled"}
        except asyncio.CancelledError:
            self.diagnostic("dispatch", "cancelled", started=started,
                            plugins=self.event_plugins(event), error_code="ASTRBOT_CANCELLED")
            raise
        except Exception:
            self.diagnostic("dispatch", "failed", started=started,
                            plugins=self.event_plugins(event), error_code="ASTRBOT_DISPATCH_FAILED")
            raise
        finally:
            if effects_token is not None:
                self.callback.end_effects(effects_token)
            self.tasks.pop(identity.context_id, None)
            if token is not None:
                reset_principal(token)

    def cancel(self, context_id):
        task = self.tasks.get(context_id)
        if task:
            task.cancel()
        return {"cancelled": task is not None}

    def event_plugins(self, event):
        from astrbot.core.star.star_handler import star_map
        owners = set(getattr(event, "_qq_plugin_claimed_by", ()))
        for handler in event.get_extra("activated_handlers", []) or []:
            plugin = star_map.get(getattr(handler, "handler_module_path", None))
            owners.add(getattr(plugin, "root_dir_name", None))
        return sorted(owner for owner in owners if owner in self.loaded_ids)

    def diagnostic(self, stage, status, *, started=None, plugins=None, error_code=None):
        record = {"stage": stage, "status": status, "at": int(time.time() * 1000)}
        if plugins:
            record["plugins"] = plugins
        if error_code:
            record["errorCode"] = error_code
        if started is not None:
            record["durationMs"] = round((time.monotonic() - started) * 1000)
        destination = self.root / "manager/runtime.jsonl"
        if destination.exists() and destination.stat().st_size > 2 * 1024 * 1024:
            destination.replace(destination.with_suffix(".previous.jsonl"))
        with destination.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")

    async def stop(self):
        self.accepting = False
        pending = list(self.tasks.values())
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        try:
            if self.lifecycle and hasattr(self.lifecycle, "dashboard_shutdown_event"):
                await self.lifecycle.stop()
        finally:
            if self.run_task:
                self.run_task.cancel()
                await asyncio.gather(self.run_task, return_exceptions=True)
            if self.callback:
                await self.callback.close()
