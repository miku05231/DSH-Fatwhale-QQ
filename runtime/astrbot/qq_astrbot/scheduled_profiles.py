"""Source-locked argument and execution profiles for two native APS jobs.

Only the unchanged Reminder ``trigger_reminder`` and Weather
``WeatherPushPlugin._run_daily_push`` callbacks are recognized. The reminder
profile binds the full JSON reminder record (apart from its proven mutable
``executed_count`` field); the weather profile adds only a descriptive,
non-identity outbound scope.
"""

from __future__ import annotations

import hashlib
import importlib
import inspect
import json
import math
import os
import stat
import sys
from contextlib import contextmanager, nullcontext
from dataclasses import asdict, dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Iterator

from .outbound import ScheduledOutbound, bind_outbound


_REMINDER = "astrbot_plugin_reminder"
_WEATHER = "astrbot_plugin_weather"
_REMINDER_ARCHIVE_SHA256 = (
    "d13f101e1e1eaed05ff6b1209549c9c97fab1ec5c797d088dc71fb007db88755"
)
_REMINDER_MAIN_SHA256 = (
    "7ccdc09a78a5bb5e7a9d99e378ea1aeea6304bc382ca66285a5f10a97328fd75"
)
_REMINDER_UTILS_SHA256 = (
    "65447c6278fb74dd330cb9ef077b0681c69c6da563f44242b8f1b063fdf5abef"
)
_WEATHER_ARCHIVE_SHA256 = (
    "d149d4754147ac26e531fd63e78b7c040af3f1b4dee0e6a694300da3dcf32f30"
)
_WEATHER_MAIN_SHA256 = (
    "d4b7a3a94062eb31353bed1508fd8bde370d54dec5546c3485a0ff14b74ac142"
)
_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_MAX_SOURCE_BYTES = 8 * 1024 * 1024
_MAX_ARGUMENT_BYTES = 2 * 1024 * 1024
_MAX_JSON_DEPTH = 48
_MAX_JSON_NODES = 50_000


@dataclass(frozen=True, slots=True)
class _Profile:
    plugin_id: str
    archive_sha256: str
    main_sha256: str
    module_name: str
    class_name: str
    callback_name: str
    callback_relative_path: str
    callback_sha256: str
    kind: str


_PROFILES = {
    _REMINDER: _Profile(
        plugin_id=_REMINDER,
        archive_sha256=_REMINDER_ARCHIVE_SHA256,
        main_sha256=_REMINDER_MAIN_SHA256,
        module_name=f"data.plugins.{_REMINDER}.main",
        class_name="ReminderPlugin",
        callback_name="trigger_reminder",
        callback_relative_path="core/utils.py",
        callback_sha256=_REMINDER_UTILS_SHA256,
        kind="reminder",
    ),
    _WEATHER: _Profile(
        plugin_id=_WEATHER,
        archive_sha256=_WEATHER_ARCHIVE_SHA256,
        main_sha256=_WEATHER_MAIN_SHA256,
        module_name=f"data.plugins.{_WEATHER}.main",
        class_name="WeatherPushPlugin",
        callback_name="_run_daily_push",
        callback_relative_path="main.py",
        callback_sha256=_WEATHER_MAIN_SHA256,
        kind="weather",
    ),
}


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _profile_sha256(profile: _Profile) -> str:
    profile_spec = {
        "schema": "qq-astrbot-scheduled-profile/v1",
        **asdict(profile),
        "projection": (
            {
                "callback_arguments": ["plugin-instance", "reminder-item"],
                "item_fields": "all-json-fields",
                "omitted_mutable_fields": ["executed_count"],
                "allowed_is_task": False,
                "identity_metadata_is_authority": False,
            }
            if profile.kind == "reminder"
            else {
                "callback_arguments": "none",
                "outbound_purpose": "weather.daily",
                "outbound_source_sha256": profile.archive_sha256,
                "creates_dispatch_identity": False,
            }
        ),
    }
    return hashlib.sha256(_canonical_json(profile_spec)).hexdigest()


_PROFILE_SHA256 = {
    plugin_id: _profile_sha256(profile)
    for plugin_id, profile in _PROFILES.items()
}


