"""Observe exact archived bytes on a native runner, without user Codex credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from policy import ReleaseError


def run_version(argv, record):
    result=subprocess.run(argv,capture_output=True,text=True,check=True)
    info=json.loads(result.stdout)
    if (info['version'],info['source_sha'])!=(record['version'],record['merge_sha']):raise ReleaseError('native package identity mismatch')


def smoke(directory,record):
    for path in directory.glob('*.tar.gz'):
        with tempfile.TemporaryDirectory(prefix='loomhelm-package-smoke-') as tmp:
            with tarfile.open(path) as archive:
                # These are the just-built product bytes; reject any escape anyway.
                archive.extractall(tmp,filter='data')
            root=Path(tmp)
            if path.name.startswith('go-client-'):
                run_version([str(root/'loomhelm-connector'),'--version'],record)
            elif path.name.startswith('ts-client-'):
                run_version(['node',str(root/'dist/cli.js'),'--version'],record)
                subprocess.run(['node',str(root/'dist/cli.js'),'skills','list'],check=True,stdout=subprocess.DEVNULL)
            elif path.name.startswith('web'):
                info=json.loads((root/'product-version.json').read_text())
                if info['version']!=record['version'] or info['source_sha']!=record['merge_sha']:raise ReleaseError('Web build identity mismatch')
            elif path.name.startswith('server'):
                for name in ('server','worker','connector'):
                    run_version([str(root/'bin'/name),'--version'],record)
                images=json.loads((root/'images/images.json').read_text())
                for name,entry in images.items():
                    # Same frozen OCI archive, imported for local smoke only.
                    tag='loomhelm-smoke-'+name+':'+record['merge_sha']
                    subprocess.run(['skopeo','copy','oci-archive:'+str(root/'images'/entry['archive']),'docker-daemon:'+tag],check=True)
                    run_version(['docker','run','--rm',tag,'--version'],record)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--directory',type=Path,required=True);p.add_argument('--record',type=Path,required=True);a=p.parse_args();smoke(a.directory,json.loads(a.record.read_text()))
