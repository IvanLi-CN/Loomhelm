"""The checked-in gate and the sidecar workflow must not drift apart."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT/'.github/workflows'
GATE = ROOT/'.github/release-failure-notification.json'
SIDECAR = WORKFLOWS/'release-failure.yml'


def names():
    return {re.match(r'name:\s*(.+)', (path.read_text().splitlines() or [''])[0])[1].strip() for path in sorted(WORKFLOWS.glob('*.yml'))}


def gate():
    return json.loads(GATE.read_text())


class NotificationContractTests(unittest.TestCase):
    def test_every_workflow_is_classified(self):
        self.assertEqual(names(), set(gate()['workflow_routes']))

    def test_notifier_is_excluded_and_routes_are_valid(self):
        routes = gate()['workflow_routes']
        self.assertEqual(routes['Release Failure Notification']['route'], 'excluded')
        for name, entry in routes.items():
            with self.subTest(workflow=name):
                self.assertIn(entry['route'], ('release', 'excluded'))
                if entry['route'] == 'excluded':
                    self.assertTrue(entry.get('reason'))
                else:
                    self.assertIn(entry.get('identity'), ('product-ledger', 'skill-receipt', 'none'))

    def test_workflow_run_list_matches_release_routes(self):
        match = re.search(r'workflows:\s*\[([^\]]*)\]', SIDECAR.read_text())
        self.assertIsNotNone(match)
        watched = {name.strip() for name in match[1].split(',') if name.strip()}
        routed = {name for name, entry in gate()['workflow_routes'].items() if entry['route'] == 'release'}
        self.assertEqual(watched, routed)

    def test_reusable_workflow_pin_is_full_sha_and_matches_gate(self):
        text = SIDECAR.read_text()
        pins = re.findall(r'IvanLi-CN/oidrune/\.github/workflows/notify\.yml@([0-9a-f]{40})', text)
        self.assertEqual(len(pins), 2)
        self.assertEqual({'IvanLi-CN/oidrune/.github/workflows/notify.yml@'+pin for pin in pins}, {gate()['transport_selection']['notify_workflow']})
        self.assertNotIn('secrets:', text)
        self.assertEqual(gate()['transport_selection']['required_secrets'], [])

    def test_guard_requires_failure_on_main_dispatch(self):
        text = SIDECAR.read_text()
        for required in ("conclusion == 'failure'", "event == 'workflow_dispatch'", "head_branch == 'main'", "head_repository.full_name == github.repository"):
            self.assertIn(required, text)
        self.assertNotIn("conclusion != 'success'", text)

    def test_no_github_issue_delivery_remains(self):
        for path in sorted(WORKFLOWS.glob('*.yml')):
            with self.subTest(workflow=path.name):
                self.assertNotIn('issues: write', path.read_text())
        adapter = (ROOT/'tools/release/github.py').read_text()
        self.assertNotIn('def issues', adapter)
        self.assertNotIn('def notify', adapter)


if __name__ == '__main__':
    unittest.main()