class _ProfileMismatch(ValueError):
    """A callback did not match the exact live native profile."""


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def _is_link_or_junction(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        return bool(is_junction()) if callable(is_junction) else False
    except OSError:
        return True


def _checked_path(root: Path, relative: str, *, directory: bool) -> Path:
    """Resolve a fixed profile path while rejecting links in every component."""

    if _is_link_or_junction(root):
        raise _ProfileMismatch("profile root is linked")
    try:
        resolved_root = root.resolve(strict=True)
    except OSError as exc:
        raise _ProfileMismatch("profile root is unavailable") from exc
    if not resolved_root.is_dir():
        raise _ProfileMismatch("profile root is not a directory")

    current = resolved_root
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(part in (".", "..") for part in parts):
        raise _ProfileMismatch("invalid locked profile path")
    for index, part in enumerate(parts):
        current = current / part
        if _is_link_or_junction(current):
            raise _ProfileMismatch("profile path contains a link")
        try:
            info = current.lstat()
        except OSError as exc:
            raise _ProfileMismatch("profile path is unavailable") from exc
        final = index == len(parts) - 1
        if not final and not stat.S_ISDIR(info.st_mode):
            raise _ProfileMismatch("profile path parent is not a directory")
        if final:
            expected_mode = stat.S_ISDIR if directory else stat.S_ISREG
            if not expected_mode(info.st_mode):
                raise _ProfileMismatch("profile path has the wrong file type")

    try:
        resolved = current.resolve(strict=True)
    except OSError as exc:
        raise _ProfileMismatch("profile path cannot be resolved") from exc
    expected = resolved_root.joinpath(*parts)
    if _path_key(resolved) != _path_key(expected):
        raise _ProfileMismatch("profile path escaped its generation")
    return resolved


def _sha256_file(path: Path, *, limit: int) -> str:
    try:
        if _is_link_or_junction(path):
            raise _ProfileMismatch("locked source is linked")
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise _ProfileMismatch("locked source has an invalid size or type")
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as stream:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise _ProfileMismatch("locked source exceeds its size limit")
                digest.update(chunk)
        return digest.hexdigest()
    except _ProfileMismatch:
        raise
    except OSError as exc:
        raise _ProfileMismatch("locked source is unavailable") from exc


def _module_file(module: ModuleType, expected: Path) -> None:
    filename = getattr(module, "__file__", None)
    if type(filename) is not str:
        raise _ProfileMismatch("native module has no source file")
    try:
        actual = Path(filename).resolve(strict=True)
        expected_resolved = expected.resolve(strict=True)
    except OSError as exc:
        raise _ProfileMismatch("native module source is unavailable") from exc
    if _path_key(actual) != _path_key(expected_resolved):
        raise _ProfileMismatch("native module source path changed")


def _add_json_bytes(budget: list[int], size: int) -> None:
    budget[0] += size
    if budget[0] > _MAX_ARGUMENT_BYTES:
        raise _ProfileMismatch("reminder item exceeds the profile size limit")


def _json_string_byte_size(value: str) -> int:
    if len(value) > _MAX_ARGUMENT_BYTES:
        raise _ProfileMismatch("reminder item exceeds the profile size limit")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise _ProfileMismatch("reminder item contains invalid text") from exc

    size = len(encoded) + 2
    for character in value:
        codepoint = ord(character)
        if character in ('"', "\\"):
            size += 1
        elif codepoint < 0x20:
            size += 1 if character in "\b\t\n\f\r" else 5
    return size


def _copy_json(
    value: Any,
    *,
    budget: list[int],
    byte_budget: list[int],
    depth: int = 0,
) -> Any:
    budget[0] += 1
    if budget[0] > _MAX_JSON_NODES or depth > _MAX_JSON_DEPTH:
        raise _ProfileMismatch("reminder item exceeds JSON bounds")
    value_type = type(value)
    if value is None:
        _add_json_bytes(byte_budget, 4)
        return value
    if value_type is bool:
        _add_json_bytes(byte_budget, 4 if value else 5)
        return value
    if value_type is int:
        if value.bit_length() > 4096:
            raise _ProfileMismatch("reminder item contains an oversized integer")
        _add_json_bytes(byte_budget, len(str(value)))
        return value
    if value_type is str:
        _add_json_bytes(byte_budget, _json_string_byte_size(value))
        return value
    if value_type is float:
        if not math.isfinite(value):
            raise _ProfileMismatch("reminder item contains a non-finite number")
        _add_json_bytes(byte_budget, len(repr(value)))
        return value
    if value_type is list:
        _add_json_bytes(byte_budget, 2 + max(0, len(value) - 1))
        return [
            _copy_json(
                child,
                budget=budget,
                byte_budget=byte_budget,
                depth=depth + 1,
            )
            for child in value
        ]
    if value_type is dict:
        _add_json_bytes(byte_budget, 2 + max(0, len(value) - 1))
        copied: dict[str, Any] = {}
        for key, child in value.items():
            if type(key) is not str:
                raise _ProfileMismatch("reminder item contains a non-string key")
            _add_json_bytes(byte_budget, _json_string_byte_size(key) + 1)
            copied[key] = _copy_json(
                child,
                budget=budget,
                byte_budget=byte_budget,
                depth=depth + 1,
            )
        return copied
    raise _ProfileMismatch("reminder item contains a non-JSON value")


class ScheduledProfiles:
    """Resolve and validate the two locked scheduled callback profiles.

    ``plugins`` is the manager's plugin map. Its values are checked against a
    fresh read of ``root/manager/plugins.json`` whenever a callback is looked
    up, encoded, or entered for execution.
    """

    def __init__(self, root: Path, plugins: dict):
        self.root = Path(root)
        self.plugins = plugins

    def _manager_record(self, profile: _Profile) -> dict[str, Any]:
        if type(self.plugins) is not dict:
            raise _ProfileMismatch("manager plugin map is unavailable")
        manifest_path = _checked_path(
            self.root,
            "manager/plugins.json",
            directory=False,
        )
        try:
            info = manifest_path.stat()
            if info.st_size > _MAX_MANIFEST_BYTES:
                raise _ProfileMismatch("manager plugin manifest is too large")
            raw = manifest_path.read_bytes()
            if len(raw) > _MAX_MANIFEST_BYTES:
                raise _ProfileMismatch("manager plugin manifest is too large")
            manifest = json.loads(raw)
        except _ProfileMismatch:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _ProfileMismatch("manager plugin manifest is invalid") from exc
        disk_plugins = manifest.get("plugins") if type(manifest) is dict else None
        if type(disk_plugins) is not dict:
            raise _ProfileMismatch("manager plugin map is invalid")
        disk_record = disk_plugins.get(profile.plugin_id)
        supplied_record = self.plugins.get(profile.plugin_id)
        if type(disk_record) is not dict or type(supplied_record) is not dict:
            raise _ProfileMismatch("locked plugin is absent from the manager")

        for record in (disk_record, supplied_record):
            if (
                record.get("id") != profile.plugin_id
                or record.get("archiveSHA256") != profile.archive_sha256
                or record.get("sourceSHA256") != profile.archive_sha256
            ):
                raise _ProfileMismatch("manager archive identity changed")
        return disk_record

    def _native_metadata(self, profile: _Profile) -> tuple[Any, ModuleType, Path]:
        self._manager_record(profile)
        plugin_root = _checked_path(
            self.root,
            f"data/plugins/{profile.plugin_id}",
            directory=True,
        )
        main_path = _checked_path(
            self.root,
            f"data/plugins/{profile.plugin_id}/main.py",
            directory=False,
        )
        if _sha256_file(main_path, limit=_MAX_SOURCE_BYTES) != profile.main_sha256:
            raise _ProfileMismatch("locked main source hash changed")

        try:
            native_star = importlib.import_module("astrbot.core.star.star")
            metadata_type = getattr(native_star, "StarMetadata", None)
            star_map = getattr(native_star, "star_map", None)
            star_registry = getattr(native_star, "star_registry", None)
        except Exception as exc:
            raise _ProfileMismatch("native plugin registry is unavailable") from exc
        if (
            not isinstance(metadata_type, type)
            or type(star_map) is not dict
            or type(star_registry) is not list
        ):
            raise _ProfileMismatch("native plugin registry has an invalid shape")

        registered = [
            metadata
            for metadata in star_registry
            if type(metadata) is metadata_type
            and getattr(metadata, "root_dir_name", None) == profile.plugin_id
            and getattr(metadata, "reserved", None) is False
        ]
        if len(registered) != 1:
            raise _ProfileMismatch("native plugin metadata is ambiguous or absent")
        metadata = registered[0]
        module = sys.modules.get(profile.module_name)
        if (
            module is None
            or getattr(metadata, "module_path", None) != profile.module_name
            or getattr(metadata, "module", None) is not module
            or star_map.get(profile.module_name) is not metadata
            or getattr(metadata, "activated", None) is not True
        ):
            raise _ProfileMismatch("native plugin registration changed")

        plugin_class = getattr(metadata, "star_cls_type", None)
        plugin_instance = getattr(metadata, "star_cls", None)
        if (
            not isinstance(plugin_class, type)
            or plugin_class.__name__ != profile.class_name
            or plugin_class.__module__ != profile.module_name
            or plugin_class is not getattr(module, profile.class_name, None)
            or plugin_instance is None
            or type(plugin_instance) is not plugin_class
        ):
            raise _ProfileMismatch("native plugin instance changed")

        _module_file(module, main_path)
        if _sha256_file(main_path, limit=_MAX_SOURCE_BYTES) != profile.main_sha256:
            raise _ProfileMismatch("locked main source hash changed")
        return metadata, module, plugin_root

    def _match_callable(self, profile: _Profile, func: Any) -> tuple[Any, ModuleType, Path]:
        metadata, main_module, plugin_root = self._native_metadata(profile)
        expected_callback_path = _checked_path(
            self.root,
            f"data/plugins/{profile.plugin_id}/{profile.callback_relative_path}",
            directory=False,
        )

        if profile.kind == "reminder":
            if (
                not inspect.isfunction(func)
                or func.__name__ != profile.callback_name
                or func.__module__ != f"data.plugins.{profile.plugin_id}.core.utils"
                or not inspect.iscoroutinefunction(func)
            ):
                raise _ProfileMismatch("reminder callback shape changed")
            callback_module = sys.modules.get(func.__module__)
            if (
                callback_module is None
                or getattr(callback_module, "__name__", None) != func.__module__
                or getattr(callback_module, func.__name__, None) is not func
                or func.__globals__ is not callback_module.__dict__
            ):
                raise _ProfileMismatch("reminder callback is not the loaded module function")
        else:
            if (
                not inspect.ismethod(func)
                or func.__name__ != profile.callback_name
                or func.__self__ is not metadata.star_cls
                or not inspect.iscoroutinefunction(func.__func__)
                or func.__func__.__module__ != profile.module_name
                or func.__func__ is not metadata.star_cls_type.__dict__.get(
                    profile.callback_name
                )
                or func.__func__.__globals__ is not main_module.__dict__
            ):
                raise _ProfileMismatch("weather callback is not the native bound method")
            callback_module = main_module

        _module_file(callback_module, expected_callback_path)
        if _sha256_file(expected_callback_path, limit=_MAX_SOURCE_BYTES) != profile.callback_sha256:
            raise _ProfileMismatch("locked callback source hash changed")
        code = getattr(func, "__code__", None)
        if code is None or _path_key(Path(code.co_filename).resolve()) != _path_key(
            expected_callback_path
        ):
            raise _ProfileMismatch("callback code source path changed")
        return metadata, callback_module, plugin_root

    @staticmethod
    def _candidate(func: Any) -> str | None:
        if inspect.isfunction(func):
            if (
                getattr(func, "__name__", None) == "trigger_reminder"
                and getattr(func, "__module__", None)
                == f"data.plugins.{_REMINDER}.core.utils"
            ):
                return _REMINDER
            return None
        if inspect.ismethod(func):
            if (
                getattr(func, "__name__", None) == "_run_daily_push"
                and getattr(func, "__module__", None)
                == f"data.plugins.{_WEATHER}.main"
            ):
                return _WEATHER
        return None

    def owner(self, func: Any) -> str | None:
        """Return a locked plugin ID only for its live native callback object."""

        candidate = self._candidate(func)
        if candidate is None:
            return None
        try:
            self._match_callable(_PROFILES[candidate], func)
        except Exception:
            return None
        return candidate

    def _checked_call(
        self,
        owner: str,
        func: Any,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> tuple[_Profile, Any, dict[str, Any]]:
        if type(owner) is not str or owner not in _PROFILES:
            raise _ProfileMismatch("unknown scheduled profile")
        if self._candidate(func) != owner:
            raise _ProfileMismatch("caller owner does not match the native callback")
        profile = _PROFILES[owner]
        metadata, _module, _plugin_root = self._match_callable(profile, func)
        if type(args) is not tuple or type(kwargs) is not dict or kwargs:
            raise _ProfileMismatch("scheduled callback arguments changed")

        if profile.kind == "reminder":
            if (
                len(args) != 2
                or args[0] is not metadata.star_cls
                or type(args[1]) is not dict
            ):
                raise _ProfileMismatch("reminder callback instance or item changed")
            item = args[1]
            if (
                item.get("is_task") is not False
                or type(item.get("name")) is not str
                or not item.get("name")
                or type(item.get("enabled_sessions")) is not list
                or any(type(session) is not str for session in item["enabled_sessions"])
                or type(item.get("message_structure")) is not list
                or not (
                    type(item.get("cron_expr")) is str
                    or type(item.get("cron")) is str
                )
            ):
                raise _ProfileMismatch("reminder item is outside the supported schema")
            item_copy = _copy_json(item, budget=[0], byte_budget=[0])
            # The locked callback increments this field after each run. All
            # other top-level JSON fields remain bound into the job digest.
            item_copy.pop("executed_count", None)
            try:
                encoded_item = _canonical_json(item_copy)
            except (TypeError, ValueError, OverflowError) as exc:
                raise _ProfileMismatch("reminder item is not canonical JSON") from exc
            if len(encoded_item) > _MAX_ARGUMENT_BYTES:
                raise _ProfileMismatch("reminder item exceeds the profile size limit")
            arguments = {"item": item_copy}
        else:
            if args:
                raise _ProfileMismatch("weather callback does not accept arguments")
            arguments = {"args": [], "kwargs": {}}

        projection = {
            "schema": "qq-astrbot-scheduled-profile/v1",
            "plugin_id": profile.plugin_id,
            "archive_sha256": profile.archive_sha256,
            "main_py_sha256": profile.main_sha256,
            "callback_source_sha256": profile.callback_sha256,
            "profile_sha256": _PROFILE_SHA256[profile.plugin_id],
            "callback": f"{profile.module_name}:{profile.callback_name}",
            "arguments": arguments,
        }
        try:
            encoded_projection = _canonical_json(projection)
        except (TypeError, ValueError, OverflowError) as exc:
            raise _ProfileMismatch("scheduled profile is not canonical JSON") from exc
        if len(encoded_projection) > _MAX_ARGUMENT_BYTES:
            raise _ProfileMismatch("scheduled profile exceeds its size limit")
        return profile, metadata, projection

    def arguments(self, owner: str, func: Any, args: tuple, kwargs: dict) -> dict:
        """Return a deterministic JSON projection after live source checks."""

        _profile, _metadata, projection = self._checked_call(owner, func, args, kwargs)
        return projection

    @contextmanager
    def execution_scope(
        self,
        owner: str,
        func: Any,
        args: tuple,
        kwargs: dict,
    ) -> Iterator[ScheduledOutbound | None]:
        """Revalidate the live profile at execution and scope Weather narrowly."""

        profile, _metadata, _projection = self._checked_call(owner, func, args, kwargs)
        if profile.kind == "reminder":
            # Reminder provenance is supplied by the authenticated native APS
            # job wrapper. This profile intentionally creates no identity.
            with nullcontext():
                yield None
            return

        scope = ScheduledOutbound(
            plugin_id=profile.plugin_id,
            # The callback protocol identifies the immutable plugin archive;
            # the main.py hash remains separately bound in the job projection.
            source_sha256=profile.archive_sha256,
            purpose="weather.daily",
        )
        with bind_outbound(scope):
            yield scope
