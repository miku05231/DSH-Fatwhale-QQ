# AstrBot runtime sources and notices

The optional runtime uses the unmodified AstrBot 4.29.3 distribution from
https://github.com/AstrBotDevs/AstrBot/tree/v4.29.3.
Its source archive is fixed in `../astrbot-lock.json` and `pyproject.toml` with
SHA-256 `4f7187273a3fa3e9bea327e1338dcff7567af5ab095c4847da12452ad22d8508`.

AstrBot is distributed under AGPL-3.0-or-later. The upstream license is retained
in `licenses/ASTRBOT-LICENSE`. Runtime installation also retains the downloaded
distribution metadata. The `qq_astrbot` package is the integration layer added
by this project; it registers a platform/provider and wraps native dispatch,
tools, and scheduling to enforce bridge permissions. It does not patch plugin
source files. It does not include AstrBot's dashboard or expose its HTTP UI.

Python's portable distribution and its included notices remain in the managed
Python directory. Docker uses the official Python image identified in the lock
file. Other Python packages retain their installed distribution metadata and
licenses; their measured versions and metadata hashes are written to
`dependency-inventory.json` by `qq_astrbot.inventory` during runtime installation
or image construction. These measurements do not constitute an archive hash
lock for transitive dependencies.

Plugin archives retain their own LICENSE, notices, metadata, and source files.
The manager records the source, selected ref, archive hash, tree hash, dependency
hash, and generation. The sample commit/archive/source hashes in
`../astrbot-samples.json` are reference inputs, not evidence of compatibility:
Windows, NAS, and real QQ acceptance remain pending.
