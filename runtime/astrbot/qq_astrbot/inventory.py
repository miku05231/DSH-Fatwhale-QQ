"""Write a measured inventory of the installed AstrBot runtime packages."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import sys
import tempfile
from pathlib import Path
from typing import Any


EXPECTED_ASTRBOT_VERSION = "4.29.3"
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class InventoryError(Exception):
    """Raised when an installed runtime inventory cannot be measured safely."""


def _distribution_file_bytes(
    distribution: importlib.metadata.Distribution, filename: str
) -> bytes | None:
    files = distribution.files
    if files is not None:
        for item in files:
            if item.name != filename:
                continue
            if not any(
                part.casefold().endswith((".dist-info", ".egg-info"))
                for part in item.parts[:-1]
            ):
                continue
            try:
                path = Path(distribution.locate_file(item))
                if path.is_file() and not path.is_symlink():
                    return path.read_bytes()
            except (OSError, TypeError, ValueError):
                continue
    return None


def _metadata_hash(
    distribution: importlib.metadata.Distribution,
) -> tuple[str, str]:
    for filename in ("RECORD", "METADATA", "PKG-INFO"):
        content = _distribution_file_bytes(distribution, filename)
        if content is None:
            try:
                text = distribution.read_text(filename)
            except (OSError, UnicodeError, ValueError):
                text = None
            if text is not None:
                content = text.encode("utf-8")
        if content is not None:
            return filename, hashlib.sha256(content).hexdigest()

    raise InventoryError("An installed distribution has no readable RECORD or metadata.")


def _direct_url_sha256(distribution: importlib.metadata.Distribution) -> str | None:
    try:
        raw = distribution.read_text("direct_url.json")
    except (OSError, UnicodeError, ValueError) as exc:
        raise InventoryError("Installed direct URL metadata could not be read.") from exc
    if raw is None:
        return None

    try:
        direct_url: Any = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise InventoryError("Installed direct URL metadata is invalid.") from exc
    if not isinstance(direct_url, dict):
        raise InventoryError("Installed direct URL metadata is invalid.")

    archive_info = direct_url.get("archive_info")
    if not isinstance(archive_info, dict):
        return None

    hashes = archive_info.get("hashes")
    value: Any = hashes.get("sha256") if isinstance(hashes, dict) else None
    if value is None:
        legacy_hash = archive_info.get("hash")
        if isinstance(legacy_hash, str) and legacy_hash.startswith("sha256="):
            value = legacy_hash[len("sha256=") :]
    if value is None:
        return None
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise InventoryError("Installed direct URL SHA-256 metadata is invalid.")
    return value.lower()


def _distribution_inventory(
    distribution: importlib.metadata.Distribution,
) -> dict[str, Any]:
    name = distribution.metadata.get("Name")
    version = distribution.version
    if not isinstance(name, str) or not name.strip() or not version:
        raise InventoryError("An installed distribution is missing its name or version.")

    hash_source, digest = _metadata_hash(distribution)
    return {
        "distName": name,
        "version": version,
        "recordOrMetadataHashSource": hash_source,
        "recordOrMetadataSHA256": digest,
        "directURLDownloadSHA256": _direct_url_sha256(distribution),
    }


def collect_inventory() -> dict[str, Any]:
    if sys.version_info[:2] != (3, 12):
        raise InventoryError("The AstrBot runtime inventory requires Python 3.12.")

    try:
        astrbot_version = importlib.metadata.version("AstrBot")
    except importlib.metadata.PackageNotFoundError as exc:
        raise InventoryError("AstrBot distribution metadata is not installed.") from exc
    if astrbot_version != EXPECTED_ASTRBOT_VERSION:
        raise InventoryError("Installed AstrBot version does not match the 4.29.3 baseline.")

    distributions = [
        _distribution_inventory(distribution)
        for distribution in importlib.metadata.distributions()
    ]
    distributions.sort(
        key=lambda item: (
            re.sub(r"[-_.]+", "-", item["distName"]).casefold(),
            item["version"],
            item["recordOrMetadataSHA256"],
        )
    )

    return {
        "schemaVersion": 1,
        "inventoryType": "measured-installed-runtime-distributions",
        "baseline": {
            "pythonVersion": platform.python_version(),
            "astrbotVersion": astrbot_version,
        },
        "transitivePackagesHashLocked": False,
        "hashScope": (
            "Hashes measure installed RECORD or metadata files; they are not package "
            "archive hashes and do not make dependency resolution reproducible."
        ),
        "distributionCount": len(distributions),
        "distributions": distributions,
    }


def _output_target(value: str) -> Path:
    requested = Path(value).expanduser()
    if not requested.is_absolute():
        requested = Path.cwd() / requested
    try:
        parent = requested.parent.resolve(strict=True)
    except OSError as exc:
        raise InventoryError("Output directory is unavailable.") from exc
    target = parent / requested.name
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise InventoryError("Output path must name a regular file and cannot be a symlink.")
    return target


def write_inventory(output: str) -> None:
    inventory = collect_inventory()
    target = _output_target(output)
    temporary_path: str | None = None
    try:
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
        )
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(inventory, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, target)
        temporary_path = None
    except (OSError, ValueError) as exc:
        raise InventoryError("Dependency inventory could not be written atomically.") from exc
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="Path for the JSON inventory.")
    arguments = parser.parse_args(argv)
    try:
        write_inventory(arguments.output)
    except (InventoryError, ValueError):
        print("Failed to write the runtime dependency inventory.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
