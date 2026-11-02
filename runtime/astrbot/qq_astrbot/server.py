"""Authenticated supervisor. Native imports never enter this process."""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import secrets
import signal
import uuid
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

from .config import RuntimeConfig
from .generation import GenerationError, _contained, _terminate_and_reap, inspect_candidate, prepare_generation
from .processes import ProcessTree, python_child_launch


class Supervisor:
    def __init__(self, config: RuntimeConfig):
        self.config = config
        self.process = None
        self.worker_url = None
        self.worker_token = None
        self.generation = None
        self.frozen = False
        self.lock = asyncio.Lock()
        self.session = None
        self.stop_event = asyncio.Event()
        self.process_tree = None
        self.transitions: set[asyncio.Task] = set()

    def generation_path(self, params):
        generation_id = params.get("generationId")
        if not isinstance(generation_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", generation_id):
            raise ValueError("generation identifier is invalid")
        relative = params.get("generationPath", f"generations/{generation_id}")
        if relative != f"generations/{generation_id}":
            raise ValueError("generation path does not match its identifier")
        root = _contained(self.config.state_root, relative)
        if not root.is_dir() or not (root / "manager/plugins.json").is_file():
            raise ValueError("generation is unavailable")
        return root

    async def start(self):
        self.session = ClientSession(timeout=ClientTimeout(total=190), trust_env=False)

    async def activate(self, root: Path):
        if self.process and self.process.returncode is None and self.generation == root and not self.frozen:
            return {"active": True, "generationId": root.name}
        await self.stop_worker()
        self.worker_token = secrets.token_urlsafe(32)
        permitted = {"path", "systemroot", "windir", "pathext", "comspec", "home", "userprofile",
                     "temp", "tmp", "tmpdir", "lang", "lc_all", "tz"}
        environment = {key: value for key, value in os.environ.items() if key.lower() in permitted}
        environment.update({"QQ_ASTRBOT_HOST": self.config.host, "QQ_ASTRBOT_PORT": str(self.config.port),
                            "QQ_ASTRBOT_TOKEN": self.config.token,
                            "QQ_ASTRBOT_CALLBACK_URL": self.config.callback_url,
                            "QQ_ASTRBOT_ROOT": str(self.config.code_root),
                            "QQ_ASTRBOT_STATE_ROOT": str(self.config.state_root),
                            "QQ_ASTRBOT_ALLOW_NETWORK_BIND": "1" if self.config.network_bind_enabled else "0",
                            "QQ_ASTRBOT_MEDIA_ROOTS": os.pathsep.join(map(str, self.config.media_roots))})
        environment.update({"QQ_ASTRBOT_WORKER_TOKEN": self.worker_token,
                            "QQ_ASTRBOT_GENERATION_ROOT": str(root),
                            "ASTRBOT_ROOT": str(root), "PYTHONDONTWRITEBYTECODE": "1",
                            "PYTHONUNBUFFERED": "1", "PYTHONNOUSERSITE": "1",
                            "PYTHONPATH": os.pathsep.join([str(self.config.code_root)])})
        environment.pop("PYTHONHOME", None)
        options = {"creationflags": 0x08000000} if os.name == "nt" else {"start_new_session": True}
        python_executable, child_environment = python_child_launch(environment)
        self.process = await asyncio.create_subprocess_exec(
            python_executable, "-m", "qq_astrbot.worker", "--generation-root", str(root),
            cwd=self.config.code_root, env=child_environment,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=4096, **options,
        )
        try:
            self.process_tree = ProcessTree.for_subprocess(self.process)
            async with asyncio.timeout(150):
                ready = json.loads(await self.process.stdout.readline())
            port = ready.get("port")
            if ready.get("version") != 1 or ready.get("pid") != self.process.pid or type(port) is not int or not 1 <= port <= 65535:
                raise RuntimeError("invalid worker startup response")
            self.worker_url = f"http://127.0.0.1:{port}/rpc"
            self.generation = root
            self.frozen = False
            return {"active": True, "generationId": root.name}
        except BaseException:
            await self.stop_worker()
            raise RuntimeError("ASTRBOT_NATIVE_START_FAILED") from None

    async def forward(self, method, params):
        if not self.process or self.process.returncode is not None or not self.worker_url or self.frozen:
            raise RuntimeError("ASTRBOT_NATIVE_UNAVAILABLE")
        request_id = str(uuid.uuid4())
        async with self.session.post(self.worker_url, json={"version": 1, "id": request_id,
                                                          "method": method, "params": params},
                                     headers={"Authorization": f"Bearer {self.worker_token}"}) as response:
            raw = await response.content.read(16 * 1024 * 1024 + 1)
            if len(raw) > 16 * 1024 * 1024:
                raise RuntimeError("ASTRBOT_WORKER_RESPONSE_TOO_LARGE")
            value = json.loads(raw)
            if value.get("version") != 1 or value.get("id") != request_id or value.get("error"):
                raise RuntimeError(value.get("error", {}).get("code", "ASTRBOT_WORKER_PROTOCOL_ERROR"))
            return value.get("result")

    async def stop_worker(self):
        process = self.process
        if process is None:
            return
        clean = process.returncode == 0
        if process.returncode is None:
            try:
                # Keep the channel usable until the native shutdown is requested.
                self.frozen = False
                async with asyncio.timeout(5):
                    await self.forward("stop", {})
                async with asyncio.timeout(25):
                    await process.wait()
                clean = process.returncode == 0
            except Exception:
                pass
        self.frozen = True
        if os.name == "nt" and self.process_tree is None and process.returncode is None:
            await _terminate_and_reap(process)
        if process.returncode is None:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                process.terminate()
            try:
                async with asyncio.timeout(5):
                    await process.wait()
            except TimeoutError:
                if os.name != "nt":
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.kill()
                await process.wait()
        self.process = None
        self.worker_url = None
        if self.process_tree:
            self.process_tree.close()
            self.process_tree = None
        return clean

    async def invoke(self, method, params):
        if method == "health":
            running = bool(self.process and self.process.returncode is None
                           and self.worker_url and not self.frozen)
            return {"healthy": True, "ok": True, "version": "4.29.3", "rpcVersion": 1,
                    "running": running,
                    "workerPid": self.process.pid if running else None,
                    "generationId": self.generation.name if self.generation else None,
                    "status": "running" if running else "frozen" if self.frozen else "idle"}
        if method in {"dispatch", "cancel"}:
            return await self.forward(method, params)
        async with self.lock:
            if method == "generation.inspect":
                return inspect_candidate(self.config.state_root, params)
            if method == "generation.prepare":
                if self.process and self.process.returncode is None:
                    raise RuntimeError("ASTRBOT_GENERATION_NOT_FROZEN")
                return await prepare_generation(self.config.state_root, params)
            if method == "generation.freeze":
                requested = params.get("generationId")
                if self.generation and requested != self.generation.name:
                    raise ValueError("cannot freeze a different generation")
                clean = await self.stop_worker()
                if clean is False:
                    raise RuntimeError("ASTRBOT_GENERATION_UNCLEAN_SHUTDOWN")
                self.frozen = True
                return {"frozen": True, "generationId": requested}
            if method in {"generation.activate", "runtime.start", "generation.resume"}:
                root = self.generation_path(params)
                result = await self.activate(root)
                if method == "generation.resume":
                    result["resumed"] = True
                return result
            if method == "runtime.stop":
                await self.stop_worker()
                return {"stopped": True}
            raise ValueError("ASTRBOT_METHOD_UNKNOWN")

    async def close(self):
        # Finish any already authorized transition before shutting down. A lost
        # HTTP caller must not leave a half-stopped generation to be snapshotted.
        if self.transitions:
            await asyncio.gather(*self.transitions, return_exceptions=True)
        await self.stop_worker()
        if self.session:
            await self.session.close()


async def serve(config: RuntimeConfig):
    supervisor = Supervisor(config)
    await supervisor.start()

    async def rpc(request):
        if request.headers.get("Origin") or not hmac.compare_digest(
            request.headers.get("Authorization", ""), f"Bearer {config.token}"
        ):
            raise web.HTTPForbidden()
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            raise web.HTTPBadRequest() from None
        if not isinstance(body, dict) or body.get("version") != 1 or not isinstance(body.get("id"), str) or not isinstance(body.get("params", {}), dict):
            raise web.HTTPBadRequest()
        request_id = body["id"]
        try:
            method, params = body.get("method"), body.get("params", {})
            if method in {"health", "dispatch", "cancel", "generation.inspect"}:
                result = await supervisor.invoke(method, params)
            else:
                transition = asyncio.create_task(supervisor.invoke(method, params))
                supervisor.transitions.add(transition)
                def finished(task):
                    supervisor.transitions.discard(task)
                    if not task.cancelled():
                        task.exception()  # Retrieve failures even after a client disconnect.
                transition.add_done_callback(finished)
                result = await asyncio.shield(transition)
            return web.json_response({"version": 1, "id": request_id, "result": result})
        except GenerationError as error:
            return web.json_response({"version": 1, "id": request_id,
                                      "error": {"code": error.code, "message": str(error)}}, status=409)
        except Exception as error:
            # Never return exception strings from plugin imports, providers or dependencies.
            code = str(error) if re.fullmatch(r"ASTRBOT_[A-Z_]+", str(error)) else "ASTRBOT_RUNTIME_REQUEST_FAILED"
            return web.json_response({"version": 1, "id": request_id,
                                      "error": {"code": code}}, status=500)

    app = web.Application(client_max_size=16 * 1024 * 1024, handler_args={"handler_cancellation": True})
    app.router.add_post("/rpc", rpc)
    runner = web.AppRunner(app, access_log=None, shutdown_timeout=2)
    await runner.setup()
    site = web.TCPSite(runner, config.host, config.port)
    loop = asyncio.get_running_loop()
    for name in ("SIGINT", "SIGTERM"):
        try:
            loop.add_signal_handler(getattr(signal, name), supervisor.stop_event.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await site.start()
        if config.generation_root:
            # Managed launches include a generation; external containers boot idle.
            async with supervisor.lock:
                await supervisor.activate(config.generation_root)
        await supervisor.stop_event.wait()
    finally:
        await supervisor.close()
        await runner.cleanup()
