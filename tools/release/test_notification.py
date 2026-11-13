import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock,patch
from notify_failure import failure_identity,main
from policy import ReleaseError


class FailureNotificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.path=self.root/'failed-release-record/identity.json'
        self.path.parent.mkdir()
        self.event=self.root/'event.json'
        self.run=dict(name='Manual Release',path='.github/workflows/manual-release.yml',event='workflow_dispatch',head_branch='main',head_repository={'full_name':'owner/repo'},conclusion='failure',id=123,html_url='https://github.com/owner/repo/actions/runs/123',head_sha='a'*40,run_attempt=1)

    def invoke(self,issues=()):
        self.event.write_text(json.dumps({'workflow_run':self.run}))
        api=Mock();api.issues.return_value=list(issues)
        with patch.dict(os.environ,GITHUB_REPOSITORY='owner/repo',GITHUB_EVENT_PATH=str(self.event),RUNNER_TEMP=str(self.root)),patch('notify_failure.GitHub',return_value=api),patch('notify_failure.subprocess.run') as notify:
            main()
        return api,notify

    def test_missing_or_empty_capture_has_no_verified_identity(self):
        self.assertIsNone(failure_identity(self.path))
        for value in ('',' \n\t'):
            self.path.write_text(value)
            self.assertIsNone(failure_identity(self.path))

    def test_nonempty_malformed_capture_is_rejected(self):
        for value in ('{','null','[]','"identity"','{}','{"id":123}','{"id":"wrong"}'):
            self.path.write_text(value)
            with self.subTest(value=value),self.assertRaises(ReleaseError):failure_identity(self.path)

    def test_empty_capture_uses_metadata_only_run_issue(self):
        self.path.write_text('')
        api,notify=self.invoke()
        notify.assert_not_called()
        api.api.assert_called_once()
        path,method,body=api.api.call_args.args
        self.assertEqual((path,method),('issues','POST'))
        self.assertIn('<!-- loomhelm-release-run:123 -->',body['body'])
        self.assertIn('No verified release identity',body['body'])

    def test_existing_run_issue_is_reconciled_without_duplicate_creation(self):
        self.path.write_text('')
        api,notify=self.invoke([dict(number=7,body='<!-- loomhelm-release-run:123 -->')])
        self.assertEqual(api.api.call_args.args[:2],('issues/7','PATCH'))
        api.api.assert_called_once()
        notify.assert_not_called()

    def test_valid_identity_uses_product_notification(self):
        identity='a'*64
        self.path.write_text(json.dumps({'id':identity}))
        api,notify=self.invoke()
        api.issues.assert_not_called();api.api.assert_not_called()
        self.assertEqual(notify.call_args.args[0],['scripts/product-release','notify','--identity',identity])
        self.assertEqual(notify.call_args.kwargs['env']['FAILURE_RUN_ID'],'123')

    def test_skill_identity_creates_idempotent_metadata_only_issue(self):
        self.run.update(name='Skill Runtime Release', path='.github/workflows/skill-release-publish.yml')
        self.path.write_text(json.dumps({
            'id': 'b' * 64,
            'state': 'processing-timeout',
            'packageName': '@loomhelm/multi-task-flow',
            'packageVersion': '0.2.8',
            'compatibilityLine': 'compat-v1',
            'mergeSha': 'c' * 40,
            'buildId': 'd' * 64,
            'tag': 'multi-task-flow-v0.2.8',
            'canonicalDigest': 'e' * 64,
            'rawIntegrity': 'sha512-test',
            'registryObservation': 'processing',
        }))
        api,notify=self.invoke()
        notify.assert_not_called()
        path,method,body=api.api.call_args.args
        self.assertEqual((path,method),('issues','POST'))
        self.assertIn('<!-- loomhelm-skill-release-run:123 -->',body['body'])
        self.assertIn('Package: @loomhelm/multi-task-flow@0.2.8',body['body'])
        self.assertIn('State: processing-timeout',body['body'])
        api,notify=self.invoke([dict(number=9,body='<!-- loomhelm-skill-release-run:123 -->')])
        notify.assert_not_called()
        self.assertEqual(api.api.call_args.args[:2],('issues/9','PATCH'))
        api.api.assert_called_once()

    def test_untrusted_failure_does_not_send_or_execute(self):
        self.run['head_repository']['full_name']='other/repo'
        self.event.write_text(json.dumps({'workflow_run':self.run}))
        with patch.dict(os.environ,GITHUB_REPOSITORY='owner/repo',GITHUB_EVENT_PATH=str(self.event),RUNNER_TEMP=str(self.root)),patch('notify_failure.GitHub') as api,patch('notify_failure.subprocess.run') as notify:
            with self.assertRaisesRegex(ReleaseError,'untrusted'):main()
            api.return_value.issues.assert_not_called();api.return_value.api.assert_not_called()
            notify.assert_not_called()
