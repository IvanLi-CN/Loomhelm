"""Stage a completed release and optionally import its exact offline OCI images.

This adapter does not promote a slot or change a production installation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from github import GitHub
from ledger import Ledger
from policy import ReleaseError, canonical
from product import prerequisites, inventory, ROOT


def persist_receipt(path, receipt):
    data = canonical(receipt)+b'\n'
    if path.is_symlink():
        raise ReleaseError('receipt symlink refused')
    if path.exists():
        if not path.is_file() or path.read_bytes() != data:
            raise ReleaseError('existing stage receipt differs; retain it and use a new output directory')
        return
    try:
        with path.open('xb') as output:
            output.write(data)
    except FileExistsError:
        if path.is_symlink() or not path.is_file() or path.read_bytes() != data:
            raise ReleaseError('stage receipt concurrently changed')


def stage(api, record, directory):
    if record['state'] != 'completed':
        raise ReleaseError('Deploy requires completed release identity')
    release = api.existing_release(record)
    if release['draft']:
        raise ReleaseError('Deploy refuses draft release')
    api.verify_tag(record['version'], record['merge_sha'], required=True)
    api.verify_assets(release, record['artifacts'])
    directory.mkdir(parents=True, exist_ok=True)
    assets = {a['name']: a for a in api.api(f'releases/{release["id"]}/assets?per_page=100')}
    for name, expected in record['artifacts'].items():
        if Path(name).name != name:
            raise ReleaseError('unsafe asset path')
        path = directory/name
        if path.is_symlink():
            raise ReleaseError('unsafe existing artifact path')
        data = path.read_bytes() if path.exists() else api.asset_bytes(assets[name])
        if hashlib.sha256(data).hexdigest() != expected:
            raise ReleaseError('deployment artifact differs from completed release')
        if not path.exists():
            with path.open('xb') as output:
                output.write(data)
    if inventory(directory, record) != record['artifacts']:
        raise ReleaseError('deployment inventory differs from completion')


def import_images(server, record):
    images = json.loads((server/'images/images.json').read_text())
    if set(images) != {'server', 'worker'}:
        raise ReleaseError('offline OCI matrix incomplete')
    result = {}
    for component, info in images.items():
        path = server/'images'/info['archive']
        if Path(info['archive']).name != info['archive'] or hashlib.sha256(path.read_bytes()).hexdigest() != info['sha256']:
            raise ReleaseError('offline image archive drift')
        with tarfile.open(path) as archive:
            index = json.load(archive.extractfile('index.json'))
            manifest_digest = index['manifests'][0]['digest']
            if manifest_digest != info['manifest_digest']:
                raise ReleaseError('OCI manifest identity differs')
            manifest_bytes = archive.extractfile('blobs/sha256/'+manifest_digest.removeprefix('sha256:')).read()
            if 'sha256:'+hashlib.sha256(manifest_bytes).hexdigest() != manifest_digest:
                raise ReleaseError('OCI manifest content differs')
            image_id = json.loads(manifest_bytes)['config']['digest']
        tag = 'loomhelm-local/'+component+':'+record['id']
        subprocess.run(['skopeo','copy','oci-archive:'+str(path),'docker-daemon:'+tag],check=True)
        actual = subprocess.check_output(['docker','image','inspect',tag,'--format','{{.Id}}'],text=True).strip()
        if actual != image_id:
            raise ReleaseError('imported runtime image differs from frozen OCI config')
        result[component] = image_id
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--identity',required=True);p.add_argument('--directory',type=Path,required=True)
    p.add_argument('--import-images',action='store_true');a=p.parse_args()
    os.chdir(ROOT)
    api=GitHub(os.environ['GITHUB_REPOSITORY']);prerequisites(api,require_sign=False)
    ledger=Ledger();state=ledger.read()
    if a.identity not in state['releases']:raise ReleaseError('unknown release identity')
    record=state['releases'][a.identity]
    destination=a.directory.resolve()
    if destination == ROOT or ROOT in destination.parents:raise ReleaseError('stage outside checkout')
    stage(api,record,destination/'product')
    receipt=dict(identity=record['id'],version=record['version'],source_sha=record['merge_sha'],artifacts=record['artifacts'],status='verified',production_deployed=False)
    if a.import_images:
        with tempfile.TemporaryDirectory(prefix='loomhelm-offline-import-') as tmp:
            server=Path(tmp)
            with tarfile.open(destination/'product/server-linux-amd64.tar.gz') as archive:
                archive.extractall(server,filter='data')
            images=import_images(server,record)
            envelope=server/'deployment-envelope.json'
            subprocess.run(['scripts/build-deployment-envelope','--candidate-manifest',str(server/'candidate/candidate-manifest.json'),'--server-image',images['server'],'--worker-image',images['worker'],'--output',str(envelope)],check=True)
            saved=destination/'deployment-envelope.json'
            if saved.is_symlink() or (saved.exists() and saved.read_bytes()!=envelope.read_bytes()):raise ReleaseError('existing deployment envelope differs; reconcile without overwrite')
            if not saved.exists():
                with saved.open('xb') as output:output.write(envelope.read_bytes())
            receipt.update(status='imported',runtime_images=images,envelope_sha256=hashlib.sha256(envelope.read_bytes()).hexdigest())
    # A local stage/import receipt is never a production deployment receipt.
    persist_receipt(destination/'stage-receipt.json',receipt)
    print(json.dumps(receipt))


if __name__=='__main__':
    main()
