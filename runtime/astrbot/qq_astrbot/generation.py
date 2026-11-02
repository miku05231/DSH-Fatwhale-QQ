from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

from .processes import ProcessTree, python_child_launch


SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
EXPECTED_LAYOUT = {
    "plugins": "data/plugins",
    "pluginData": "data/plugin_data",
    "sitePackages": "data/site-packages",
    "manifest": "manager/plugins.json",
}
CORE_DISTRIBUTION = canonicalize_name("AstrBot")
MAX_REQUIREMENTS_BYTES = 1024 * 1024
MAX_REQUIREMENTS = 5000
DEFAULT_TIMEOUT_SECONDS = 600


class GenerationError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _is_link(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return path.is_symlink() or (callable(is_junction) and is_junction())


def _safe_relative(value: Any) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Generation path is invalid.")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Generation path is invalid.")
    return path


def _contained(root: Path, relative: str) -> Path:
    rel = _safe_relative(relative)
    root = root.resolve(strict=True)
    target = root.joinpath(*rel.parts)
    resolved = target.resolve(strict=False)
    if resolved != root and root not in resolved.parents:
        raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Generation path escapes the state root.")
    current = root
    for part in rel.parts:
        current = current / part
        if _is_link(current):
            raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Generation paths cannot contain symlinks.")
    return target


def _metadata(candidate: Path) -> dict[str, Any]:
    for name in ("metadata.yaml", "metadata.yml"):
        file_path = candidate / name
        if file_path.is_file() and not _is_link(file_path):
            try:
                import yaml

                value = yaml.safe_load(file_path.read_text("utf-8"))
            except Exception as exc:
                raise GenerationError("ASTRBOT_METADATA_INVALID", "Plugin metadata could not be parsed.") from exc
            if not isinstance(value, dict):
                break
            plugin_name = value.get("name")
            if not isinstance(plugin_name, str) or not SAFE_ID.fullmatch(plugin_name):
                raise GenerationError("ASTRBOT_METADATA_INVALID", "Plugin metadata has an invalid name.")
            return {
                "name": plugin_name,
                "version": str(value.get("version", "")),
                "author": str(value.get("author", "")),
                "display_name": str(value.get("display_name", "")),
                "desc": str(value.get("desc", "")),
            }
    raise GenerationError("ASTRBOT_METADATA_MISSING", "Plugin metadata.yaml was not found.")


