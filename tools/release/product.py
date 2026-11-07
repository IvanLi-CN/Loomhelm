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
PROJECTIONS = ('VERSION','clients/typescript/package.json','clients/typescript/package-lock.json','web/package.json','bun.lock')


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


def project(version):
    Version(version)
    (ROOT/'VERSION').write_text(version+'\n')
    for name in PROJECTIONS[1:4]:
        path = ROOT/name
        obj = json.loads(path.read_text())
        obj['version'] = version
        if name.endswith('package-lock.json'):
            obj['packages']['']['version'] = version
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
    for name in PROJECTIONS[1:4]:
        obj = json.loads((ROOT/name).read_text())
        if obj['version'] != version or (name.endswith('package-lock.json') and obj['packages']['']['version'] != version):
            raise ReleaseError('version projection drift: '+name)
    if not re.search(r'"web":\s*\{\s*"name":\s*"@loomhelm/web",\s*"version":\s*"'+re.escape(version)+'"', (ROOT/'bun.lock').read_text()):
        raise ReleaseError('Bun workspace version drift')
    return version


def prerequisites(api, require_sign=True):
    if require_sign and not os.environ.get('RELEASE_SIGNING_KEY_ID'):
        raise ReleaseError('RELEASE_SIGNING_KEY_ID is required')
    # Effective rules, including rulesets. Empty/unreadable rules fail closed.
    for branch in ('main','release-ledger'):
        rules = api.api('rules/branches/'+branch)
        types = {r['type'] for r in rules}
        if not {'required_signatures','non_fast_forward','deletion'} <= types:
            raise ReleaseError('protected signed branch prerequisites missing: '+branch)
        if branch == 'main' and 'pull_request' not in types:
            raise ReleaseError('main must require pull requests')
    rulesets = api.api('rulesets?per_page=100')
    protected = False
    for summary in rulesets:
        ruleset = api.api('rulesets/'+str(summary['id']))
        includes = ruleset.get('conditions',{}).get('ref_name',{}).get('include',[])
        excludes = ruleset.get('conditions',{}).get('ref_name',{}).get('exclude',[])
        if ruleset['target'] == 'tag' and ruleset['enforcement'] == 'active' and not excludes and ('refs/tags/v*' in includes or '~ALL' in includes):
            protected = {'update','deletion'} <= {r['type'] for r in ruleset['rules']}
            if protected:
                break
    if not protected:
        raise ReleaseError('immutable product tag protection is required')


def trusted_baseline(api, records):
    finals = []
    for record in records.values():
        if record['state'] == 'completed' and not Version(record['version']).pre:
            release = api.release(record['version'])
            if not release or release['draft'] or release['prerelease']:
                raise ReleaseError('completed baseline publication missing')
            api.verify_tag(record['version'], record['merge_sha'], required=True)
            api.verify_assets(release, record['artifacts'])
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
        transition(record,'staged',artifacts=frozen,build_run_id=os.environ.get('GITHUB_RUN_ID'))
        ledger.append(ledger.state)
    if record['state'] not in ('staged','frozen','completed'):
        raise ReleaseError('identity is not frozen')
    release = api.ensure_draft(record)
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
        api.api('releases/'+str(release['id']),'PATCH',dict(draft=False))
    # Re-read the public record: a lost response must not create a second Release.
    release = api.ensure_draft(record)
    if release['draft']:
        raise ReleaseError('release is not publicly completed')
    api.verify_tag(record['version'],record['merge_sha'],required=True)
    verified = api.verify_assets(release,record['artifacts'])
    transition(record,'completed',verified_artifacts=verified)
    ledger.append(ledger.state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['check','project','reserve','prepare','bind','inspect','verify','publish','notify','terminate'])
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
    prerequisites(api, require_sign=args.action not in ('inspect','verify'))
    if args.action not in ('inspect','verify'):
        git('config','user.signingkey',os.environ['RELEASE_SIGNING_KEY_ID'])
    ledger = Ledger()
    records = ledger.read()['releases']
    checks = json.loads((ROOT/'.github/quality-gates.json').read_text())['required_checks']
    if args.action == 'reserve':
        sha = args.source_sha
        if not sha or not re.fullmatch('[0-9a-f]{40}',sha):
            raise ReleaseError('exact source SHA required')
        api.verify_source(sha,checks)
        # Resolve once; a retried symbolic intent must not re-read a new baseline.
        same = [r for r in records.values() if r['intent']['target'] == args.target and r['intent']['source_sha'] == sha and r['intent']['policy_hash'] == digest(contract()) and r['intent']['owner'] == os.environ['GITHUB_ACTOR'] and r['state'] != 'terminated']
        baseline = same[0]['intent']['baseline'] if same else trusted_baseline(api,records)
        record = reserve(records,args.target,sha,digest(contract()),os.environ['GITHUB_ACTOR'],baseline)
        if record['id'] not in records:
            event(record,'reserved',run=os.environ.get('GITHUB_RUN_ID'),attempt=os.environ.get('GITHUB_RUN_ATTEMPT'))
            records[record['id']] = record
            ledger.append(ledger.state)
    else:
        if args.identity not in records:
            raise ReleaseError('unknown release identity')
        record = records[args.identity]
        if record['intent']['policy_hash'] != digest(contract()):
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
                if existing.returncode == 0:
                    sha = existing.stdout.decode().split()[0]
                    git('fetch','--no-tags','origin','refs/heads/'+branch)
                    git('verify-commit',sha)
                    if git('rev-parse',sha+'^{tree}').stdout.decode().strip() != expected_tree or git('rev-parse',sha+'^').stdout.decode().strip() != record['intent']['source_sha']:
                        raise ReleaseError('existing preparation branch differs from reserved intent')
                else:
                    git('commit','-S','--signoff','-m','chore(release): prepare product '+record['version'])
                    sha = git('rev-parse','HEAD').stdout.decode().strip()
                    result = git('push','--force-with-lease=refs/heads/'+branch+':','origin',f'{sha}:refs/heads/{branch}',check=False)
                    if result.returncode:
                        raise ReleaseError('preparation branch uncertain; reconcile before retry')
                transition(record,'prepared',branch=branch,preparation_sha=sha)
                ledger.append(ledger.state)
            prs = api.api('pulls?state=all&head='+repo.split('/')[0]+':'+record['branch'])
            matching = [p for p in prs if p['head']['sha'] == record['preparation_sha'] and p['base']['ref'] == 'main']
            if not matching:
                api.api('pulls','POST',dict(title='chore(release): prepare '+record['version'],head=record['branch'],base='main',body='Manual product release identity: '+record['id']+'\nTarget: '+record['intent']['target']))
        elif args.action == 'bind':
            if record['state'] == 'prepared':
                api.verify_source(args.source_sha,checks)
                bind(api,record,args.source_sha)
                ledger.append(ledger.state)
            elif record.get('merge_sha') != args.source_sha:
                raise ReleaseError('merge SHA collision')
        elif args.action == 'verify':
            if record['state'] != 'completed':
                raise ReleaseError('Deploy requires a completed product release')
            release = api.ensure_draft(record)
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
