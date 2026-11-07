"""Small trusted Actions adapter; never interpret dispatch values as shell code."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from github import GitHub
from policy import ReleaseError


def original_build(record, run_id, attempt):
    return record['state']=='bound' and record.get('build_source')==dict(run_id=str(run_id),attempt=str(attempt))


def recover(record, directory, repo):
    directory.mkdir(parents=True,exist_ok=True)
    staged=next((e for e in record['events'] if e['kind']=='staged'),{})
    run=record.get('build_source',{}).get('run_id') or staged.get('build_run_id')
    if run and str(run).isdigit():
        subprocess.run(['gh','run','download',str(run),'--repo',repo,'--pattern','product-*','--dir',str(directory)],check=False)
        for child in list(directory.iterdir()):
            if child.is_dir() and not child.is_symlink():
                for path in child.iterdir():
                    destination=directory/path.name
                    if destination.exists():raise ReleaseError('duplicate original artifact')
                    path.rename(destination)
                child.rmdir()
    metadata_run=staged.get('inventory_run_id') or staged.get('build_run_id')
    if metadata_run and str(metadata_run).isdigit():
        subprocess.run(['gh','run','download',str(metadata_run),'--repo',repo,'--name','release-inventory','--dir',str(directory)],check=False)
    if record['state']=='bound':
        # No inventory was frozen yet: assemble metadata from the original bytes.
        # This never rebuilds native packages; missing originals fail closed.
        from assemble import assemble
        if not (directory/'release-manifest.json').exists():assemble(directory,record)


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
            out.write('record='+json.dumps(r,separators=(',',':'))+'\nsha='+r['merge_sha']+'\nstate='+r['state']+'\nbuild='+str(original_build(r,os.environ.get('GITHUB_RUN_ID'),os.environ.get('GITHUB_RUN_ATTEMPT'))).lower()+'\n')
    elif a.action=='recover':
        recover(r,a.directory,os.environ['GITHUB_REPOSITORY'])

if __name__=='__main__': main()
