"""Offline regression for media upload names; no runtime or network is started."""
from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime/astrbot"))
from qq_astrbot.callback import CallbackError, NodeCallbackClient  # noqa: E402


class RecordingClient(NodeCallbackClient):
    def __init__(self):
        self.calls = []

    async def call(self, method, params):
        self.calls.append((method, params))
        return {"file": "astrbot-media://00000000-0000-4000-8000-000000000000." + params["extension"]}


class MediaUploadTests(unittest.IsolatedAsyncioTestCase):
    async def test_media_extensions_and_bytes_reach_node(self):
        for extension, expected in (("png", "png"), (".png", "png"), ("wav", "wav"), ("JPG", "jpg"), ("mp4", "mp4")):
            with self.subTest(extension=extension):
                client = RecordingClient()
                payload = b"offline fixture bytes"
                handle = await client.upload(payload, extension)
                method, params = client.calls[0]
                self.assertEqual(method, "media.put")
                self.assertEqual(params["extension"], expected)
                self.assertEqual(base64.b64decode(params["base64"]), payload)
                self.assertTrue(handle.endswith("." + expected))

    async def test_invalid_extension_uses_bin(self):
        for extension in ("", "../", "bad_name", "x" * 9, "非英文"):
            with self.subTest(extension=extension):
                client = RecordingClient()
                await client.upload(b"fixture", extension)
                self.assertEqual(client.calls[0][1]["extension"], "bin")

    async def test_empty_upload_never_calls_node(self):
        client = RecordingClient()
        with self.assertRaises(CallbackError):
            await client.upload(b"", "png")
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
