"""Metadata-only sidecar: never checkout or execute the failed run's source."""
import json
import os
from pathlib import Path
import subprocess
from github import GitHub
from policy import ReleaseError

api=GitHub(os.environ['GITHUB_REPOSITORY'])
event=json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
run=event['workflow_run']
paths={'Manual Release':'.github/workflows/manual-release.yml','Release':'.github/workflows/product-release.yml'}
if run['name'] not in paths or run['path']!=paths[run['name']] or run['event']!='workflow_dispatch' or run['head_branch']!='main' or run['head_repository']['full_name']!=os.environ['GITHUB_REPOSITORY'] or run['conclusion'] not in ('failure','timed_out','cancelled'):
    raise ReleaseError('untrusted failure provenance')
record_path=Path(os.environ['RUNNER_TEMP'])/'failed-release-record/identity.json'
if record_path.is_file():
    record=json.loads(record_path.read_text())
    identity=record.get('id','')
    if len(identity)!=64 or any(c not in '0123456789abcdef' for c in identity):raise ReleaseError('invalid failure identity')
    subprocess.run(['scripts/product-release','notify','--identity',identity],env=dict(os.environ,RELEASE_FAILURE_STAGE=run['name'],FAILURE_RUN_ID=str(run['id'])),check=True)
else:
    # Failure before reservation has no product identity; keep generic metadata.
    marker='<!-- loomhelm-release-run:'+str(run['id'])+' -->'
    response=api.issues()
    matches=[i for i in response if marker in (i.get('body') or '') and 'pull_request' not in i]
    body=marker+'\nWorkflow: '+run['name']+'\nRun: '+run['html_url']+'\nSHA: '+run['head_sha']+'\nAttempt: '+str(run['run_attempt'])+'\nNo verified release identity; inspect the failed run before retry.'
    if len(matches)>1:raise ReleaseError('ambiguous workflow notification identity')
    if matches:api.api('issues/'+str(matches[0]['number']),'PATCH',dict(body=body))
    else:api.api('issues','POST',dict(title='Product release workflow failed before identity capture',body=body))
