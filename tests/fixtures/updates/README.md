# Legacy Update Helper

`install-update-v0.2.3.ps1` is an unmodified snapshot of
`scripts/install-update.ps1` from release `v0.2.3`, commit `777b149`.

SHA-256: `12d4985bcd81b394e6d9fbe451a8c8d51b195fccdbc643d80e4e416da66f0fa2`

`tests/release-update-test.mjs` runs this exact locally installed helper against
the newly generated portable ZIP, then repeats the installation with the current
helper. Keeping the snapshot offline makes the compatibility check independent
of network access and historical Git refs in shallow release checkouts.
