from __future__ import annotations

import asyncio

from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform import Platform
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.platform.register import register_platform_adapter as register

from .callback import NodeCallbackClient
from .context import (
    AI_PRINCIPAL,
    DispatchIdentity,
    Principal,
    bind_principal,
    current_principal,
    require_principal,
    reset_principal,
)
from .segments import incoming_components, outgoing_components

_callback_client: NodeCallbackClient | None = None


def set_callback_client(client: NodeCallbackClient) -> None:
    global _callback_client
    _callback_client = client


class QQBridgeMessageEvent(AstrMessageEvent):
    def __init__(self, message, platform_meta, identity, callback_client):
        self._qq_identity = identity
        self.callback_client = callback_client
        self._qq_bridge_event = True
        self._qq_plugin_claimed = False
        self._qq_plugin_claimed_by: set[str] = set()
        self._qq_result_principal: Principal | None = None
        super().__init__(
            message_str=message.message_str,
            message_obj=message,
            platform_meta=platform_meta,
            session_id=message.session_id,
        )

    def __setattr__(self, name, value):
        if name == "_qq_identity" and hasattr(self, "_qq_identity"):
            raise AttributeError("bridge event identity is immutable")
        super().__setattr__(name, value)

    @property
    def identity(self) -> DispatchIdentity:
        return self._qq_identity

    def is_admin(self) -> bool:
        return self.identity.is_admin

    def _qq_mark_plugin_claim(self) -> None:
        principal = current_principal.get()
        if (
            principal is not None
            and principal.identity == self.identity
            and principal.plugin_id != AI_PRINCIPAL
            and principal.plugin_id in self.identity.plugin_ids
        ):
            self._qq_plugin_claimed = True
            self._qq_plugin_claimed_by.add(principal.plugin_id)

    def stop_event(self) -> None:
        result = super().stop_event()
        self._qq_mark_plugin_claim()
        return result

    def set_result(self, result):
        principal = current_principal.get()
        result_value = super().set_result(result)
        self._qq_result_principal = principal if principal is not None and principal.identity == self.identity else None
        self._qq_mark_plugin_claim()
        return result_value

    def _send_principal(self) -> Principal:
        active = current_principal.get()
        result_owner = self._qq_result_principal
        if active is not None and active.identity != self.identity:
            raise PermissionError("send provenance does not match the bridge event")
        if result_owner is not None and result_owner.identity != self.identity:
            raise PermissionError("result provenance does not match the bridge event")
        if result_owner is not None and (active is None or active.plugin_id == AI_PRINCIPAL):
            return result_owner
        if active is not None:
            return active
        if result_owner is not None:
            return result_owner
        if self.identity.allow_ai:
            return Principal(self.identity, AI_PRINCIPAL)
        raise PermissionError("send provenance is unavailable")

    async def send(self, message):
        if message is None or not getattr(message, "chain", None):
            return
        principal = self._send_principal()
        token = bind_principal(principal.identity, principal.plugin_id)
        try:
            components = await outgoing_components(message, self.callback_client)
            await self.callback_client.send(self.identity.target(), components, principal)
            self._qq_mark_plugin_claim()
            await super().send(message)
        finally:
            reset_principal(token)


@register(
    "qq_bridge",
    "Authenticated qq-bridge OneBot RPC adapter",
    adapter_display_name="qq-bridge",
    support_streaming_message=False,
    default_config_tmpl={"type": "qq_bridge", "enable": True, "id": "qq_bridge"},
)
class QQBridgePlatform(Platform):
    def __init__(self, config: dict, platform_settings: dict, event_queue: asyncio.Queue):
        super().__init__(config, event_queue)
        self.platform_settings = platform_settings
        if _callback_client is None:
            raise RuntimeError("Node callback client was not installed")
        self.callback_client = _callback_client

    async def run(self) -> None:
        await asyncio.Event().wait()

    def meta(self) -> PlatformMetadata:
        return PlatformMetadata(
            name="qq_bridge",
            description="Authenticated qq-bridge OneBot RPC adapter",
            id=str(self.config.get("id", "qq_bridge")),
            adapter_display_name="qq-bridge",
            support_streaming_message=False,
            support_proactive_message=False,
        )

    def create_bridge_event(self, identity: DispatchIdentity):
        from astrbot.core.platform.astrbot_message import AstrBotMessage, Group, MessageMember

        message = AstrBotMessage()
        message.type = MessageType.GROUP_MESSAGE if identity.is_group else MessageType.FRIEND_MESSAGE
        message.self_id = str(self.config.get("self_id", "qq-bridge"))
        message.session_id = identity.group_id if identity.is_group else identity.user_id
        message.message_id = identity.message_id
        message.sender = MessageMember(user_id=identity.user_id, nickname=identity.nickname)
        message.group = Group(group_id=identity.group_id) if identity.is_group else None
        message.message = incoming_components(list(identity.message), self.callback_client)
        message.message_str = identity.text
        message.raw_message = {"message": list(identity.message)}
        event = QQBridgeMessageEvent(message, self.meta(), identity, self.callback_client)
        event.role = "admin" if identity.is_admin else "member"
        event.plugins_name = sorted(identity.plugin_ids)
        event.is_wake = identity.is_wake
        event.is_at_or_wake_command = identity.is_wake
        event.call_llm = not identity.allow_ai
        event._qq_node_is_admin = identity.is_admin
        event._qq_node_is_wake = identity.is_wake
        event._qq_allow_ai = identity.allow_ai
        return event

    async def send_by_session(self, session, message_chain) -> None:
        from .outbound import current_outbound
        scope = current_outbound()
        if scope is not None and current_principal.get() is None:
            from astrbot.core.message.components import Plain
            components = getattr(message_chain, "chain", message_chain)
            if not isinstance(components, (list, tuple)) or not components or len(components) > 32:
                raise PermissionError("scheduled outbound message is invalid")
            if any(type(component) is not Plain for component in components):
                raise PermissionError("scheduled outbound supports text only")
            if session.message_type == MessageType.FRIEND_MESSAGE:
                kind = "private"
            elif session.message_type == MessageType.GROUP_MESSAGE:
                kind = "group"
            else:
                raise PermissionError("scheduled outbound target is invalid")
            await self.callback_client.send_outbound(scope, {"kind": kind, "id": str(session.session_id)}, [
                {"type": "text", "data": {"text": component.text}} for component in components
            ])
            return
        principal = require_principal()
        identity = principal.identity
        from astrbot.core.platform.astr_message_event import current_message_event
        event = current_message_event.get(None)
        if (
            getattr(event, "_qq_bridge_event", False)
            and getattr(event, "identity", None) != identity
        ):
            raise PermissionError("send provenance does not match the bridge event")
        if session.message_type == MessageType.GROUP_MESSAGE:
            if not identity.is_group or str(session.session_id) != str(identity.group_id):
                raise PermissionError("cross-session send denied")
        elif session.message_type == MessageType.FRIEND_MESSAGE:
            if identity.is_group or str(session.session_id) != str(identity.user_id):
                raise PermissionError("cross-session send denied")
        else:
            raise PermissionError("send_by_session requires an origin session")
        await self.callback_client.send(identity.target(), await outgoing_components(message_chain, self.callback_client))
        mark_claim = getattr(event, "_qq_mark_plugin_claim", None)
        if callable(mark_claim):
            mark_claim()
