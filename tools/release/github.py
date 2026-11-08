"""Bound GitHub adapter. All provider reads/writes use gh, never ambient HTTP."""
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from policy import ReleaseError, Version


class GitHub:
    def __init__(self, repo):
        if not repo or len(repo.split('/')) != 2 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./' for c in repo):
            raise ReleaseError('invalid bound GitHub repository')
        self.repo = repo

    def api(self, path, method='GET', body=None, missing=False):
        args = ['gh', 'api', f'repos/{self.repo}/{path}', '--method', method]
        if body is not None:
            args += ['--input', '-']
        result = subprocess.run(args, input=json.dumps(body) if body is not None else None, text=True, capture_output=True)
        if result.returncode:
            if missing and 'HTTP 404' in result.stderr:
                return None
            raise ReleaseError('GitHub authority unavailable: '+result.stderr.strip())
        return json.loads(result.stdout) if result.stdout.strip() else None

    def graphql(self, query, variables):
        result = subprocess.run(['gh','api','graphql','--input','-'],input=json.dumps(dict(query=query,variables=variables)),text=True,capture_output=True)
        if result.returncode:
            raise ReleaseError('GitHub GraphQL authority unavailable: '+result.stderr.strip())
        data = json.loads(result.stdout)
        if data.get('errors'):
            raise ReleaseError('GitHub GraphQL request failed; reconcile before retry')
        return data['data']

    def signed_commit(self, branch, expected, files, message):
        query = 'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid signature{isValid}}}}'
        signoff = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>'
        if os.environ.get('GITHUB_ACTIONS') != 'true':
            result = subprocess.run(['git','var','GIT_COMMITTER_IDENT'],text=True,capture_output=True,check=True)
            signoff = result.stdout.strip().rsplit('>',1)[0]+'>'
        value = self.graphql(query, {'input': dict(branch=dict(repositoryNameWithOwner=self.repo,refName=branch),expectedHeadOid=expected,fileChanges=dict(additions=[dict(path=name,contents=base64.b64encode(data).decode()) for name,data in files.items()]),message=dict(headline=message,body='Signed-off-by: '+signoff))})['createCommitOnBranch']['commit']
        if not (value.get('signature') or {}).get('isValid'):
            raise ReleaseError('platform commit signature unavailable; stop and reconcile')
        self.verify_record_commit(value['oid'])
        return value['oid']

    def verify_record_commit(self, sha):
        value = self.api('commits/'+sha)
        if value['sha'] != sha or not value['commit']['verification']['verified'] or (value.get('author') or {}).get('login') not in ('github-actions[bot]',self.repo.split('/')[0]):
            raise ReleaseError('release record is not a verified repository-owner or Actions commit')

    def main_protection(self):
        owner,name = self.repo.split('/')
        return self.graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){ref(qualifiedName:"refs/heads/main"){branchProtectionRule{requiresApprovingReviews requiresCommitSignatures isAdminEnforced allowsForcePushes allowsDeletions requiresStatusChecks requiresStrictStatusChecks requiredStatusCheckContexts}}}}',dict(owner=owner,name=name))['repository']['ref']['branchProtectionRule']

    def require_empty_release_history(self):
        page = 1
        while True:
            releases = self.api(f'releases?per_page=100&page={page}')
            if any((r.get('body') or '').startswith('Loomhelm release identity: ') for r in releases):
                raise ReleaseError('ledger missing but product publication history exists; restore records, never bootstrap')
            if len(releases) < 100:
                break
            page += 1
        refs = self.api('git/matching-refs/heads/th/release-')
        for ref in refs:
            match = re.fullmatch(r'refs/heads/th/release-(.+)-[0-9a-f]{12}', ref['ref'])
            if not match:
                continue
            try:
                Version(match[1])
            except ReleaseError:
                continue
            raise ReleaseError('ledger missing but preparation refs exist; restore records, never bootstrap')

    def release(self, version):
        return self.api('releases/tags/v'+version, missing=True)

    def verify_tag(self, version, sha, required=False):
        value = self.api('git/ref/tags/v'+version, missing=True)
        if value is None:
            if required:
                raise ReleaseError('release tag missing')
            return
        obj = value['object']
        seen = set()
        while obj['type'] == 'tag':
            if obj['sha'] in seen:
                raise ReleaseError('tag cycle')
            seen.add(obj['sha'])
            obj = self.api('git/tags/'+obj['sha'])['object']
        if obj['type'] != 'commit' or obj['sha'] != sha:
            raise ReleaseError('tag belongs to a different source identity')

    def ensure_tag(self, version, sha):
        self.verify_tag(version, sha)
        if self.api("git/ref/tags/v"+version, missing=True) is None:
            # A lost create response is reconciled on retry; never replace a ref.
            self.api("git/refs", "POST", dict(ref="refs/tags/v"+version, sha=sha))
        self.verify_tag(version, sha, required=True)

    def issues(self):
        result = []
        page = 1
        while True:
            batch = self.api(f"issues?state=all&per_page=100&page={page}")
            result.extend(batch)
            if len(batch) < 100:
                return result
            page += 1

    def verify_seed(self, sha):
        # The seed is storage ancestry, not released product source. It needs
        # signed main ancestry, but no PR/check read permission in the notifier.
        commit = self.api('commits/'+sha)
        if commit['sha'] != sha or not commit['commit']['verification']['verified']:
            raise ReleaseError('unverified ledger seed')
        if self.api('compare/'+sha+'...main')['status'] not in ('ahead','identical'):
            raise ReleaseError('ledger seed is outside main history')

    def verify_source(self, sha, required_checks):
        commit = self.api('commits/'+sha)
        if commit['sha'] != sha or not commit['commit']['verification']['verified']:
            raise ReleaseError('unverified source commit')
        comparison = self.api('compare/'+sha+'...main')
        if comparison['status'] not in ('ahead','identical'):
            raise ReleaseError('source is outside main history')
        pulls = self.api('commits/'+sha+'/pulls?per_page=100')
        if not any(p.get('merged_at') and p.get('merge_commit_sha') == sha and p.get('base',{}).get('ref') == 'main' for p in pulls):
            raise ReleaseError('source has no exact merged main PR')
        checks = []
        page = 1
        while True:
            batch = self.api('commits/'+sha+f'/check-runs?per_page=100&page={page}')['check_runs']
            checks.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        for name in required_checks:
            matches = [c for c in checks if c['name'] == name]
            if not matches or matches[0]['head_sha'] != sha or matches[0]['conclusion'] != 'success' or matches[0]['status'] != 'completed' or matches[0]['app']['slug'] != 'github-actions':
                raise ReleaseError('source check missing or unsuccessful: '+name)

    def asset_bytes(self, asset):
        result = subprocess.run(['gh','api',f'repos/{self.repo}/releases/assets/{asset["id"]}','-H','Accept: application/octet-stream'], capture_output=True)
        if result.returncode:
            raise ReleaseError('cannot download frozen asset')
        return result.stdout

    def verify_assets(self, release, inventory):
        assets = {a['name']: a for a in self.api(f'releases/{release["id"]}/assets?per_page=100')}
        if set(assets) != set(inventory):
            raise ReleaseError('Release asset names differ from the frozen inventory')
        for name, expected in inventory.items():
            if name not in assets or hashlib.sha256(self.asset_bytes(assets[name])).hexdigest() != expected:
                raise ReleaseError('missing or conflicting frozen asset: '+name)
        return inventory

    def existing_release(self, record):
        self.verify_tag(record['version'], record['merge_sha'], required=True)
        release = self.release(record['version'])
        if not release:
            raise ReleaseError('recorded Release missing; verification never creates one')
        self.match_release(release, record)
        return release

    @staticmethod
    def match_release(release, record):
        if release.get('body') != 'Loomhelm release identity: '+record['id'] or release.get('target_commitish') != record['merge_sha'] or release.get('prerelease') != ('-' in record['version']):
            raise ReleaseError('Release belongs to another identity')

    def ensure_draft(self, record):
        self.verify_tag(record['version'], record['merge_sha'])
        release = self.release(record['version'])
        marker = 'Loomhelm release identity: '+record['id']
        if release:
            self.match_release(release, record)
            return release
        self.ensure_tag(record['version'], record['merge_sha'])
        return self.api('releases','POST',dict(tag_name='v'+record['version'],target_commitish=record['merge_sha'],name='Loomhelm '+record['version'],body=marker,draft=True,prerelease='-' in record['version']))

    def upload(self, release, name, path, expected):
        if Path(path).name != name or hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected:
            raise ReleaseError('local artifact differs from frozen inventory')
        assets = self.api(f'releases/{release["id"]}/assets?per_page=100')
        for asset in assets:
            if asset['name'] == name:
                if hashlib.sha256(self.asset_bytes(asset)).hexdigest() != expected:
                    raise ReleaseError('existing asset conflict; never clobber')
                return
        if not release['draft']:
            raise ReleaseError('cannot append assets to a published release')
        # gh upload has no clobber. An ambiguous failure is reconciled by the next run.
        result = subprocess.run(['gh','release','upload',release['tag_name'],str(path),'--repo',self.repo], capture_output=True)
        if result.returncode:
            raise ReleaseError('asset upload uncertain; reconcile the same identity')

    def notify(self, record, run_url, stage):
        marker = '<!-- loomhelm-release:'+record['id']+' -->'
        issues = self.issues()
        body = f'{marker}\nProduct release {record["version"]}\nIdentity: {record["id"]}\nStage: {stage}\nRun: {run_url}\nRecovery: rerun Release with this identity; do not allocate a successor.'
        matches = [i for i in issues if marker in (i.get('body') or '') and 'pull_request' not in i]
        if len(matches) > 1:
            raise ReleaseError('ambiguous notification identity')
        if matches:
            return self.api('issues/'+str(matches[0]['number']),'PATCH',dict(body=body))
        return self.api('issues','POST',dict(title='Product release failed: '+record['version'],body=body))
