"""MIT-licensed, offline fixture for the bridge's native AstrBot acceptance tests."""
import base64
from datetime import datetime, timedelta, timezone
import io
import struct
import wave
import zlib
from dataclasses import dataclass
from urllib.parse import urlsplit

from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import File, Image, Plain, Record, Video
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.tool import FunctionTool
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType
from qq_astrbot.context import require_principal


FIXTURE_JOB_OWNER = "qq_boundary_fixture"
FIXTURE_JOB_KIND = "basic-timer"
FIXTURE_JOB_CRON = "* * * * *"
MIN_TIMER_SECONDS = 3
MAX_TIMER_SECONDS = 300


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def _fixture_png() -> bytes:
    """Return a tiny deterministic RGBA PNG without Pillow or network access."""
    header = struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0)
    pixels = b"\x00" + bytes((255, 64, 64, 255, 0, 64, 255, 255))
    pixels += b"\x00" + bytes((64, 255, 64, 255, 255, 64, 255, 255))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(pixels))
        + _png_chunk(b"IEND", b"")
    )


def _bridge_platform_id(context: Context) -> str:
    for platform in context.platform_manager.platform_insts:
        metadata = platform.meta()
        if metadata.name == "qq_bridge":
            return str(metadata.id)
    raise RuntimeError("qq_bridge platform instance is unavailable")


def _identity_session(identity, platform_id: str) -> MessageSession:
    if identity.is_group:
        return MessageSession(platform_id, MessageType.GROUP_MESSAGE, str(identity.group_id))
    return MessageSession(platform_id, MessageType.FRIEND_MESSAGE, str(identity.user_id))


def _fixture_plugin_owner(module_path: str) -> str:
    # Use the bridge's same native module-to-plugin-root mapping as its guards.
    from qq_astrbot.provider import _native_module_owner

    owner = _native_module_owner(module_path)
    if not owner:
        raise RuntimeError("fixture plugin owner is unavailable")
    return owner


@dataclass
class FixtureTool(FunctionTool):
    async def call(self, context, value: str):
        return "class-tool:" + value


