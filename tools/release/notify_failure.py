"""Metadata-only sidecar: never checkout or execute the failed run's source."""
import json
import os
from pathlib import Path
import subprocess
from github import GitHub
from policy import ReleaseError


def failure_identity(record_path):
    record = read_failure_record(record_path)
    return None if record is None else record['id']


def read_failure_record(record_path):
    if not record_path.is_file():
        return None
    try:
        text=record_path.read_text()
        if not text.strip():
            # Shell redirection can create the file before reservation fails.
            return None
        record=json.loads(text)
    except (ValueError,UnicodeError):
        raise ReleaseError('invalid failure identity metadata') from None
    identity=record.get('id') if isinstance(record,dict) else None
    if not isinstance(identity,str) or len(identity)!=64 or any(c not in '0123456789abcdef' for c in identity):
        raise ReleaseError('invalid failure identity')
    return record


def safe_metadata(record, key):
    value = record.get(key)
    if isinstance(value, dict) and isinstance(value.get('state'), str):
        value = value['state']
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(char) < 0x20 or ord(char) > 0x7e for char in value):
        return 'unknown'
    return value


def reconcile_issue(api, marker, title, body):
    response=api.issues()
    matches=[i for i in response if marker in (i.get('body') or '') and 'pull_request' not in i]
    if len(matches)>1:raise ReleaseError('ambiguous workflow notification identity')
    if matches:api.api('issues/'+str(matches[0]['number']),'PATCH',dict(body=body))
    else:api.api('issues','POST',dict(title=title,body=body))


def main():
    api=GitHub(os.environ['GITHUB_REPOSITORY'])
    event=json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    run=event['workflow_run']
    paths={'Manual Release':'.github/workflows/manual-release.yml','Release':'.github/workflows/product-release.yml','Skill Runtime Release':'.github/workflows/skill-release-publish.yml'}
    if run['name'] not in paths or run['path']!=paths[run['name']] or run['event']!='workflow_dispatch' or run['head_branch']!='main' or run['head_repository']['full_name']!=os.environ['GITHUB_REPOSITORY'] or run['conclusion'] not in ('failure','timed_out','cancelled'):
        raise ReleaseError('untrusted failure provenance')
    record_path=Path(os.environ['RUNNER_TEMP'])/'failed-release-record/identity.json'
    record=read_failure_record(record_path)
    receipt_path=Path(os.environ['RUNNER_TEMP'])/'failed-release-receipt/skill-release-receipt.json'
    if record is not None and receipt_path.is_file():
        try:
            receipt=json.loads(receipt_path.read_text())
        except (ValueError,UnicodeError,OSError):
            receipt=None
        if isinstance(receipt,dict):
            record={**record, **{key: receipt[key] for key in ('state','published','completed','registryObservation','distTags') if key in receipt}}
    identity=None if record is None else record['id']
    if run['name']=='Skill Runtime Release':
        marker='<!-- loomhelm-skill-release-run:'+str(run['id'])+' -->'
        if record is None:
            details='No verified release identity; inspect the failed run before retry.'
        else:
            details='\n'.join([
                'Receipt ID: '+record['id'],
                'Package: '+safe_metadata(record, 'packageName')+'@'+safe_metadata(record, 'packageVersion'),
                'Compatibility: '+safe_metadata(record, 'compatibilityLine'),
                'Merge SHA: '+safe_metadata(record, 'mergeSha'),
                'Build ID: '+safe_metadata(record, 'buildId'),
                'Tag: '+safe_metadata(record, 'tag'),
                'Canonical digest: '+safe_metadata(record, 'canonicalDigest'),
                'Raw integrity: '+safe_metadata(record, 'rawIntegrity'),
                'State: '+safe_metadata(record, 'state'),
                'Registry observation: '+safe_metadata(record, 'registryObservation'),
                'Next action: reconcile the exact package identity from this receipt; do not rebuild or republish blindly.',
            ])
        body='\n'.join([
            marker,
            'Workflow: '+run['name'],
            'Run: '+run['html_url'],
            'SHA: '+run['head_sha'],
            'Attempt: '+str(run['run_attempt']),
            details,
        ])
        reconcile_issue(api, marker, 'Skill runtime release workflow failed', body)
        return
    if identity is not None:
        subprocess.run(['scripts/product-release','notify','--identity',identity],env=dict(os.environ,RELEASE_FAILURE_STAGE=run['name'],FAILURE_RUN_ID=str(run['id'])),check=True)
        return
    # Failure before reservation has no product identity; keep generic metadata.
    marker='<!-- loomhelm-release-run:'+str(run['id'])+' -->'
    body=marker+'\nWorkflow: '+run['name']+'\nRun: '+run['html_url']+'\nSHA: '+run['head_sha']+'\nAttempt: '+str(run['run_attempt'])+'\nNo verified release identity; inspect the failed run before retry.'
    reconcile_issue(api, marker, 'Product release workflow failed before identity capture', body)


if __name__=='__main__':main()
