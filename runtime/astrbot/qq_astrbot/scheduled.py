"""Bounded provenance guards for third-party APScheduler jobs.

Only explicitly identified jobs in an APScheduler memory store can receive a
persisted principal. Owned jobs without an exact grant run with principal and
native event cleared; unknown callbacks use the scheduler's executor guard.
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass
from datetime import datetime, timedelta
import functools
import hashlib
import importlib
import inspect
import json
import logging
import math
import sys
import textwrap
import threading
import weakref
from typing import Any, Callable

from .context import Principal, current_principal

_LOG = logging.getLogger("qq_astrbot.scheduled")
_STATE_ATTR = "__qq_aps_provenance_state__"
_PROCESSING_JOBS: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "qq_astrbot_aps_processing_jobs", default=False
)
_PROCESSING_JOB_LOCAL = threading.local()

_MAX_JSON_BYTES = 64 * 1024
_MAX_JSON_NODES = 8192
_MAX_JSON_DEPTH = 32
_MAX_STRING_BYTES = 16 * 1024
_MAX_TRIGGER_BYTES = 4096
_MAX_TIMEZONE_BYTES = 256
_MAX_OWNER_BYTES = 256
_MAX_PROFILE_SOURCE_BYTES = 32 * 1024


@dataclass(frozen=True)
class _JobState:
    job_id: str | None
    jobstore: str
    owner: str | None
    key: str | None
    args_digest: str | None
    profile_hash: str | None
    original_func: Any


def _json_string_byte_size(value: str, label: str = "argument string") -> int:
    if len(value) > _MAX_STRING_BYTES:
        raise ValueError(f"{label} exceeds size limit")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{label} is not valid UTF-8") from exc

    size = len(encoded) + 2
    for character in value:
        codepoint = ord(character)
        if character in ('"', "\\"):
            size += 1
        elif codepoint < 0x20:
            size += 1 if character in "\b\t\n\f\r" else 5
    return size


def _validate_json(value: Any) -> None:
    """Reject non-JSON values and bound traversal before serializing them."""
    count = 0
    encoded_size = 0

    def add_size(size: int) -> None:
        nonlocal encoded_size
        encoded_size += size
        if encoded_size > _MAX_JSON_BYTES:
            raise ValueError("argument projection exceeds byte limit")

    def visit(item: Any, depth: int) -> None:
        nonlocal count
        count += 1
        if count > _MAX_JSON_NODES or depth > _MAX_JSON_DEPTH:
            raise ValueError("argument projection exceeds structural limits")

        item_type = type(item)
        if item is None or item_type is bool:
            add_size(4 if item is None or item is True else 5)
            return
        if item_type is int:
            if item.bit_length() > 4096:
                raise ValueError("argument integer exceeds size limit")
            add_size(len(str(item)))
            return
        if item_type is float:
            if not math.isfinite(item):
                raise ValueError("argument float is not finite")
            add_size(len(repr(item)))
            return
        if item_type is str:
            add_size(_json_string_byte_size(item))
            return
        if item_type is list:
            add_size(2 + max(0, len(item) - 1))
            for child in item:
                visit(child, depth + 1)
            return
        if item_type is dict:
            add_size(2 + max(0, len(item) - 1))
            for key, child in item.items():
                if type(key) is not str:
                    raise ValueError("argument object keys must be strings")
                add_size(_json_string_byte_size(key, "argument object key") + 1)
                count += 1
                if count > _MAX_JSON_NODES:
                    raise ValueError("argument projection exceeds structural limits")
                visit(child, depth + 1)
            return
        raise ValueError("argument projection contains a non-JSON value")

    visit(value, 0)


def _canonical_json(value: Any) -> bytes:
    _validate_json(value)
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    if len(encoded) > _MAX_JSON_BYTES:
        raise ValueError("argument projection exceeds byte limit")
    return encoded


def _argument_projection(
    owner: str,
    original_func: Any,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    argument_encoder: Callable[[str, Any, tuple[Any, ...], dict[str, Any]], Any] | None,
) -> tuple[Any, bytes]:
    if argument_encoder is None:
        projection = {"args": list(args), "kwargs": kwargs}
    else:
        projection = argument_encoder(owner, original_func, args, kwargs)
    return projection, _canonical_json(projection)


def _stable_trigger(scheduler: Any, trigger: Any) -> tuple[str, str, dict[str, Any]] | None:
    try:
        from apscheduler.triggers.cron import CronTrigger
        from apscheduler.triggers.date import DateTrigger
        from apscheduler.triggers.interval import IntervalTrigger

        if type(trigger) not in (CronTrigger, DateTrigger, IntervalTrigger):
            return None
        trigger_text = str(trigger)
        timezone = getattr(trigger, "timezone", None)
        if timezone is None and type(trigger) is DateTrigger:
            timezone = getattr(getattr(trigger, "run_date", None), "tzinfo", None)
        if timezone is None:
            timezone = getattr(scheduler, "timezone", None)
        timezone_text = str(timezone) if timezone is not None else ""
        if (
            not trigger_text
            or len(trigger_text.encode("utf-8")) > _MAX_TRIGGER_BYTES
            or len(timezone_text.encode("utf-8")) > _MAX_TIMEZONE_BYTES
        ):
            return None

        def datetime_value(value: Any) -> str | None:
            if value is None:
                return None
            if not isinstance(value, datetime):
                raise ValueError("unsupported trigger datetime")
            return value.isoformat(timespec="microseconds")

        def duration_value(value: Any) -> list[int]:
            if not isinstance(value, timedelta):
                raise ValueError("unsupported trigger duration")
            return [value.days, value.seconds, value.microseconds]

        if type(trigger) is DateTrigger:
            parameters = {"runDate": datetime_value(trigger.run_date)}
        elif type(trigger) is IntervalTrigger:
            parameters = {
                "interval": duration_value(trigger.interval),
                "startDate": datetime_value(trigger.start_date),
                "endDate": datetime_value(trigger.end_date),
                "jitter": trigger.jitter,
            }
        else:
            parameters = {
                "fields": [[field.name, str(field)] for field in trigger.fields],
                "startDate": datetime_value(trigger.start_date),
                "endDate": datetime_value(trigger.end_date),
                "jitter": trigger.jitter,
            }
        return trigger_text, timezone_text, parameters
    except Exception:
        return None


def _callable_name(func: Any) -> tuple[str, str] | None:
    target = getattr(func, "__func__", func)
    module = getattr(target, "__module__", None)
    qualname = getattr(target, "__qualname__", None)
    if type(module) is not str or not module or type(qualname) is not str or not qualname:
        return None
    return module, qualname


def _source_profile_hash(
    owner_resolver: Callable[[Any], str | None],
    argument_encoder: Callable[[str, Any, tuple[Any, ...], dict[str, Any]], Any] | None,
    execution_scope: Callable[[str, Any, tuple[Any, ...], dict[str, Any]], Any] | None,
    original_func: Any,
) -> str | None:
    """Hash the source of the authorization and argument/scope profiles.

    A cold restore must use the same profile implementation that created the
    HMAC grant. Profiles without inspectable, bounded Python source fail
    closed rather than silently sharing a descriptor.
    """
    digest = hashlib.sha256(b"qq-aps-source-profile-v1")
    callbacks = (
        ("owner-resolver", owner_resolver, None),
        ("argument-encoder", argument_encoder, b"strict-json-v1"),
        ("execution-scope", execution_scope, b"no-execution-scope-v1"),
        ("callback", original_func, None),
    )
    for label, callback, absent_marker in callbacks:
        parts = [label.encode("ascii")]
        if callback is None:
            if absent_marker is None:
                return None
            parts.append(absent_marker)
        else:
            try:
                target = inspect.unwrap(getattr(callback, "__func__", callback))
                if not inspect.isfunction(target):
                    return None
                callable_parts = _callable_name(target)
                if callable_parts is None:
                    return None
                source = textwrap.dedent(inspect.getsource(target)).replace("\r\n", "\n")
                source_bytes = source.encode("utf-8")
            except Exception:
                return None
            if not source_bytes or len(source_bytes) > _MAX_PROFILE_SOURCE_BYTES:
                return None
            parts.extend(
                (
                    callable_parts[0].encode("utf-8"),
                    callable_parts[1].encode("utf-8"),
                    source_bytes,
                )
            )
        for part in parts:
            digest.update(len(part).to_bytes(8, "big"))
            digest.update(part)
    return digest.hexdigest()


def _aps_auto_prune_line(process_jobs: Any) -> int | None:
    """Locate APS 3.11's one-shot removal call in its pinned private hook."""
    try:
        source_lines, first_line = inspect.getsourcelines(process_jobs)
    except (OSError, TypeError):
        return None
    remove_lines = [
        first_line + offset
        for offset, line in enumerate(source_lines)
        if line.strip() == "self.remove_job(job.id, jobstore_alias)"
    ]
    # APScheduler 3.11.3 has one removal for executor lookup failure and one
    # after successful one-shot submission. Only the latter is an auto-prune.
    return remove_lines[-1] if len(remove_lines) == 2 else None


