import copy
import hashlib
import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from deploy import stage
from github import GitHub
from ledger import transition
from policy import ReleaseError, reserve
from product import publish, prerequisites, claim_build, policy_hash, contract
from test_publication import Provider, frozen
from workflow import original_build, recover
from deploy import persist_receipt


class CASLedger:
    def __init__(self, shared):
        self.shared = shared
        self.version = shared['revision']
        self.state = copy.deepcopy(shared['state'])

    def append(self, state):
        if self.version != self.shared['revision']:
            raise ReleaseError('CAS lost')
        self.shared['state'] = copy.deepcopy(state)
        self.shared['revision'] += 1
        self.version = self.shared['revision']


class BoundaryTests(unittest.TestCase):
    def test_termination_winning_before_intent_prevents_publication(self):
        record = frozen()
        shared = {'revision': 0, 'state': {'releases': {record['id']: record}}}
        ledger = CASLedger(shared)
        record = ledger.state['releases'][record['id']]
        api = Provider()
        api.assets = {'package': b'original'}
        verify = api.verify_assets
        def terminate_first(release, inventory):
            other = CASLedger(shared)
            transition(other.state['releases'][record['id']], 'terminated', reason='owner cancelled')
            other.append(other.state)
            return verify(release, inventory)
        api.verify_assets = terminate_first
        with self.assertRaises(ReleaseError):
            publish(api, ledger, record, Path('/no-local-originals'))
        self.assertEqual(api.publications, 0)
        self.assertEqual(shared['state']['releases'][record['id']]['state'], 'terminated')

    def test_publication_intent_winning_prevents_termination(self):
        record = frozen()
        transition(record, 'publication_intent')
        with self.assertRaises(ReleaseError):
            transition(record, 'terminated', reason='late cancellation')

    def test_extra_release_asset_is_not_part_of_completion(self):
        api = GitHub('owner/repo')
        api.api = Mock(return_value=[{'id': 1, 'name': 'package'}, {'id': 2, 'name': 'unrecorded'}])
        api.asset_bytes = Mock(return_value=b'original')
        with self.assertRaises(ReleaseError):
            api.verify_assets({'id': 1}, {'package': hashlib.sha256(b'original').hexdigest()})

    def test_missing_completed_release_verification_never_creates_draft(self):
        api = GitHub('owner/repo')
        api.verify_tag = Mock()
        api.ensure_tag = Mock()
        writes = []
        def call(path, method='GET', body=None, missing=False):
            if method != 'GET':
                writes.append((path, method))
                return {'id': 1, 'draft': True}
            return None
        api.api = call
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ReleaseError):
            stage(api, dict(frozen(), state='completed'), Path(tmp))
        self.assertEqual(writes, [])

    def test_completed_prerelease_sets_a_monotonic_floor(self):
        previous = reserve({}, '1.2.0-rc.2', 'a'*40, 'policy', 'owner', '1.0.0')
        previous['state'] = 'completed'
        for target in ('1.2.0-rc.1', 'patch'):
            with self.assertRaises(ReleaseError):
                reserve({previous['id']: previous}, target, 'b'*40, 'policy', 'owner', '1.0.0')

    def test_original_build_claim_survives_rerun_and_missing_originals(self):
        record = dict(frozen(), state='bound')
        shared = {'revision': 0, 'state': {'releases': {record['id']: record}}}
        first = CASLedger(shared)
        record = first.state['releases'][record['id']]
        claim_build(first, record, '101', '1')
        claim_build(first, record, '102', '1')
        self.assertTrue(original_build(record, '101', '1'))
        self.assertFalse(original_build(record, '101', '2'))
        self.assertFalse(original_build(record, '102', '1'))
        with tempfile.TemporaryDirectory() as tmp, patch('workflow.subprocess.run') as download:
            with self.assertRaises(ReleaseError):
                recover(record, Path(tmp), 'owner/repo')
            self.assertEqual(download.call_args.args[0][3], '101')

    def test_recovery_assembles_only_original_archive_bytes(self):
        record = dict(frozen(), state='bound', build_source={'run_id': '101', 'attempt': '1'})
        record['intent']['policy_hash'] = policy_hash()
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            originals = {name: ('original:'+name).encode() for name in contract()['artifacts']}
            def download(args, **kwargs):
                partition = directory/'product-original'
                partition.mkdir()
                for name, data in originals.items():
                    (partition/name).write_bytes(data)
            with patch('workflow.subprocess.run', side_effect=download):
                recover(record, directory, 'owner/repo')
            manifest = json.loads((directory/'release-manifest.json').read_text())
            self.assertEqual(manifest['build_run_id'], '101')
            self.assertEqual(manifest['build_attempt'], '1')
            self.assertEqual(manifest['artifacts'], {n: hashlib.sha256(b).hexdigest() for n,b in originals.items()})
            self.assertTrue(all(p.is_file() for p in directory.iterdir()))

    def test_quality_gate_change_invalidates_policy_identity(self):
        before = policy_hash()
        import product
        actual = product.ROOT
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'.github').mkdir()
            (root/'.github/release-contract.json').write_bytes((actual/'.github/release-contract.json').read_bytes())
            gates = json.loads((actual/'.github/quality-gates.json').read_text())
            gates['required_checks'] = []
            (root/'.github/quality-gates.json').write_text(json.dumps(gates))
            with patch('product.ROOT', root):
                self.assertNotEqual(policy_hash(), before)

    def test_inventory_rejects_a_different_build_run_or_attempt(self):
        from assemble import assemble
        from product import inventory
        record = dict(frozen(),state='bound',build_source={'run_id':'101','attempt':'1'})
        record['intent']['policy_hash'] = policy_hash()
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for name in contract()['artifacts']:
                (directory/name).write_bytes(('original:'+name).encode())
            assemble(directory,record)
            path = directory/'release-manifest.json'
            original = json.loads(path.read_text())
            for field,value in (('build_run_id','102'),('build_attempt','2')):
                manifest = dict(original,**{field:value})
                path.write_text(json.dumps(manifest))
                with self.subTest(field=field), self.assertRaisesRegex(ReleaseError,'original build claim'):
                    inventory(directory,record)

    def test_stage_receipt_is_immutable_and_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'receipt'
            persist_receipt(path, {'status': 'imported'})
            before = path.read_bytes()
            persist_receipt(path, {'status': 'imported'})
            with self.assertRaises(ReleaseError):
                persist_receipt(path, {'status': 'verified'})
            self.assertEqual(path.read_bytes(), before)
            link = Path(tmp)/'link'
            link.symlink_to(path)
            with self.assertRaises(ReleaseError):
                persist_receipt(link, {'status': 'imported'})
            self.assertEqual(path.read_bytes(), before)
