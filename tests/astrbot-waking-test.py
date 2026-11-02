"""Isolated regression tests for the native AstrBot wake-stage wrapper.

The real qq_astrbot.acl module is imported and patched. Small Core stubs model
only the interfaces needed by install_native_guards; this does not claim to
exercise AstrBot Core's own pipeline implementation.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
import sys
import types
import unittest
from contextvars import ContextVar
from types import SimpleNamespace


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "runtime" / "astrbot"))

from qq_astrbot.acl import install_native_guards  # noqa: E402
from qq_astrbot.context import DispatchIdentity  # noqa: E402


def stub_module(name: str, *, package: bool = False, **attributes):
    module = types.ModuleType(name)
    if package:
        module.__path__ = []
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module
    parent_name, separator, child_name = name.rpartition(".")
    if separator:
        setattr(sys.modules[parent_name], child_name, module)
    return module


@dataclass
class StubStageContext:
    astrbot_config: dict


class StubWakingCheckStage:
    def __init__(self, ctx):
        self.ctx = ctx

    async def process(self, event):
        prefixes = self.ctx.astrbot_config.get("wake_prefix", [])
        event.stage_seen = self
        event.prefixes_seen = tuple(prefixes)
        return event.prefixes_seen


class StubHandlerRegistry:
    _handlers = []

    def get_handlers_by_event_type(self, event_type, *args, **kwargs):
        return []


class StubCronMessageEvent:
    def __init__(self, *args, **kwargs):
        pass

    def is_admin(self):
        return False


class StubFunctionToolExecutor:
    @classmethod
    async def execute(cls, tool, run_context, **tool_args):
        if False:
            yield None


async def _stub_call_handler(*args, **kwargs):
    if False:
        yield None


async def _stub_call_event_hook(*args, **kwargs):
    return False


def install_core_stubs() -> None:
    stub_module("astrbot", package=True)
    core = stub_module("astrbot.core", package=True, astrbot_config={}, logger=SimpleNamespace(error=lambda *_: None))
    stub_module("astrbot.core.platform", package=True)
    event_module = stub_module("astrbot.core.platform.astr_message_event")
    event_module.current_message_event = ContextVar("stub_current_message_event", default=None)

    stub_module("astrbot.core.pipeline", package=True)
    context_utils = stub_module("astrbot.core.pipeline.context_utils")
    context_utils.call_handler = _stub_call_handler
    context_utils.call_event_hook = _stub_call_event_hook
    stub_module("astrbot.core.pipeline.waking_check", package=True)
    stub_module(
        "astrbot.core.pipeline.waking_check.stage",
        WakingCheckStage=StubWakingCheckStage,
    )

    stub_module("astrbot.core.star", package=True)
    star_handler = stub_module("astrbot.core.star.star_handler")
    star_handler.star_handlers_registry = StubHandlerRegistry()
    star_handler.star_map = {}

    stub_module("astrbot.core.cron", package=True)
    stub_module(
        "astrbot.core.cron.events",
        CronMessageEvent=StubCronMessageEvent,
    )
    stub_module(
        "astrbot.core.astr_agent_tool_exec",
        FunctionToolExecutor=StubFunctionToolExecutor,
    )

    # Avoid importing AstrBot's provider dependencies: this test targets the
    # real ACL installer and wake wrapper only.
    provider = stub_module("qq_astrbot.provider")
    provider._admin_only_tool = lambda _tool: False
    provider._native_module_owner = lambda _path: None
    provider._native_tool_owner = lambda _tool: None
    provider._native_tool_permissions_allowed = lambda _tool, _event: True

    assert core.astrbot_config == {}
    install_native_guards(SimpleNamespace(authorize_tool=lambda _name: True))


def make_identity(*, is_wake: bool) -> DispatchIdentity:
    return DispatchIdentity.from_params(
        {
            "contextId": "isolated-wake-test",
            "deadlineAt": 2_000_000_000,
            "event": {
                "messageId": "wake-test-message",
                "userId": "test-user",
                "groupId": "test-group",
                "isGroup": True,
                "isAdmin": False,
                "isWake": is_wake,
                "text": "ordinary body",
                "message": [],
            },
            "policy": {
                "pluginIds": ["fixture-plugin"],
                "chatMode": "astrbot",
                "allowAi": is_wake,
            },
        }
    )


class NativeWakingGuardTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        install_core_stubs()

    async def test_wake_event_gets_local_empty_prefix_without_mutating_shared_stage(self):
        prefixes = ["/"]
        shared_config = {"wake_prefix": prefixes}
        context = StubStageContext(shared_config)
        stage = StubWakingCheckStage(context)
        event = SimpleNamespace(
            _qq_bridge_event=True,
            identity=make_identity(is_wake=True),
            text="ordinary body",
        )

        result = await stage.process(event)

        self.assertEqual(result, ("/", ""))
        self.assertEqual(event.prefixes_seen, ("/", ""))
        self.assertIsNot(event.stage_seen, stage)
        self.assertIs(stage.ctx, context)
        self.assertIs(stage.ctx.astrbot_config, shared_config)
        self.assertIs(shared_config["wake_prefix"], prefixes)
        self.assertEqual(prefixes, ["/"])
        self.assertEqual(event.text, "ordinary body")

    async def test_unwoken_bridge_and_ordinary_events_keep_original_wake_config(self):
        shared_config = {"wake_prefix": ["/"]}
        stage = StubWakingCheckStage(StubStageContext(shared_config))
        unwoken = SimpleNamespace(
            _qq_bridge_event=True,
            identity=make_identity(is_wake=False),
            text="ordinary body",
        )
        ordinary = SimpleNamespace(text="/ordinary command")

        self.assertEqual(await stage.process(unwoken), ("/",))
        self.assertIs(unwoken.stage_seen, stage)
        self.assertEqual(unwoken.prefixes_seen, ("/",))
        self.assertEqual(await stage.process(ordinary), ("/",))
        self.assertIs(ordinary.stage_seen, stage)
        self.assertEqual(stage.ctx.astrbot_config, {"wake_prefix": ["/"]})

    async def test_concurrent_wake_fallback_does_not_leak_to_unwoken_dispatch(self):
        config = {"wake_prefix": ["/"]}
        stage = StubWakingCheckStage(StubStageContext(config))
        wake = SimpleNamespace(
            _qq_bridge_event=True,
            identity=make_identity(is_wake=True),
            text="wake body",
        )
        no_wake = SimpleNamespace(
            _qq_bridge_event=True,
            identity=make_identity(is_wake=False),
            text="no wake body",
        )

        results = await asyncio.gather(stage.process(wake), stage.process(no_wake))

        self.assertEqual(results, [("/", ""), ("/",)])
        self.assertEqual(wake.prefixes_seen, ("/", ""))
        self.assertEqual(no_wake.prefixes_seen, ("/",))
        self.assertIsNot(wake.stage_seen, stage)
        self.assertIs(no_wake.stage_seen, stage)
        self.assertEqual(config, {"wake_prefix": ["/"]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
