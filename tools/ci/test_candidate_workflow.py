"""Exercise the actual fail-closed gate and its workflow/cache contract."""
import json
import os
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/candidate-ci.yml'


class CandidateWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = WORKFLOW.read_text()
        self.gate = self.workflow.split('  candidate-build:\n', 1)[1].split('\n  candidate-reproducibility:', 1)[0]
        self.needs = re.search(r'needs: \[(.*?)\]', self.gate)[1].split(', ')
        self.script = '\n'.join(line[10:] for line in self.gate.split("python3 - <<'PYTHON'\n", 1)[1].split('          PYTHON', 1)[0].splitlines())

    def gate_result(self, values):
        return subprocess.run(['python3', '-c', self.script], env={**os.environ, 'CANDIDATE_RESULTS': json.dumps(values)}, capture_output=True).returncode

    def test_gate_matrix(self):
        good = {name: {'result': 'success'} for name in self.needs}
        self.assertEqual(self.gate_result(good), 0)
        for name in self.needs:
            for status in ('failure', 'cancelled', 'skipped', None):
                with self.subTest(name=name, status=status):
                    values = {**good, name: {'result': status}}
                    self.assertNotEqual(self.gate_result(values), 0)
            missing = dict(good)
            del missing[name]
            self.assertNotEqual(self.gate_result(missing), 0)
        self.assertNotEqual(self.gate_result({**good, 'unexpected': {'result': 'success'}}), 0)

    def test_dag_and_full_workload(self):
        self.assertIn('if: ${{ always() }}', self.gate)
        producer = self.workflow.split('  candidate-producer:\n')[1].split('\n  candidate-build:')[0]
        self.assertIn('needs: quality-gates\n', producer)
        self.assertIn('candidate-producer', self.needs)
        self.assertNotIn('cache: true', self.workflow)
        self.assertIn('retention-days: 90', producer)
        for group in ('generated', 'source', 'database', 'web'):
            self.assertIn('scripts/checks ' + group, self.workflow)
        checks = (ROOT / 'scripts/checks').read_text()
        for command in ('go test -p=1 ./...', 'go test -p=1 -race ./...', 'go test -p=1 -shuffle=on ./...', 'go vet ./...'):
            self.assertIn(command, checks)

    def test_cold_consumers_wait_for_producer(self):
        for name in ('candidate-reproducibility', 'product-package-smoke'):
            chunk = self.workflow.split('  ' + name + ':\n', 1)[1]
            chunk = re.split(r'^  [a-z][a-z-]+:\n', chunk, maxsplit=1, flags=re.M)[0]
            self.assertIn('    needs: candidate-producer\n', chunk)
            self.assertIn('purpose: candidate', chunk)
            self.assertNotIn('operation: save', chunk)
        repository = self.workflow.split('  repository-verification:\n', 1)[1].split('  typescript-client-bun:', 1)[0]
        self.assertNotIn('candidate-producer', repository)

    def test_repository_work_is_isolated_and_gated(self):
        source = self.workflow.split('  repository-verification:\n', 1)[1].split('  repository-contracts:', 1)[0]
        contracts = self.workflow.split('  repository-contracts:\n', 1)[1].split('  typescript-client-bun:', 1)[0]
        self.assertIn('needs: quality-gates\n', source)
        self.assertIn('needs: quality-gates\n', contracts)
        self.assertIn('scripts/checks source', source)
        self.assertNotIn('scripts/checks source', contracts)
        for group in ('generated', 'database', 'web'):
            self.assertNotIn('scripts/checks ' + group, source)
            self.assertIn('scripts/checks ' + group, contracts)
        self.assertNotIn('operation: save', contracts)
        self.assertIn('repository-contracts', self.needs)

    def test_single_writers_and_bounds(self):
        chunks = re.split(r'^  ([a-z][a-z-]+):\n', self.workflow, flags=re.M)
        writers = [chunks[i] for i in range(1, len(chunks), 2) if 'operation: save' in chunks[i+1]]
        self.assertEqual(set(writers), {'repository-verification', 'candidate-producer'})
        action = (ROOT / '.github/actions/go-cache/action.yml').read_text()
        self.assertIn('go clean -testcache', action)
        self.assertIn('500 * 1024**2', action)
        self.assertIn('1024**3', action)
        self.assertIn('github.event.pull_request.head.repo.full_name == github.repository', action)
        self.assertIn("inputs.purpose == 'candidate'", action)
        self.assertIn('continue-on-error: true', action)


if __name__ == '__main__':
    unittest.main()
