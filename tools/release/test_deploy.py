import unittest
from pathlib import Path
from unittest.mock import Mock
from deploy import stage
from policy import ReleaseError

class DeploymentTests(unittest.TestCase):
    def test_incomplete_release_never_downloads_or_imports(self):
        for state in ('reserved','prepared','bound','frozen','terminated'):
            api=Mock()
            with self.assertRaises(ReleaseError):stage(api,{'state':state},Path('/not-created'))
            api.ensure_draft.assert_not_called()

    def test_completed_ledger_alone_cannot_authorize_draft_deploy(self):
        api=Mock();api.ensure_draft.return_value={'draft':True}
        with self.assertRaises(ReleaseError):stage(api,{'state':'completed'},Path('/not-created'))
        api.verify_assets.assert_not_called()
