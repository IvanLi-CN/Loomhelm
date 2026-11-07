import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import product
from policy import ReleaseError


class ContractTests(unittest.TestCase):
    def test_projection_round_trip_preserves_other_package_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'clients/typescript').mkdir(parents=True);(root/'web').mkdir()
            (root/'VERSION').write_text('dev\n')
            (root/'clients/typescript/package.json').write_text('{"name":"@loomhelm/client","version":"0.1.0","private":true}')
            (root/'clients/typescript/bun.lock').write_text('fixed root lock without a root version field')
            (root/'web/package.json').write_text('{"name":"@loomhelm/web","version":"0.0.0"}')
            (root/'bun.lock').write_text('{"web": {"name": "@loomhelm/web", "version": "0.0.0", "dependencies": {}}}')
            with patch.object(product,'ROOT',root):
                product.project('1.2.3-rc.1')
                self.assertEqual(product.check_projections(),'1.2.3-rc.1')
                package=json.loads((root/'clients/typescript/package.json').read_text())
                self.assertTrue(package['private'])
                self.assertEqual((root/'clients/typescript/bun.lock').read_text(),'fixed root lock without a root version field')
                (root/'web/package.json').write_text('{"version":"1.2.4"}')
                with self.assertRaises(ReleaseError):product.check_projections()

    def test_incomplete_artifact_matrix_is_not_a_supported_policy(self):
        original=product.contract()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'.github').mkdir()
            original['artifacts'].remove('go-client-linux-amd64.tar.gz')
            (root/'.github/release-contract.json').write_text(json.dumps(original))
            with patch.object(product,'ROOT',root), self.assertRaises(ReleaseError):product.contract()

    def test_unreadable_main_protection_fails_closed(self):
        from unittest.mock import Mock
        api = Mock()
        api.main_protection.return_value = None
        with self.assertRaises(ReleaseError): product.prerequisites(api)
        api.api.assert_not_called()
