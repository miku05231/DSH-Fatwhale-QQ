"""Narrow scheduled outbound metadata for the locked Weather profile.

This context is descriptive provenance only. It is not a broker identity, a
principal, or an authorization grant. The native bridge must continue to
enforce the plugin's active policy and exact target-session checks.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Iterator


_WEATHER_PLUGIN_ID = "astrbot_plugin_weather"
_WEATHER_ARCHIVE_SHA256 = (
    "d149d4754147ac26e531fd63e78b7c040af3f1b4dee0e6a694300da3dcf32f30"
)
_WEATHER_PURPOSE = "weather.daily"


@dataclass(frozen=True, slots=True)
class ScheduledOutbound:
    """The exact narrow provenance fields accepted for a daily weather push."""

    plugin_id: str
    source_sha256: str
    purpose: str = _WEATHER_PURPOSE


outbound_context: ContextVar[ScheduledOutbound | None] = ContextVar(
    "qq_astrbot_scheduled_outbound",
    default=None,
)


def current_outbound() -> ScheduledOutbound | None:
    """Return the current scheduled outbound scope, if one is active."""

    scope = outbound_context.get()
    if type(scope) is not ScheduledOutbound:
        return None
    if (
        scope.plugin_id != _WEATHER_PLUGIN_ID
        or scope.source_sha256 != _WEATHER_ARCHIVE_SHA256
        or scope.purpose != _WEATHER_PURPOSE
    ):
        return None
    return scope


@contextmanager
def bind_outbound(scope: ScheduledOutbound) -> Iterator[ScheduledOutbound]:
    """Set the narrow scope and always restore the caller's ContextVar value."""

    if type(scope) is not ScheduledOutbound:
        raise TypeError("scope must be ScheduledOutbound")
    if (
        scope.plugin_id != _WEATHER_PLUGIN_ID
        or scope.source_sha256 != _WEATHER_ARCHIVE_SHA256
        or scope.purpose != _WEATHER_PURPOSE
    ):
        raise ValueError("unsupported scheduled outbound scope")

    token: Token[ScheduledOutbound | None] = outbound_context.set(scope)
    try:
        yield scope
    finally:
        outbound_context.reset(token)
