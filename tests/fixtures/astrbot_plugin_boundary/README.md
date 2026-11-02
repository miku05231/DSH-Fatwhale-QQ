# Offline AstrBot acceptance fixture

Load this plugin only into an isolated test installation. Existing commands cover
command filters, project administrator identity, generated WAV output, current and
legacy provider calls, decorator tools, and `FunctionTool` registration. Test model
replies must be local fixtures. The runner should also revoke a grant between tool
selection and execution and verify that neither execution nor final delivery
succeeds.

## Media commands

- `/ast_image` sends a deterministic 2×2 PNG generated with the Python standard
  library; it needs no image package, fixture file, or network fetch.
- Attach one or more media components to `/ast_media`. The fixture reports only
  component type and source scheme, then echoes at most the first three native
  components. It does not open a URL or local path. Local/base64 upload and media
  handle handling remain in the bridge adapter.

## Native scheduled callback

`/ast_timer [delay_seconds] [marker] [target_group_id]` schedules a one-shot native
basic job. Delay defaults to 3 seconds and is limited to 3–300 seconds. The source
group is derived at callback time from the broker-verified principal. The job
payload stores the marker, optional target group, and fixture ownership tags,
including the fixture's plugin root; it does not contain a creator identity.

Example default run:

```text
/ast_timer 3 smoke-1
```

The command acknowledges with `timer-scheduled:smoke-1`; after about three
seconds the callback sends `timer-fired:smoke-1` to the original conversation.
To test cross-group denial, use a different numeric group ID:

```text
/ast_timer 3 deny-1 123456789
```

The callback attempts that other-group session through AstrBot's native
`Context.send_message`. The bridge must reject it, after which the callback sends
`timer-denied-cross-group:deny-1` to the original conversation. An
`unexpected-target-accepted` response indicates a failure.

For the restart case, choose a longer delay (for example, 20 seconds), then restart
the AstrBot runtime before it expires. `initialize()` lists native basic jobs and
reattaches only persisted rows tagged for this fixture and its loaded plugin
root. The scheduled callback also checks that the broker-restored plugin
principal matches that root. Rows without verified stored provenance are left
disabled and skipped. AstrBot 4.29.3 persists basic job records but not Python
handlers, so this fixture uses the private
`CronJobManager._basic_handlers` mapping to restore its own callback, followed by
the public `update_job()` scheduling path. The existing job ID, payload, and
HMAC-authenticated broker provenance are reused; restart does not create a job or
invent a principal. The timer uses `add_basic_job()` to create a disabled
persistent basic row, then `update_job(run_once=True, payload=...)` to activate the
native APScheduler `DateTrigger` at the stored UTC `run_at` time. The bridge binds
provenance when the job is first scheduled and requires that verified record when
the callback is rescheduled after restart.

This callback restoration depends on the pinned AstrBot 4.29.3 private handler
mapping; review it if the upstream cron manager changes.

## Offline cron provenance test

Run from the repository root with system Python:

```powershell
python tests/astrbot-cron-boundary-test.py
```

The test imports only the bridge's standard-library cron provenance modules and
uses temporary files. It covers HMAC reload, tamper rejection, refusal to bind or
run a job without source provenance, plugin-principal restriction, and scheduled
run context binding/reset. It does not start AstrBot, install packages, or touch
NAS configuration/state.

The fixture is part of this repository and uses its MIT license. It does not
replace or modify the third-party compatibility samples.
