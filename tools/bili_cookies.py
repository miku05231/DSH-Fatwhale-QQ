#!/usr/bin/env python3
"""Extract bilibili cookies from a Chromium profile (Chrome/Edge) on Windows.

Usage: python bili_cookies.py [chrome|edge] [--json]
Outputs SESSDATA / bili_jct / buvid3 / DedeUserID etc. so the bili tool can
call api.bilibili.com with the user's real login.
"""
import base64
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from ctypes import wintypes

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:
    AESGCM = None

PROFILES = {
    "chrome": os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data"),
    "edge": os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data"),
}
PROFILE_DIRS = ["Default"] + [f"Profile {i}" for i in range(1, 12)] + ["Guest Profile"]
COOKIE_NAMES = ("SESSDATA", "bili_jct", "buvid3", "DedeUserID", "DedeUserID__ckMd5", "sid")
ERROR_PRIORITY = {
    "browser_profile_not_found": 0,
    "bilibili_login_not_found": 1,
    "cookie_database_unreadable": 2,
    "cookie_decryption_failed": 3,
    "cookie_crypto_unavailable": 4,
    "cookie_database_locked": 5,
    "cookie_app_bound_unsupported": 6,
}


class CookieError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi_decrypt(data: bytes) -> bytes:
    if not hasattr(ctypes, "windll"):
        raise CookieError("cookie_crypto_unavailable")
    in_blob = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)),
                                               ctypes.POINTER(ctypes.c_char)))
    out_blob = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
        raise CookieError("cookie_decryption_failed")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def master_key(user_data: str) -> bytes:
    try:
        state_path = os.path.join(user_data, "Local State")
        with open(state_path, "r", encoding="utf-8") as stream:
            state = json.load(stream)
        encrypted = base64.b64decode(state["os_crypt"]["encrypted_key"], validate=True)
        if not encrypted.startswith(b"DPAPI"):
            raise CookieError("cookie_decryption_failed")
        key = dpapi_decrypt(encrypted[5:])
        if len(key) not in (16, 24, 32):
            raise CookieError("cookie_decryption_failed")
        return key
    except CookieError:
        raise
    except Exception:
        raise CookieError("cookie_decryption_failed") from None


def decrypt_value(blob: bytes, key: bytes, host: str = "", version: int = 0) -> str:
    if blob[:3] == b"v20":
        raise CookieError("cookie_app_bound_unsupported")
    try:
        if blob[:3] in (b"v10", b"v11"):
            if AESGCM is None:
                raise CookieError("cookie_crypto_unavailable")
            if len(blob) < 31:
                raise CookieError("cookie_decryption_failed")
            clear = AESGCM(key).decrypt(blob[3:15], blob[15:], None)
        else:
            # Older Chromium stores a DPAPI blob, not UTF-8 plaintext, here.
            clear = dpapi_decrypt(blob)
        if version >= 24:
            digest = hashlib.sha256(host.encode("utf-8")).digest()
            if len(clear) < len(digest) or clear[:len(digest)] != digest:
                raise CookieError("cookie_decryption_failed")
            clear = clear[len(digest):]
        return clear.decode("utf-8")
    except CookieError:
        raise
    except Exception:
        raise CookieError("cookie_decryption_failed") from None


def database_error(error):
    code = getattr(error, "sqlite_errorcode", 0) or 0
    if (getattr(error, "winerror", None) in (32, 33)
            or getattr(error, "errno", None) == errno.EBUSY
            or code & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
            or "database is locked" in str(error).lower()
            or "database table is locked" in str(error).lower()):
        return CookieError("cookie_database_locked")
    return CookieError("cookie_database_unreadable")


def read_profile_database(database):
    # Unique directories prevent simultaneous imports from sharing or deleting snapshots.
    with tempfile.TemporaryDirectory(prefix="qq-bili-cookies-") as directory:
        snapshot = os.path.join(directory, "Cookies")
        connection = None
        try:
            shutil.copy2(database, snapshot)
            wal = f"{database}-wal"
            if os.path.isfile(wal):
                try:
                    shutil.copy2(wal, f"{snapshot}-wal")
                except FileNotFoundError:
                    pass
            connection = sqlite3.connect(Path(snapshot).as_uri() + "?mode=ro", uri=True, timeout=0)
            try:
                row = connection.execute("SELECT value FROM meta WHERE key='version'").fetchone()
                version = int(row[0]) if row else 0
            except sqlite3.OperationalError as error:
                if "no such table: meta" not in str(error):
                    raise
                version = 0
            placeholders = ",".join("?" for _ in COOKIE_NAMES)
            rows = connection.execute(
                "SELECT host_key,name,encrypted_value,value FROM cookies "
                "WHERE (host_key='bilibili.com' OR host_key LIKE '%.bilibili.com') "
                f"AND name IN ({placeholders})", COOKIE_NAMES).fetchall()
            return version, rows
        except CookieError:
            raise
        except Exception as error:
            raise database_error(error) from None
        finally:
            if connection is not None:
                connection.close()


def read_cookies(profile: str):
    if profile not in PROFILES or not os.path.isdir(PROFILES[profile]):
        raise CookieError("browser_profile_not_found")
    user_data = PROFILES[profile]
    key = None
    errors = []
    found_database = False
    for pdir in PROFILE_DIRS:
        db = os.path.join(user_data, pdir, "Network", "Cookies")
        if not os.path.isfile(db):
            db = os.path.join(user_data, pdir, "Cookies")
            if not os.path.isfile(db):
                continue
        found_database = True
        try:
            version, rows = read_profile_database(db)
        except CookieError as error:
            errors.append(error.code)
            continue
        if not rows:
            continue
        out = {}
        profile_errors = []
        for host, name, encrypted, plaintext in rows:
            domain = str(host).lower().lstrip(".")
            if domain != "bilibili.com" and not domain.endswith(".bilibili.com"):
                continue
            try:
                blob = bytes(encrypted or b"")
                if blob[:3] in (b"v10", b"v11") and key is None:
                    if AESGCM is None:
                        raise CookieError("cookie_crypto_unavailable")
                    key = master_key(user_data)
                val = decrypt_value(blob, key, host, version) if blob else str(plaintext or "")
            except CookieError as error:
                profile_errors.append(error.code)
                continue
            except Exception:
                profile_errors.append("cookie_decryption_failed")
                continue
            if val:
                out.setdefault(name, val)
        if out.get("SESSDATA") and out.get("bili_jct"):
            return pdir, out
        errors.extend(profile_errors)
    if errors:
        raise CookieError(max(errors, key=lambda code: ERROR_PRIORITY[code]))
    raise CookieError("bilibili_login_not_found" if found_database else "browser_profile_not_found")


def main():
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    wanted = args[0] if args else "chrome"
    try:
        if len(args) > 1:
            raise CookieError("browser_profile_not_found")
        pdir, cookies = read_cookies(wanted)
        keep = {key: cookies[key] for key in COOKIE_NAMES if key in cookies}
        if as_json:
            print(json.dumps({"profile": wanted, "dir": pdir, "cookies": keep}, ensure_ascii=False))
        else:
            print(f"profile={wanted} dir={pdir}")
            for key, value in keep.items():
                print(f"{key}={value}")
        return 0
    except CookieError as error:
        code = error.code
    except Exception:
        code = "cookie_database_unreadable"
    print(json.dumps({"error": code}) if as_json else code)
    return 1


if __name__ == "__main__":
    sys.exit(main())
