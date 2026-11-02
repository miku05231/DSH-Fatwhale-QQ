from __future__ import annotations

import asyncio
import sys


def main():
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("AstrBot compatibility runtime requires managed Python 3.12.")
    from .config import RuntimeConfig
    from .server import serve
    asyncio.run(serve(RuntimeConfig.from_env()))


if __name__ == "__main__":
    main()
