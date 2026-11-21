import unittest
from policy import ReleaseError, reserve
from product import notify_failure


class MemoryLedger:
    def __init__(self, record):
        self.state = {'releases': {record['id']: record}}
        self.appends = 0

    def append(self, state):
        self.appends += 1


def reserved():
    record = reserve({}, '1.0.0', 'a'*40, 'policy', 'owner', None)
    return record


def notifications(record):
    return [e for e in record['events'] if e['kind'] == 'notification']


class ProductNotificationTests(unittest.TestCase):
    def test_prepare_records_pending_once(self):
        record = reserved()
        ledger = MemoryLedger(record)
        first = notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'prepare')
        second = notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'prepare')
        self.assertEqual(first, second)
        self.assertEqual(ledger.appends, 1)
        pending = [e for e in notifications(record) if e['status'] == 'pending']
        self.assertEqual(len(pending), 1)
        self.assertEqual((pending[0]['run'], pending[0]['stage']), ('9', 'Release'))
        self.assertEqual(first['identity'], record['id'])
        self.assertIn('Product release 1.0.0', first['summary'])
        self.assertIn('Run: https://github.com/owner/repo/actions/runs/9', first['summary'])

    def test_result_records_handoff_accepted(self):
        record = reserved()
        ledger = MemoryLedger(record)
        notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'prepare')
        notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
        last = notifications(record)[-1]
        self.assertEqual((last['status'], last['run'], last['stage']), ('handoff-accepted', '9', 'Release'))
        self.assertEqual(ledger.appends, 2)
        self.assertEqual(record['state'], 'reserved')

    def test_result_failed_records_unknown(self):
        record = reserved()
        ledger = MemoryLedger(record)
        notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'prepare')
        notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'failed')
        self.assertEqual(notifications(record)[-1]['status'], 'failed-or-unknown')
        self.assertEqual(record['state'], 'reserved')

    def test_result_without_pending_stops(self):
        record = reserved()
        ledger = MemoryLedger(record)
        with self.assertRaisesRegex(ReleaseError, 'no pending notification'):
            notify_failure(record, ledger, 'owner/repo', '9', 'Release', 'result', 'accepted')
        self.assertEqual(ledger.appends, 0)
        self.assertEqual(notifications(record), [])

    def test_unsupported_stage_and_run_are_rejected_before_any_write(self):
        record = reserved()
        ledger = MemoryLedger(record)
        for stage, run_id in (('Skill Runtime Release', '9'), ('Release', 'not-a-run')):
            with self.subTest(stage=stage, run=run_id), self.assertRaises(ReleaseError):
                notify_failure(record, ledger, 'owner/repo', run_id, stage, 'prepare')
        self.assertEqual(ledger.appends, 0)


if __name__ == '__main__':
    unittest.main()
