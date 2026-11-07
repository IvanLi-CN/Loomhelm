"""Small trusted Actions adapter; never interpret dispatch values as shell code."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from github import GitHub
from policy import ReleaseError


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['bind','outputs','recover']);p.add_argument('--record',type=Path,required=True);p.add_argument('--directory',type=Path)
    a=p.parse_args();r=json.loads(a.record.read_text())
    if a.action=='bind' and r['state']=='prepared':
        api=GitHub(os.environ['GITHUB_REPOSITORY'])
        owner=os.environ['GITHUB_REPOSITORY'].split('/')[0]
        matches=[v for v in api.api('pulls?state=closed&head='+owner+':'+r['branch']) if v['merged_at'] and v['head']['sha']==r['preparation_sha']]
        if len(matches)!=1:raise ReleaseError('preparation PR not exactly merged')
        subprocess.run(['scripts/product-release','bind','--identity',r['id'],'--source-sha',matches[0]['merge_commit_sha']],check=True)
    elif a.action=='outputs':
        if r['state'] not in ('bound','staged','frozen','completed'):raise ReleaseError('identity is not buildable/recoverable')
        with open(os.environ['GITHUB_OUTPUT'],'a') as out:
            out.write('record='+json.dumps(r,separators=(',',':'))+'\nsha='+r['merge_sha']+'\nbuild='+str(r['state']=='bound').lower()+'\n')
    elif a.action=='recover':
        a.directory.mkdir(parents=True,exist_ok=True)
        # Frozen original build run is authoritative. Failed/expired download may
        # still recover entirely from durable draft assets; publish reconciles it.
        run=next((e.get('build_run_id') for e in r['events'] if e['kind']=='staged'),None)
        if run and str(run).isdigit():
            subprocess.run(['gh','run','download',str(run),'--repo',os.environ['GITHUB_REPOSITORY'],'--pattern','product-*','--dir',str(a.directory)],check=False)
            # gh puts each artifact in its own child directory.
            for directory in list(a.directory.iterdir()):
                if directory.is_dir():
                    for path in directory.iterdir():
                        destination=a.directory/path.name
                        if destination.exists():raise ReleaseError('duplicate original artifact')
                        path.rename(destination)
            subprocess.run(['gh','run','download',str(run),'--repo',os.environ['GITHUB_REPOSITORY'],'--name','release-inventory','--dir',str(a.directory)],check=False)
        # Metadata was frozen too; a missing local checksum/manifest is fetched
        # directly from the draft by publish, never regenerated in recovery.

if __name__=='__main__': main()
