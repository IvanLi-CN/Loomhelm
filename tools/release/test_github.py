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

    def test_source_requires_verified_trunk_and_trusted_successful_checks(self):
        for verified, status, conclusion, app in [(False,'completed','success','github-actions'),(True,'in_progress',None,'github-actions'),(True,'completed','failure','github-actions'),(True,'completed','success','another-app')]:
            api=GitHub('owner/repo')
            def read(path):
                if path.startswith('commits/') and '/check-runs' not in path:return {'sha':'a'*40,'commit':{'verification':{'verified':verified}}}
                if path.startswith('compare/'):return {'status':'ahead'}
                return {'check_runs':[{'name':'Quality Gates','head_sha':'a'*40,'status':status,'conclusion':conclusion,'app':{'slug':app}}]}
            api.api=read
            with self.assertRaises(ReleaseError):api.verify_source('a'*40,['Quality Gates'])

    def test_tag_create_response_loss_is_reconciled_without_rewrite(self):
        api=GitHub('owner/repo');refs={};writes=[]
        def call(path, method='GET', body=None, missing=False):
            if method=='POST':
                writes.append(body);refs['object']={'type':'commit','sha':body['sha']}
                raise ReleaseError('response lost')
            return refs or None
        api.api=call
        with self.assertRaises(ReleaseError):api.ensure_tag('1.0.0','a'*40)
        api.ensure_tag('1.0.0','a'*40)
        self.assertEqual(len(writes),1)
