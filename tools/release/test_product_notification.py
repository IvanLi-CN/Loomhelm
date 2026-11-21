import os
import unittest
from unittest.mock import patch
from policy import ReleaseError, reserve
from product import notify_failure


class MemoryLedger:
    def __init__(self, record):
        self.state = {'releases': {record['id']: record}}
        self.appends = 0

    def append(self, state):
        self.appends += 1


def reserved():
    return reserve({}, '1.0.0', 'a'*40, 'policy', 'owner', None)


def notifications(record):
    return [e for e in record['events'] if e['kind'] == 'notification']


RUN_ENV = dict(GITHUB_REPOSITORY='owner/repo', FAILURE_HEAD_SHA='f'*40, FAILURE_RUN_ATTEMPT='5', FAILURE_ACTOR='owner', GITHUB_RUN_ATTEMPT='1', GITHUB_ACTOR='github-actions[bot]')


def attempt(number):
    return patch.dict(os.environ, dict(RUN_ENV, GITHUB_RUN_ATTEMPT=str(number)))


class ProductNotificationTests(unittest.TestCase):
    def prepare(self, record, ledger, run_id='9', stage='Release'):
        return notify_failure(record, ledger, 'owner/repo', run_id, stage, 'prepare')

    def test_prepare_records_pending_once(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            first = self.prepare(record, ledger)
            second = self.prepare(record, ledger)
        self.assertEqual(first, second)
        self.assertEqual(ledger.appends, 1)
        pending = [e for e in notifications(record) if e['status'] == 'pending']
        self.assertEqual(len(pending), 1)
        self.assertEqual((pending[0]['run'], pending[0]['stage']), ('9', 'Release'))
        self.assertTrue(first['deliver'])
        self.assertEqual(first['identity'], record['id'])
        self.assertIn('Product release 1.0.0', first['summary'])
        self.assertIn('Run: https://github.com/owner/repo/actions/runs/9', first['summary'])

    def test_summary_uses_the_failed_run_metadata(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            prepared = self.prepare(record, ledger)
        lines = prepared['summary'].splitlines()
        self.assertIn('Head SHA: ' + 'f'*40, lines)
        self.assertIn('Attempt: 5', lines)
        self.assertIn('Actor: owner', lines)
        self.assertIn('Repository: owner/repo', lines)

    def test_identity_source_never_mislabels_the_failed_run_head(self):
        record = reserved()
        record['merge_sha'] = 'b'*40
        with patch.dict(os.environ, RUN_ENV):
            prepared = self.prepare(record, MemoryLedger(record))
        lines = prepared['summary'].splitlines()
        self.assertIn('Head SHA: ' + 'f'*40, lines)
        self.assertNotIn('Head SHA: ' + 'b'*40, lines)

    def test_result_records_handoff_accepted(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            self.prepare(record, ledger)
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
        last = notifications(record)[-1]
        self.assertEqual((last['status'], last['run'], last['stage']), ('handoff-accepted', '9', 'Release'))
        self.assertEqual(ledger.appends, 2)
        self.assertEqual(record['state'], 'reserved')

    def test_result_failed_records_unknown(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            self.prepare(record, ledger)
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'failed')
        self.assertEqual(notifications(record)[-1]['status'], 'failed-or-unknown')
        self.assertEqual(record['state'], 'reserved')

    def test_result_without_pending_stops(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV), self.assertRaisesRegex(ReleaseError, 'no pending notification'):
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
        self.assertEqual(ledger.appends, 0)
        self.assertEqual(notifications(record), [])

    def test_retried_handoff_records_its_own_verdict_without_a_new_pending(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            self.prepare(record, ledger)
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'failed')
        # Only the failed notify job is re-run: prepare does not run again.
        with attempt(2):
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
        self.assertEqual([e['status'] for e in notifications(record)], ['pending', 'failed-or-unknown', 'handoff-accepted'])
        self.assertEqual(ledger.appends, 3)

    def test_orphaned_pending_is_converged_by_the_next_attempt(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            self.prepare(record, ledger)
        with attempt(2):
            self.prepare(record, ledger)
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
        self.assertEqual([e['status'] for e in notifications(record)], ['pending', 'handoff-accepted'])
        self.assertEqual(ledger.appends, 2)

    def test_new_attempt_opens_one_new_pending(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            self.prepare(record, ledger)
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'failed')
        with attempt(2):
            self.assertTrue(self.prepare(record, ledger)['deliver'])
        self.assertEqual([e['status'] for e in notifications(record)], ['pending', 'failed-or-unknown', 'pending'])

    def test_duplicate_result_does_not_append_a_second_verdict(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            self.prepare(record, ledger)
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'failed')
        statuses = [e['status'] for e in notifications(record)]
        self.assertEqual(statuses, ['pending', 'handoff-accepted'])
        self.assertEqual(ledger.appends, 2)

    def test_accepted_handoff_is_not_redelivered(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with patch.dict(os.environ, RUN_ENV):
            self.prepare(record, ledger)
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
            repeated = self.prepare(record, ledger)
        self.assertFalse(repeated['deliver'])
        self.assertEqual([e['status'] for e in notifications(record)], ['pending', 'handoff-accepted'])
        self.assertEqual(ledger.appends, 2)

    def test_unsupported_stage_and_run_are_rejected_before_any_write(self):
        record = reserved()
        ledger = MemoryLedger(record)
        for stage, run_id in (('Skill Runtime Release', '9'), ('Release', 'not-a-run')):
            with self.subTest(stage=stage, run=run_id), self.assertRaises(ReleaseError):
                notify_failure(record, ledger, 'owner/repo', run_id, stage, 'prepare')
        self.assertEqual(ledger.appends, 0)


if __name__ == '__main__':
    unittest.main()
