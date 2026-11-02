"""Offline unit tests for durable AstrBot cron provenance."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "runtime" / "astrbot"))

from qq_astrbot.acl import CronProvenanceStore, install_cron_provenance  # noqa: E402
from qq_astrbot.context import DispatchIdentity, bind_principal, current_principal  # noqa: E402


def make_identity() -> DispatchIdentity:
    return DispatchIdentity.from_params(
        {
            "contextId": "offline-cron-test",
            "deadlineAt": 2_000_000_000,
            "event": {
                "messageId": "message-123",
                "userId": "user-456",
                "nickname": "Offline test",
                "groupId": "group-789",
                "isGroup": True,
                "isAdmin": True,
                "isWake": True,
                "text": "",
                "message": [],
            },
            "policy": {
                "pluginIds": ["fixture-plugin", "unrelated-plugin"],
                "chatMode": "astrbot",
                "allowAi": True,
            },
        }
    )


class CronProvenanceTests(unittest.TestCase):
    def bind_fixture_job(self, store: CronProvenanceStore, job_id: str) -> None:
        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            store.bind_job(job_id)
        finally:
            current_principal.reset(token)

    def test_hmac_provenance_reloads_across_store_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cron-provenance.json"
            original = CronProvenanceStore(path, "test-secret")
            self.bind_fixture_job(original, "persistent-job")

            restarted = CronProvenanceStore(path, "test-secret")
            principal = restarted.resolve("persistent-job")

            self.assertTrue(restarted.healthy)
            self.assertIsNotNone(principal)
            assert principal is not None
            self.assertEqual(principal.plugin_id, "fixture-plugin")
            self.assertEqual(principal.identity.user_id, "user-456")
            self.assertEqual(principal.identity.group_id, "group-789")

    def test_tampered_document_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cron-provenance.json"
            original = CronProvenanceStore(path, "test-secret")
            self.bind_fixture_job(original, "tampered-job")

            document = json.loads(path.read_text("utf-8"))
            document["payload"]["jobs"]["tampered-job"]["identity"]["userId"] = "forged-user"
            path.write_text(json.dumps(document), encoding="utf-8")

            restarted = CronProvenanceStore(path, "test-secret")

            self.assertFalse(restarted.healthy)
            self.assertIsNone(restarted.resolve("tampered-job"))

    def test_job_without_source_principal_cannot_be_bound_or_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = CronProvenanceStore(Path(temporary) / "cron-provenance.json", "test-secret")
            self.assertIsNone(current_principal.get())
            with self.assertRaisesRegex(RuntimeError, "scheduled job has no verified broker provenance"):
                store.bind_job("no-source-job")
            self.assertIsNone(store.resolve("no-source-job"))

            class FakeCronManager:
                async def _run_job(self, job_id, **kwargs):
                    raise AssertionError("an unverified scheduled job must not run")

                def _schedule_job(self, job):
                    raise AssertionError("an unverified job must not be scheduled")

                async def delete_job(self, job_id):
                    return None

            install_cron_provenance(FakeCronManager, store)
            with self.assertRaisesRegex(RuntimeError, "scheduled job has no verified broker provenance"):
                FakeCronManager()._schedule_job(SimpleNamespace(job_id="no-source-job"))
            with self.assertRaisesRegex(RuntimeError, "scheduled job provenance is unavailable"):
                asyncio.run(FakeCronManager()._run_job("no-source-job"))
            self.assertIsNone(current_principal.get())

    def test_plugin_principal_is_restricted_after_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = CronProvenanceStore(Path(temporary) / "cron-provenance.json", "test-secret")
            self.bind_fixture_job(store, "restricted-job")

            principal = store.resolve("restricted-job")

            self.assertIsNotNone(principal)
            assert principal is not None
            self.assertEqual(principal.identity.plugin_ids, frozenset({"fixture-plugin"}))
            self.assertFalse(principal.identity.allow_ai)

    def test_scheduled_run_binds_and_resets_verified_principal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = CronProvenanceStore(Path(temporary) / "cron-provenance.json", "test-secret")
            self.bind_fixture_job(store, "scheduled-job")
            observed = []
            event_var = ContextVar("test_native_message_event", default=None)
            stale_event = SimpleNamespace(identity=make_identity())
            event_token = event_var.set(stale_event)

            class FakeCronManager:
                async def _run_job(self, job_id, **kwargs):
                    observed.append((current_principal.get(), event_var.get()))
                    return "ran"

                def _schedule_job(self, job):
                    return None

                async def delete_job(self, job_id):
                    return None

            install_cron_provenance(FakeCronManager, store)
            try:
                with patch.dict(sys.modules, {
                    "astrbot.core.platform.astr_message_event": SimpleNamespace(current_message_event=event_var),
                }):
                    result = asyncio.run(FakeCronManager()._run_job("scheduled-job"))
                self.assertIs(event_var.get(), stale_event)
            finally:
                event_var.reset(event_token)

            self.assertEqual(result, "ran")
            self.assertEqual(len(observed), 1)
            self.assertEqual(observed[0][0], store.resolve("scheduled-job"))
            self.assertIsNone(observed[0][1], "a scheduled job must not inherit its creator's completed message event")
            self.assertIsNone(current_principal.get())


if __name__ == "__main__":
    unittest.main(verbosity=2)
