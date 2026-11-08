"""Audited preparation revisions before a version is fixed on main."""
import json
import re
from ledger import git, transition
from policy import ReleaseError, Version

PROJECTIONS = ('VERSION','clients/typescript/package.json','web/package.json','bun.lock')


def projected_files(files, version):
    Version(version)
    result = {'VERSION':(version+'\n').encode()}
    for path in PROJECTIONS[1:3]:
        value = json.loads(files[path])
        value['version'] = version
        result[path] = (json.dumps(value,indent=2)+'\n').encode()
    text,count = re.subn(r'("web":\s*\{\s*"name":\s*"@loomhelm/web",\s*"version":\s*")[^"]+',lambda m:m[1]+version,files['bun.lock'].decode(),count=1)
    if count != 1:
        raise ReleaseError('unknown Bun workspace projection shape')
    result['bun.lock'] = text.encode()
    return result


def current_preparation(record):
    revisions = record.get('preparation_revisions', [])
    return revisions[-1] if revisions else dict(source_sha=record['intent']['source_sha'], preparation_sha=record.get('preparation_sha'), branch=record.get('branch'))


def validate_revision(record, revision):
    previous = current_preparation(record)
    assessment = revision.get('assessment', {})
    if revision.get('policy_revision') != 'pre-main-intent-v1':
        raise ReleaseError('unsupported preparation reconciliation policy')
    if record['state'] not in ('prepared','terminated') or any(record.get(k) for k in ('merge_sha','build_source','artifacts','publication_intent')):
        raise ReleaseError('a main-bound or built identity cannot change source')
    if not record.get('preparation_sha') or revision.get('branch') != record.get('branch'):
        raise ReleaseError('reconciliation must retain the original preparation branch')
    if any(not re.fullmatch('[0-9a-f]{40}',str(revision.get(k,''))) for k in ('source_sha','preparation_sha')):
        raise ReleaseError('exact preparation source and head are required')
    expected = dict(version=record['version'], previous_source_sha=previous['source_sha'], source_sha=revision['source_sha'], verdict='within-intent')
    if any(assessment.get(k) != v for k,v in expected.items()) or not isinstance(assessment.get('reason'),str) or not assessment['reason'].strip() or not isinstance(assessment.get('evidence'),list) or not assessment['evidence'] or not all(isinstance(v,str) and v.strip() for v in assessment['evidence']):
        raise ReleaseError('a documented within-intent assessment is required; never infer it from the version or filenames')
    if assessment.get('operator') != record['intent']['owner'] or not isinstance(assessment.get('changed_paths'),list):
        raise ReleaseError('release owner and exact change inventory are required')


def reconcile(api, ledger, record, source_sha, head_sha, assessment, checks):
    revision = dict(policy_revision='pre-main-intent-v1',source_sha=source_sha,preparation_sha=head_sha,branch=record.get('branch'),assessment=assessment)
    # Same request after a lost CAS response is a read-only reconciliation.
    if record.get('preparation_revisions') and current_preparation(record) == revision:
        return
    validate_revision(record,revision)
    if any(r['id'] != record['id'] and r['state'] not in ('completed','terminated') for r in ledger.state['releases'].values()):
        raise ReleaseError('another release identity is active')
    actor = api.graphql('query{viewer{login}}',{})['viewer']['login']
    if actor != record['intent']['owner']:
        raise ReleaseError('only the release owner may approve an intent assessment')
    api.verify_source(source_sha,checks)
    if api.api('branches/main')['commit']['sha'] != source_sha:
        raise ReleaseError('assessment source is no longer current main')
    for sha in (record['intent']['source_sha'],current_preparation(record)['source_sha'],source_sha,head_sha):
        git('fetch','--no-tags','origin',sha)
    git('merge-base','--is-ancestor',current_preparation(record)['source_sha'],source_sha)
    git('merge-base','--is-ancestor',source_sha,head_sha)
    # Inspect history, not just current VERSION: a later release may have replaced it.
    history = [record['intent']['source_sha']] + git('rev-list','--first-parent',source_sha,'^'+record['intent']['source_sha'],'--','VERSION').stdout.decode().split()
    for sha in history:
        if git('show',sha+':VERSION').stdout.decode().strip() == record['version']:
            raise ReleaseError('version is already fixed on main; bind its original merge instead')
    if api.release(record['version']) or api.api('git/ref/tags/v'+record['version'],missing=True):
        raise ReleaseError('publication identity already exists; never change its source')
    pulls = api.api('pulls?state=all&head='+api.repo.split('/')[0]+':'+record['branch'])
    if any(p.get('merged_at') for p in pulls) or len([p for p in pulls if p['state']=='open' and p['base']['ref']=='main' and p['head']['sha']==head_sha]) != 1:
        raise ReleaseError('an exact open preparation PR is required; merged versions cannot be reassigned')
    api.verify_record_commit(head_sha)
    paths = git('diff','--name-only',current_preparation(record)['source_sha'],source_sha).stdout.decode().splitlines()
    if assessment['changed_paths'] != paths:
        raise ReleaseError('assessment does not cover the actual change inventory')
    if not set(git('diff','--name-only',source_sha,head_sha).stdout.decode().splitlines()) <= set(PROJECTIONS):
        raise ReleaseError('preparation contains unassessed changes beyond its main source')
    expected = projected_files({path:git('show',source_sha+':'+path).stdout for path in PROJECTIONS},record['version'])
    for path,data in expected.items():
        if git('show',head_sha+':'+path).stdout != data:
            raise ReleaseError('preparation contains changes beyond exact version projections')
    transition(record,'preparation_reconciled',revision=revision)
    ledger.append(ledger.state)
