"""APScheduler executor context isolation for broker dispatch identities."""

from __future__ import annotations

import inspect
import threading
from functools import wraps
from typing import Any

from .context import current_principal


_SUPPORTED_APSCHEDULER_VERSION = "3.11.3"
_INSTALL_LOCK = threading.RLock()
_INSTALLED_EXECUTOR_CLASS: type[Any] | None = None
_ORIGINAL_DO_SUBMIT_JOB: Any = None
_GUARDED_DO_SUBMIT_JOB: Any = None
_GUARD_MARKER = "__qq_astrbot_scheduler_context_guard__"
_ORIGINAL_MARKER = "__qq_astrbot_scheduler_context_guard_original__"
_VERSION_MARKER = "__qq_astrbot_scheduler_context_guard_version__"


def _validate_hook(method: Any) -> None:
    if not inspect.isfunction(method):
        raise RuntimeError("Unsupported APScheduler AsyncIOExecutor._do_submit_job hook")

    try:
        parameters = tuple(inspect.signature(method).parameters.values())
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Cannot inspect APScheduler AsyncIOExecutor._do_submit_job") from exc

    expected_names = ("self", "job", "run_times")
    if tuple(parameter.name for parameter in parameters) != expected_names or any(
        parameter.kind not in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        or parameter.default is not inspect.Parameter.empty
        for parameter in parameters
    ):
        raise RuntimeError("Unsupported APScheduler AsyncIOExecutor._do_submit_job signature")


def install_scheduler_context_guard() -> None:
    """Clear message identity while APScheduler submits async or thread jobs.

    APScheduler 3.11.3 is the only supported hook shape. Unsupported versions
    or a replaced hook fail closed instead of silently leaving ambient identity
    inheritance enabled.
    """

    try:
        import apscheduler
        from apscheduler.executors.asyncio import AsyncIOExecutor
        from astrbot.core.platform.astr_message_event import current_message_event
    except Exception as exc:
        raise RuntimeError("Scheduler context guard dependencies are unavailable") from exc

    version = getattr(apscheduler, "__version__", None)
    if version != _SUPPORTED_APSCHEDULER_VERSION:
        raise RuntimeError(
            "Scheduler context guard supports APScheduler "
            f"{_SUPPORTED_APSCHEDULER_VERSION}; found {version!r}"
        )

    global _INSTALLED_EXECUTOR_CLASS, _ORIGINAL_DO_SUBMIT_JOB, _GUARDED_DO_SUBMIT_JOB
    with _INSTALL_LOCK:
        current = getattr(AsyncIOExecutor, "_do_submit_job", None)

        if _INSTALLED_EXECUTOR_CLASS is AsyncIOExecutor:
            if current is _GUARDED_DO_SUBMIT_JOB:
                return
            raise RuntimeError("APScheduler AsyncIOExecutor hook changed after context guard install")

        if getattr(current, _GUARD_MARKER, False):
            if getattr(current, _VERSION_MARKER, None) != _SUPPORTED_APSCHEDULER_VERSION:
                raise RuntimeError("APScheduler AsyncIOExecutor has an incompatible context guard")
            original = getattr(current, _ORIGINAL_MARKER, None)
            _validate_hook(original)
            _INSTALLED_EXECUTOR_CLASS = AsyncIOExecutor
            _ORIGINAL_DO_SUBMIT_JOB = original
            _GUARDED_DO_SUBMIT_JOB = current
            return

        original = AsyncIOExecutor.__dict__.get("_do_submit_job")
        if current is not original:
            raise RuntimeError("APScheduler AsyncIOExecutor._do_submit_job is overridden")
        _validate_hook(original)

        @wraps(original)
        def guarded_do_submit_job(self, job, run_times):
            from .outbound import outbound_context
            outbound_token = outbound_context.set(None)
            principal_token = current_principal.set(None)
            try:
                event_token = current_message_event.set(None)
                try:
                    # create_task() captures this cleared context. The executor
                    # also uses this same guarded submission path for thread jobs.
                    return original(self, job, run_times)
                finally:
                    current_message_event.reset(event_token)
            finally:
                current_principal.reset(principal_token)
                outbound_context.reset(outbound_token)

        setattr(guarded_do_submit_job, _GUARD_MARKER, True)
        setattr(guarded_do_submit_job, _ORIGINAL_MARKER, original)
        setattr(guarded_do_submit_job, _VERSION_MARKER, _SUPPORTED_APSCHEDULER_VERSION)

        AsyncIOExecutor._do_submit_job = guarded_do_submit_job
        _INSTALLED_EXECUTOR_CLASS = AsyncIOExecutor
        _ORIGINAL_DO_SUBMIT_JOB = original
        _GUARDED_DO_SUBMIT_JOB = guarded_do_submit_job


__all__ = ["install_scheduler_context_guard"]
