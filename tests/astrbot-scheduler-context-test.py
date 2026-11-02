"""Real APScheduler tests for scheduler ContextVar isolation."""

from __future__ import annotations

import asyncio
import apscheduler
import os
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from unittest.mock import patch

from apscheduler.events import EVENT_JOB_SUBMITTED
from apscheduler.executors.asyncio import AsyncIOExecutor
from apscheduler.schedulers.asyncio import AsyncIOScheduler


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "runtime" / "astrbot"))

# Importing native AstrBot initializes paths. Never inherit a live AstrBot root.
_NATIVE_ROOT = tempfile.TemporaryDirectory(prefix="astrbot-scheduler-context-")
os.environ["ASTRBOT_ROOT"] = _NATIVE_ROOT.name

from astrbot.core.platform.astr_message_event import current_message_event  # noqa: E402
from qq_astrbot.acl import CronProvenanceStore  # noqa: E402
from qq_astrbot.context import DispatchIdentity, bind_principal, current_principal  # noqa: E402
from qq_astrbot.executor import install_scheduler_context_guard  # noqa: E402


if apscheduler.__version__ != "3.11.3":
    raise RuntimeError(f"This test requires APScheduler 3.11.3; found {apscheduler.__version__!r}")


def make_identity(user_id: str, plugin_ids: tuple[str, ...]) -> DispatchIdentity:
    return DispatchIdentity.from_params(
        {
            "contextId": f"scheduler-context-{user_id}",
            "deadlineAt": 2_000_000_000,
            "event": {
                "messageId": f"message-{user_id}",
                "userId": user_id,
                "nickname": user_id,
                "groupId": "scheduler-context-group",
                "isGroup": True,
                "isAdmin": False,
                "isWake": False,
                "text": "",
                "message": [],
            },
            "policy": {
                "pluginIds": list(plugin_ids),
                "chatMode": "astrbot",
                "allowAi": False,
            },
        }
    )


@contextmanager
def ambient_message(user_id: str, plugin_id: str):
    identity = make_identity(user_id, ("fixture-plugin", "unrelated-plugin"))
    principal_token = bind_principal(identity, plugin_id)
    event = {"message_id": f"event-{user_id}", "user_id": user_id}
    event_token = current_message_event.set(event)
    try:
        yield current_principal.get(), event
    finally:
        current_message_event.reset(event_token)
        current_principal.reset(principal_token)


async def run_cross_job_probe() -> tuple[object, object]:
    loop = asyncio.get_running_loop()
    scheduler = AsyncIOScheduler(event_loop=loop, timezone=timezone.utc)
    completed = loop.create_future()

    async def job_a():
        if not completed.done():
            completed.set_result((current_principal.get(), current_message_event.get()))

    async def job_b():
        raise AssertionError("far-future job B should have been removed")

    scheduler.add_job(
        job_a,
        trigger="date",
        run_date=datetime.now(timezone.utc) + timedelta(seconds=0.7),
        id="job-A",
    )
    scheduler.start()
    try:
        await asyncio.sleep(0.05)
        with ambient_message("ambient-user-B", "unrelated-plugin"):
            scheduler.add_job(
                job_b,
                trigger="date",
                run_date=datetime.now(timezone.utc) + timedelta(seconds=30),
                id="job-B",
            )
            scheduler.remove_job("job-B")
            scheduler.wakeup()

        return await asyncio.wait_for(completed, timeout=3)
    finally:
        scheduler.shutdown(wait=False)
        await asyncio.sleep(0.05)


async def stop_scheduler(scheduler: AsyncIOScheduler) -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
        await asyncio.sleep(0.05)


class SchedulerContextGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_00_cross_job_context_is_cleared_after_raw_leak_reproduction(self):
        before_principal, before_event = await run_cross_job_probe()
        self.assertIsNotNone(before_principal, "raw APScheduler control must reproduce context inheritance")
        self.assertEqual(before_principal.identity.user_id, "ambient-user-B")
        self.assertEqual(before_principal.plugin_id, "unrelated-plugin")
        self.assertEqual(before_event["user_id"], "ambient-user-B")

        install_scheduler_context_guard()
        install_scheduler_context_guard()  # installation is idempotent
        after_principal, after_event = await run_cross_job_probe()
        self.assertIsNone(after_principal)
        self.assertIsNone(after_event)
        self.assertIsNone(current_principal.get())
        self.assertIsNone(current_message_event.get())

    async def test_10_direct_job_does_not_inherit_and_submission_restores_caller(self):
        install_scheduler_context_guard()
        loop = asyncio.get_running_loop()
        scheduler = AsyncIOScheduler(event_loop=loop, timezone=timezone.utc)
        ran = loop.create_future()
        submission_context = loop.create_future()

        async def job():
            if not ran.done():
                ran.set_result((current_principal.get(), current_message_event.get()))

        def listener(event):
            if event.code == EVENT_JOB_SUBMITTED and not submission_context.done():
                submission_context.set_result((current_principal.get(), current_message_event.get()))

        scheduler.add_listener(listener, EVENT_JOB_SUBMITTED)
        scheduler.add_job(
            job,
            trigger="date",
            run_date=datetime.now(timezone.utc) + timedelta(seconds=0.05),
            id="direct-job",
            misfire_grace_time=5,
        )
        await asyncio.sleep(0.1)  # leave the scheduler stopped so its first wakeup is under B

        try:
            with ambient_message("direct-user-B", "unrelated-plugin") as (principal_b, event_b):
                scheduler.start()
                self.assertIs(current_principal.get(), principal_b)
                self.assertIs(current_message_event.get(), event_b)

            submitted_principal, submitted_event = await asyncio.wait_for(submission_context, timeout=3)
            job_principal, job_event = await asyncio.wait_for(ran, timeout=3)
            self.assertIs(submitted_principal, principal_b)
            self.assertIs(submitted_event, event_b)
            self.assertIsNone(job_principal)
            self.assertIsNone(job_event)
        finally:
            await stop_scheduler(scheduler)

    async def test_20_signed_native_wrapper_rebinds_exact_creator_after_guard(self):
        install_scheduler_context_guard()
        loop = asyncio.get_running_loop()
        scheduler = AsyncIOScheduler(event_loop=loop, timezone=timezone.utc)
        completed = loop.create_future()

        with tempfile.TemporaryDirectory() as tempdir:
            store = CronProvenanceStore(Path(tempdir) / "cron-provenance.json", "test-secret")
            creator_identity = make_identity("signed-creator", ("fixture-plugin",))
            creator_token = bind_principal(creator_identity, "fixture-plugin")
            try:
                store.bind_current("signed-native-job")
            finally:
                current_principal.reset(creator_token)

            async def signed_native_wrapper():
                resolved = store.resolve("signed-native-job")
                if resolved is None:
                    raise AssertionError("signed native provenance did not resolve")
                principal_token = current_principal.set(resolved)
                event_token = current_message_event.set(None)
                try:
                    if not completed.done():
                        completed.set_result((current_principal.get(), current_message_event.get()))
                finally:
                    current_message_event.reset(event_token)
                    current_principal.reset(principal_token)

            scheduler.add_job(
                signed_native_wrapper,
                trigger="date",
                run_date=datetime.now(timezone.utc) + timedelta(seconds=0.05),
                id="signed-native-job",
                misfire_grace_time=5,
            )
            await asyncio.sleep(0.1)
            try:
                with ambient_message("ambient-user-B", "unrelated-plugin"):
                    scheduler.start()
                principal, event = await asyncio.wait_for(completed, timeout=3)
            finally:
                await stop_scheduler(scheduler)

        self.assertIsNotNone(principal)
        self.assertEqual(principal.identity.user_id, "signed-creator")
        self.assertEqual(principal.plugin_id, "fixture-plugin")
        self.assertEqual(principal.identity.plugin_ids, frozenset({"fixture-plugin"}))
        self.assertFalse(principal.identity.allow_ai)
        self.assertIsNone(event)

    async def test_30_sync_job_thread_sees_no_ambient_identity(self):
        install_scheduler_context_guard()
        loop = asyncio.get_running_loop()
        scheduler = AsyncIOScheduler(event_loop=loop, timezone=timezone.utc)
        completed = loop.create_future()

        def sync_job():
            result = (current_principal.get(), current_message_event.get())
            loop.call_soon_threadsafe(completed.set_result, result)

        scheduler.add_job(
            sync_job,
            trigger="date",
            run_date=datetime.now(timezone.utc) + timedelta(seconds=0.05),
            id="sync-thread-job",
            misfire_grace_time=5,
        )
        await asyncio.sleep(0.1)
        try:
            with ambient_message("thread-user-B", "unrelated-plugin"):
                scheduler.start()
            principal, event = await asyncio.wait_for(completed, timeout=3)
        finally:
            await stop_scheduler(scheduler)

        self.assertIsNone(principal)
        self.assertIsNone(event)

    async def test_35_outbound_scope_does_not_bleed_into_another_job(self):
        from qq_astrbot.outbound import outbound_context
        install_scheduler_context_guard()
        loop = asyncio.get_running_loop()
        scheduler = AsyncIOScheduler(event_loop=loop, timezone=timezone.utc)
        observed = loop.create_future()
        sentinel = object()

        async def job():
            if not observed.done():
                observed.set_result(outbound_context.get())

        token = outbound_context.set(sentinel)
        try:
            scheduler.add_job(job, "date", run_date=datetime.now(timezone.utc) + timedelta(milliseconds=120))
            scheduler.start()
            self.assertIsNone(await asyncio.wait_for(observed, timeout=3))
            self.assertIs(outbound_context.get(), sentinel)
        finally:
            outbound_context.reset(token)
            await stop_scheduler(scheduler)

    def test_40_unsupported_version_or_replaced_hook_fails_closed(self):
        with patch.object(apscheduler, "__version__", "3.11.2"):
            with self.assertRaisesRegex(RuntimeError, "supports APScheduler 3.11.3"):
                install_scheduler_context_guard()

        guarded = AsyncIOExecutor._do_submit_job
        with patch.object(AsyncIOExecutor, "_do_submit_job", lambda self, job, run_times: None):
            with self.assertRaisesRegex(RuntimeError, "hook changed after context guard install"):
                install_scheduler_context_guard()
        self.assertIs(AsyncIOExecutor._do_submit_job, guarded)


if __name__ == "__main__":
    unittest.main(verbosity=2)
