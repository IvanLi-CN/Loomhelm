import argparse
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from smoke import run_version
p=argparse.ArgumentParser();p.add_argument('--record',type=Path,required=True);p.add_argument('--directory',type=Path,required=True);a=p.parse_args()
record=json.loads(a.record.read_text())
for archive in a.directory.glob('ts-client-*.tar.gz'):
    with tempfile.TemporaryDirectory(prefix='loomhelm-node-matrix-') as tmp:
        with tarfile.open(archive) as tar:tar.extractall(tmp,filter='data')
        for major in ('22','24'):
            # npm executes the requested official Node binary; package bytes stay fixed.
            run_version(['npx','--yes','--package=node@'+major,'node',str(Path(tmp)/'dist/cli.js'),'--version'],record)

            subprocess.run(['npx','--yes','--package=node@'+major,'node',str(Path(tmp)/'dist/cli.js'),'skills','list'], check=True, stdout=subprocess.DEVNULL)

            subprocess.run(['npx','--yes','--package=node@'+major,'node','-e','require(process.argv[1])',str(Path(tmp)/'dist/toolkit/skills/bin/native/posix.node')], check=True)
