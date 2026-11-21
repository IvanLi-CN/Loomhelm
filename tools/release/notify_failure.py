"""Metadata-only sidecar: never checkout or execute the failed run's source."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import failure_report
from policy import ReleaseError

PATHS = {
    'Manual Release': '.github/workflows/manual-release.yml',
    'Release': '.github/workflows/product-release.yml',
    'Runtime Core Release': '.github/workflows/runtime-core-release.yml',
    'Skill Runtime Release': '.github/workflows/skill-release-publish.yml',
}
PRODUCT = ('Manual Release', 'Release')
GENERIC_TAIL = (
    'No verified release identity; inspect the failed run before retry.',
    'Recovery: inspect the failing jobs in the run above, then rerun the same workflow.',
)


def validate(run):
    if (
        run['name'] not in PATHS
        or run['path'] != PATHS[run['name']]
        or run['event'] != 'workflow_dispatch'
        or run['head_branch'] != 'main'
        or run['head_repository']['full_name'] != os.environ['GITHUB_REPOSITORY']
        or run['conclusion'] != 'failure'
    ):
        raise ReleaseError('untrusted failure provenance')


def read_failure_record(record_path):
    if not record_path.is_file():
        return None
    try:
        text = record_path.read_text()
        if not text.strip():
            # Shell redirection can create the file before reservation fails.
            return None
        record = json.loads(text)
    except (ValueError, UnicodeError):
        raise ReleaseError('invalid failure identity metadata') from None
    identity = record.get('id') if isinstance(record, dict) else None
    if not isinstance(identity, str) or len(identity) != 64 or any(c not in '0123456789abcdef' for c in identity):
        raise ReleaseError('invalid failure identity')
    return record


def safe_metadata(record, key):
    value = record.get(key)
    if isinstance(value, dict) and isinstance(value.get('state'), str):
        value = value['state']
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(char) < 0x20 or ord(char) > 0x7e for char in value):
        return 'unknown'
    return value


def load_record():
    # Product and Manual Release upload identity.json; Skill Runtime Release uploads
    # release-identity.json under the same artifact name.
    root = Path(os.environ['RUNNER_TEMP']) / 'failed-release-record'
    record = read_failure_record(root / 'identity.json')
    if record is None:
        record = read_failure_record(root / 'release-identity.json')
    receipt_path = Path(os.environ['RUNNER_TEMP']) / 'failed-release-receipt/skill-release-receipt.json'
    if record is not None and receipt_path.is_file():
        try:
            receipt = json.loads(receipt_path.read_text())
        except (ValueError, UnicodeError, OSError):
            receipt = None
        if isinstance(receipt, dict):
            record = {**record, **{key: receipt[key] for key in ('state', 'published', 'completed', 'registryObservation', 'distTags') if key in receipt}}
    return record


def skill_tail(record):
    if record is None:
        return list(GENERIC_TAIL)
    return [
        'Receipt ID: ' + record['id'],
        'Package: ' + safe_metadata(record, 'packageName') + '@' + safe_metadata(record, 'packageVersion'),
        'Compatibility: ' + safe_metadata(record, 'compatibilityLine'),
        'Merge SHA: ' + safe_metadata(record, 'mergeSha'),
        'Build ID: ' + safe_metadata(record, 'buildId'),
        'Tag: ' + safe_metadata(record, 'tag'),
        'Canonical digest: ' + safe_metadata(record, 'canonicalDigest'),
        'Raw integrity: ' + safe_metadata(record, 'rawIntegrity'),
        'State: ' + safe_metadata(record, 'state'),
        'Registry observation: ' + safe_metadata(record, 'registryObservation'),
        'Next action: reconcile the exact package identity from this receipt; do not rebuild or republish blindly.',
    ]


def prepare():
    run = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())['workflow_run']
    validate(run)
    record = load_record()
    if run['name'] == 'Skill Runtime Release':
        return dict(summary=failure_report.summary(run, skill_tail(record)), identity='', stage=run['name'], deliver=True)
    identity = None if record is None else record['id']
    if identity is not None and run['name'] in PRODUCT:
        result = subprocess.run(
            ['scripts/product-release', 'notify', '--identity', identity, '--phase', 'prepare'],
            capture_output=True, text=True, check=True,
            env=dict(os.environ, RELEASE_FAILURE_STAGE=run['name'], FAILURE_RUN_ID=str(run['id']),
                     FAILURE_HEAD_SHA=run['head_sha'], FAILURE_RUN_ATTEMPT=str(run['run_attempt']),
                     FAILURE_ACTOR=(run.get('actor') or {}).get('login', '')),
        )
        return json.loads(result.stdout)
    return dict(summary=failure_report.summary(run, GENERIC_TAIL), identity='', stage=run['name'], deliver=True)


def record(result):
    identity = os.environ.get('NOTIFICATION_IDENTITY', '')
    stage = os.environ.get('RELEASE_FAILURE_STAGE', '')
    if not identity or stage not in PRODUCT:
        return
    subprocess.run(
        ['scripts/product-release', 'notify', '--identity', identity, '--phase', 'result', '--result', result],
        check=True,
    )


def main(argv):
    parser = argparse.ArgumentParser(description='Prepare or record one Oidrune failure handoff.')
    parser.add_argument('phase', choices=['prepare', 'record'])
    parser.add_argument('--result', choices=['accepted', 'failed'])
    args = parser.parse_args(argv)
    if args.phase == 'prepare':
        print(json.dumps(prepare(), sort_keys=True))
        return
    if args.result is None:
        raise ReleaseError('record requires --result')
    record(args.result)


if __name__ == '__main__':
    main(sys.argv[1:])
