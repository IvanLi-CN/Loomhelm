"""Exercise pinned Markdown download retries and fail-closed validation."""

import hashlib
from http.client import IncompleteRead
import importlib.util
import io
from pathlib import Path
import socket
import unittest
from urllib.error import HTTPError
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".agents/skills/markdown-style/assets/scripts/markdown.py"
SPEC = importlib.util.spec_from_file_location("markdown_tools", SCRIPT)
MARKDOWN = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MARKDOWN)


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.payload


class MarkdownDownloadTests(unittest.TestCase):
    def resource(self, payload):
        return {
            "url": "https://example.test/tool",
            "sha256": hashlib.sha256(payload).hexdigest(),
        }

    def http_error(self, status):
        return HTTPError(
            "https://example.test/tool",
            status,
            "Gateway failure",
            hdrs=None,
            fp=None,
        )

    def raise_http_error(self, status):
        error = self.http_error(status)
        try:
            raise error
        finally:
            error.close()

    def test_transient_http_failure_is_retried(self):
        payload = b"verified tool archive"
        outcomes = [self.http_error(504) for _ in range(4)] + [Response(payload)]
        calls = []
        sleeps = []

        def opener(url, timeout):
            calls.append((url, timeout))
            outcome = outcomes.pop(0)
            if isinstance(outcome, BaseException):
                try:
                    raise outcome
                finally:
                    outcome.close()
            return outcome

        self.assertEqual(
            MARKDOWN.download(self.resource(payload), opener=opener, sleeper=sleeps.append),
            payload,
        )
        self.assertEqual(len(calls), 5)
        self.assertEqual(sleeps, [1, 2, 4, 8])

    def test_exhausted_transient_failure_propagates(self):
        calls = []

        def opener(url, timeout):
            calls.append((url, timeout))
            self.raise_http_error(504)

        with self.assertRaisesRegex(MARKDOWN.ToolError, r"after 5 attempts"):
            MARKDOWN.download(self.resource(b"never received"), opener=opener, sleeper=lambda _: None)
        self.assertEqual(len(calls), 5)

    def test_permanent_http_failure_is_not_retried(self):
        calls = []

        def opener(url, timeout):
            calls.append((url, timeout))
            self.raise_http_error(404)

        with self.assertRaisesRegex(MARKDOWN.ToolError, r"HTTP Error 404"):
            MARKDOWN.download(self.resource(b"not found"), opener=opener, sleeper=lambda _: None)
        self.assertEqual(len(calls), 1)

    def test_truncated_response_is_retried(self):
        payload = b"verified after truncation"
        outcomes = [IncompleteRead(b"partial"), Response(payload)]
        calls = []

        def opener(url, timeout):
            calls.append((url, timeout))
            outcome = outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        self.assertEqual(
            MARKDOWN.download(self.resource(payload), opener=opener, sleeper=lambda _: None),
            payload,
        )
        self.assertEqual(len(calls), 2)

    def test_socket_timeout_is_retried(self):
        payload = b"verified after socket timeout"
        outcomes = [socket.timeout("read timed out"), Response(payload)]
        calls = []

        def opener(url, timeout):
            calls.append((url, timeout))
            outcome = outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        self.assertEqual(
            MARKDOWN.download(self.resource(payload), opener=opener, sleeper=lambda _: None),
            payload,
        )
        self.assertEqual(len(calls), 2)

    def test_archive_hash_mismatch_remains_fail_closed(self):
        payload = b"unexpected archive"
        resource = self.resource(b"expected archive")
        calls = []

        def opener(url, timeout):
            calls.append((url, timeout))
            return Response(payload)

        with self.assertRaisesRegex(MARKDOWN.ToolError, "Official download SHA256 mismatch"):
            MARKDOWN.download(resource, opener=opener, sleeper=lambda _: None)
        self.assertEqual(len(calls), 1)

    def test_native_binary_hash_mismatch_remains_fail_closed(self):
        binary = b"unexpected native binary"
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("tool", binary)
        payload = archive.getvalue()
        resource = {
            "url": "https://example.test/tool.zip",
            "sha256": hashlib.sha256(payload).hexdigest(),
            "binary_sha256": hashlib.sha256(b"expected native binary").hexdigest(),
            "format": "zip",
            "member": "tool",
        }

        def opener(url, timeout):
            return Response(payload)

        with self.assertRaisesRegex(MARKDOWN.ToolError, "Native binary SHA256 mismatch"):
            MARKDOWN.download(resource, opener=opener, sleeper=lambda _: None)


if __name__ == "__main__":
    unittest.main()
