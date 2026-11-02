from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Any


AI_PRINCIPAL = "__ai__"


@dataclass(frozen=True)
class DispatchIdentity:
    context_id: str
    message_id: str
    user_id: str
    nickname: str
    group_id: str | None
    is_group: bool
    is_admin: bool
    is_wake: bool
    plugin_ids: frozenset[str]
    chat_mode: str
    allow_ai: bool
    deadline_at: int
    text: str
    message: tuple[dict[str, Any], ...]

    @classmethod
    def from_params(cls, params: dict[str, Any]) -> "DispatchIdentity":
        event = params.get("event")
        policy = params.get("policy")
        if not isinstance(event, dict) or not isinstance(policy, dict):
            raise ValueError("dispatch event and policy are required")
        context_id = params.get("contextId")
        user_id = event.get("userId")
        group_id = event.get("groupId")
        mode = policy.get("chatMode")
        plugin_ids = policy.get("pluginIds", [])
        if not isinstance(context_id, str) or not context_id:
            raise ValueError("contextId is required")
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("event.userId is required")
        if not isinstance(event.get("messageId"), str) or not event["messageId"]:
            raise ValueError("event.messageId is required")
        if not isinstance(mode, str) or mode not in {"dsh", "astrbot"}:
            raise ValueError("policy.chatMode is invalid")
        if not isinstance(plugin_ids, list) or any(not isinstance(item, str) for item in plugin_ids):
            raise ValueError("policy.pluginIds is invalid")
        is_group = event.get("isGroup") is True
        if is_group and (not isinstance(group_id, str) or not group_id):
            raise ValueError("groupId is required for group dispatch")
        allow_ai = policy.get("allowAi") is True
        is_wake = event.get("isWake") is True
        if allow_ai and (mode != "astrbot" or not is_wake):
            raise ValueError("allowAi requires an AstrBot wake dispatch")
        deadline = params.get("deadlineAt", 0)
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)):
            raise ValueError("policy.deadlineAt is invalid")
        segments = event.get("message", [])
        if not isinstance(segments, list) or any(not isinstance(item, dict) for item in segments):
            raise ValueError("event.message must be OneBot segments")
        return cls(
            context_id=context_id,
            message_id=event["messageId"],
            user_id=user_id,
            nickname=str(event.get("nickname", "")),
            group_id=group_id if is_group else None,
            is_group=is_group,
            is_admin=event.get("isAdmin") is True,
            is_wake=is_wake,
            plugin_ids=frozenset(plugin_ids),
            chat_mode=mode,
            allow_ai=allow_ai,
            deadline_at=int(deadline),
            text=str(event.get("text", "")),
            message=tuple(dict(item) for item in segments),
        )

    def target(self) -> dict[str, Any]:
        if self.is_group:
            return {"isGroup": True, "groupId": self.group_id}
        return {"isGroup": False, "userId": self.user_id}


@dataclass(frozen=True)
class Principal:
    identity: DispatchIdentity
    plugin_id: str


current_principal: ContextVar[Principal | None] = ContextVar(
    "qq_astrbot_principal",
    default=None,
)


def bind_principal(identity: DispatchIdentity, plugin_id: str) -> Token:
    if plugin_id != AI_PRINCIPAL and plugin_id not in identity.plugin_ids:
        raise PermissionError("plugin is outside the broker session allowlist")
    if plugin_id == AI_PRINCIPAL and not identity.allow_ai:
        raise PermissionError("generic AI is not enabled for this dispatch")
    return current_principal.set(Principal(identity, plugin_id))


def reset_principal(token: Token) -> None:
    current_principal.reset(token)


def require_principal() -> Principal:
    principal = current_principal.get()
    if principal is None:
        raise PermissionError("durable broker provenance is unavailable")
    if principal.plugin_id != AI_PRINCIPAL and principal.plugin_id not in principal.identity.plugin_ids:
        raise PermissionError("plugin is outside the broker session allowlist")
    if principal.plugin_id == AI_PRINCIPAL and not principal.identity.allow_ai:
        raise PermissionError("generic AI is not enabled for this dispatch")
    return principal
