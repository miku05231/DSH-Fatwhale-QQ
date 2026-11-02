"""Real APScheduler tests for bounded third-party job provenance."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import sys
import tempfile
import unittest
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.schedulers.base import BaseScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "runtime" / "astrbot"))

from qq_astrbot.acl import CronProvenanceStore  # noqa: E402
from qq_astrbot.context import DispatchIdentity, bind_principal, current_principal  # noqa: E402
from qq_astrbot.scheduled import _validate_scheduler_runtime, install_aps_provenance  # noqa: E402
from qq_astrbot import scheduled as scheduled_module  # noqa: E402


native_event = ContextVar("aps_provenance_native_event", default=None)
BODY = "remember: private reminder body"


def make_identity(*, user_id: str = "creator-user", is_admin: bool = False) -> DispatchIdentity:
    return DispatchIdentity.from_params(
        {
            "contextId": "offline-aps-provenance",
            "deadlineAt": 2_000_000_000,
            "event": {
                "messageId": "message-aps-1",
                "userId": user_id,
                "nickname": "APS test creator",
                "groupId": "group-aps-1",
                "isGroup": True,
                "isAdmin": is_admin,
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


async def observe_async(*args, **kwargs):
    observed.append((current_principal.get(), native_event.get(), args, kwargs))
    return "ran"


def observe_sync(*args, **kwargs):
    observed.append((current_principal.get(), native_event.get(), args, kwargs))
    return "ran"


observed = []
scope_observations = []
weather_scope_active = ContextVar("aps_provenance_weather_scope", default=False)


def observe_scoped(*args, **kwargs):
    observed.append(
        (current_principal.get(), native_event.get(), args, kwargs, weather_scope_active.get())
    )
    return "ran"


@contextmanager
def weather_execution_scope(owner, func, args, kwargs):
    scope_observations.append((owner, current_principal.get(), native_event.get()))
    token = weather_scope_active.set(True)
    try:
        yield "verified-weather-scope"
    finally:
        weather_scope_active.reset(token)


@contextmanager
def reminder_execution_scope(owner, func, args, kwargs):
    scope_observations.append(("reminder", current_principal.get(), native_event.get()))
    yield None


def profile_encoder_v1(owner, func, args, kwargs):
    return {"args": list(args), "kwargs": kwargs}


def profile_encoder_v2(owner, func, args, kwargs):
    return {"kwargs": dict(kwargs), "args": list(args)}


# Simulate a profile implementation replaced in place while keeping its public
# callable identity stable. The source hash must still invalidate old grants.
profile_encoder_v2.__module__ = profile_encoder_v1.__module__
profile_encoder_v2.__qualname__ = profile_encoder_v1.__qualname__


def owner_resolver(func):
    original = getattr(func, "__wrapped__", func)
    if original in (observe_async, observe_sync, observe_scoped):
        return "fixture-plugin"
    return None


def failing_owner_resolver(func):
    raise RuntimeError("fixture owner lookup failure")


def scheduler_type(store, *, argument_encoder=None, execution_scope=None):
    cls = type("TestAsyncIOScheduler", (AsyncIOScheduler,), {})
    install_aps_provenance(
        cls,
        store,
        owner_resolver,
        argument_encoder=argument_encoder,
        execution_scope=execution_scope,
    )
    return cls


def cron_trigger():
    return CronTrigger.from_crontab("15 4 * * *", timezone=timezone.utc)


def run_wrapped(job):
    with patch.dict(
        sys.modules,
        {
            "astrbot.core.platform.astr_message_event": SimpleNamespace(
                current_message_event=native_event
            ),
        },
    ):
        return asyncio.run(job.func(*job.args, **job.kwargs))


class APSProvenanceTests(unittest.TestCase):
    def setUp(self):
        observed.clear()
        scope_observations.clear()
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.provenance_path = Path(self.tempdir.name) / "aps-provenance.json"

    def test_argument_projection_bounds_aggregate_before_serializing(self):
        projection = ["x" * 16_000 for _ in range(5)]
        with patch.object(
            scheduled_module.json,
            "dumps",
            side_effect=AssertionError("oversized projection reached JSON serialization"),
        ) as serialize:
            with self.assertRaisesRegex(ValueError, "byte limit"):
                scheduled_module._canonical_json(projection)
        serialize.assert_not_called()

    def add_owned_job(self, scheduler, *, args, job_id="reminder-job"):
        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            return scheduler.add_job(
                observe_async,
                trigger=cron_trigger(),
                id=job_id,
                args=args,
                kwargs={},
            )
        finally:
            current_principal.reset(token)

    def test_restart_restores_only_exact_descriptor_and_does_not_store_body(self):
        original_store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        first_scheduler_class = scheduler_type(original_store)
        first_scheduler = first_scheduler_class(timezone=timezone.utc)
        first_job = self.add_owned_job(first_scheduler, args=[{"message": BODY}])

        self.assertIs(first_scheduler.get_job("reminder-job"), first_job)
        state = first_job.func.__qq_aps_provenance_state__
        self.assertIsNotNone(state.key)
        persisted = self.provenance_path.read_text("utf-8")
        self.assertNotIn(BODY, persisted)
        self.assertIn(state.key, persisted)

        restarted_store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        restarted_scheduler_class = scheduler_type(restarted_store)
        restarted_scheduler = restarted_scheduler_class(timezone=timezone.utc)
        job = restarted_scheduler.add_job(
            observe_async,
            trigger=cron_trigger(),
            id="reminder-job",
            args=[{"message": BODY}],
            kwargs={},
        )

        stale = SimpleNamespace(text="ambient message")
        event_token = native_event.set(stale)
        try:
            self.assertEqual(run_wrapped(job), "ran")
            self.assertIs(native_event.get(), stale)
        finally:
            native_event.reset(event_token)

        self.assertEqual(len(observed), 1)
        principal, event, _args, _kwargs = observed[0]
        self.assertIsNotNone(principal)
        assert principal is not None
        self.assertEqual(principal.plugin_id, "fixture-plugin")
        self.assertEqual(principal.identity.user_id, "creator-user")
        self.assertFalse(principal.identity.is_admin)
        self.assertEqual(principal.identity.plugin_ids, frozenset({"fixture-plugin"}))
        self.assertFalse(principal.identity.allow_ai)
        self.assertIsNone(event)

        changed_scheduler_class = scheduler_type(restarted_store)
        changed_scheduler = changed_scheduler_class(timezone=timezone.utc)
        changed_job = changed_scheduler.add_job(
            observe_async,
            trigger=cron_trigger(),
            id="reminder-job",
            args=[{"message": "changed command"}],
            kwargs={},
        )
        self.assertEqual(run_wrapped(changed_job), "ran")
        self.assertIsNone(observed[-1][0], "changed arguments must not inherit the old creator")

        bounded_trigger = cron_trigger()
        bounded_trigger.start_date = datetime(2027, 1, 1, tzinfo=timezone.utc)
        bounded_trigger.end_date = datetime(2027, 2, 1, tzinfo=timezone.utc)
        self.assertEqual(str(bounded_trigger), str(cron_trigger()))
        bounded_scheduler_class = scheduler_type(restarted_store)
        bounded_scheduler = bounded_scheduler_class(timezone=timezone.utc)
        bounded_job = bounded_scheduler.add_job(
            observe_async,
            trigger=bounded_trigger,
            id="reminder-job",
            args=[{"message": BODY}],
            kwargs={},
        )
        self.assertNotEqual(state.key, bounded_job.func.__qq_aps_provenance_state__.key)
        self.assertEqual(run_wrapped(bounded_job), "ran")
        self.assertIsNone(observed[-1][0], "different trigger bounds must not reuse a grant")

    def test_pending_get_modify_and_explicit_cancel_revoke_grant(self):
        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store)
        scheduler = cls(timezone=timezone.utc)
        job = self.add_owned_job(scheduler, args=[{"message": "original"}])
        old_key = job.func.__qq_aps_provenance_state__.key
        self.assertIs(scheduler.get_job(job.id), job)
        self.assertIsNotNone(store.resolve(old_key))

        scheduler.modify_job(job.id, args=[{"message": "modified"}])
        modified = scheduler.get_job(job.id)
        self.assertIsNotNone(modified)
        self.assertEqual(modified.args, [{"message": "modified"}])
        self.assertIsNone(store.resolve(old_key), "a changed pending job must retire its old grant")
        self.assertEqual(run_wrapped(modified), "ran")
        self.assertIsNone(observed[-1][0])

        modified_key = modified.func.__qq_aps_provenance_state__.key
        self.assertIsNotNone(modified_key)
        # A creator-matching modification may bind a fresh descriptor.
        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            scheduler.modify_job(job.id, args=[{"message": "authorized update"}])
        finally:
            current_principal.reset(token)
        replacement = scheduler.get_job(job.id)
        replacement_key = replacement.func.__qq_aps_provenance_state__.key
        self.assertNotEqual(modified_key, replacement_key)
        self.assertIsNotNone(store.resolve(replacement_key))

        changed_trigger = CronTrigger.from_crontab("30 4 * * *", timezone=timezone.utc)
        scheduler.modify_job(job.id, trigger=changed_trigger)
        trigger_modified = scheduler.get_job(job.id)
        trigger_modified_key = trigger_modified.func.__qq_aps_provenance_state__.key
        self.assertNotEqual(replacement_key, trigger_modified_key)
        self.assertIsNone(store.resolve(replacement_key))
        self.assertIsNone(
            store.resolve(trigger_modified_key),
            "changing a trigger without the creator must not carry the prior grant",
        )
        self.assertEqual(run_wrapped(trigger_modified), "ran")
        self.assertIsNone(observed[-1][0])

        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            scheduler.modify_job(job.id, trigger=changed_trigger)
        finally:
            current_principal.reset(token)
        authorized_trigger_job = scheduler.get_job(job.id)
        authorized_trigger_key = (
            authorized_trigger_job.func.__qq_aps_provenance_state__.key
        )
        self.assertEqual(trigger_modified_key, authorized_trigger_key)
        self.assertIsNotNone(store.resolve(authorized_trigger_key))

        scheduler.remove_job(job.id)
        self.assertIsNone(scheduler.get_job(job.id))
        self.assertIsNone(store.resolve(authorized_trigger_key))

    def test_replace_existing_retires_owned_grant_including_native_replacement(self):
        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store)
        scheduler = cls(timezone=timezone.utc)
        old_job = self.add_owned_job(scheduler, args=[{"body": "old"}], job_id="replace-me")
        old_key = old_job.func.__qq_aps_provenance_state__.key
        self.assertIsNotNone(store.resolve(old_key))

        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            replacement = scheduler.add_job(
                observe_async,
                trigger=cron_trigger(),
                id="replace-me",
                args=[{"body": "new"}],
                kwargs={},
                replace_existing=True,
            )
        finally:
            current_principal.reset(token)
        replacement_key = replacement.func.__qq_aps_provenance_state__.key
        self.assertNotEqual(old_key, replacement_key)
        self.assertIsNone(store.resolve(old_key))
        self.assertIsNotNone(store.resolve(replacement_key))

        def native_callback():
            return None

        native_replacement = scheduler.add_job(
            native_callback,
            trigger=cron_trigger(),
            id="replace-me",
            replace_existing=True,
        )
        self.assertIs(native_replacement.func, native_callback)
        self.assertIsNone(store.resolve(replacement_key))

    def test_native_callback_cancellation_is_explicit_even_with_inherited_prune_flag(self):
        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store)
        scheduler = cls(timezone=timezone.utc)
        target = self.add_owned_job(
            scheduler,
            args=[{"body": "cancel target"}],
            job_id="native-cancel-target",
        )
        target_key = target.func.__qq_aps_provenance_state__.key

        def native_canceller():
            scheduler.remove_job("native-cancel-target")

        callback_job = scheduler.add_job(
            native_canceller,
            trigger=cron_trigger(),
            id="native-canceller",
        )
        self.assertIs(callback_job.func, native_canceller)

        inherited_prune_token = scheduled_module._PROCESSING_JOBS.set(True)
        try:
            callback_job.func()
        finally:
            scheduled_module._PROCESSING_JOBS.reset(inherited_prune_token)

        self.assertIsNone(scheduler.get_job("native-cancel-target"))
        self.assertIsNone(
            store.resolve(target_key),
            "a copied prune ContextVar must not suppress explicit cancellation",
        )

    def test_wrong_owner_cannot_bind_or_reuse_an_existing_descriptor(self):
        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store)
        scheduler = cls(timezone=timezone.utc)
        self.add_owned_job(scheduler, args=[{"message": "same descriptor"}])
        job = scheduler.get_job("reminder-job")
        key = job.func.__qq_aps_provenance_state__.key
        self.assertIsNotNone(store.resolve(key))

        wrong_token = bind_principal(make_identity(user_id="other-user"), "unrelated-plugin")
        try:
            # A second scheduler models a restarted/plugin-recreated APS memory
            # store while the previous HMAC mapping still exists.
            second_scheduler_class = scheduler_type(store)
            second_scheduler = second_scheduler_class(timezone=timezone.utc)
            wrong_job = second_scheduler.add_job(
                observe_async,
                trigger=cron_trigger(),
                id="reminder-job",
                args=[{"message": "same descriptor"}],
                kwargs={},
            )
        finally:
            current_principal.reset(wrong_token)

        self.assertIsNone(store.resolve(key))
        self.assertEqual(run_wrapped(wrong_job), "ran")
        self.assertIsNone(observed[-1][0])

    def test_unsupported_arguments_fail_closed_and_unowned_callbacks_stay_native(self):
        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store)
        scheduler = cls(timezone=timezone.utc)
        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            owned = scheduler.add_job(
                observe_sync,
                trigger=cron_trigger(),
                id="unsupported-owned-job",
                args=[object()],
                kwargs={},
            )
        finally:
            current_principal.reset(token)
        self.assertIsNone(owned.func.__qq_aps_provenance_state__.key)
        self.assertEqual(run_sync_wrapped(owned), "ran")
        self.assertIsNone(observed[-1][0])

        def native_callback():
            return None

        native_job = scheduler.add_job(
            native_callback,
            trigger=cron_trigger(),
            id="native-job",
        )
        self.assertIs(native_job.func, native_callback)
        self.assertIs(scheduler.get_job("native-job"), native_job)

        failing_cls = type("FailingOwnerAsyncIOScheduler", (AsyncIOScheduler,), {})
        install_aps_provenance(failing_cls, store, failing_owner_resolver)
        failing_scheduler = failing_cls(timezone=timezone.utc)
        unresolved_job = failing_scheduler.add_job(
            observe_sync,
            trigger=cron_trigger(),
            id="unresolved-owner-job",
        )
        self.assertIs(unresolved_job.func, observe_sync)
        self.assertIs(failing_scheduler.get_job("unresolved-owner-job"), unresolved_job)

    def test_install_requires_pinned_apscheduler_version_and_signatures(self):
        _validate_scheduler_runtime(BaseScheduler)
        wrong_version_cls = type("WrongVersionAsyncIOScheduler", (AsyncIOScheduler,), {})
        with patch("importlib.metadata.version", return_value="3.11.2"):
            with self.assertRaisesRegex(RuntimeError, "expected '3.11.3'"):
                install_aps_provenance(wrong_version_cls, object(), owner_resolver)

        class WrongSignatureAsyncIOScheduler(AsyncIOScheduler):
            def modify_job(self, job_id, **changes):
                return super().modify_job(job_id, **changes)

        with self.assertRaisesRegex(RuntimeError, "modify_job signature"):
            install_aps_provenance(
                WrongSignatureAsyncIOScheduler,
                object(),
                owner_resolver,
            )

    def test_cold_restore_requires_exact_source_profile_hash(self):
        original_store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        original_cls = scheduler_type(original_store, argument_encoder=profile_encoder_v1)
        original_scheduler = original_cls(timezone=timezone.utc)
        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            original_job = original_scheduler.add_job(
                observe_sync,
                trigger=cron_trigger(),
                id="profile-source-job",
                args=[{"target": "qq:group:1", "body": "scheduled text"}],
                kwargs={},
            )
        finally:
            current_principal.reset(token)
        original_state = original_job.func.__qq_aps_provenance_state__
        self.assertIsNotNone(original_state.key)

        cold_store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cold_cls = scheduler_type(cold_store, argument_encoder=profile_encoder_v1)
        cold_scheduler = cold_cls(timezone=timezone.utc)
        cold_job = cold_scheduler.add_job(
            observe_sync,
            trigger=cron_trigger(),
            id="profile-source-job",
            args=[{"target": "qq:group:1", "body": "scheduled text"}],
            kwargs={},
        )
        self.assertEqual(
            cold_job.func.__qq_aps_provenance_state__.key,
            original_state.key,
        )
        self.assertEqual(run_sync_wrapped(cold_job), "ran")
        self.assertEqual(observed[-1][0].identity.user_id, "creator-user")

        changed_profile_cls = scheduler_type(
            cold_store, argument_encoder=profile_encoder_v2
        )
        changed_profile_scheduler = changed_profile_cls(timezone=timezone.utc)
        changed_profile_job = changed_profile_scheduler.add_job(
            observe_sync,
            trigger=cron_trigger(),
            id="profile-source-job",
            args=[{"target": "qq:group:1", "body": "scheduled text"}],
            kwargs={},
        )
        self.assertNotEqual(
            original_state.key,
            changed_profile_job.func.__qq_aps_provenance_state__.key,
        )
        self.assertEqual(run_sync_wrapped(changed_profile_job), "ran")
        self.assertIsNone(
            observed[-1][0],
            "a changed source profile must not reuse an old creator grant",
        )

    def test_execution_scope_requires_exact_arguments_and_has_no_principal(self):
        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store, execution_scope=weather_execution_scope)
        scheduler = cls(timezone=timezone.utc)
        job = scheduler.add_job(
            observe_scoped,
            trigger=cron_trigger(),
            id="scoped-weather-job",
            args=[{"target": "qq:group:1", "body": "forecast question"}],
            kwargs={},
        )
        scoped_key = job.func.__qq_aps_provenance_state__.key
        self.assertIsNotNone(scoped_key)
        self.assertIsNone(
            store.resolve(scoped_key),
            "scope-only weather jobs deliberately have no creator Principal record",
        )

        ambient_token = bind_principal(
            make_identity(user_id="ambient-user"), "unrelated-plugin"
        )
        try:
            self.assertEqual(run_sync_wrapped(job), "ran")
            self.assertEqual(current_principal.get().identity.user_id, "ambient-user")
        finally:
            current_principal.reset(ambient_token)

        self.assertEqual(scope_observations, [("fixture-plugin", None, None)])
        principal, event, _args, _kwargs, scope_active = observed[-1]
        self.assertIsNone(principal, "scoped jobs must not receive a broker Principal")
        self.assertIsNone(event)
        self.assertTrue(scope_active)

        job.trigger = CronTrigger.from_crontab("30 4 * * *", timezone=timezone.utc)
        with self.assertRaisesRegex(PermissionError, "source profile"):
            run_sync_wrapped(job)
        self.assertEqual(len(scope_observations), 1)
        self.assertEqual(len(observed), 1)

        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            hmac_backed_job = scheduler.add_job(
                observe_scoped,
                trigger=cron_trigger(),
                id="scoped-weather-with-creator-record",
                args=[{"target": "qq:group:1", "body": "forecast question"}],
                kwargs={},
            )
        finally:
            current_principal.reset(token)
        hmac_key = hmac_backed_job.func.__qq_aps_provenance_state__.key
        self.assertIsNotNone(store.resolve(hmac_key))
        self.assertEqual(run_sync_wrapped(hmac_backed_job), "ran")
        principal, event, _args, _kwargs, scope_active = observed[-1]
        self.assertIsNone(principal, "weather scope must not expose an HMAC Principal")
        self.assertIsNone(event)
        self.assertTrue(scope_active)
        self.assertEqual(len(scope_observations), 2)

        job.args[0]["target"] = "qq:group:changed"
        with self.assertRaisesRegex(PermissionError, "source profile"):
            run_sync_wrapped(job)
        self.assertEqual(len(scope_observations), 2)
        self.assertEqual(len(observed), 2)

    def test_null_execution_scope_requires_the_exact_hmac_creator(self):
        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store, execution_scope=reminder_execution_scope)
        scheduler = cls(timezone=timezone.utc)
        job = scheduler.add_job(
            observe_sync,
            trigger=cron_trigger(),
            id="scoped-reminder-job",
            args=[{"body": "reminder text"}],
            kwargs={},
        )
        key = job.func.__qq_aps_provenance_state__.key
        self.assertIsNotNone(key)
        self.assertIsNone(store.resolve(key))

        with self.assertRaisesRegex(PermissionError, "creator grant"):
            run_sync_wrapped(job)
        self.assertEqual(observed, [])
        self.assertEqual(scope_observations, [("reminder", None, None)])

        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            scheduler.modify_job(job.id, args=[{"body": "reminder text"}])
        finally:
            current_principal.reset(token)
        rebound = scheduler.get_job(job.id)
        self.assertEqual(rebound.func.__qq_aps_provenance_state__.key, key)
        self.assertIsNotNone(store.resolve(key))
        self.assertEqual(run_sync_wrapped(rebound), "ran")
        principal, event, _args, _kwargs = observed[-1]
        self.assertEqual(principal.identity.user_id, "creator-user")
        self.assertIsNone(event)

    def test_custom_encoder_can_ignore_only_a_pinned_runtime_counter(self):
        class ReminderStar:
            pass

        item = {
            "name": "daily reminder",
            "message": BODY,
            "message_structure": [{"type": "text", "data": {"text": BODY}}],
            "enabled_sessions": ["qq:group:1"],
            "executed_count": 0,
        }
        star = ReminderStar()

        def encode_reminder(owner, func, args, kwargs):
            if owner != "fixture-plugin" or type(args[0]) is not ReminderStar:
                raise ValueError("unrecognized reminder Star instance")
            stable_item = dict(args[1])
            stable_item.pop("executed_count", None)
            return {
                "args": [{"registeredStar": "fixture-plugin"}, stable_item],
                "kwargs": kwargs,
            }

        store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
        cls = scheduler_type(store, argument_encoder=encode_reminder)
        scheduler = cls(timezone=timezone.utc)
        token = bind_principal(make_identity(), "fixture-plugin")
        try:
            job = scheduler.add_job(
                observe_sync,
                trigger=cron_trigger(),
                id="profiled-reminder",
                args=[star, item],
                kwargs={},
            )
        finally:
            current_principal.reset(token)

        self.assertIsNotNone(job.func.__qq_aps_provenance_state__.key)
        item["executed_count"] = 7
        self.assertEqual(
            run_sync_wrapped(job),
            "ran",
            "the pinned runtime counter should not invalidate a reminder",
        )
        self.assertIsNotNone(observed[-1][0])
        self.assertNotIn(BODY, self.provenance_path.read_text("utf-8"))

        item["message"] = "changed command"
        self.assertEqual(run_sync_wrapped(job), "ran")
        self.assertIsNone(observed[-1][0], "content changes must invalidate the old grant")

    def test_date_job_survives_aps_autoprune_and_runs_once(self):
        async def exercise():
            store = CronProvenanceStore(self.provenance_path, "aps-test-secret")
            completed = asyncio.Event()
            calls = []

            async def date_callback():
                calls.append((current_principal.get(), native_event.get()))
                completed.set()

            def date_owner(func):
                return "fixture-plugin" if func is date_callback else None

            # This class has its own resolver because the callback is local to
            # this test and must resolve to its actual directory owner.
            cls = type("DateAsyncIOScheduler", (AsyncIOScheduler,), {})
            install_aps_provenance(cls, store, date_owner)
            scheduler = cls(timezone=timezone.utc)
            scheduler.start(paused=True)

            creator_token = bind_principal(make_identity(), "fixture-plugin")
            try:
                scheduler.add_job(
                    date_callback,
                    trigger=DateTrigger(
                        run_date=datetime.now(timezone.utc) + timedelta(milliseconds=80)
                    ),
                    id="one-shot-reminder",
                    args=[],
                    kwargs={},
                )
            finally:
                current_principal.reset(creator_token)
            job = scheduler.get_job("one-shot-reminder")
            key = job.func.__qq_aps_provenance_state__.key
            self.assertIsNotNone(key)

            ambient_token = bind_principal(
                make_identity(user_id="ambient-user"), "unrelated-plugin"
            )
            stale = SimpleNamespace(text="ambient native event")
            event_token = native_event.set(stale)
            try:
                scheduler.resume()
                await asyncio.wait_for(completed.wait(), timeout=3)
                await asyncio.sleep(0.1)
                self.assertEqual(len(calls), 1)
                scheduled_principal, event = calls[0]
                self.assertIsNotNone(scheduled_principal)
                assert scheduled_principal is not None
                self.assertEqual(scheduled_principal.identity.user_id, "creator-user")
                self.assertIsNone(event)
                self.assertIsNone(scheduler.get_job("one-shot-reminder"))
                self.assertIsNone(store.resolve(key), "one-shot grant should retire after dispatch")
                self.assertEqual(current_principal.get().identity.user_id, "ambient-user")
                self.assertIs(native_event.get(), stale)
            finally:
                native_event.reset(event_token)
                current_principal.reset(ambient_token)
                scheduler.shutdown(wait=False)
                await asyncio.sleep(0.05)

        with patch.dict(
            sys.modules,
            {
                "astrbot.core.platform.astr_message_event": SimpleNamespace(
                    current_message_event=native_event
                ),
            },
        ):
            asyncio.run(exercise())


def run_sync_wrapped(job):
    event_token = native_event.set(SimpleNamespace(text="ambient sync event"))
    try:
        with patch.dict(
            sys.modules,
            {
                "astrbot.core.platform.astr_message_event": SimpleNamespace(
                    current_message_event=native_event
                ),
            },
        ):
            return job.func(*job.args, **job.kwargs)
    finally:
        native_event.reset(event_token)


if __name__ == "__main__":
    unittest.main(verbosity=2)
