# Legacy Update Helpers

`install-update-v0.2.3.ps1` is an unmodified snapshot of
`scripts/install-update.ps1` from release `v0.2.3`, commit `777b149`.

SHA-256: `12d4985bcd81b394e6d9fbe451a8c8d51b195fccdbc643d80e4e416da66f0fa2`

`install-update-v3.1.5.ps1` is an unmodified snapshot of the same script from
release v3.1.5, commit `91ab30b3aa5b2a5b2a4934e913e771ce4dfafa43`.

SHA-256: `326c1fb1f06aecc32e9335e175e12ed14e4b1cd3fb9b9beabd2c216abcc7fee4`

`tests/release-update-test.mjs` runs both exact old helpers against the newly
generated portable ZIP and verifies that they reject the added runtime paths
before staging, while preserving the installed application and local data. It
then verifies installation with the current helper. Offline snapshots make these
checks independent of network access and historical refs in shallow CI checkouts.