@register("qq_boundary_fixture", "miku05231", "Offline boundary fixture", "1.0.0")
class BoundaryFixture(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        context.add_llm_tools(FixtureTool(
            name="fixture_class_tool", description="Echo a fixture value with no external effect.",
            parameters={"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]},
        ))

    async def initialize(self):
        """Reattach only this fixture's persisted native basic-job callbacks."""
        manager = self.context.cron_manager
        plugin_owner = _fixture_plugin_owner(self.__class__.__module__)
        for job in await manager.list_jobs("basic"):
            payload = job.payload if isinstance(job.payload, dict) else {}
            if (
                not job.persistent
                or payload.get("fixture_owner") != FIXTURE_JOB_OWNER
                or payload.get("fixture_kind") != FIXTURE_JOB_KIND
                or payload.get("fixture_plugin_owner") != plugin_owner
            ):
                continue
            # AstrBot 4.29.3 persists basic job rows but not Python callbacks.
            # This private registry is the narrow reattachment point; update_job
            # performs the native schedule and the bridge verifies stored HMAC
            # provenance before APScheduler accepts it.
            manager._basic_handlers[job.job_id] = self._scheduled_timer
            try:
                await manager.update_job(job.job_id, enabled=job.enabled)
            except RuntimeError as exc:
                manager._basic_handlers.pop(job.job_id, None)
                if str(exc) != "scheduled job has no verified broker provenance":
                    raise
                await manager.update_job(job.job_id, enabled=False)
                self.logger.warning(
                    "Skipped fixture timer %s because verified broker provenance is unavailable.",
                    job.job_id,
                )

    @filter.command("ast_echo")
    async def echo(self, event: AstrMessageEvent, value: str = "fixture"):
        yield event.plain_result("echo:" + value)

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("ast_admin")
    async def admin(self, event: AstrMessageEvent):
        yield event.plain_result("admin-only")

    @filter.command("ast_voice")
    async def voice(self, event: AstrMessageEvent):
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x00" * 800)
        yield event.chain_result([Record.fromBase64(base64.b64encode(output.getvalue()).decode("ascii"))])

    @filter.command("ast_image")
    async def image(self, event: AstrMessageEvent):
        yield event.chain_result([
            Image.fromBytes(_fixture_png()),
        ])

    @filter.command("ast_media")
    async def media(self, event: AstrMessageEvent):
        media_types = (File, Image, Record, Video)
        media = [component for component in event.get_messages() if isinstance(component, media_types)]
        if not media:
            yield event.plain_result("media:none; attach media to /ast_media")
            return

        echoed = media[:3]
        sources = []
        for component in echoed:
            source = str(getattr(component, "file", "") or "")
            kind = type(component).__name__.lower()
            sources.append(f"{kind}:{urlsplit(source).scheme or 'local'}")
        label = f"media:count={len(media)}; echoed={len(echoed)}; sources={','.join(sources)}"
        # Echo native components only. The fixture never opens URLs or paths;
        # the bridge handles its bounded base64/local-media flow on send.
        yield event.chain_result([Plain(label), *echoed])

    @filter.command("ast_timer")
    async def timer(
        self,
        event: AstrMessageEvent,
        delay_seconds: str = "3",
        marker: str = "timer",
        target_group: str = "",
    ):
        try:
            delay = int(delay_seconds)
        except (TypeError, ValueError):
            yield event.plain_result("timer-error: delay must be an integer from 3 to 300 seconds")
            return
        if not MIN_TIMER_SECONDS <= delay <= MAX_TIMER_SECONDS:
            yield event.plain_result("timer-error: delay must be an integer from 3 to 300 seconds")
            return
        marker = marker.strip()[:64] or "timer"
        target_group = target_group.strip()
        if target_group and (not target_group.isascii() or not target_group.isdigit() or len(target_group) > 32):
            yield event.plain_result("timer-error: target_group must be a numeric group id")
            return

        principal = require_principal()
        plugin_owner = _fixture_plugin_owner(self.__class__.__module__)
        if principal.plugin_id != plugin_owner:
            raise PermissionError("timer source principal does not own this fixture plugin")

        run_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
        payload = {
            "fixture_owner": FIXTURE_JOB_OWNER,
            "fixture_kind": FIXTURE_JOB_KIND,
            "fixture_plugin_owner": plugin_owner,
            "marker": marker,
            "target_group": target_group,
            "run_at": run_at.isoformat(),
        }
        manager = self.context.cron_manager
        job = await manager.add_basic_job(
            name=f"QQ boundary fixture timer: {marker}",
            cron_expression=FIXTURE_JOB_CRON,
            handler=self._scheduled_timer,
            description="One-shot offline acceptance-fixture callback.",
            payload=payload,
            enabled=False,
            persistent=True,
        )
        try:
            # add_basic_job has no run_once argument in AstrBot 4.29.3. Create
            # the persistent basic row disabled, then use the public update
            # path to select its native DateTrigger and enable it. Provenance
            # is bound by the bridge's _schedule_job guard at this point.
            updated = await manager.update_job(
                job.job_id,
                enabled=True,
                run_once=True,
                payload=payload,
                cron_expression=run_at.isoformat(),
            )
            if updated is None:
                raise RuntimeError("native cron job disappeared before scheduling")
        except Exception:
            await manager.delete_job(job.job_id)
            raise

        yield event.plain_result(f"timer-scheduled:{marker}; delay={delay}s; job={job.job_id}")

    async def _scheduled_timer(self, **payload):
        if (
            payload.get("fixture_owner") != FIXTURE_JOB_OWNER
            or payload.get("fixture_kind") != FIXTURE_JOB_KIND
        ):
            raise RuntimeError("refusing a non-fixture basic cron payload")

        principal = require_principal()
        plugin_owner = _fixture_plugin_owner(self.__class__.__module__)
        if (
            payload.get("fixture_plugin_owner") != plugin_owner
            or principal.plugin_id != plugin_owner
        ):
            raise PermissionError("scheduled principal does not own this fixture timer")
        identity = principal.identity
        platform_id = _bridge_platform_id(self.context)
        origin_session = _identity_session(identity, platform_id)
        marker = str(payload.get("marker", "timer"))[:64]
        target_group = str(payload.get("target_group", ""))
        if target_group:
            target_session = MessageSession(
                platform_id, MessageType.GROUP_MESSAGE, target_group
            )
            try:
                await self.context.send_message(
                    target_session,
                    MessageChain().message(f"timer-fired:{marker}"),
                )
            except PermissionError:
                await self.context.send_message(
                    origin_session,
                    MessageChain().message(f"timer-denied-cross-group:{marker}"),
                )
                return
            await self.context.send_message(
                origin_session,
                MessageChain().message(f"timer-warning:unexpected-target-accepted:{marker}"),
            )
            return

        await self.context.send_message(
            origin_session,
            MessageChain().message(f"timer-fired:{marker}"),
        )

    @filter.command("ast_llm")
    async def model(self, event: AstrMessageEvent):
        provider_id = await self.context.get_current_chat_provider_id(event.unified_msg_origin)
        response = await self.context.llm_generate(chat_provider_id=provider_id, prompt="fixture-model-request")
        yield event.plain_result(response.completion_text)

    @filter.command("ast_legacy")
    async def legacy(self, event: AstrMessageEvent):
        provider = self.context.get_using_provider(event.unified_msg_origin)
        response = await provider.text_chat(prompt="fixture-legacy-request", session_id=event.unified_msg_origin)
        yield event.plain_result(response.completion_text)

    @filter.llm_tool(name="fixture_decorator_tool")
    async def decorator_tool(self, event: AstrMessageEvent, value: str):
        """Echo a value with no external effect.

        Args:
            value(string): The fixture value.
        """
        return "decorator-tool:" + value

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.llm_tool(name="fixture_admin_tool")
    async def admin_tool(self, event: AstrMessageEvent):
        """Return the fixture's administrator-only marker."""
        return "administrator-tool"
