#!/usr/bin/env python3
"""Manual product release entrypoint. A recovery reads a reservation, never a target."""
import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from policy import ReleaseError, Version, canonical, digest, reserve
from ledger import Ledger, event, git, transition
from github import GitHub

ROOT = Path(__file__).resolve().parents[2]
PROJECTIONS = ('VERSION','clients/typescript/package.json','web/package.json','bun.lock')


def contract():
    value = json.loads((ROOT/'.github/release-contract.json').read_text())
    expected = dict(schema_version=1, policy='loomhelm-manual-v1', release_unit='loomhelm',
        target='semver-final-or-prerelease-without-build-metadata', baseline='verified-public-completed-final',
        ledger_ref='refs/heads/release-ledger', tag_prefix='v', single_active_reservation=True,
        notification_transport='github-issue', compatibility={'default':'exact-version','allow':[]})
    artifacts = {'server-linux-amd64.tar.gz','go-client-darwin-arm64.tar.gz','go-client-linux-amd64.tar.gz','ts-client-darwin-arm64.tar.gz','ts-client-linux-amd64.tar.gz','web.tar.gz'}
    if set(value) != set(expected) | {'artifacts'} or any(value.get(key) != expected[key] for key in expected) or len(value['artifacts']) != len(artifacts) or set(value['artifacts']) != artifacts:
        raise ReleaseError('unsupported or incomplete executable release policy')
    return value


def policy_hash():
    return digest(dict(release=contract(), quality_gates=json.loads((ROOT/'.github/quality-gates.json').read_text())))


def claim_build(ledger, record, run_id, attempt):
    if record['state'] != 'bound':
        return
    if not str(run_id).isdigit() or not str(attempt).isdigit():
        raise ReleaseError('an authoritative Actions run and attempt are required')
    if not record.get('build_source'):
        transition(record, 'build_claim', run_id=str(run_id), attempt=str(attempt))
        ledger.append(ledger.state)


def project(version):
    Version(version)
    (ROOT/'VERSION').write_text(version+'\n')
    for name in PROJECTIONS[1:3]:
        path = ROOT/name
        obj = json.loads(path.read_text())
        obj['version'] = version
        path.write_text(json.dumps(obj,indent=2)+'\n')
    path = ROOT/'bun.lock'
    text, count = re.subn(r'("web":\s*\{\s*"name":\s*"@loomhelm/web",\s*"version":\s*")[^"]+', lambda m:m[1]+version, path.read_text(),count=1)
    if count != 1:
        raise ReleaseError('unknown Bun workspace projection shape')
    path.write_text(text)


def check_projections():
    version = (ROOT/'VERSION').read_text().strip()
    if version == 'dev':
        return version
    Version(version)
    for name in PROJECTIONS[1:3]:
        obj = json.loads((ROOT/name).read_text())
        if obj['version'] != version:
            raise ReleaseError('version projection drift: '+name)
    if not re.search(r'"web":\s*\{\s*"name":\s*"@loomhelm/web",\s*"version":\s*"'+re.escape(version)+'"', (ROOT/'bun.lock').read_text()):
        raise ReleaseError('Bun workspace version drift')
    return version


def prerequisites(api, require_sign=True, detailed=False):
    # Contents-readable facts are sufficient for runtime routing. Actual source
    # signatures, merged PRs and exact-SHA checks are verified at each boundary.
    checks = json.loads((ROOT/'.github/quality-gates.json').read_text())['required_checks']
    branch = api.api('branches/main')
    if not branch or branch.get('name') != 'main' or branch.get('protected') is not True:
        raise ReleaseError('main protection is absent or unreadable')
    visible = branch.get('protection',{}).get('required_status_checks',{})
    if visible.get('enforcement_level') != 'everyone' or not set(checks) <= set(visible.get('contexts',[])):
        raise ReleaseError('main required-check protection does not match declared quality gates')
    if detailed:
        # Owner-side delivery audit uses the owner's existing gh login. Do not
        # demand administrator-only visibility from a workflow token.
        protection = api.main_protection()
        if not protection or not all(protection.get(k) is True for k in ('requiresApprovingReviews','requiresCommitSignatures','isAdminEnforced','requiresStatusChecks','requiresStrictStatusChecks')) or any(protection.get(k) is not False for k in ('allowsForcePushes','allowsDeletions')) or not set(checks) <= set(protection.get('requiredStatusCheckContexts',[])):
            raise ReleaseError('main PR/signature/required-check protection does not match declared quality gates')


