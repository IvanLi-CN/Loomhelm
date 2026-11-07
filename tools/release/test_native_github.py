"""Native GitHub authentication, verified commits and exact-head CAS contracts."""
import base64
import copy
import json
import unittest
from unittest.mock import Mock
from github import GitHub
from ledger import Ledger
from policy import ReleaseError
from product import prerequisites


class NativeGitHubTests(unittest.TestCase):
    def test_ordinary_release_topic_refs_do_not_block_initialization(self):
        api = GitHub('owner/repo')
        for ref in ('refs/heads/th/release-prerequisite-followup','refs/heads/th/release-fix-abcdef012345','refs/heads/th/release-1.0.0-abc','refs/heads/th/release-01.0.0-abcdef012345'):
            with self.subTest(ref=ref):
                api.api = Mock(side_effect=[[],[{'ref':ref}]])
                api.require_empty_release_history()

    def test_exact_preparation_refs_and_product_history_still_block_initialization(self):
        api = GitHub('owner/repo')
        for version in ('1.0.0','1.2.0-rc.1','2.0.0-beta-with-hyphens.2'):
            api.api = Mock(side_effect=[[],[{'ref':'refs/heads/th/release-'+version+'-abcdef012345'}]])
            with self.subTest(version=version), self.assertRaises(ReleaseError):
                api.require_empty_release_history()
        api.api = Mock(return_value=[{'body':'Loomhelm release identity: occupied'}])
        with self.assertRaises(ReleaseError):api.require_empty_release_history()

    def branch(self):
        return dict(name='main',protected=True,protection={'required_status_checks':dict(enforcement_level='everyone',contexts=self.protection()['requiredStatusCheckContexts'])})

    def protection(self):
        from product import ROOT
        return dict(requiresApprovingReviews=True,requiresCommitSignatures=True,isAdminEnforced=True,allowsForcePushes=False,allowsDeletions=False,requiresStatusChecks=True,requiresStrictStatusChecks=True,requiredStatusCheckContexts=json.loads((ROOT/'.github/quality-gates.json').read_text())['required_checks'])

    def test_existing_classic_protection_passes_without_rulesets_or_new_credentials(self):
        api = Mock()
        api.main_protection.return_value = self.protection()
        api.api.return_value = self.branch()
        prerequisites(api)
        api.api.assert_called_once_with('branches/main')

    def test_missing_signature_pr_check_or_admin_protection_fails(self):
        for key in ('requiresApprovingReviews','requiresCommitSignatures','isAdminEnforced','requiresStatusChecks','requiresStrictStatusChecks','requiredStatusCheckContexts','allowsForcePushes','allowsDeletions'):
            protection = self.protection()
            protection[key] = [] if key=='requiredStatusCheckContexts' else not protection[key]
            api = Mock()
            api.main_protection.return_value = protection
            api.api.return_value = self.branch()
            with self.subTest(key=key), self.assertRaises(ReleaseError):prerequisites(api,detailed=True)

    def test_platform_signing_uses_exact_head_and_original_file_bytes(self):
        api = GitHub('owner/repo')
        api.graphql = Mock(return_value={'createCommitOnBranch': {'commit': {'oid':'b'*40,'signature':{'isValid':True}}}})
        api.verify_record_commit = Mock()
        data = b'{"schema_version":1}\n'
        self.assertEqual(api.signed_commit('release-ledger','a'*40,{'ledger.json':data},'chore(release): append'), 'b'*40)
        payload = api.graphql.call_args.args[1]['input']
        self.assertEqual(payload['expectedHeadOid'], 'a'*40)
        self.assertEqual(payload['branch'], dict(repositoryNameWithOwner='owner/repo',refName='release-ledger'))
        self.assertEqual(base64.b64decode(payload['fileChanges']['additions'][0]['contents']),data)
        self.assertFalse({'author','committer','signature'} & set(payload))
        api.verify_record_commit.assert_called_once_with('b'*40)

    def test_unsupported_platform_signature_stops_before_next_step(self):
        api = GitHub('owner/repo')
        api.graphql = Mock(return_value={'createCommitOnBranch': {'commit': {'oid':'b'*40,'signature':None}}})
        with self.assertRaises(ReleaseError):api.signed_commit('release-ledger','a'*40,{},'chore(release): append')

    def test_record_author_and_verified_signature_are_both_required(self):
        api = GitHub('owner/repo')
        for login, verified, accepted in [('github-actions[bot]',True,True),('owner',True,True),('owner',False,False),('other',True,False)]:
            api.api = Mock(return_value={'sha':'a'*40,'author':{'login':login},'commit':{'verification':{'verified':verified}}})
            if accepted:api.verify_record_commit('a'*40)
            else:
                with self.assertRaises(ReleaseError):api.verify_record_commit('a'*40)

    def test_competing_initial_ref_create_is_not_retried_as_an_update(self):
        api = Mock()
        api.api.side_effect = [{'sha':'a'*40,'commit':{'verification':{'verified':True}}},ReleaseError('ref already exists')]
        ledger = Ledger(api=api)
        with self.assertRaises(ReleaseError):ledger.append(ledger.state)
        api.signed_commit.assert_not_called()

    def test_existing_ledger_update_is_one_exact_ref_cas(self):
        api = Mock()
        api.signed_commit.return_value = 'b'*40
        ledger = Ledger(api=api)
        ledger.head = 'a'*40
        ledger.append(ledger.state)
        args = api.signed_commit.call_args.args
        self.assertEqual(args[:2], ('release-ledger','a'*40))
        self.assertEqual(json.loads(args[2]['ledger.json']), ledger.state)
        self.assertEqual(ledger.head, 'b'*40)
        api.api.assert_not_called()

    def test_cas_failure_never_advances_local_receipt(self):
        api = Mock()
        api.signed_commit.side_effect = ReleaseError('expectedHeadOid conflict')
        ledger = Ledger(api=api)
        ledger.head = 'a'*40
        before = copy.deepcopy(ledger.original)
        with self.assertRaises(ReleaseError):ledger.append(ledger.state)
        self.assertEqual(ledger.head, 'a'*40)
        self.assertEqual(ledger.original, before)

    def test_storage_seed_does_not_require_notifier_pr_or_check_permissions(self):
        api=GitHub('owner/repo')
        api.api=Mock(side_effect=[{'sha':'a'*40,'commit':{'verification':{'verified':True}}},{'status':'ahead'}])
        api.verify_seed('a'*40)
        self.assertEqual([c.args[0] for c in api.api.call_args_list],['commits/'+'a'*40,'compare/'+'a'*40+'...main'])
