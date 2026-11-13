import tempfile
import unittest
from pathlib import Path

from policy import ReleaseError
from smoke import validate_ts_manifest


class TypeScriptSmokeTests(unittest.TestCase):
    record = {'merge_sha': 'a' * 40}

    def test_accepts_current_consumer_install_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'toolkit').mkdir()
            validate_ts_manifest(
                root,
                {
                    'candidateSha': self.record['merge_sha'],
                    'dirty': False,
                    'schemaVersion': 3,
                    'runtime': 'bun@1.4.4',
                    'canonicalDigestAlgorithm': 'path-byte-v2',
                    'dependenciesBundled': False,
                    'dependencies': [
                        {'name': 'playwright', 'version': '1.64.1', 'mode': 'consumer-install'},
                        {'name': 'sharp', 'version': '0.35.5', 'mode': 'consumer-install'},
                        {'name': 'zod', 'version': '4.6.7', 'mode': 'consumer-install'},
                    ],
                },
                self.record,
            )

    def test_rejects_current_artifact_with_toolkit_node_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'toolkit/node_modules/zod').mkdir(parents=True)
            with self.assertRaisesRegex(ReleaseError, 'toolkit node_modules'):
                validate_ts_manifest(
                    root,
                    {
                        'candidateSha': self.record['merge_sha'],
                        'dirty': False,
                        'schemaVersion': 3,
                        'runtime': 'bun@1.4.4',
                        'canonicalDigestAlgorithm': 'path-byte-v2',
                        'dependenciesBundled': False,
                        'dependencies': [{'name': 'zod', 'version': '4.6.7', 'mode': 'consumer-install'}],
                    },
                    self.record,
                )

    def test_retains_schema_two_bundled_compatibility(self):
        with tempfile.TemporaryDirectory() as directory:
            validate_ts_manifest(
                Path(directory),
                {
                    'candidateSha': self.record['merge_sha'],
                    'dirty': False,
                    'schemaVersion': 2,
                    'runtime': 'bun@1.4.4',
                    'dependenciesBundled': True,
                },
                self.record,
            )


if __name__ == '__main__':
    unittest.main()