def inspect_candidate(state_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    expected = params.get("expectedAstrbotVersion")
    if expected != "4.29.3":
        raise GenerationError("ASTRBOT_CORE_VERSION_MISMATCH", "Expected AstrBot version must be 4.29.3.")
    candidate = _contained(state_root, params.get("candidatePath"))
    if not candidate.is_dir() or _is_link(candidate):
        raise GenerationError("ASTRBOT_CANDIDATE_INVALID", "Plugin candidate directory is invalid.")
    metadata = _metadata(candidate)
    return {"metadataParsed": True, "metadata": metadata, "astrbotVersion": "4.29.3"}


def _site_package_digest(site_packages: Path) -> str:
    digest = hashlib.sha256()
    if not site_packages.is_dir() or _is_link(site_packages):
        raise GenerationError("ASTRBOT_DEPENDENCIES_MISSING", "Staged site-packages directory is missing.")
    for directory, child_directories, filenames in os.walk(site_packages, followlinks=False):
        base = Path(directory)
        child_directories.sort()
        filenames.sort()
        for child in child_directories:
            if _is_link(base / child):
                raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Staged site-packages cannot contain links.")
        for filename in filenames:
            item = base / filename
            if _is_link(item):
                raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Staged site-packages cannot contain links.")
            if not item.is_file():
                continue
            relative = item.relative_to(site_packages).as_posix().encode("utf-8")
            digest.update(len(relative).to_bytes(4, "big"))
            digest.update(relative)
            with item.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
    return digest.hexdigest()


def _validate_direct_url(requirement: Requirement) -> None:
    url = requirement.url
    if url is None:
        return
    if "\\" in url:
        raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "Plugin requirements contain an unsafe URL.")
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "Plugin requirement URL is invalid.") from exc
    if parsed.scheme.lower() not in {"https", "git+https"} or not parsed.hostname:
        raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "Only HTTPS package and VCS URLs are supported.")
    if parsed.username is not None or parsed.password is not None or parsed.query:
        raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "Credential-bearing or query URLs are not supported.")
    decoded_path = unquote(parsed.path)
    if "\\" in decoded_path or any(part == ".." for part in decoded_path.split("/")):
        raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "Package URL traversal is unsupported.")
    if parsed.fragment:
        if parsed.scheme.lower() == "https":
            if not re.fullmatch(r"sha256=[A-Fa-f0-9]{64}", parsed.fragment):
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "HTTPS package URL fragment is unsupported.")
        else:
            try:
                fragments = parse_qs(parsed.fragment, strict_parsing=True)
            except ValueError as exc:
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "VCS URL fragment is invalid.") from exc
            if set(fragments) != {"subdirectory"} or len(fragments["subdirectory"]) != 1:
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "VCS URL fragment is unsupported.")
            subdirectory = fragments["subdirectory"][0]
            subpath = PurePosixPath(subdirectory)
            if (
                not subdirectory
                or "\\" in subdirectory
                or subpath.is_absolute()
                or any(part in {"", ".", ".."} for part in subpath.parts)
            ):
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "VCS subdirectory is unsafe.")


def _plugin_requirements(stage_root: Path, entries: dict[str, Any]) -> list[str]:
    requirements: list[str] = []
    seen: set[str] = set()
    requirement_count = 0
    plugins = stage_root / "data" / "plugins"
    for plugin_id in entries:
        plugin_dir = plugins / plugin_id
        if not plugin_dir.is_dir() or _is_link(plugin_dir):
            raise GenerationError("ASTRBOT_PLUGIN_MISSING", "A manifest plugin directory is missing.")
        requirements_file = plugin_dir / "requirements.txt"
        if _is_link(requirements_file):
            raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "A plugin requirements file is invalid.")
        if not requirements_file.exists():
            continue
        if not requirements_file.is_file():
            raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "A plugin requirements file is invalid.")
        try:
            if requirements_file.stat().st_size > MAX_REQUIREMENTS_BYTES:
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "A plugin requirements file is too large.")
            lines = requirements_file.read_text("utf-8").splitlines()
        except GenerationError:
            raise
        except Exception as exc:
            raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "A plugin requirements file cannot be read.") from exc
        for raw_line in lines:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            line = re.split(r"\s+#", line, maxsplit=1)[0].strip()
            if not line or line.startswith("-") or "\\" in line:
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "Plugin requirement options and local paths are unsupported.")
            try:
                requirement = Requirement(line)
            except Exception as exc:
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "A plugin requirement is invalid.") from exc
            requirement_count += 1
            if requirement_count > MAX_REQUIREMENTS:
                raise GenerationError("ASTRBOT_REQUIREMENTS_INVALID", "The generation has too many requirements.")
            _validate_direct_url(requirement)
            if requirement.marker and not requirement.marker.evaluate():
                continue
            if canonicalize_name(requirement.name) == CORE_DISTRIBUTION:
                if requirement.url or not requirement.specifier.contains("4.29.3", prereleases=True):
                    raise GenerationError(
                        "ASTRBOT_CORE_VERSION_MISMATCH",
                        "Plugin requirements conflict with the pinned AstrBot 4.29.3 runtime.",
                    )
                # AstrBot is supplied by the shared runtime and must not be overlaid in the generation.
                continue
            normalized = str(requirement)
            if normalized not in seen:
                seen.add(normalized)
                requirements.append(normalized)
    return requirements