def _validate_scheduler_runtime(scheduler_class: type) -> None:
    try:
        from importlib.metadata import version
        from apscheduler.schedulers.base import BaseScheduler
        from apscheduler.schedulers.asyncio import AsyncIOScheduler

        installed_version = version("APScheduler")
    except Exception as exc:
        raise RuntimeError("APScheduler 3.11.3 runtime is unavailable") from exc
    if installed_version != "3.11.3":
        raise RuntimeError(
            f"Unsupported APScheduler version {installed_version!r}; expected '3.11.3'"
        )
    if not isinstance(scheduler_class, type) or (
        scheduler_class is not BaseScheduler
        and not issubclass(scheduler_class, AsyncIOScheduler)
    ):
        raise TypeError(
            "scheduler_class must be BaseScheduler or derive from AsyncIOScheduler"
        )

    expected = {
        "add_job": (
            ("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("func", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("trigger", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("args", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("kwargs", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("id", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("name", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("misfire_grace_time", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("coalesce", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("max_instances", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("next_run_time", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("jobstore", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("executor", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("replace_existing", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("trigger_args", inspect.Parameter.VAR_KEYWORD),
        ),
        "get_job": (
            ("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("job_id", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("jobstore", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        ),
        "modify_job": (
            ("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("job_id", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("jobstore", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("changes", inspect.Parameter.VAR_KEYWORD),
        ),
        "remove_job": (
            ("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("job_id", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("jobstore", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        ),
        "_process_jobs": (("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),),
    }
    for method_name, expected_shape in expected.items():
        method = getattr(scheduler_class, method_name, None)
        try:
            actual_shape = tuple(
                (parameter.name, parameter.kind)
                for parameter in inspect.signature(method).parameters.values()
            )
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                f"Unsupported APScheduler {method_name} signature"
            ) from exc
        if actual_shape != expected_shape:
            raise RuntimeError(
                f"Unsupported APScheduler {method_name} signature: {actual_shape!r}"
            )


def _build_key(
    scheduler: Any,
    job_id: Any,
    jobstore: Any,
    owner: str,
    original_func: Any,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    trigger: Any,
    argument_encoder: Callable[[str, Any, tuple[Any, ...], dict[str, Any]], Any] | None,
    profile_hash: str | None,
) -> tuple[str, str] | None:
    if type(job_id) is not str or not job_id or type(jobstore) is not str:
        return None
    if len(owner.encode("utf-8")) > _MAX_OWNER_BYTES:
        return None
    trigger_parts = _stable_trigger(scheduler, trigger)
    callable_parts = _callable_name(original_func)
    if trigger_parts is None or callable_parts is None or profile_hash is None:
        return None
    try:
        projection, args_bytes = _argument_projection(
            owner, original_func, args, kwargs, argument_encoder
        )
        trigger_text, timezone_text, trigger_parameters = trigger_parts
        descriptor = {
            "version": 2,
            "jobId": job_id,
            "jobstore": jobstore,
            "owner": owner,
            "functionModule": callable_parts[0],
            "functionQualname": callable_parts[1],
            "arguments": projection,
            "sourceProfileHash": profile_hash,
            "triggerString": trigger_text,
            "timezone": timezone_text,
            "triggerParameters": trigger_parameters,
        }
        descriptor_bytes = _canonical_json(descriptor)
    except Exception:
        return None
    key = "aps:v2:" + hashlib.sha256(descriptor_bytes).hexdigest()
    return key, hashlib.sha256(args_bytes).hexdigest()


def _state_from_job(job: Any) -> _JobState | None:
    state = getattr(getattr(job, "func", None), _STATE_ATTR, None)
    return state if isinstance(state, _JobState) else None


def _original_function(func: Any) -> Any:
    state = getattr(func, _STATE_ATTR, None)
    if isinstance(state, _JobState):
        return state.original_func
    return func


def _safe_remove(store: Any, key: str | None) -> None:
    if not key:
        return
    try:
        store.remove(key)
    except Exception:
        _LOG.exception("Could not remove APS job provenance")


def install_aps_provenance(
    scheduler_class: type,
    store: Any,
    owner_resolver: Callable[[Any], str | None],
    argument_encoder: Callable[[str, Any, tuple[Any, ...], dict[str, Any]], Any] | None = None,
    execution_scope: Callable[[str, Any, tuple[Any, ...], dict[str, Any]], Any] | None = None,
) -> None:
    """Install provenance guards on an APScheduler 3 ``AsyncIOScheduler`` class.

    ``argument_encoder(owner, original_func, args, kwargs)`` may return a
    deterministic JSON projection for a known plugin argument shape. Its
    result is size-bounded here and used both to derive the persisted key and
    to verify runtime arguments. With no encoder, only strict JSON arguments
    are supported. The encoder should be pure and must retain every field that
    can change the callback's effects. ``execution_scope(owner, original_func,
    args, kwargs)`` may return a synchronous context manager. It is entered
    only after the exact descriptor and source profile match; in that mode
    the callback runs with no broker principal and with the native event
    cleared. Scope authorization is independent of the stored creator HMAC.
    """
    _validate_scheduler_runtime(scheduler_class)
    if not callable(owner_resolver):
        raise TypeError("owner_resolver must be callable")
    installed = getattr(scheduler_class, "_qq_aps_provenance_install", None)
    if installed is not None:
        if (
            installed.get("store") is store
            and installed.get("owner_resolver") is owner_resolver
            and installed.get("argument_encoder") is argument_encoder
            and installed.get("execution_scope") is execution_scope
        ):
            return
        raise RuntimeError("APS provenance is already installed with another configuration")

    from apscheduler.jobstores.memory import MemoryJobStore

    original_add_job = scheduler_class.add_job
    original_get_job = scheduler_class.get_job
    original_modify_job = scheduler_class.modify_job
    original_remove_job = scheduler_class.remove_job
    original_process_jobs = scheduler_class._process_jobs
    auto_prune_line = _aps_auto_prune_line(original_process_jobs)
    if auto_prune_line is None:
        raise RuntimeError("Unsupported APScheduler _process_jobs prune hook")
    add_signature = inspect.signature(original_add_job)

    def lookup_job(self: Any, job_id: Any, jobstore: str | None = None) -> Any:
        lock = getattr(self, "_jobstores_lock", None)
        if lock is None:
            return original_get_job(self, job_id, jobstore)
        with lock:
            if getattr(self, "state", None) == 0:
                pending = getattr(self, "_pending_jobs", ())
                for job, alias, _replace_existing in reversed(pending):
                    if job.id == job_id and jobstore in (None, alias):
                        return job
        return original_get_job(self, job_id, jobstore)

    def find_live_job(self: Any, state: _JobState) -> tuple[Any, str] | None:
        if state.job_id is not None:
            job = lookup_job(self, state.job_id, state.jobstore)
            if job is not None:
                return job, state.jobstore
        lock = getattr(self, "_jobstores_lock", None)
        if lock is None:
            return None
        with lock:
            for job, alias, _replace_existing in reversed(
                getattr(self, "_pending_jobs", ())
            ):
                if _state_from_job(job) is state:
                    return job, alias
            for alias, jobstore in getattr(self, "_jobstores", {}).items():
                if not isinstance(jobstore, MemoryJobStore):
                    continue
                try:
                    jobs = jobstore.get_all_jobs()
                except Exception:
                    continue
                for job in jobs:
                    if _state_from_job(job) is state:
                        return job, alias
        return None

    def is_memory_jobstore(self: Any, alias: Any) -> bool:
        if type(alias) is not str:
            return False
        stores = getattr(self, "_jobstores", {})
        configured = stores.get(alias)
        if configured is not None:
            return isinstance(configured, MemoryJobStore)
        # APScheduler creates a MemoryJobStore for "default" at start when
        # one was not explicitly configured. Other pending aliases are not
        # assumed to be safe.
        return getattr(self, "state", None) == 0 and alias == "default"

    def resolve_owner(func: Any) -> str | None:
        try:
            owner = owner_resolver(func)
        except Exception:
            _LOG.debug("APS owner resolution failed", exc_info=True)
            return None
        if owner is None:
            return None
        if type(owner) is not str or not owner or len(owner.encode("utf-8")) > _MAX_OWNER_BYTES:
            _LOG.debug("APS owner resolution returned an invalid owner")
            return None
        return owner

    def make_state(
        self: Any,
        job_id: Any,
        jobstore: Any,
        owner: str | None,
        func: Any,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        trigger: Any,
    ) -> _JobState:
        key = None
        args_digest = None
        profile_hash = None
        if (
            owner is not None
            and is_memory_jobstore(self, jobstore)
            and type(job_id) is str
            and job_id
        ):
            profile_hash = _source_profile_hash(
                owner_resolver, argument_encoder, execution_scope, func
            )
            candidate = _build_key(
                self,
                job_id,
                jobstore,
                owner,
                func,
                args,
                kwargs,
                trigger,
                argument_encoder,
                profile_hash,
            )
            if candidate is not None:
                key, args_digest = candidate
        return _JobState(
            job_id if type(job_id) is str else None,
            jobstore if type(jobstore) is str else "",
            owner,
            key,
            args_digest,
            profile_hash,
            func,
        )

    def authorize(state: _JobState) -> bool:
        if state.key is None or state.owner is None:
            return False
        principal: Principal | None = current_principal.get()
        if principal is not None:
            if principal.plugin_id != state.owner:
                _safe_remove(store, state.key)
                return False
            try:
                store.bind_current(state.key)
            except Exception:
                _LOG.debug("Could not bind APS job provenance", exc_info=True)
                _safe_remove(store, state.key)
                return False
        try:
            resolved = store.resolve(state.key)
        except Exception:
            resolved = None
        return resolved is not None and resolved.plugin_id == state.owner

    def make_wrapper(self: Any, state: _JobState) -> Any:
        scheduler_ref = weakref.ref(self)

        def enter(
            args: tuple[Any, ...], kwargs: dict[str, Any]
        ) -> tuple[tuple[Any, Any, Any, Any], bool]:
            # APScheduler's one-shot prune runs in _process_jobs. Executor work
            # can inherit that context; callback-side remove_job calls must be
            # treated as explicit cancellations instead.
            process_token = _PROCESSING_JOBS.set(False)
            principal_token = current_principal.set(None)
            event_var = None
            event_token = None
            try:
                event_module = importlib.import_module(
                    "astrbot.core.platform.astr_message_event"
                )
                candidate_event_var = getattr(event_module, "current_message_event", None)
                if callable(getattr(candidate_event_var, "set", None)):
                    candidate_token = candidate_event_var.set(None)
                    event_var = candidate_event_var
                    event_token = candidate_token
            except Exception:
                # Non-AstrBot unit contexts have no native event variable.
                pass

            selected: Principal | None = None
            descriptor_matches = False
            if state.key and state.args_digest and state.owner and state.profile_hash:
                try:
                    current_profile_hash = _source_profile_hash(
                        owner_resolver,
                        argument_encoder,
                        execution_scope,
                        state.original_func,
                    )
                    if current_profile_hash == state.profile_hash:
                        actual_owner = resolve_owner(state.original_func)
                        if actual_owner == state.owner:
                            scheduler = scheduler_ref()
                            live_entry = (
                                find_live_job(scheduler, state)
                                if scheduler is not None
                                else None
                            )
                            if live_entry is None:
                                _projection, actual_bytes = _argument_projection(
                                    state.owner,
                                    state.original_func,
                                    tuple(args),
                                    dict(kwargs),
                                    argument_encoder,
                                )
                                actual_digest = hashlib.sha256(actual_bytes).hexdigest()
                                descriptor_matches = actual_digest == state.args_digest
                            else:
                                live_job, live_jobstore = live_entry
                                live_state = _state_from_job(live_job)
                                if (
                                    live_state is None
                                    or live_state.owner != state.owner
                                    or live_state.key != state.key
                                ):
                                    descriptor_matches = False
                                    live_state = None
                                else:
                                    descriptor_matches = True
                                if live_state is not None:
                                    live_profile_hash = _source_profile_hash(
                                        owner_resolver,
                                        argument_encoder,
                                        execution_scope,
                                        live_state.original_func,
                                    )
                                else:
                                    live_profile_hash = None
                                actual_descriptor = _build_key(
                                    scheduler,
                                    live_job.id,
                                    live_jobstore,
                                    live_state.owner if live_state is not None else state.owner,
                                    live_state.original_func
                                    if live_state is not None
                                    else state.original_func,
                                    tuple(args),
                                    dict(kwargs),
                                    live_job.trigger,
                                    argument_encoder,
                                    live_profile_hash,
                                )
                                descriptor_matches = (
                                    descriptor_matches
                                    and live_profile_hash == state.profile_hash
                                    and actual_descriptor
                                    == (state.key, state.args_digest)
                                )
                            if descriptor_matches:
                                try:
                                    candidate = store.resolve(state.key)
                                except Exception:
                                    candidate = None
                                if candidate is not None and candidate.plugin_id == state.owner:
                                    selected = candidate
                except Exception:
                    selected = None

            if selected is not None and execution_scope is None:
                current_principal.set(selected)
            return (
                (process_token, principal_token, event_var, event_token),
                selected,
                descriptor_matches,
            )

        def leave(tokens: tuple[Any, Any, Any, Any]) -> None:
            process_token, principal_token, event_var, event_token = tokens
            try:
                if event_var is not None and event_token is not None:
                    event_var.reset(event_token)
            finally:
                try:
                    current_principal.reset(principal_token)
                finally:
                    _PROCESSING_JOBS.reset(process_token)
            if state.key:
                scheduler = scheduler_ref()
                live_job = (
                    lookup_job(scheduler, state.job_id, state.jobstore)
                    if scheduler is not None and state.job_id is not None
                    else None
                )
                live_state = _state_from_job(live_job) if live_job is not None else None
                if live_job is None or live_state is None or live_state.key != state.key:
                    _safe_remove(store, state.key)

        if inspect.iscoroutinefunction(state.original_func):

            @functools.wraps(state.original_func)
            async def guarded_async(*args: Any, **kwargs: Any) -> Any:
                tokens, selected, descriptor_matches = enter(args, kwargs)
                try:
                    if execution_scope is not None:
                        if not descriptor_matches:
                            raise PermissionError(
                                "scheduled job no longer matches its source profile"
                            )
                        with execution_scope(
                            state.owner, state.original_func, args, kwargs
                        ) as scope_grant:
                            if scope_grant is None:
                                if selected is None:
                                    raise PermissionError(
                                        "scheduled callback has no verified creator grant"
                                    )
                                current_principal.set(selected)
                            return await state.original_func(*args, **kwargs)
                    return await state.original_func(*args, **kwargs)
                finally:
                    leave(tokens)

            setattr(guarded_async, _STATE_ATTR, state)
            return guarded_async

        @functools.wraps(state.original_func)
        def guarded_sync(*args: Any, **kwargs: Any) -> Any:
            tokens, selected, descriptor_matches = enter(args, kwargs)
            try:
                if execution_scope is not None:
                    if not descriptor_matches:
                        raise PermissionError(
                            "scheduled job no longer matches its source profile"
                        )
                    with execution_scope(
                        state.owner, state.original_func, args, kwargs
                    ) as scope_grant:
                        if scope_grant is None:
                            if selected is None:
                                raise PermissionError(
                                    "scheduled callback has no verified creator grant"
                                )
                            current_principal.set(selected)
                        return state.original_func(*args, **kwargs)
                return state.original_func(*args, **kwargs)
            finally:
                leave(tokens)

        setattr(guarded_sync, _STATE_ATTR, state)
        return guarded_sync

    def guarded_add_job(self: Any, *args: Any, **kwargs: Any) -> Any:
        bound = add_signature.bind(self, *args, **kwargs)
        bound.apply_defaults()
        values = bound.arguments
        func = _original_function(values["func"])
        job_id = values.get("id")
        jobstore = values.get("jobstore", "default")
        replace_existing = values.get("replace_existing") is True
        previous = lookup_job(self, job_id, jobstore) if job_id is not None else None
        previous_state = _state_from_job(previous) if previous is not None else None
        owner = resolve_owner(func)
        if owner is None:
            # Unknown/native callbacks use the executor's general clear-context
            # guard. If explicitly replacing an owned job, retire its grant.
            result = original_add_job(*bound.args, **bound.kwargs)
            if replace_existing and previous_state is not None:
                _safe_remove(store, previous_state.key)
            return result

        raw_args = values.get("args")
        raw_kwargs = values.get("kwargs")
        call_args = tuple(raw_args) if raw_args is not None else ()
        call_kwargs = dict(raw_kwargs) if raw_kwargs is not None else {}
        trigger = None
        try:
            trigger_args = dict(values.get("trigger_args", {}))
            trigger = self._create_trigger(values.get("trigger"), trigger_args)
        except Exception:
            # Let APScheduler raise its normal validation error below.
            trigger = None
        state = make_state(
            self,
            job_id,
            jobstore,
            owner,
            func,
            call_args,
            call_kwargs,
            trigger,
        )
        wrapped = make_wrapper(self, state)
        values["func"] = wrapped
        result = original_add_job(*bound.args, **bound.kwargs)
        authorized = authorize(state)
        if replace_existing and previous_state is not None:
            if previous_state.key != state.key or not authorized:
                _safe_remove(store, previous_state.key)
        return result

    def guarded_get_job(self: Any, job_id: Any, jobstore: str | None = None) -> Any:
        return lookup_job(self, job_id, jobstore)

    def guarded_modify_job(
        self: Any, job_id: Any, jobstore: str | None = None, **changes: Any
    ) -> Any:
        job = lookup_job(self, job_id, jobstore)
        old_state = _state_from_job(job) if job is not None else None
        if job is None:
            return original_modify_job(self, job_id, jobstore, **changes)

        func = changes.get("func", old_state.original_func if old_state else job.func)
        func = _original_function(func)
        owner = resolve_owner(func)
        jobstore_alias = jobstore
        if jobstore_alias is None:
            for candidate_job, alias, _replace_existing in getattr(self, "_pending_jobs", ()):
                if candidate_job is job:
                    jobstore_alias = alias
                    break
            if jobstore_alias is None:
                jobstore_alias = "default"

        # Explicitly switching to a native/unowned function removes any old
        # plugin grant and leaves that callback under APScheduler's normal path.
        should_wrap = owner is not None
        if should_wrap:
            next_args = changes.get("args", job.args)
            next_kwargs = changes.get("kwargs", job.kwargs)
            try:
                call_args = tuple(next_args)
                call_kwargs = dict(next_kwargs)
            except Exception:
                call_args, call_kwargs = (), {}
            state = make_state(
                self,
                job.id,
                jobstore_alias,
                owner,
                func,
                call_args,
                call_kwargs,
                changes.get("trigger", job.trigger),
            )
            changes["func"] = make_wrapper(self, state)
        elif old_state is not None or "func" in changes:
            # On resolver failure the executor guard is the remaining safety
            # boundary; do not retain an obsolete per-job provenance wrapper.
            changes["func"] = func

        pending = getattr(self, "state", None) == 0
        if pending:
            lock = getattr(self, "_jobstores_lock")
            with lock:
                job._modify(**changes)
                result = job
        else:
            result = original_modify_job(self, job_id, jobstore, **changes)

        if should_wrap:
            authorized = authorize(state)
            if old_state is not None and (
                old_state.key != state.key or not authorized
            ):
                _safe_remove(store, old_state.key)
        elif old_state is not None:
            _safe_remove(store, old_state.key)
        return result

    def guarded_remove_job(
        self: Any, job_id: Any, jobstore: str | None = None
    ) -> Any:
        job = lookup_job(self, job_id, jobstore)
        state = _state_from_job(job) if job is not None else None
        result = original_remove_job(self, job_id, jobstore)
        try:
            caller = sys._getframe(1)
        except ValueError:
            caller = None
        automatic_prune = bool(
            _PROCESSING_JOBS.get()
            and getattr(_PROCESSING_JOB_LOCAL, "scheduler_id", None) == id(self)
            and caller is not None
            and caller.f_code is original_process_jobs.__code__
            and caller.f_lineno == auto_prune_line
        )
        if state is not None and not automatic_prune:
            _safe_remove(store, state.key)
        return result

    def guarded_process_jobs(self: Any) -> Any:
        token = _PROCESSING_JOBS.set(True)
        previous_scheduler_id = getattr(_PROCESSING_JOB_LOCAL, "scheduler_id", None)
        _PROCESSING_JOB_LOCAL.scheduler_id = id(self)
        try:
            return original_process_jobs(self)
        finally:
            if previous_scheduler_id is None:
                try:
                    del _PROCESSING_JOB_LOCAL.scheduler_id
                except AttributeError:
                    pass
            else:
                _PROCESSING_JOB_LOCAL.scheduler_id = previous_scheduler_id
            _PROCESSING_JOBS.reset(token)

    scheduler_class.add_job = guarded_add_job
    scheduler_class.get_job = guarded_get_job
    scheduler_class.modify_job = guarded_modify_job
    scheduler_class.remove_job = guarded_remove_job
    scheduler_class._process_jobs = guarded_process_jobs
    scheduler_class._qq_aps_provenance_install = {
        "store": store,
        "owner_resolver": owner_resolver,
        "argument_encoder": argument_encoder,
        "execution_scope": execution_scope,
    }
