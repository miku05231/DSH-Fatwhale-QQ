# Native scheduled acceptance

These harnesses use the locked, unchanged plugin ZIPs and a marked isolated
external runtime. Their send sink is an in-memory collector, not QQ. Keep the
source mounted read-only, use a dedicated writable case state, and wait for
runtime health before starting the collector. Never use the live installation's
configuration or state.

## Flags and case layout

| Case | Required acceptance flags | Existing environment prefix |
| --- | --- | --- |
| Weather with outbound grant | `ASTRBOT_WEATHER_NATIVE_TEST=1`, `ASTRBOT_WEATHER_OUTBOUND_GRANT=1` | `ASTRBOT_SAMPLE_APP_ROOT`, `ASTRBOT_SAMPLE_STATE_DIR`, `ASTRBOT_SAMPLE_CALLBACK_*`, `ASTRBOT_RUNTIME_URL`, `ASTRBOT_WEATHER_FIXTURE_*` |
| Reminder with cold restore | `ASTRBOT_REMINDER_TEST=1`, `ASTRBOT_REMINDER_COLD_RESTORE=1` | `ASTRBOT_REMINDER_APP_ROOT`, `ASTRBOT_REMINDER_STATE_DIR`, `ASTRBOT_REMINDER_RUNTIME_URL`, `ASTRBOT_REMINDER_CALLBACK_*` |

For either case, the dedicated state directory contains
`.astrbot-acceptance-only` and `samples/weather.zip` or `samples/reminder.zip`.
The native runtime uses `QQ_ASTRBOT_STATE_ROOT=<case-state>/astrbot`. On NAS the
separate case state mount can be `/app/state`; the application source is `/app`.
The ZIP archive and installed `main.py` must match the committed sample manifest.
The tests do not need a second ZIP under the source checkout's `.tmp` directory.

Weather chooses the Shanghai minute two minute boundaries after slot selection
(about 60–120 seconds ahead), then caps its scheduled wait at 160 seconds.
Reminder keeps the existing two timer windows, each bounded by
`ASTRBOT_REMINDER_EVENT_TIMEOUT_MS` (default 240 seconds). Both installation
timeouts default to 600 seconds. Lifecycle callback checks add no timer wait.

## Weather evidence

After all initial manager configuration and policy setup, and after the native
controlled queries, the grant phase requires a no-grant authorization denial.
It then calls `policy.createOutboundGrant` for the installed plugin, purpose
`weather.daily`, and synthetic private target `456`. Positive policy
authorization does not send a message. No successful synthetic send callback is
used to satisfy the scheduled-delivery assertion.

The actual native daily scheduler must produce both a fixture adcode request
and a private collector reply at or after the selected slot. Only then can
`scheduledDailyPush.status` and `outboundGrant.actualScheduledDeliveryCaptured`
pass. The grant phase also requires all these independent checks:

- Explicit revoke rejects policy authorization and an `outbound.send` callback.
- A distinct replacement grant authorizes before configuration.
- Same-config `manager.configure` rejects that grant and its callback.
- Actual `manager.rollback` restores the previous generation without reviving
  either grant; both records remain inactive with reason `revoked`.
- Every denied callback leaves the collector unchanged.

The callback probes have a different message signature from the scheduled
weather reply. Owned grants are revoked again during cleanup. A grant-phase or
daily-phase failure is retained in `failureCodes` and cannot produce an overall
pass.

`ASTRBOT_WEATHER_PUBLIC_TEST=1` remains a separate optional native public-query
phase using the official anonymous endpoint, blank API key, and disabled push
and monitor. It still runs after daily/grant failure. A public phase may pass
while the overall result fails. A diagnostic HTTP GET alone never proves native
plugin success. Leave this flag unset when avoiding another public API request.

## Reminder evidence

Cold restore is mandatory once the reminder harness is enabled. Missing
`ASTRBOT_REMINDER_COLD_RESTORE=1` produces
`ASTRBOT_REMINDER_COLD_RESTORE_REQUIRED`, not a warm-restore pass. The runtime
worker PID must change. No message dispatch, including a restored-reminder
query, is allowed between restart and the first captured restored timer send.
Only health/status probes precede that send.

The creator remains synthetic non-admin `789` in original group `123`; project
admin `456` can view the reminder without changing its creator or the immutable
origin snapshot. The existing outsider denial, admin deletion, and cross-group
`124` delivery-leak checks remain required.

After the native cold timer and cross-group checks, the original creation
context must still authorize a read-only bridge permission probe. Same-config
configuration, then disable/re-enable, must each make that original context
fail both the exact epoch check (`ASTRBOT_SCHEDULED_ORIGIN_REVOKED`) and the real
bridge send callback (`ASTRBOT_PERMISSION_DENIED`), with no collector effect.
A fresh creator query after re-enable must succeed and preserve the old origin.

`lifecycleRevocation.method=original-context-callback` and
`additionalNativeTimerTested=false` describe this bounded proof: old authority
cannot send after lifecycle invalidation. This is not a second post-re-enable
native timer test or proof that every old APS job was physically deleted.

Local validation covers Node syntax and isolated execution of the actual new
phase/helper code, including simulated authorization failures and callback
leaks. Only a subsequent native runtime run can establish the scheduled
delivery, cold worker restoration, and current product integration results.
