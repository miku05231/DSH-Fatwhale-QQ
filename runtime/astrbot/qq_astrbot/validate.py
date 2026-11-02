"""Staged native loading. Does not dispatch messages, start cron or invoke tools."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path


async def validate(root: Path) -> None:
    from .core import NativeCore
    core = NativeCore(root, validation=True)
    try:
        await core.initialize()
    finally:
        await core.stop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--generation-root", type=Path, required=True)
    args = parser.parse_args()
    # Third-party import-time output may contain configuration values.
    with open(__import__("os").devnull, "w", encoding="utf-8") as sink:
        original_out, original_err = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = sink
        try:
            asyncio.run(validate(args.generation_root))
        except BaseException:
            original_err.write(json.dumps({"error": "ASTRBOT_PLUGIN_NATIVE_LOAD_FAILED"}) + "\n")
            raise SystemExit(1) from None
        finally:
            sys.stdout, sys.stderr = original_out, original_err


if __name__ == "__main__":
    main()