def trusted_baseline(api, records):
    finals = []
    for record in records.values():
        if record['state'] == 'completed':
            release = api.release(record['version'])
            if not release or release['draft'] or release['prerelease'] != bool(Version(record['version']).pre):
                raise ReleaseError('completed baseline publication missing')
            api.verify_tag(record['version'], record['merge_sha'], required=True)
            api.verify_assets(release, record['artifacts'])
            api.match_release(release, record)
            if not Version(record['version']).pre:
                finals.append(Version(record['version']))
    return max(finals).text if finals else None


def bind(api, record, merge_sha):
    pulls = api.api('commits/'+merge_sha+'/pulls?per_page=100')
    matches = [p for p in pulls if p['merged_at'] and p['merge_commit_sha'] == merge_sha and p['base']['ref'] == 'main' and p['head']['sha'] == record['preparation_sha'] and p['head']['ref'] == record['branch']]
    if len(matches) != 1:
        raise ReleaseError('missing exact-head merged preparation PR')
    git('fetch','--no-tags','origin',merge_sha)
    git('fetch','--no-tags','origin',record['intent']['source_sha'])
    # Merge must contain precisely the approved version projections, no hidden code.
    changed = git('diff','--name-only',record['intent']['source_sha'],merge_sha).stdout.decode().splitlines()
    if not set(changed) <= set(PROJECTIONS):
        raise ReleaseError('source boundary drift during version preparation')
    for name in PROJECTIONS:
        if git('show',f'{merge_sha}:{name}').stdout != git('show',f'{record["preparation_sha"]}:{name}').stdout:
            raise ReleaseError('version projection changed at merge')
    transition(record,'bound',merge_sha=merge_sha,pr=matches[0]['number'])


def inventory(directory, record):
    policy = contract()
    required = set(policy['artifacts']) | {'release-manifest.json','SHA256SUMS'}
    paths = list(directory.iterdir())
    if {p.name for p in paths} != required or any(not p.is_file() or p.is_symlink() for p in paths):
        raise ReleaseError('incomplete or unsafe product artifact set')
    manifest = json.loads((directory/'release-manifest.json').read_text())
    Version(record['version'])
    if record.get('fixture'):
        raise ReleaseError('PR fixtures cannot be published')
    if (manifest['version'],manifest['source_sha'],manifest['identity'],manifest['policy_hash']) != (record['version'],record['merge_sha'],record['id'],record['intent']['policy_hash']):
        raise ReleaseError('product manifest identity mismatch')
    result = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    if manifest['artifacts'] != {k:v for k,v in result.items() if k not in ('release-manifest.json','SHA256SUMS')}:
        raise ReleaseError('product digest drift')
    expected = ''.join(f'{value}  {name}\n' for name,value in sorted(result.items()) if name != 'SHA256SUMS')
    if (directory/'SHA256SUMS').read_text() != expected:
        raise ReleaseError('checksums drift')
    return result


