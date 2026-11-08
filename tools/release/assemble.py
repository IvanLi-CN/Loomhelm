import argparse
import hashlib
import json
from pathlib import Path
from policy import ReleaseError, canonical, digest
from product import contract, inventory


def assemble(directory, record):
    files = list(directory.iterdir())
    if {p.name for p in files} != set(contract()['artifacts']) or any(p.is_symlink() or not p.is_file() for p in files):
        raise ReleaseError('all native product partitions are required')
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    manifest=dict(schema_version=1,identity=record['id'],version=record['version'],source_sha=record['merge_sha'],policy_hash=record['intent']['policy_hash'],artifacts=hashes,build_run_id=record.get('build_source',{}).get('run_id'),build_attempt=record.get('build_source',{}).get('attempt'))
    (directory/'release-manifest.json').write_bytes(canonical(manifest)+b'\n')
    hashes['release-manifest.json']=hashlib.sha256((directory/'release-manifest.json').read_bytes()).hexdigest()
    (directory/'SHA256SUMS').write_text(''.join(f'{value}  {name}\n' for name,value in sorted(hashes.items())))
    inventory(directory,record)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--record',type=Path,required=True);p.add_argument('--directory',type=Path,required=True)
    a=p.parse_args();assemble(a.directory,json.loads(a.record.read_text()))
