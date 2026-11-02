"""The active-send probe must preserve results, failures and private data."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime/astrbot"))
from qq_astrbot.diagnostics import configure_send_diagnostics, install_send_diagnostics


class SendDiagnosticsTests(unittest.TestCase):
    def exercise(self, result=True, error=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configure_send_diagnostics(root, {"fixture"})

            class Context:
                async def send_message(self, session, chain):
                    if error is not None:
                        raise error
                    return result

            install_send_diagnostics(Context)
            install_send_diagnostics(Context)
            namespace = {}
            source = "async def run(ctx): return await ctx.send_message('private-session-secret', 'private-body-secret')"
            exec(compile(source, str(root / "data/plugins/fixture/main.py"), "exec"), namespace)
            if error is not None:
                with self.assertRaises(type(error)) as caught:
                    asyncio.run(namespace["run"](Context()))
                self.assertIs(caught.exception, error)
            else:
                self.assertIs(asyncio.run(namespace["run"](Context())), result)
            raw = (root / "manager/runtime.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("secret", raw)
            records = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["plugins"], ["fixture"])
            return records[0]

    def test_success_is_preserved(self):
        self.assertEqual(self.exercise()["status"], "sent")

    def test_false_result_is_distinct_from_permission_failure(self):
        self.assertEqual(self.exercise(False)["errorCode"], "ASTRBOT_SEND_PLATFORM_UNMATCHED")

    def test_missing_provenance_is_explicit(self):
        error = PermissionError("durable broker provenance is unavailable")
        self.assertEqual(self.exercise(error=error)["errorCode"], "ASTRBOT_SEND_PROVENANCE_MISSING")

    def test_unknown_errors_do_not_expose_their_text(self):
        self.assertEqual(self.exercise(error=RuntimeError("private-exception-secret"))["errorCode"],
                         "ASTRBOT_SEND_FAILED")

    def test_non_string_error_codes_preserve_original_failure(self):
        error = RuntimeError("private-exception-secret")
        error.code = ["private-code-secret"]
        self.assertEqual(self.exercise(error=error)["errorCode"], "ASTRBOT_SEND_FAILED")

    def test_error_code_property_cannot_replace_original_failure(self):
        class UnusualError(RuntimeError):
            @property
            def code(self):
                raise ValueError("private-property-secret")

        self.assertEqual(self.exercise(error=UnusualError("private-error-secret"))["errorCode"],
                         "ASTRBOT_SEND_FAILED")


if __name__ == "__main__":
    unittest.main()
