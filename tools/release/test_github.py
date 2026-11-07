import unittest
from unittest.mock import Mock, patch
from github import GitHub
from policy import ReleaseError


class GitHubTests(unittest.TestCase):
    def test_foreign_tag_stops_publication(self):
        api=GitHub('owner/repo')
        api.api=Mock(return_value={'object':{'type':'commit','sha':'b'*40}})
        with self.assertRaises(ReleaseError):api.verify_tag('1.0.0','a'*40)

    def test_foreign_release_identity_is_not_adopted(self):
        api=GitHub('owner/repo');api.verify_tag=Mock();api.release=Mock(return_value={'body':'another identity','target_commitish':'a'*40})
        with self.assertRaises(ReleaseError):api.ensure_draft({'version':'1.0.0','merge_sha':'a'*40,'id':'id'})

    def test_asset_bytes_are_verified_not_provider_metadata(self):
        api=GitHub('owner/repo');api.api=Mock(return_value=[{'name':'package','id':1}]);api.asset_bytes=Mock(return_value=b'tampered')
        with self.assertRaises(ReleaseError):api.verify_assets({'id':1},{'package':'a'*64})
