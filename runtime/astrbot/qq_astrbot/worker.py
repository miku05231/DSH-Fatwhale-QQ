"""One native AstrBot process per generation, behind the supervisor's RPC."""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
import signal
import sys
from pathlib import Path


async def run(root: Path, protocol):
    from aiohttp import web
    from .config import RuntimeConfig
    from .core import NativeCore

    config = RuntimeConfig.from_env()
    worker_token = os.environ["QQ_ASTRBOT_WORKER_TOKEN"]
    shutdown = asyncio.Event()
    core = NativeCore(root, config)
    await core.initialize()

    async def rpc(request):
        if request.headers.get("Origin") or not hmac.compare_digest(
            request.headers.get("Authorization", ""), f"Bearer {worker_token}"
        ):
            raise web.HTTPForbidden()
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("id"), str):
            raise web.HTTPBadRequest()
        request_id = body.get("id")
        if body.get("version") != 1 or not isinstance(body.get("params", {}), dict):
            raise web.HTTPBadRequest()
        method, params = body.get("method"), body.get("params", {})
        try:
            if method == "dispatch":
                result = await core.dispatch(params)
            elif method == "cancel":
                result = core.cancel(params.get("contextId"))
            elif method == "stop":
                core.accepting = False
                shutdown.set()
                result = {"stopping": True}
            else:
                return web.json_response({"version": 1, "id": request_id,
                                          "error": {"code": "ASTRBOT_METHOD_UNKNOWN"}}, status=400)
            return web.json_response({"version": 1, "id": request_id, "result": result})
        except asyncio.CancelledError:
            return web.json_response({"version": 1, "id": request_id,
                                      "error": {"code": "ASTRBOT_CANCELLED"}}, status=409)
        except Exception:
            return web.json_response({"version": 1, "id": request_id,
                                      "error": {"code": "ASTRBOT_WORKER_REQUEST_FAILED"}}, status=500)

    app = web.Application(client_max_size=16 * 1024 * 1024,
                          handler_args={"handler_cancellation": True})
    app.router.add_post("/rpc", rpc)
    runner = web.AppRunner(app, access_log=None, shutdown_timeout=2)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    protocol.write(json.dumps({"version": 1, "port": port, "pid": os.getpid()}) + "\n")
    protocol.flush()
    loop = asyncio.get_running_loop()
    for name in ("SIGINT", "SIGTERM"):
        try:
            loop.add_signal_handler(getattr(signal, name), shutdown.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        shutdown_task = asyncio.create_task(shutdown.wait())
        try:
            done, _ = await asyncio.wait((shutdown_task, core.run_task),
                                         return_when=asyncio.FIRST_COMPLETED)
            if core.run_task in done and not shutdown.is_set():
                raise RuntimeError("ASTRBOT_NATIVE_LIFECYCLE_STOPPED")
        finally:
            shutdown_task.cancel()
            await asyncio.gather(shutdown_task, return_exceptions=True)
        # Stop native tasks and close SQLite before a freeze can be acknowledged.
    finally:
        try:
            await core.stop()
        finally:
            await runner.cleanup()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--generation-root", type=Path, required=True)
    args = parser.parse_args()
    protocol = sys.stdout
    with open(os.devnull, "w", encoding="utf-8") as sink:
        sys.stdout = sys.stderr = sink
        try:
            asyncio.run(run(args.generation_root, protocol))
        except BaseException:
            raise SystemExit(1) from None


if __name__ == "__main__":
    main()
