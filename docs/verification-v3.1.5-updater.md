# Windows updater verification (2026-10-29)

The application version remains 3.1.5. After explicit maintainer approval,
the four existing release assets were replaced. The final package source is
`bf7d4ba`, including the updater correction and image generation recovery fixes.
The existing v3.1.5 Git tag was retained.

## Finding and correction

The default Windows installer launch could exit without executing its script.
The real UI reached installation after downloading and verifying the official
package, but no installer result appeared and the old console stayed running.
The previous tests injected an installer launcher and missed this boundary.

The launcher now uses a short-lived PowerShell process to call `Start-Process`
with a hidden, independent console. Its output and errors are recorded in the
private update job directory. Paths are quoted separately for PowerShell
literals and native command-line arguments. Provider paths are wildcard-escaped
because quoted bracket characters otherwise break `Start-Process` redirects.

## Verification

- `node tests/updates-test.mjs`: 367 assertions passed. The added Windows test
  uses the default launcher in a path containing spaces, brackets and an apostrophe. The
  installer starts, the launching Node process exits, and the installer still
  completes its delayed write.
- `node tests/updates-api-test.mjs`: 29 checks passed.
- Real UI: an isolated official 3.1.3 portable installation initially reproduced
  the launch failure. After replacing its updater module with the corrected
  source, the UI downloaded the official 3.1.5 portable package and performed
  installation and restart without `SkipRestart` or `SkipProcessActions`.
- The installer reported `complete`; the restarted UI displayed current and
  latest version 3.1.5. Owned bridge, console and tray processes restarted.
- Configuration, autostart marker, memory sentinel, persona sentinel and custom
  tool sentinel all retained their exact pre-install SHA256 values. The host
  startup shortcut inventory was unchanged.

The installed DeepSeek Harness application was used for restart. OneBot was a
local isolated fixture with empty message allow lists; this test does not prove
real QQ delivery or model response quality. The successful UI test verifies the
corrected launch path, not an untouched 3.1.3 installation. The subsequently
reissued portable asset contains the corrected launcher, including bracket-path
escaping. Its complete package installer regression passed all 66 checks.

Reissued portable SHA256:
`6325c89407e99744c31c464e4ee61100a4797e7fed7e8c4e78606eaea3c58bed`.
All four new assets matched GitHub's asset digests. Fresh public downloads using
a revision query also matched; the original download URLs initially returned
cached pre-reissue assets. Client checks must allow time for those caches to
expire. Existing 3.1.5 installations need a manual program-file replacement to
receive a correction with the same version number. Git source installations
following the unchanged tag also need to pull the corrected main branch.

## Privacy and broader test limits

A scan of 61 commits and 687 reachable public blobs up to 4 MiB found no exact
matches for qualifying sensitive live-configuration values or private IPv4
patterns. The official portable package checksum matched its published
manifest; inspection found no live configuration or private state payloads.
These checks are bounded scans, not a guarantee of absence of all personal data.

The earlier full suite had 79 passes and one intermittent image-generation UI
failure out of 80 tests. A subsequent isolated image-generation UI run passed
47 checks over six layouts, but its original intermittent cause remains open.
A later complete isolated suite at `20aae46` passed all 80 tests in 608.6 seconds.
The subsequent disabled-service cancellation correction passed its targeted
service, API, browser and real-package installer regressions.

## Image generation pre-submit recovery

A deterministic isolated metadata-lock injection reproduced a stranded `created`
job with a live worker PID and zero generation POSTs. Recovery previously
rejected it as busy. Recovery now cancels an unsubmitted `created` record under
the metadata lock and clears its worker token. The original worker must persist
`submitting` with that token before any generation POST, so cancellation cannot
race into a duplicate paid submission. The UI exposes this as “取消准备”. Live
workers in `submitting` and later states retain their existing protection.

The regression failed before the correction. Afterward, the service tests passed
20 tests, the console API tests passed 9 tests, and the browser journey passed
48 checks across six layouts, including cancellation with zero generation POSTs.
This injection establishes a recoverability defect; it does not identify the
cause of the two historical browser failures or explain the `unknown` result.

A follow-up review found that disabling the service also blocked this local
cancellation. The enabled-service check now runs after the unsubmitted-record
cancellation path. Service and API regressions cover cancellation while disabled;
both suites still pass (20 and 9 tests). Monitoring remote tasks continues to
require an enabled service, and administrator-context checks remain in place.

## Final public-package consumption (2026-10-30)

All four ordinary public download URLs returned the final published SHA256
values after cache propagation. An isolated official 3.1.3 installation with
the corrected updater module then used the real UI to install this final
portable package. Its downloaded ZIP matched the final checksum above; its
installed image generation source matched `bf7d4ba`. The installer reported
`complete`, the UI recovered on its original port showing current/latest 3.1.5,
and owned bridge, console and tray processes restarted. All five local data
sentinel hashes matched their pre-install values. Installer stdout/stderr were
empty. Neither process actions nor restart were skipped.

GitHub's anonymous API limit interrupted the final metadata check. Only the
isolated test process used a private fetch preload to authenticate requests to
`api.github.com` using an existing local Git credential, without logging or
persisting it. This supplied real GitHub responses, with no metadata or package
substitution. Asset downloads remained ordinary unauthenticated public downloads.
The installed real DeepSeek application and isolated OneBot fixture were used;
this remains a corrected-old-updater test, not proof that an untouched old
updater can repair its own launch defect. Test processes were stopped afterward.

Cloud verification run `40902767387` passed Linux but failed the Windows launch
regression's approximately five-second readiness window. Its other update checks
passed. The installer batches took several minutes each on that runner, compared
with much shorter local execution. This suggests a timing difference, but the
failure lacked child-installer stderr and does not establish the cause. The test
now allows at most 60 seconds for readiness and includes status/stderr diagnostics
on failure; its local run passed all 367 assertions. A fresh cloud run is required
before claiming cloud success. This test-only change does not alter release
program files. The historical intermittent `unknown` generation outcome is also
not established as fixed by the recovery correction.

The next cloud run, `40908610900`, passed all 367 update assertions but failed
when fixture cleanup removed the helper's working directory before PowerShell
released it (`EBUSY`). The helper now records its PID; the regression waits for
that exact process to exit after verifying the completion marker. A deliberate
one-second delay after that marker exercises the cleanup boundary locally.
The runner's budget includes the bounded startup, completion and exit waits.
The local corrected regression passed 368 assertions. This is a fixture-only
correction; final release program files and hashes remain unchanged.

Run `40916281917` also failed fixture cleanup after 368 assertions. Its launch
case took 75.3 seconds, matching the child-console timeout; cleanup had obscured
any earlier exception. An isolated local process probe demonstrated that a child
can exit with status zero while inherited capture pipes cause `spawnSync` to
report `ETIMEDOUT` (311 ms with a 300 ms limit). Capturing output in files instead
returned status zero without an error in 59 ms. This proves the test risk, not
the exact cause of every earlier cloud failure.

The launch regression now captures console output in files and checks both the
spawn error and exit status. Its helper holds the console process handle and
waits for that console to exit before writing completion, making the lifecycle
ordering explicit. Cleanup preserves the original error if removal also fails
and uses bounded filesystem retries after the process-exit check. The local
updated regression passed 369 assertions, including through the suite runner.
CI runs this case before the slower installer batches, retaining every former
update case without duplicate execution. A new cloud result is still required.