def _child_environment(stage_root: Path, site_packages: Path, work_dir: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for key in ("PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC"):
        value = os.environ.get(key)
        if value:
            env[key] = value
    adapter_path = str(Path(__file__).resolve().parents[1])
    isolated_work_dir = str(work_dir.resolve(strict=True))
    env.update(
        {
            "ASTRBOT_ROOT": str(stage_root.resolve(strict=True)),
            "PYTHONPATH": os.pathsep.join((str(site_packages.resolve()), adapter_path)),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PIP_CONFIG_FILE": os.devnull,
            "no_proxy": "localhost,127.0.0.1,::1",
            "HOME": isolated_work_dir,
            "TEMP": isolated_work_dir,
            "TMP": isolated_work_dir,
            "TMPDIR": isolated_work_dir,
            "USERPROFILE": isolated_work_dir,
        }
    )
    for key in ("APPDATA", "LOCALAPPDATA"):
        if os.name == "nt":
            env[key] = isolated_work_dir
    return env


def _has_core_overlay(site_packages: Path) -> bool:
    try:
        if any(
            canonicalize_name(distribution.metadata.get("Name", "")) == CORE_DISTRIBUTION
            for distribution in importlib.metadata.distributions(path=[str(site_packages)])
        ):
            return True
    except Exception:
        return True
    return any(
        (site_packages / module).exists() or _is_link(site_packages / module)
        for module in ("astrbot", "astrbot.py", "qq_astrbot", "qq_astrbot.py")
    )


def _has_distribution_overlay(site_packages: Path, distribution_name: str) -> bool:
    try:
        return any(
            canonicalize_name(distribution.metadata.get("Name", "")) == canonicalize_name(distribution_name)
            for distribution in importlib.metadata.distributions(path=[str(site_packages)])
        )
    except Exception:
        return True


def _append_validation_log(manager_dir: Path, event: str) -> None:
    log_path = manager_dir / "validation.log"
    if _is_link(log_path):
        raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Validation log cannot be a symlink.")
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with log_path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(f"{timestamp} {event}\n")


async def _terminate_and_reap(process: asyncio.subprocess.Process) -> None:
    if os.name == "nt":
        if process.returncode is None:
            killer: asyncio.subprocess.Process | None = None
            try:
                killer = await asyncio.create_subprocess_exec(
                    "taskkill.exe",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    env={
                        key: value
                        for key in ("PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC")
                        if (value := os.environ.get(key))
                    },
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(killer.wait(), timeout=10)
            except Exception:
                if killer is not None and killer.returncode is None:
                    try:
                        killer.kill()
                    except ProcessLookupError:
                        pass
                    await killer.wait()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()


async def _run_child(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: int,
    manager_dir: Path,
    event: str,
) -> bool:
    spawn_options: dict[str, Any] = {}
    if os.name == "nt":
        spawn_options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        spawn_options["start_new_session"] = True
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(cwd),
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            **spawn_options,
        )
    except Exception:
        _append_validation_log(manager_dir, f"{event}_spawn_failed")
        return False

    try:
        process_tree = ProcessTree.for_subprocess(process)
    except Exception:
        await _terminate_and_reap(process)
        _append_validation_log(manager_dir, f"{event}_process_tree_unavailable")
        return False

    return_code: int | None = None
    timed_out = False
    cancelled: asyncio.CancelledError | None = None
    close_failed = False
    try:
        return_code = await asyncio.wait_for(process.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
    except asyncio.CancelledError as exc:
        cancelled = exc
    finally:
        try:
            process_tree.close()
        except Exception:
            close_failed = True
        if close_failed:
            await _terminate_and_reap(process)
        elif process.returncode is None:
            await process.wait()

    if cancelled is not None:
        _append_validation_log(manager_dir, f"{event}_cancelled")
        raise cancelled
    if close_failed:
        _append_validation_log(manager_dir, f"{event}_process_tree_close_failed")
        return False
    if timed_out:
        _append_validation_log(manager_dir, f"{event}_timeout")
        return False
    if return_code != 0:
        _append_validation_log(manager_dir, f"{event}_failed")
        return False
    _append_validation_log(manager_dir, f"{event}_succeeded")
    return True


async def _native_core_check(
    stage_root: Path,
    site_packages: Path,
    cwd: Path,
    manager_dir: Path,
    timeout: int,
) -> bool:
    script = (
        "import importlib.metadata, astrbot; "
        "assert importlib.metadata.version('AstrBot') == '4.29.3'; "
        "assert importlib.metadata.version('APScheduler') == '3.11.3'; "
        "from astrbot.core.platform.platform import Platform; "
        "from astrbot.core.platform.astr_message_event import AstrMessageEvent; "
        "from astrbot.core.provider.provider import Provider; "
        "from astrbot.core.provider.entities import LLMResponse; "
        "from astrbot.core.message.components import Image, Record; "
        "from astrbot.core.astr_agent_tool_exec import FunctionToolExecutor; "
        "assert all((Platform, AstrMessageEvent, Provider, LLMResponse, Image, Record, FunctionToolExecutor))"
    )
    executable, env = python_child_launch(_child_environment(stage_root, site_packages, cwd))
    return await _run_child(
        [executable, "-c", script],
        cwd=cwd,
        env=env,
        timeout=timeout,
        manager_dir=manager_dir,
        event="core_validation",
    )


async def _validate_plugins(
    stage_root: Path,
    site_packages: Path,
    cwd: Path,
    manager_dir: Path,
    timeout: int,
) -> bool:
    executable, env = python_child_launch(_child_environment(stage_root, site_packages, cwd))
    return await _run_child(
        [
            executable,
            "-m",
            "qq_astrbot.validate",
            "--generation-root",
            str(stage_root.resolve(strict=True)),
        ],
        cwd=cwd,
        env=env,
        timeout=timeout,
        manager_dir=manager_dir,
        event="plugin_validation",
    )


def _restore_site_packages(site_packages: Path, backup: Path, transaction_dir: Path) -> None:
    if site_packages.exists() or _is_link(site_packages):
        rejected = transaction_dir / "rejected-site-packages"
        if rejected.exists() or _is_link(rejected):
            shutil.rmtree(rejected, ignore_errors=True)
        site_packages.rename(rejected)
    if backup.exists():
        backup.rename(site_packages)


def _result(
    *,
    metadata_parsed: bool,
    dependencies_installed: bool,
    native_validated: bool,
    core_validated: bool,
    dependency_sha256: str,
    plugin_count: int,
) -> dict[str, Any]:
    return {
        "valid": metadata_parsed and dependencies_installed and native_validated and core_validated,
        "astrbotVersion": "4.29.3",
        "metadataParsed": metadata_parsed,
        "dependenciesInstalled": dependencies_installed,
        "nativeValidated": native_validated,
        "coreValidated": core_validated,
        "dependencySHA256": dependency_sha256,
        "pluginCount": plugin_count,
    }


async def prepare_generation(state_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    if params.get("schemaVersion") != 1 or params.get("expectedAstrbotVersion") != "4.29.3":
        raise GenerationError("ASTRBOT_GENERATION_PROTOCOL", "Generation protocol or AstrBot version is unsupported.")
    generation_id = params.get("generationId")
    if not isinstance(generation_id, str) or not SAFE_ID.fullmatch(generation_id):
        raise GenerationError("ASTRBOT_GENERATION_ID_INVALID", "Generation identifier is invalid.")
    stage_path = params.get("stagePath")
    expected_stage = "staging/generations/" + generation_id
    if stage_path != expected_stage:
        raise GenerationError("ASTRBOT_GENERATION_PATH_INVALID", "Staging path does not match the generation identifier.")
    stage_root = _contained(state_root, stage_path)
    if not stage_root.is_dir() or _is_link(stage_root):
        raise GenerationError("ASTRBOT_GENERATION_MISSING", "Staging generation does not exist.")
    if params.get("layout") != EXPECTED_LAYOUT:
        raise GenerationError("ASTRBOT_GENERATION_LAYOUT_INVALID", "Generation layout does not match the supported schema.")
    timeout = params.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS)
    if type(timeout) is not int or not 1 <= timeout <= 1800:
        raise GenerationError("ASTRBOT_GENERATION_PROTOCOL", "Generation timeout is invalid.")

    manager_dir = stage_root / "manager"
    data_dir = stage_root / "data"
    plugins_dir = data_dir / "plugins"
    plugin_data_dir = data_dir / "plugin_data"
    site_packages = data_dir / "site-packages"
    manifest_path = manager_dir / "plugins.json"
    for directory in (manager_dir, data_dir, plugins_dir, plugin_data_dir, site_packages):
        if not directory.is_dir() or _is_link(directory):
            raise GenerationError("ASTRBOT_GENERATION_INCOMPLETE", "Generation directories are incomplete.")
    if _is_link(manifest_path) or not manifest_path.is_file():
        raise GenerationError("ASTRBOT_GENERATION_INCOMPLETE", "Generation manifest is missing.")
    try:
        manifest = json.loads(manifest_path.read_text("utf-8"))
    except Exception as exc:
        raise GenerationError("ASTRBOT_MANIFEST_INVALID", "Generation manifest is invalid.") from exc
    entries = manifest.get("plugins") if isinstance(manifest, dict) else None
    if not isinstance(entries, dict):
        raise GenerationError("ASTRBOT_MANIFEST_INVALID", "Generation manifest is invalid.")
    for plugin_id, entry in entries.items():
        if not isinstance(plugin_id, str) or not SAFE_ID.fullmatch(plugin_id) or not isinstance(entry, dict):
            raise GenerationError("ASTRBOT_MANIFEST_INVALID", "Generation manifest contains an invalid plugin entry.")
        plugin_dir = plugins_dir / plugin_id
        if not plugin_dir.is_dir() or _is_link(plugin_dir):
            raise GenerationError("ASTRBOT_PLUGIN_MISSING", "A manifest plugin directory is missing.")
        _metadata(plugin_dir)

    candidate_path = params.get("candidatePath")
    if candidate_path:
        candidate = _contained(state_root, candidate_path)
        candidate_metadata = _metadata(candidate)
        if candidate_metadata["name"] not in entries:
            raise GenerationError("ASTRBOT_PLUGIN_METADATA_MISMATCH", "Candidate plugin is absent from the staged manifest.")
        candidate_dir = plugins_dir / candidate_metadata["name"]
        if _metadata(candidate_dir)["name"] != candidate_metadata["name"]:
            raise GenerationError("ASTRBOT_PLUGIN_METADATA_MISMATCH", "Staged plugin metadata does not match the candidate.")

    requirements = _plugin_requirements(stage_root, entries)
    _append_validation_log(manager_dir, "generation_preparation_started")

    transaction_dir = Path(tempfile.mkdtemp(prefix=".generation-", dir=data_dir))
    pending_site = transaction_dir / "site-packages"
    requirements_file = transaction_dir / "requirements.txt"
    backup_site = transaction_dir / "previous-site-packages"
    committed = False
    keep_committed = False
    try:
        pending_site.mkdir()
        requirements_file.write_text("\n".join(requirements) + ("\n" if requirements else ""), encoding="utf-8")
        executable, env = python_child_launch(_child_environment(stage_root, pending_site, transaction_dir))
        install_ok = True
        if requirements:
            install_ok = await _run_child(
                [
                    executable,
                    "-m",
                    "pip",
                    "install",
                    "--target",
                    str(pending_site.resolve()),
                    "--requirement",
                    str(requirements_file.resolve()),
                    "--no-input",
                    "--no-cache-dir",
                    "--disable-pip-version-check",
                ],
                cwd=transaction_dir,
                env=env,
                timeout=timeout,
                manager_dir=manager_dir,
                event="dependency_install",
            )
        else:
            _append_validation_log(manager_dir, "dependency_install_skipped_no_requirements")

        if install_ok and _has_distribution_overlay(pending_site, "pip"):
            _append_validation_log(manager_dir, "pip_distribution_overlay_rejected")
            install_ok = False

        check_ok = False
        if install_ok:
            check_ok = await _run_child(
                [executable, "-m", "pip", "check"],
                cwd=transaction_dir,
                env=env,
                timeout=min(timeout, 180),
                manager_dir=manager_dir,
                event="dependency_check",
            )

        if install_ok and check_ok and _has_core_overlay(pending_site):
            _append_validation_log(manager_dir, "core_distribution_overlay_rejected")
            core_validated = await _native_core_check(
                stage_root, site_packages, transaction_dir, manager_dir, min(timeout, 90)
            )
            digest = _site_package_digest(site_packages)
            _append_validation_log(manager_dir, "generation_preparation_failed")
            return _result(
                metadata_parsed=True,
                dependencies_installed=False,
                native_validated=False,
                core_validated=core_validated,
                dependency_sha256=digest,
                plugin_count=len(entries),
            )

        if not install_ok or not check_ok:
            core_validated = await _native_core_check(
                stage_root, site_packages, transaction_dir, manager_dir, min(timeout, 90)
            )
            digest = _site_package_digest(site_packages)
            _append_validation_log(manager_dir, "generation_preparation_failed")
            return _result(
                metadata_parsed=True,
                dependencies_installed=False,
                native_validated=False,
                core_validated=core_validated,
                dependency_sha256=digest,
                plugin_count=len(entries),
            )

        try:
            _site_package_digest(pending_site)
        except GenerationError:
            _append_validation_log(manager_dir, "dependency_tree_invalid")
            _append_validation_log(manager_dir, "generation_preparation_failed")
            digest = _site_package_digest(site_packages)
            return _result(
                metadata_parsed=True,
                dependencies_installed=False,
                native_validated=False,
                core_validated=False,
                dependency_sha256=digest,
                plugin_count=len(entries),
            )

        core_validated = await _native_core_check(
            stage_root, pending_site, transaction_dir, manager_dir, min(timeout, 90)
        )
        if not core_validated:
            digest = _site_package_digest(site_packages)
            _append_validation_log(manager_dir, "generation_preparation_failed")
            return _result(
                metadata_parsed=True,
                dependencies_installed=False,
                native_validated=False,
                core_validated=False,
                dependency_sha256=digest,
                plugin_count=len(entries),
            )

        site_packages.rename(backup_site)
        try:
            pending_site.rename(site_packages)
        except Exception:
            backup_site.rename(site_packages)
            raise
        committed = True

        native_validated = await _validate_plugins(
            stage_root, site_packages, transaction_dir, manager_dir, timeout
        )
        if not native_validated:
            _restore_site_packages(site_packages, backup_site, transaction_dir)
            committed = False
            digest = _site_package_digest(site_packages)
            _append_validation_log(manager_dir, "generation_preparation_failed")
            return _result(
                metadata_parsed=True,
                dependencies_installed=False,
                native_validated=False,
                core_validated=True,
                dependency_sha256=digest,
                plugin_count=len(entries),
            )

        dependency_sha256 = _site_package_digest(site_packages)
        _append_validation_log(manager_dir, "generation_preparation_succeeded")
        keep_committed = True
        return _result(
            metadata_parsed=True,
            dependencies_installed=True,
            native_validated=True,
            core_validated=True,
            dependency_sha256=dependency_sha256,
            plugin_count=len(entries),
        )
    finally:
        if committed and not keep_committed:
            _restore_site_packages(site_packages, backup_site, transaction_dir)
        shutil.rmtree(transaction_dir, ignore_errors=True)
