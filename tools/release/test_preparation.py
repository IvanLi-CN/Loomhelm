import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock
from ledger import Ledger, transition
from policy import ReleaseError, reserve
from preparation import PROJECTIONS, current_preparation, projected_files, reconcile


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.previous = Path.cwd()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(os.chdir,self.previous)
        subprocess.run(['git','init','--bare',self.tmp.name+'/remote'],check=True,capture_output=True)
        subprocess.run(['git','init',self.tmp.name+'/local'],check=True,capture_output=True)
        os.chdir(self.tmp.name+'/local')
        self.run_git('config','user.email','fixture@example.invalid')
        self.run_git('config','user.name','Preparation Fixture')
        self.run_git('config','commit.gpgsign','false')
        self.run_git('remote','add','origin',self.tmp.name+'/remote')
        for path in PROJECTIONS:
            p=Path(path);p.parent.mkdir(parents=True,exist_ok=True)
            p.write_text('dev\n' if path=='VERSION' else '{"web":{"name":"@loomhelm/web","version":"dev"}}\n' if path=='bun.lock' else '{"name":"fixture","version":"dev"}\n')
        Path('business.txt').write_text('old\n')
        self.origin=self.commit('fixture source')
        self.project()
        self.original_head=self.commit('fixture original projection')
        self.run_git('checkout','--detach',self.origin)
        Path('business.txt').write_text('compatible fix\n')
        self.source=self.commit('fixture compatible main change')
        self.project()
        self.head=self.commit('fixture refreshed projection')
        self.run_git('push','origin',self.head+':refs/heads/preparation')
        self.record=reserve({},'0.1.0',self.origin,'policy','owner',None)
        transition(self.record,'prepared',branch='th/release-0.1.0-fixture',preparation_sha=self.original_head)
        self.ledger=Mock()
        self.ledger.state={'schema_version':1,'releases':{self.record['id']:self.record}}
        self.ledger.original=copy.deepcopy(self.ledger.state)
        self.api=Mock(repo='owner/repo')
        self.api.graphql.return_value={'viewer':{'login':'owner'}}
        self.api.release.return_value=None
        self.api.api.side_effect=self.provider
        self.assessment=dict(version='0.1.0',previous_source_sha=self.origin,source_sha=self.source,verdict='within-intent',operator='owner',reason='Fixes existing behavior within the approved first release.',evidence=['PR fixture compatible fix'],changed_paths=['business.txt'])

    def run_git(self,*args):
        return subprocess.check_output(['git',*args],stderr=subprocess.PIPE).decode().strip()

    def commit(self,message):
        self.run_git('add','.')
        self.run_git('commit','--signoff','-m','test: '+message)
        return self.run_git('rev-parse','HEAD')

    def project(self):
        for path,data in projected_files({p:Path(p).read_bytes() for p in PROJECTIONS},'0.1.0').items():
            Path(path).write_bytes(data)

    def provider(self,path,*args,**kwargs):
        if path=='branches/main':return {'commit':{'sha':self.source}}
        if path.startswith('git/ref/'):return None
        if path.startswith('pulls?'):return [dict(merged_at=None,state='open',base={'ref':'main'},head={'sha':self.head})]
        raise AssertionError(path)

    def apply(self):
        reconcile(self.api,self.ledger,self.record,self.source,self.head,self.assessment,['Quality Gates'])

    def test_unbound_revision_preserves_version_identity_original_intent_and_retries(self):
        original=copy.deepcopy(self.record)
        self.apply()
        self.assertEqual(self.record['id'],original['id'])
        self.assertEqual(self.record['version'],'0.1.0')
        self.assertEqual(self.record['intent'],original['intent'])
        self.assertEqual(self.record['preparation_sha'],self.original_head)
        self.assertEqual(current_preparation(self.record)['source_sha'],self.source)
        self.assertEqual(current_preparation(self.record)['preparation_sha'],self.head)
        validator=Ledger(signed=False);validator.original=self.ledger.original
        validator.validate(self.ledger.state)
        self.apply()
        self.ledger.append.assert_called_once()

    def test_exceeds_intent_missing_evidence_and_wrong_owner_fail_without_append(self):
        for field,value in [('verdict','exceeds-intent'),('reason',''),('evidence',[]),('operator','other')]:
            original=copy.deepcopy(self.assessment)
            self.assessment[field]=value
            with self.subTest(field=field),self.assertRaises(ReleaseError):self.apply()
            self.assessment=original
        self.ledger.append.assert_not_called()

    def test_assessment_must_cover_actual_diff_and_owner_identity(self):
        self.assessment['changed_paths']=[]
        with self.assertRaisesRegex(ReleaseError,'actual change inventory'):self.apply()
        self.assessment['changed_paths']=['business.txt']
        self.api.graphql.return_value={'viewer':{'login':'other'}}
        with self.assertRaisesRegex(ReleaseError,'only the release owner'):self.apply()
        self.ledger.append.assert_not_called()

    def test_binding_or_build_claim_forbids_revision(self):
        for field,value in [('merge_sha','a'*40),('build_source',{'run_id':'1','attempt':'1'}),('artifacts',{'package':'digest'}),('publication_intent',True)]:
            self.record[field]=value
            with self.subTest(field=field),self.assertRaises(ReleaseError):self.apply()
            del self.record[field]
        self.ledger.append.assert_not_called()

    def test_malformed_assessment_fails_before_provider_or_ledger_writes(self):
        for value in (None,[], 'within-intent',42):
            self.assessment=value
            with self.subTest(value=value),self.assertRaisesRegex(ReleaseError,'must be an object'):self.apply()
        self.api.graphql.assert_not_called()
        self.api.api.assert_not_called()
        self.ledger.append.assert_not_called()

    def test_non_main_merged_pr_does_not_fix_the_product_version(self):
        provider=self.provider
        pulls=[dict(merged_at='now',state='closed',base={'ref':'develop'},head={'sha':self.head}),*provider('pulls?')]
        self.api.api.side_effect=lambda path,*a,**kw:pulls if path.startswith('pulls?') else provider(path,*a,**kw)
        self.apply()
        self.assertEqual(self.record['version'],'0.1.0')
        self.assertEqual(current_preparation(self.record)['source_sha'],self.source)
        self.ledger.append.assert_called_once()

    def test_version_previously_fixed_on_main_cannot_be_reused_even_if_version_later_changes(self):
        self.run_git('checkout','--detach',self.source)
        self.project();self.commit('fixture version landed on main')
        Path('VERSION').write_text('0.2.0\n')
        self.source=self.commit('fixture subsequent version')
        self.run_git('push','origin',self.source+':refs/heads/main')
        self.project();self.head=self.commit('fixture attempted version reuse')
        self.run_git('push','origin',self.head+':refs/heads/next-preparation')
        self.assessment['source_sha']=self.source
        with self.assertRaisesRegex(ReleaseError,'already fixed on main'):self.apply()
        self.ledger.append.assert_not_called()

    def test_hidden_lockfile_change_is_not_a_version_projection(self):
        Path('bun.lock').write_text(Path('bun.lock').read_text()+'// hidden dependency change\n')
        self.head=self.commit('fixture hidden lock change')
        self.run_git('push','origin',self.head+':refs/heads/preparation')
        with self.assertRaisesRegex(ReleaseError,'exact version projections'):self.apply()

    def test_side_branch_version_that_never_landed_on_main_does_not_burn_version(self):
        tree=self.run_git('rev-parse',self.source+'^{tree}')
        self.source=self.run_git('commit-tree',tree,'-p',self.source,'-p',self.original_head,'-m','test: main keeps dev despite side branch version')
        self.run_git('checkout','--detach',self.source)
        self.project();self.head=self.commit('fixture preparation after main merge')
        self.run_git('push','origin',self.head+':refs/heads/next-preparation')
        self.assessment['source_sha']=self.source
        self.apply()
        self.assertEqual(self.record['version'],'0.1.0')

    def test_merged_preparation_pr_cannot_be_reconciled_without_a_bound_receipt(self):
        provider=self.provider
        self.api.api.side_effect=lambda path,*a,**kw: [dict(merged_at='now',state='closed',base={'ref':'main'},head={'sha':self.head})] if path.startswith('pulls?') else provider(path,*a,**kw)
        with self.assertRaisesRegex(ReleaseError,'merged versions cannot be reassigned'):self.apply()

    def test_unbound_termination_can_resume_same_identity_with_explicit_assessment(self):
        transition(self.record,'terminated',reason='pause before version was fixed')
        self.apply()
        self.assertEqual(self.record['state'],'prepared')
        self.assertEqual(self.record['version'],'0.1.0')
        self.assertTrue(any(e['kind']=='terminated' for e in self.record['events']))

    def test_revision_history_or_event_rewrite_is_rejected(self):
        self.apply()
        validator=Ledger(signed=False);validator.original=copy.deepcopy(self.ledger.state)
        self.record['preparation_revisions'][0]['assessment']['reason']='rewritten'
        with self.assertRaises(ReleaseError):validator.validate(self.ledger.state)

    def test_bind_uses_approved_revision_and_freezes_exact_merge(self):
        from product import bind
        self.apply()
        tree=self.run_git('rev-parse',self.head+'^{tree}')
        merge=self.run_git('commit-tree',tree,'-p',self.source,'-p',self.head,'-m','test: fixture exact merged preparation')
        self.run_git('push','origin',merge+':refs/heads/main')
        self.api.api.return_value=[dict(number=1,merged_at='now',merge_commit_sha=merge,base={'ref':'main'},head={'sha':self.head,'ref':self.record['branch']})]
        self.api.api.side_effect=None
        legacy=copy.deepcopy(self.record);legacy.pop('preparation_revisions')
        with self.assertRaisesRegex(ReleaseError,'missing exact-head'):bind(self.api,legacy,merge)
        bind(self.api,self.record,merge)
        self.assertEqual(self.record['merge_sha'],merge)
        self.assertEqual(self.record['state'],'bound')
        self.assessment['reason']='try to change a bound release'
        with self.assertRaises(ReleaseError):self.apply()

    def test_legacy_schema_one_bare_git_history_resumes_without_rewriting_original(self):
        legacy=Ledger(signed=False)
        legacy.read()['releases'][self.record['id']]=copy.deepcopy(self.record)
        legacy.append(legacy.state)
        first=legacy.head
        self.ledger=legacy
        self.record=legacy.state['releases'][self.record['id']]
        self.apply()
        updated=legacy.head
        self.run_git('merge-base','--is-ancestor',first,updated)
        reread=Ledger(api=Mock())
        record=reread.read()['releases'][self.record['id']]
        self.assertEqual(record['intent']['source_sha'],self.origin)
        self.assertEqual(current_preparation(record)['source_sha'],self.source)
        self.assertEqual(len(record['preparation_revisions']),1)
        self.apply()
        self.assertEqual(legacy.head,updated)
