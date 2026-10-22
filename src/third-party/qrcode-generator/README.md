# qrcode-generator 2.0.4

Vendored without modification from the npm package `qrcode-generator@2.0.4`.
Only upstream `dist/qrcode.mjs` is used, stored as `qrcode.mjs` so repository
build-output ignore rules do not exclude it. The MIT license is retained in `LICENSE`.

- Upstream: https://github.com/kazuhikoarase/qrcode-generator
- Package: https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-2.0.4.tgz
- npm SHA-512 integrity: `sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`
- `qrcode.mjs` SHA-256: `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`

Bilibili QR login protocol references checked on 2026-10-22:

- `bilibili-api-python` 17.4.2 source distribution, `bilibili_api/login_v2.py`
  and `bilibili_api/data/api/login.json`: Web generate/poll endpoints and states
  86101 (waiting), 86090 (scanned), 86038 (expired), 0 (confirmed).
- Distribution: https://pypi.org/project/bilibili-api-python/17.4.2/
- Anonymous live verification also confirmed the current generate response uses
  `https://account.bilibili.com/h5/account-h5/auth/scan-web`; both this exact
  host/path pair and the older passport scan pair are supported.

No login protocol source code is copied; the adapter implements the narrow HTTP
contract and uses the QR library only to render the returned login URL locally.
