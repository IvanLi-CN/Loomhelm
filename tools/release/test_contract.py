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
            (root/'clients/typescript/package-lock.json').write_text('{"version":"0.1.0","packages":{"":{"version":"0.1.0"},"node_modules/x":{"version":"5.0.0"}}}')
            (root/'web/package.json').write_text('{"name":"@loomhelm/web","version":"0.0.0"}')
            (root/'bun.lock').write_text('{"web": {"name": "@loomhelm/web", "version": "0.0.0", "dependencies": {}}}')
            with patch.object(product,'ROOT',root):
                product.project('1.2.3-rc.1')
                self.assertEqual(product.check_projections(),'1.2.3-rc.1')
                package=json.loads((root/'clients/typescript/package.json').read_text())
                self.assertTrue(package['private'])
                lock=json.loads((root/'clients/typescript/package-lock.json').read_text())
                self.assertEqual(lock['packages']['node_modules/x']['version'],'5.0.0')
                (root/'web/package.json').write_text('{"version":"1.2.4"}')
                with self.assertRaises(ReleaseError):product.check_projections()
