"""Isolated tests for the two source-locked native APS profiles.

Run with the repository's private Python 3.12 runtime. Every plugin tree,
manifest, and AstrBot root used by this file lives in a TemporaryDirectory.
No NAS, production runtime, or QQ transport is started.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_PYTHON_ROOT = REPO_ROOT / "runtime" / "astrbot"
if str(RUNTIME_PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_PYTHON_ROOT))

from qq_astrbot.outbound import (  # noqa: E402
    ScheduledOutbound,
    bind_outbound,
    current_outbound,
    outbound_context,
)
from qq_astrbot import scheduled_profiles as scheduled_profiles_module  # noqa: E402
from qq_astrbot.scheduled_profiles import ScheduledProfiles  # noqa: E402


REMINDER_ID = "astrbot_plugin_reminder"
WEATHER_ID = "astrbot_plugin_weather"
REMINDER_ARCHIVE_SHA256 = (
    "d13f101e1e1eaed05ff6b1209549c9c97fab1ec5c797d088dc71fb007db88755"
)
REMINDER_MAIN_SHA256 = (
    "7ccdc09a78a5bb5e7a9d99e378ea1aeea6304bc382ca66285a5f10a97328fd75"
)
REMINDER_UTILS_SHA256 = (
    "65447c6278fb74dd330cb9ef077b0681c69c6da563f44242b8f1b063fdf5abef"
)
WEATHER_ARCHIVE_SHA256 = (
    "d149d4754147ac26e531fd63e78b7c040af3f1b4dee0e6a694300da3dcf32f30"
)
WEATHER_MAIN_SHA256 = (
    "d4b7a3a94062eb31353bed1508fd8bde370d54dec5546c3485a0ff14b74ac142"
)
REMINDER_SOURCE = (
    REPO_ROOT
    / ".tmp"
    / "astrbot-locked-samples"
    / "reminder"
    / "astrbot_plugin_reminder-95bddae559bdc2a7451f029f80e0cab76247d3f5"
)
WEATHER_SOURCE = (
    REPO_ROOT
    / ".tmp"
    / "astrbot-locked-samples"
    / "weather"
    / "astrbot_plugin_weather-70c4913adf24e5520d5f85d2bee5876bbf872399"
)
REMINDER_ARCHIVE = REPO_ROOT / ".tmp" / "astrbot-locked-samples" / "reminder.zip"
WEATHER_ARCHIVE = REPO_ROOT / ".tmp" / "astrbot-locked-samples" / "weather.zip"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ScheduledProfilesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for path, expected in (
            (REMINDER_ARCHIVE, REMINDER_ARCHIVE_SHA256),
            (WEATHER_ARCHIVE, WEATHER_ARCHIVE_SHA256),
            (REMINDER_SOURCE / "main.py", REMINDER_MAIN_SHA256),
            (REMINDER_SOURCE / "core" / "utils.py", REMINDER_UTILS_SHA256),
            (WEATHER_SOURCE / "main.py", WEATHER_MAIN_SHA256),
        ):
            if sha256(path) != expected:
                raise AssertionError(f"locked fixture hash mismatch: {path.name}")

        cls._old_cwd = Path.cwd()
        cls._old_astrbot_root = os.environ.get("ASTRBOT_ROOT")
        cls._temporary = tempfile.TemporaryDirectory(prefix="qq-astrbot-scheduled-profiles-")
        cls.root = Path(cls._temporary.name).resolve()
        os.environ["ASTRBOT_ROOT"] = str(cls.root)
        os.chdir(cls.root)
        cls._root_path_entry = str(cls.root)
        sys.path.insert(0, cls._root_path_entry)

        manager_dir = cls.root / "manager"
        plugins_dir = cls.root / "data" / "plugins"
        manager_dir.mkdir(parents=True)
        plugins_dir.mkdir(parents=True)
        (cls.root / "data" / "__init__.py").write_text("", encoding="utf-8")
        (plugins_dir / "__init__.py").write_text("", encoding="utf-8")
        shutil.copytree(
            REMINDER_SOURCE,
            plugins_dir / REMINDER_ID,
            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"),
        )
        shutil.copytree(
            WEATHER_SOURCE,
            plugins_dir / WEATHER_ID,
            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"),
        )

        cls.manifest_path = manager_dir / "plugins.json"
        cls.plugins = {
            REMINDER_ID: {
                "id": REMINDER_ID,
                "archiveSHA256": REMINDER_ARCHIVE_SHA256,
                "sourceSHA256": REMINDER_ARCHIVE_SHA256,
            },
            WEATHER_ID: {
                "id": WEATHER_ID,
                "archiveSHA256": WEATHER_ARCHIVE_SHA256,
                "sourceSHA256": WEATHER_ARCHIVE_SHA256,
            },
        }
        cls._write_manifest()

        from astrbot.core.star import star as native_star

        cls.native_star = native_star
        cls.reminder_module = importlib.import_module(
            f"data.plugins.{REMINDER_ID}.main"
        )
        cls.reminder_utils = importlib.import_module(
            f"data.plugins.{REMINDER_ID}.core.utils"
        )
        cls.weather_module = importlib.import_module(
            f"data.plugins.{WEATHER_ID}.main"
        )

        cls.reminder_instance = object.__new__(cls.reminder_module.ReminderPlugin)
        cls.weather_instance = object.__new__(cls.weather_module.WeatherPushPlugin)
        cls.reminder_metadata = cls._install_native_metadata(
            REMINDER_ID,
            cls.reminder_module,
            cls.reminder_module.ReminderPlugin,
            cls.reminder_instance,
        )
        cls.weather_metadata = cls._install_native_metadata(
            WEATHER_ID,
            cls.weather_module,
            cls.weather_module.WeatherPushPlugin,
            cls.weather_instance,
        )
        cls.profiles = ScheduledProfiles(cls.root, cls.plugins)

    @classmethod
    def _write_manifest(cls) -> None:
        cls.manifest_path.write_text(
            json.dumps({"schemaVersion": 1, "plugins": cls.plugins}),
            encoding="utf-8",
        )

    @classmethod
    def _install_native_metadata(cls, plugin_id, module, plugin_class, instance):
        native_star = cls.native_star
        for module_path, metadata in list(native_star.star_map.items()):
            if (
                module_path == module.__name__
                or getattr(metadata, "root_dir_name", None) == plugin_id
            ):
                native_star.star_map.pop(module_path, None)
                native_star.star_registry[:] = [
                    item for item in native_star.star_registry if item is not metadata
                ]
        metadata = native_star.StarMetadata(
            name=plugin_id,
            author="locked-test-fixture",
            module_path=module.__name__,
            star_cls_type=plugin_class,
            star_cls=instance,
            module=module,
            root_dir_name=plugin_id,
            reserved=False,
            activated=True,
        )
        native_star.star_map[module.__name__] = metadata
        native_star.star_registry.append(metadata)
        return metadata

    @classmethod
    def tearDownClass(cls) -> None:
        native_star = getattr(cls, "native_star", None)
        if native_star is not None:
            for plugin_id in (REMINDER_ID, WEATHER_ID):
                for module_path, metadata in list(native_star.star_map.items()):
                    if getattr(metadata, "root_dir_name", None) == plugin_id:
                        native_star.star_map.pop(module_path, None)
                        native_star.star_registry[:] = [
                            item for item in native_star.star_registry if item is not metadata
                        ]
        for module_name in list(sys.modules):
            if module_name.startswith("data.plugins.astrbot_plugin_reminder") or module_name.startswith(
                "data.plugins.astrbot_plugin_weather"
            ):
                sys.modules.pop(module_name, None)
        sys.modules.pop("data.plugins", None)
        sys.modules.pop("data", None)
        os.chdir(cls._old_cwd)
        if cls._old_astrbot_root is None:
            os.environ.pop("ASTRBOT_ROOT", None)
        else:
            os.environ["ASTRBOT_ROOT"] = cls._old_astrbot_root
        try:
            sys.path.remove(cls._root_path_entry)
        except ValueError:
            pass
        cls._temporary.cleanup()

    def setUp(self) -> None:
        self._write_manifest()
        self.plugins[REMINDER_ID]["archiveSHA256"] = REMINDER_ARCHIVE_SHA256
        self.plugins[REMINDER_ID]["sourceSHA256"] = REMINDER_ARCHIVE_SHA256
        self.plugins[WEATHER_ID]["archiveSHA256"] = WEATHER_ARCHIVE_SHA256
        self.plugins[WEATHER_ID]["sourceSHA256"] = WEATHER_ARCHIVE_SHA256
        self._write_manifest()

    def reminder_item(self) -> dict:
        return {
            "name": "native-profile-test",
            "is_task": False,
            "cron_expr": "* * * * *",
            "enabled_sessions": ["qq:GroupMessage:123"],
            "created_by": "member-123",
            "creator_name": "fixture member",
            "is_admin": True,
            "self_id": "bot-456",
            "created_at": "2026-11-01 00:00:00",
            "message_structure": [{"type": "text", "content": "fixture payload"}],
            "max_executions": 12,
            "executed_count": 3,
            "delay_minutes": 4,
            "recall_after_seconds": 5,
            "is_paused": False,
            "extra_business_field": {"nested": [1, "kept"]},
        }

    def reminder_args(self, item=None, plugin=None):
        return (
            self.reminder_instance if plugin is None else plugin,
            self.reminder_item() if item is None else item,
        )

    def test_owner_resolves_only_live_locked_native_callbacks(self) -> None:
        self.assertEqual(
            self.profiles.owner(self.reminder_utils.trigger_reminder), REMINDER_ID
        )
        self.assertEqual(
            self.profiles.owner(self.weather_instance._run_daily_push), WEATHER_ID
        )
        self.assertIsNone(self.profiles.owner(self.weather_instance._run_weather_monitor))

    def test_reminder_projection_keeps_business_fields_except_executed_count(self) -> None:
        item = self.reminder_item()
        projection = self.profiles.arguments(
            REMINDER_ID,
            self.reminder_utils.trigger_reminder,
            self.reminder_args(item),
            {},
        )
        self.assertEqual(projection["archive_sha256"], REMINDER_ARCHIVE_SHA256)
        self.assertEqual(projection["main_py_sha256"], REMINDER_MAIN_SHA256)
        self.assertEqual(projection["callback_source_sha256"], REMINDER_UTILS_SHA256)
        self.assertEqual(len(projection["profile_sha256"]), 64)
        projected_item = projection["arguments"]["item"]
        self.assertNotIn("executed_count", projected_item)
        item_without_counter = dict(item)
        item_without_counter.pop("executed_count")
        self.assertEqual(projected_item, item_without_counter)
        self.assertTrue(projected_item["is_admin"])
        self.assertEqual(projected_item["created_by"], "member-123")
        self.assertNotIn("principal", projection)
        json.dumps(projection, allow_nan=False)

    def test_reminder_rejects_oversized_json_before_serializing(self) -> None:
        item = self.reminder_item()
        item["large_fields"] = ["x" * 32_768] * 65
        with patch.object(
            scheduled_profiles_module,
            "_canonical_json",
            side_effect=AssertionError("oversized reminder reached JSON serialization"),
        ) as serialize:
            with self.assertRaisesRegex(ValueError, "profile size limit"):
                self.profiles.arguments(
                    REMINDER_ID,
                    self.reminder_utils.trigger_reminder,
                    self.reminder_args(item),
                    {},
                )
        serialize.assert_not_called()

    def test_reminder_projection_tracks_other_mutations_and_rejects_tasks(self) -> None:
        callback = self.reminder_utils.trigger_reminder
        first = self.profiles.arguments(REMINDER_ID, callback, self.reminder_args(), {})
        changed = self.reminder_item()
        changed["message_structure"][0]["content"] = "different payload"
        second = self.profiles.arguments(
            REMINDER_ID,
            callback,
            self.reminder_args(changed),
            {},
        )
        self.assertNotEqual(first, second)

        task = self.reminder_item()
        task["is_task"] = True
        with self.assertRaises(ValueError):
            self.profiles.arguments(REMINDER_ID, callback, self.reminder_args(task), {})

    def test_reminder_requires_actual_metadata_star_instance(self) -> None:
        with self.assertRaises(ValueError):
            self.profiles.arguments(
                REMINDER_ID,
                self.reminder_utils.trigger_reminder,
                self.reminder_args(plugin=object.__new__(type(self.reminder_instance))),
                {},
            )
        previous = self.reminder_metadata.star_cls
        try:
            self.reminder_metadata.star_cls = object.__new__(type(previous))
            # owner(func) has no APS args to inspect. The loaded native class
            # remains a valid candidate, while the argument encoder must
            # reject the stale plugin instance captured by the job.
            self.assertEqual(
                self.profiles.owner(self.reminder_utils.trigger_reminder),
                REMINDER_ID,
            )
            with self.assertRaises(ValueError):
                self.profiles.arguments(
                    REMINDER_ID,
                    self.reminder_utils.trigger_reminder,
                    self.reminder_args(),
                    {},
                )
        finally:
            self.reminder_metadata.star_cls = previous

    def test_manager_manifest_archive_is_rechecked(self) -> None:
        callback = self.reminder_utils.trigger_reminder
        self.plugins[REMINDER_ID]["archiveSHA256"] = "0" * 64
        self.assertIsNone(self.profiles.owner(callback))
        with self.assertRaises(ValueError):
            self.profiles.arguments(REMINDER_ID, callback, self.reminder_args(), {})

    def test_reminder_null_scope_does_not_create_outbound_or_identity(self) -> None:
        callback = self.reminder_utils.trigger_reminder
        with self.profiles.execution_scope(
            REMINDER_ID, callback, self.reminder_args(), {}
        ) as scope:
            self.assertIsNone(scope)
            self.assertIsNone(current_outbound())

    def test_weather_scope_uses_archive_identity_and_resets(self) -> None:
        callback = self.weather_instance._run_daily_push
        before = current_outbound()
        with self.profiles.execution_scope(WEATHER_ID, callback, (), {}) as scope:
            self.assertIs(type(scope), ScheduledOutbound)
            self.assertEqual(scope.plugin_id, WEATHER_ID)
            self.assertEqual(scope.source_sha256, WEATHER_ARCHIVE_SHA256)
            self.assertNotEqual(scope.source_sha256, WEATHER_MAIN_SHA256)
            self.assertEqual(scope.purpose, "weather.daily")
            self.assertIs(current_outbound(), scope)
        self.assertIs(current_outbound(), before)

    def test_weather_scope_nests_and_restores_exact_context_object(self) -> None:
        callback = self.weather_instance._run_daily_push
        with self.profiles.execution_scope(WEATHER_ID, callback, (), {}) as outer:
            with self.profiles.execution_scope(WEATHER_ID, callback, (), {}) as inner:
                self.assertIsNot(inner, outer)
                self.assertIs(current_outbound(), inner)
            self.assertIs(current_outbound(), outer)
        self.assertIsNone(current_outbound())

    def test_executor_can_clear_and_restore_outbound_context(self) -> None:
        record = ScheduledOutbound(WEATHER_ID, WEATHER_ARCHIVE_SHA256)
        with bind_outbound(record):
            self.assertIs(current_outbound(), record)
            token = outbound_context.set(None)
            try:
                self.assertIsNone(current_outbound())
            finally:
                outbound_context.reset(token)
            self.assertIs(current_outbound(), record)
        self.assertIsNone(current_outbound())

    def test_weather_late_execution_revalidates_archive_manifest(self) -> None:
        callback = self.weather_instance._run_daily_push
        self.assertEqual(self.profiles.owner(callback), WEATHER_ID)
        self.plugins[WEATHER_ID]["sourceSHA256"] = "0" * 64
        with self.assertRaises(ValueError):
            with self.profiles.execution_scope(WEATHER_ID, callback, (), {}):
                self.fail("invalid manager archive must not enter outbound scope")

    def test_weather_late_execution_revalidates_source_hash(self) -> None:
        callback = self.weather_instance._run_daily_push
        path = self.root / "data" / "plugins" / WEATHER_ID / "main.py"
        original = path.read_bytes()
        try:
            path.write_bytes(original + b"\n# changed after scheduling\n")
            self.assertIsNone(self.profiles.owner(callback))
            with self.assertRaises(ValueError):
                with self.profiles.execution_scope(WEATHER_ID, callback, (), {}):
                    self.fail("changed callback source must not enter outbound scope")
        finally:
            path.write_bytes(original)

    def test_weather_requires_the_native_bound_instance_and_no_args(self) -> None:
        method = self.weather_instance._run_daily_push
        self.assertIsNone(self.profiles.owner(type(self.weather_instance)._run_daily_push))
        with self.assertRaises(ValueError):
            self.profiles.arguments(WEATHER_ID, method, ("unexpected",), {})

    def test_profile_fixture_archives_are_real_locked_zip_files(self) -> None:
        for path, expected in (
            (REMINDER_ARCHIVE, REMINDER_ARCHIVE_SHA256),
            (WEATHER_ARCHIVE, WEATHER_ARCHIVE_SHA256),
        ):
            self.assertEqual(sha256(path), expected)
            with zipfile.ZipFile(path) as archive:
                self.assertTrue(archive.namelist())


if __name__ == "__main__":
    unittest.main(verbosity=2)
