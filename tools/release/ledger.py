"""Signed append-only Git ledger with an exact-ref atomic publication boundary."""
import copy
import json
import os
import subprocess
import tempfile
from pathlib import Path
from policy import ReleaseError, canonical


def git(*args, data=None, env=None, check=True):
    result = subprocess.run(['git', *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, check=False)
    if check and result.returncode:
        raise ReleaseError(result.stderr.decode().strip())
    return result


class Ledger:
    ref = 'refs/heads/release-ledger'

    def __init__(self, remote='origin', signed=True):
        if remote != 'origin':
            raise ReleaseError('ledger must use the bound origin remote')
        self.remote, self.signed = remote, signed
        self.head = None
        self.state = {'schema_version': 1, 'releases': {}}
        self.original = copy.deepcopy(self.state)

    def read(self):
        result = git('ls-remote', '--exit-code', self.remote, self.ref, check=False)
        if result.returncode not in (0, 2):
            raise ReleaseError('ledger authority unavailable')
        self.head = result.stdout.decode().split()[0] if result.returncode == 0 else None
        if self.head:
            git('fetch', '--no-tags', self.remote, self.ref)
            if self.signed:
                for sha in git('rev-list', self.head).stdout.decode().split():
                    git('verify-commit', sha)
            self.state = json.loads(git('show', f'{self.head}:ledger.json').stdout)
            if self.state.get('schema_version') != 1:
                raise ReleaseError('unsupported ledger schema')
        self.original = copy.deepcopy(self.state)
        return self.state

    def append(self, state):
        for identity, old in self.original['releases'].items():
            new = state['releases'].get(identity)
            if new is None or new['events'][:len(old['events'])] != old['events']:
                raise ReleaseError('ledger history cannot be removed or rewritten')
            for field in ('id','version','intent','merge_sha','preparation_sha','branch'):
                if field in old and old[field] != new.get(field):
                    raise ReleaseError('reserved identity field cannot change: '+field)
            if old.get('state') in ('frozen','completed','terminated') and old.get('artifacts') != new.get('artifacts'):
                raise ReleaseError('frozen inventory cannot change')
        for record in state['releases'].values():
            if any(e.get('sequence') != i+1 for i,e in enumerate(record['events'])):
                raise ReleaseError('invalid append-only event sequence')
        # The new tree keeps every historical event; only ledger.json grows.
        with tempfile.TemporaryDirectory(prefix='loomhelm-ledger-') as directory:
            index = str(Path(directory)/'index')
            env = dict(os.environ, GIT_INDEX_FILE=index)
            if self.head:
                git('read-tree', self.head, env=env)
            else:
                git('read-tree', '--empty', env=env)
            blob = git('hash-object', '-w', '--stdin', data=canonical(state)+b'\n').stdout.decode().strip()
            git('update-index', '--add', '--cacheinfo', f'100644,{blob},ledger.json', env=env)
            tree = git('write-tree', env=env).stdout.decode().strip()
            args = ['commit-tree', tree]
            if self.signed:
                args += ['-S']
            if self.head:
                args += ['-p', self.head]
            identity = git('var', 'GIT_COMMITTER_IDENT').stdout.decode().strip().rsplit('>', 1)[0]+'>'
            args += ['-m', 'chore(release): append product identity receipt\n\nSigned-off-by: '+identity]
            commit = git(*args).stdout.decode().strip()
            # Force-with-lease provides CAS, but the graph is always append-only.
            lease = f'--force-with-lease={self.ref}:{self.head or ""}'
            result = git('push', lease, self.remote, f'{commit}:{self.ref}', check=False)
            if result.returncode:
                raise ReleaseError('ledger CAS lost or publication uncertain; reread before retry')
            self.head, self.state = commit, state
            self.original = copy.deepcopy(state)


def event(record, kind, **fields):
    record['events'].append(dict(sequence=len(record['events'])+1, kind=kind, **fields))


def transition(record, kind, **fields):
    allowed = {
        'prepared': ('reserved',), 'bound': ('prepared',),
        'frozen': ('bound',), 'uploaded': ('frozen',),
        'completed': ('frozen',), 'terminated': ('reserved','prepared','bound','frozen'),
        'notification': ('reserved','prepared','bound','frozen','completed','terminated'),
    }
    if kind not in allowed or record['state'] not in allowed[kind]:
        raise ReleaseError('invalid release state transition')
    if kind == 'prepared':
        record.update(branch=fields['branch'], preparation_sha=fields['preparation_sha'])
        record['state'] = kind
    elif kind == 'bound':
        record['merge_sha'] = fields['merge_sha']
        record['state'] = kind
    elif kind == 'frozen':
        if not fields['artifacts']:
            raise ReleaseError('empty frozen inventory')
        record['artifacts'] = fields['artifacts']
        record['state'] = kind
    elif kind == 'completed':
        if fields.get('verified_artifacts') != record['artifacts']:
            raise ReleaseError('completion requires all frozen artifacts verified')
        record['state'] = kind
    elif kind == 'terminated':
        if not fields.get('reason'):
            raise ReleaseError('termination requires a reason')
        record['state'] = kind
    event(record, kind, **fields)
