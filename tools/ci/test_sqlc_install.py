"""Exercise the pinned sqlc installer against a transient HTTP failure."""

from __future__ import annotations

import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[2]
SQLC_VERSION = "1.31.1"


def sqlc_archive() -> bytes:
    payload = b"#!/bin/sh\nprintf '%s\\n' '1.31.1'\n"
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as bundle:
        info = tarfile.TarInfo("sqlc")
        info.mode = 0o755
        info.size = len(payload)
        bundle.addfile(info, io.BytesIO(payload))
    return archive.getvalue()


class TransientSqlcHandler(http.server.BaseHTTPRequestHandler):
    archive = b""
    attempts = 0

    def do_GET(self):  # noqa: N802 - stdlib handler API
        type(self).attempts += 1
        if type(self).attempts == 1:
            self.send_response(503)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(type(self).archive)))
        self.end_headers()
        self.wfile.write(type(self).archive)

    def log_message(self, *_):
        return


class SqlcInstallTests(unittest.TestCase):
    def test_transient_release_failure_is_retried_and_verified(self):
        archive = sqlc_archive()
        TransientSqlcHandler.archive = archive
        TransientSqlcHandler.attempts = 0
        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), TransientSqlcHandler
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "scripts").mkdir()
                (root / "tools").mkdir()
                installer = root / "scripts/install-sqlc"
                shutil.copy2(ROOT / "scripts/install-sqlc", installer)
                installer.chmod(0o755)
                (root / "tools/versions.env").write_text(
                    f"SQLC_VERSION={SQLC_VERSION}\n", encoding="utf-8"
                )
                manifest = {
                    "schema_version": 1,
                    "sqlc": {
                        "version": SQLC_VERSION,
                        "platforms": {
                            platform: {
                                "url": f"http://127.0.0.1:{server.server_port}/sqlc.tar.gz",
                                "sha256": hashlib.sha256(archive).hexdigest(),
                            }
                            for platform in (
                                "darwin-arm64",
                                "darwin-x86_64",
                                "linux-arm64",
                                "linux-x86_64",
                            )
                        },
                    },
                }
                (root / "tools/database-toolchain.json").write_text(
                    json.dumps(manifest), encoding="utf-8"
                )
                output = root / "bin"
                temp_dir = root / "tmp"
                temp_dir.mkdir()
                environment = {**os.environ, "TMPDIR": str(temp_dir)}
                result = subprocess.run(
                    [str(installer), str(output)],
                    cwd=root,
                    capture_output=True,
                    env=environment,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    subprocess.run(
                        [str(output / "sqlc"), "version"],
                        capture_output=True,
                        text=True,
                        check=True,
                    ).stdout.strip(),
                    SQLC_VERSION,
                )
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
        self.assertGreaterEqual(TransientSqlcHandler.attempts, 2)


if __name__ == "__main__":
    unittest.main()