def publish(api, ledger, record, directory):
    if record['state'] == 'bound':
        frozen = inventory(directory,record)
        transition(record,'staged',artifacts=frozen,build_run_id=record.get('build_source',{}).get('run_id',os.environ.get('GITHUB_RUN_ID')),inventory_run_id=os.environ.get('GITHUB_RUN_ID'))
        ledger.append(ledger.state)
    if record['state'] not in ('staged','frozen','completed'):
        raise ReleaseError('identity is not frozen')
    release = api.existing_release(record) if record['state'] == 'completed' else api.ensure_draft(record)
    # Completed recovery is also verified; it never mutates the version.
    if record['state'] == 'completed':
        if release['draft']:
            raise ReleaseError('completed publication became draft')
        api.verify_tag(record['version'],record['merge_sha'],required=True)
        api.verify_assets(release,record['artifacts'])
        return
    if release['draft']:
        for name, expected in sorted(record['artifacts'].items()):
            local = directory/name
            if not local.is_file():
                # Recovery can use an already durable asset without local originals.
                assets = api.api(f'releases/{release["id"]}/assets?per_page=100')
                matches = [a for a in assets if a['name'] == name]
                if len(matches) != 1 or hashlib.sha256(api.asset_bytes(matches[0])).hexdigest() != expected:
                    raise ReleaseError('frozen original lost; never rebuild: '+name)
            else:
                api.upload(release,name,local,expected)
            transition(record,'uploaded',name=name,digest=expected)
            ledger.append(ledger.state)
        api.verify_assets(release,record['artifacts'])
        if record['state'] == 'staged':
            # Freeze only after all originals have durable draft copies.
            transition(record,'frozen',artifacts=record['artifacts'])
            ledger.append(ledger.state)
        api.verify_tag(record['version'],record['merge_sha'],required=True)
        if not record.get('publication_intent'):
            transition(record,'publication_intent')
            ledger.append(ledger.state)
        api.api('releases/'+str(release['id']),'PATCH',dict(draft=False))
    # Re-read the public record: a lost response must not create a second Release.
    release = api.existing_release(record)
    if release['draft']:
        raise ReleaseError('release is not publicly completed')
    api.verify_tag(record['version'],record['merge_sha'],required=True)
    verified = api.verify_assets(release,record['artifacts'])
    if not record.get('publication_intent'):
        transition(record,'publication_intent')
        ledger.append(ledger.state)
    transition(record,'completed',verified_artifacts=verified)
    ledger.append(ledger.state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['check','audit','project','reserve','prepare','bind','inspect','verify','publish','notify','terminate','claim-build'])
    parser.add_argument('--target')
    parser.add_argument('--identity')
    parser.add_argument('--source-sha')
    parser.add_argument('--directory',type=Path)
    parser.add_argument('--reason')
    args = parser.parse_args()
    os.chdir(ROOT)
    if args.action == 'check':
        contract()
        print(check_projections()); return
    if args.action == 'project':
        project(args.target); return
    repo = os.environ.get('GITHUB_REPOSITORY')
    api = GitHub(repo)
    prerequisites(api,detailed=args.action == 'audit' and os.environ.get('GITHUB_ACTIONS') != 'true')
    if args.action == 'audit':
        print(json.dumps(dict(main_protected=True,required_contexts='passed',detailed_policy='owner-audit-required' if os.environ.get('GITHUB_ACTIONS') == 'true' else 'passed',authentication='existing-gh-or-workflow-token',publication='not-attempted',reservation='not-created'))); return
    ledger = Ledger(api=api)
    records = ledger.read()['releases']
    checks = json.loads((ROOT/'.github/quality-gates.json').read_text())['required_checks']
    if args.action == 'reserve':
        sha = args.source_sha
        if not sha or not re.fullmatch('[0-9a-f]{40}',sha):
            raise ReleaseError('exact source SHA required')
        api.verify_source(sha,checks)
        # Resolve once; a retried symbolic intent must not re-read a new baseline.
        same = [r for r in records.values() if r['intent']['target'] == args.target and r['intent']['source_sha'] == sha and r['intent']['policy_hash'] == policy_hash() and r['intent']['owner'] == os.environ['GITHUB_ACTOR'] and r['state'] != 'terminated']
        baseline = same[0]['intent']['baseline'] if same else trusted_baseline(api,records)
        record = reserve(records,args.target,sha,policy_hash(),os.environ['GITHUB_ACTOR'],baseline)
        if record['id'] not in records:
            event(record,'reserved',run=os.environ.get('GITHUB_RUN_ID'),attempt=os.environ.get('GITHUB_RUN_ATTEMPT'))
            records[record['id']] = record
            ledger.append(ledger.state)
    else:
        if args.identity not in records:
            raise ReleaseError('unknown release identity')
        record = records[args.identity]
        if record['intent']['policy_hash'] != policy_hash():
            raise ReleaseError('policy differs from reserved identity')
        if args.action == 'prepare':
            if record['state'] in ('bound','staged','frozen','completed'):
                print(json.dumps(record,sort_keys=True)); return
            if record['state'] == 'reserved':
                if git('status','--porcelain').stdout:
                    raise ReleaseError('preparation checkout must be clean')
                if git('rev-parse','HEAD').stdout.decode().strip() != record['intent']['source_sha']:
                    raise ReleaseError('preparation checkout source mismatch')
                branch = 'th/release-'+record['version']+'-'+record['id'][:12]
                existing = git('ls-remote','--exit-code','origin','refs/heads/'+branch,check=False)
                if existing.returncode not in (0,2):
                    raise ReleaseError('preparation branch authority unavailable')
                project(record['version'])
                git('add','--',*PROJECTIONS)
                expected_tree = git('write-tree').stdout.decode().strip()
                sha = existing.stdout.decode().split()[0] if existing.returncode == 0 else None
                if sha is None:
                    api.api('git/refs','POST',dict(ref='refs/heads/'+branch,sha=record['intent']['source_sha']))
                    sha = record['intent']['source_sha']
                if sha == record['intent']['source_sha']:
                    sha = api.signed_commit(branch,sha,{name:(ROOT/name).read_bytes() for name in PROJECTIONS},'chore(release): prepare product '+record['version'])
                git('fetch','--no-tags','origin',sha)
                api.verify_record_commit(sha)
                if git('rev-parse',sha+'^{tree}').stdout.decode().strip() != expected_tree or git('rev-parse',sha+'^').stdout.decode().strip() != record['intent']['source_sha']:
                    raise ReleaseError('existing preparation branch differs from reserved intent')
                transition(record,'prepared',branch=branch,preparation_sha=sha)
                ledger.append(ledger.state)
            prs = api.api('pulls?state=all&head='+repo.split('/')[0]+':'+record['branch'])
            matching = [p for p in prs if p['head']['sha'] == record['preparation_sha'] and p['base']['ref'] == 'main']
            if not matching:
                if os.environ.get('GITHUB_ACTIONS') == 'true':
                    # Keep the repository's existing ban on workflow-created PRs.
                    # The owner or agent opens the ordinary PR with existing gh auth.
                    print('Preparation PR required: https://github.com/'+repo+'/compare/main...'+record['branch']+'?expand=1',file=sys.stderr)
                    summary = os.environ.get('GITHUB_STEP_SUMMARY')
                    if summary:
                        with open(summary,'a') as output:
                            output.write('Open the [version preparation PR](https://github.com/'+repo+'/compare/main...'+record['branch']+'?expand=1), complete its checks, and merge it before running Release with identity `'+record['id']+'`.\n')
                else:
                    api.api('pulls','POST',dict(title='chore(release): prepare '+record['version'],head=record['branch'],base='main',body='Manual product release identity: '+record['id']+'\nTarget: '+record['intent']['target']))
        elif args.action == 'bind':
            if record['state'] == 'prepared':
                api.verify_source(args.source_sha,checks)
                bind(api,record,args.source_sha)
                ledger.append(ledger.state)
            elif record.get('merge_sha') != args.source_sha:
                raise ReleaseError('merge SHA collision')
        elif args.action == 'claim-build':
            claim_build(ledger,record,os.environ.get('GITHUB_RUN_ID'),os.environ.get('GITHUB_RUN_ATTEMPT'))
        elif args.action == 'verify':
            if record['state'] != 'completed':
                raise ReleaseError('Deploy requires a completed product release')
            release = api.existing_release(record)
            if release['draft']:
                raise ReleaseError('Deploy cannot consume a draft release')
            api.verify_tag(record['version'],record['merge_sha'],required=True)
            api.verify_assets(release,record['artifacts'])
            if args.directory and inventory(args.directory,record) != record['artifacts']:
                raise ReleaseError('local deployment bytes differ from completed release')
        elif args.action == 'publish':
            api.verify_source(record['merge_sha'],checks)
            publish(api,ledger,record,args.directory or Path('/nonexistent-frozen-originals'))
        elif args.action == 'terminate':
            published = api.release(record['version'])
            if published and not published['draft']:
                raise ReleaseError('public identity must reconcile completion; cannot terminate publication facts')
            transition(record,'terminated',reason=args.reason)
            ledger.append(ledger.state)
        elif args.action == 'notify':
            # Metadata only; secret-bearing sidecar passes allowlisted stage/run URL.
            stage = os.environ.get('RELEASE_FAILURE_STAGE','Release')
            if stage not in ('Manual Release','Release'):
                raise ReleaseError('unsupported failure stage')
            run_id = os.environ.get('FAILURE_RUN_ID','')
            if not run_id.isdigit():
                raise ReleaseError('invalid failed workflow run')
            transition(record,'notification',status='pending',run=run_id,stage=stage)
            ledger.append(ledger.state)
            try:
                issue = api.notify(record,f'https://github.com/{repo}/actions/runs/{run_id}',stage)
            except ReleaseError:
                transition(record,'notification',status='failed-or-unknown',run=run_id,stage=stage)
                ledger.append(ledger.state)
                raise
            transition(record,'notification',status='delivered',issue=issue['number'],run=run_id,stage=stage)
            ledger.append(ledger.state)
    print(json.dumps(record,sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ReleaseError,KeyError,TypeError) as error:
        print('product-release: '+str(error),file=sys.stderr)
        sys.exit(1)
