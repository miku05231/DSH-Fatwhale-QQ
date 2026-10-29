# Windows updater verification (2026-10-29)

The application version remains 3.1.5. This source correction does not replace
the existing v3.1.5 tag or published assets.

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
corrected launch path, not an untouched 3.1.3 installation. The published 3.1.5
portable asset still contains the previous updater launch implementation.

## Privacy and broader test limits

A scan of 57 commits and 673 reachable public blobs up to 4 MiB found no exact
matches for qualifying sensitive live-configuration values or private IPv4
patterns. The official portable package checksum matched its published
manifest; inspection found no live configuration or private state payloads.
These checks are bounded scans, not a guarantee of absence of all personal data.

The earlier full suite had 79 passes and one intermittent image-generation UI
failure out of 80 tests. A subsequent isolated image-generation UI run passed
47 checks over six layouts, but its original intermittent cause remains open.
No full-suite green result is claimed here.
