import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import notify_failure
from notify_failure import main, read_failure_record
from policy import ReleaseError


class FailureNotificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root/'failed-release-record/identity.json'
        self.path.parent.mkdir()
        self.event = self.root/'event.json'
        self.run = dict(name='Manual Release', path='.github/workflows/manual-release.yml', event='workflow_dispatch', head_branch='main',
                        head_repository={'full_name': 'owner/repo'}, conclusion='failure', id=123,
                        html_url='https://github.com/owner/repo/actions/runs/123', head_sha='a'*40, run_attempt=1, actor={'login': 'owner'})

    def invoke(self, phase='prepare', result=None, extra=None):
        self.event.write_text(json.dumps({'workflow_run': self.run}))
        environment = dict(GITHUB_REPOSITORY='owner/repo', GITHUB_EVENT_PATH=str(self.event), RUNNER_TEMP=str(self.root), **(extra or {}))
        out = io.StringIO()
        argv = [phase] if result is None else [phase, '--result', result]
        with patch.dict(os.environ, environment), patch('notify_failure.subprocess.run') as delegate, contextlib.redirect_stdout(out):
            main(argv)
        return json.loads(out.getvalue()) if phase == 'prepare' else None, delegate

    def test_missing_or_empty_capture_has_no_verified_identity(self):
        self.assertIsNone(read_failure_record(self.path))
        for value in ('', ' \n\t'):
            self.path.write_text(value)
            self.assertIsNone(read_failure_record(self.path))

    def test_nonempty_malformed_capture_is_rejected(self):
        for value in ('{', 'null', '[]', '"identity"', '{}', '{"id":123}', '{"id":"wrong"}'):
            self.path.write_text(value)
            with self.subTest(value=value), self.assertRaises(ReleaseError):
                read_failure_record(self.path)

    def test_skill_failure_summary_contains_receipt_context(self):
        self.run.update(name='Skill Runtime Release', path='.github/workflows/skill-release-publish.yml')
        self.path.write_text(json.dumps({'id': 'b'*64, 'state': 'processing-timeout', 'packageName': '@loomhelm/multi-task-flow',
                                         'packageVersion': '0.2.8', 'compatibilityLine': 'compat-v1', 'mergeSha': 'c'*40,
                                         'buildId': 'd'*64, 'tag': 'multi-task-flow-v0.2.8', 'canonicalDigest': 'e'*64,
                                         'rawIntegrity': 'sha512-test', 'registryObservation': 'processing'}))
        receipt = self.root/'failed-release-receipt/skill-release-receipt.json'
        receipt.parent.mkdir()
        receipt.write_text(json.dumps({'state': 'processing-timeout'}))
        prepared, delegate = self.invoke()
        delegate.assert_not_called()
        self.assertEqual((prepared['identity'], prepared['stage']), ('', 'Skill Runtime Release'))
        lines = prepared['summary'].splitlines()
        self.assertEqual(lines[0], 'Loomhelm release failure')
        for expected in ('Workflow: Skill Runtime Release', 'Package: @loomhelm/multi-task-flow@0.2.8', 'State: processing-timeout',
                         'Run: https://github.com/owner/repo/actions/runs/123', 'Actor: owner'):
            self.assertIn(expected, lines)
        self.assertNotIn('No verified release identity', prepared['summary'])

    def test_skill_failure_without_identity_uses_generic_tail(self):
        self.run.update(name='Skill Runtime Release', path='.github/workflows/skill-release-publish.yml')
        prepared, _ = self.invoke()
        self.assertIn('No verified release identity', prepared['summary'])
        self.assertIn('Recovery: inspect the failing jobs', prepared['summary'])

    def test_runtime_core_failure_is_metadata_only(self):
        self.run.update(name='Runtime Core Release', path='.github/workflows/runtime-core-release.yml')
        prepared, delegate = self.invoke()
        delegate.assert_not_called()
        self.assertEqual(prepared['identity'], '')
        self.assertNotIn('Product release', prepared['summary'])
        self.assertIn('Workflow: Runtime Core Release', prepared['summary'])

    def test_product_identity_delegates_prepare(self):
        identity = 'a'*64
        self.path.write_text(json.dumps({'id': identity}))
        self.event.write_text(json.dumps({'workflow_run': self.run}))
        stdout = json.dumps(dict(summary='s', identity=identity, stage='Manual Release'))
        out = io.StringIO()
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo', GITHUB_EVENT_PATH=str(self.event), RUNNER_TEMP=str(self.root)), \
             patch('notify_failure.subprocess.run', Mock(return_value=Mock(stdout=stdout))) as delegate, contextlib.redirect_stdout(out):
            main(['prepare'])
        self.assertEqual(delegate.call_args.args[0], ['scripts/product-release', 'notify', '--identity', identity, '--phase', 'prepare'])
        self.assertEqual((delegate.call_args.kwargs['env']['RELEASE_FAILURE_STAGE'], delegate.call_args.kwargs['env']['FAILURE_RUN_ID']), ('Manual Release', '123'))
        self.assertEqual(json.loads(out.getvalue()), dict(summary='s', identity=identity, stage='Manual Release'))

    def test_untrusted_failure_does_not_prepare_or_execute(self):
        for change in ({'head_repository': {'full_name': 'other/repo'}}, {'head_branch': 'th/release'}, {'event': 'push'},
                       {'conclusion': 'cancelled'}, {'conclusion': 'timed_out'}, {'conclusion': 'success'},
                       {'name': 'Candidate CI', 'path': '.github/workflows/candidate-ci.yml'},
                       {'path': '.github/workflows/other.yml'}):
            self.run = dict(name='Manual Release', path='.github/workflows/manual-release.yml', event='workflow_dispatch', head_branch='main',
                            head_repository={'full_name': 'owner/repo'}, conclusion='failure', id=123,
                            html_url='https://github.com/owner/repo/actions/runs/123', head_sha='a'*40, run_attempt=1, actor={'login': 'owner'})
            self.run.update(change)
            self.event.write_text(json.dumps({'workflow_run': self.run}))
            with self.subTest(change=change), patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo', GITHUB_EVENT_PATH=str(self.event), RUNNER_TEMP=str(self.root)), \
                 patch('notify_failure.subprocess.run') as delegate, self.assertRaisesRegex(ReleaseError, 'untrusted'):
                main(['prepare'])
            delegate.assert_not_called()

    def test_record_without_identity_is_noop(self):
        _, delegate = self.invoke('record', 'accepted')
        delegate.assert_not_called()

    def test_record_with_identity_delegates_result(self):
        identity = 'a'*64
        _, delegate = self.invoke('record', 'accepted', extra=dict(NOTIFICATION_IDENTITY=identity, RELEASE_FAILURE_STAGE='Release'))
        self.assertEqual(delegate.call_args.args[0], ['scripts/product-release', 'notify', '--identity', identity, '--phase', 'result', '--result', 'accepted'])
        self.assertTrue(delegate.call_args.kwargs['check'])


if __name__ == '__main__':
    unittest.main()
