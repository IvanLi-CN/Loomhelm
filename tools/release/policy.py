"""Pure version/identity policy. Never infer an owner target."""
import hashlib
import json
import re
from functools import total_ordering


class ReleaseError(ValueError):
    pass


@total_ordering
class Version:
    def __init__(self, text):
        match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?', text)
        if not match:
            raise ReleaseError('invalid release version (build metadata is unsupported)')
        self.text = text
        self.core = tuple(int(match[i]) for i in range(1, 4))
        self.pre = tuple(match[4].split('.')) if match[4] else ()
        if any(x.isdigit() and len(x) > 1 and x[0] == '0' for x in self.pre):
            raise ReleaseError('prerelease numeric identifier has leading zero')

    def key(self):
        return self.core, not self.pre, tuple((0, int(x)) if x.isdigit() else (1, x) for x in self.pre)

    def __lt__(self, other):
        return self.key() < other.key()

    def __eq__(self, other):
        return isinstance(other, Version) and self.key() == other.key()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def resolve(target, baseline, occupied=(), completed=()):
    if not target:
        raise ReleaseError('release_target is required')
    base = Version(baseline) if baseline else None
    if base and base.pre:
        raise ReleaseError('baseline must be a completed final')
    if target in ('patch', 'minor', 'major'):
        if not base:
            raise ReleaseError('first release requires an explicit full version')
        parts = list(base.core)
        index = ('major', 'minor', 'patch').index(target)
        parts[index] += 1
        parts[index+1:] = [0] * (2-index)
        target = '.'.join(map(str, parts))
    version = Version(target)
    if base and (version <= base or version.core <= base.core):
        raise ReleaseError('target must advance trusted final baseline')
    if completed and version <= max(Version(v) for v in completed):
        raise ReleaseError('target must advance every completed final or prerelease')
    if target in occupied:
        raise ReleaseError('version is already reserved; recover the original identity')
    return target


def reserve(records, target, source_sha, policy_hash, owner, baseline):
    intent = dict(target=target, source_sha=source_sha, policy_hash=policy_hash, owner=owner, baseline=baseline)
    for record in records.values():
        if record['intent'] == intent and record['state'] != 'terminated':
            return record
    if any(r['state'] not in ('completed', 'terminated') for r in records.values()):
        raise ReleaseError('another release identity is active')
    version = resolve(target, baseline, [r['version'] for r in records.values()], [r['version'] for r in records.values() if r['state']=='completed'])
    identity = digest(dict(unit='loomhelm', version=version, **intent))
    return dict(id=identity, version=version, intent=intent, state='reserved', artifacts={}, events=[])
