"""Build one frozen product partition on its native runner, from a clean SHA."""
import argparse
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
from policy import ReleaseError, canonical
from product import ROOT, check_projections


def run(*args, **kwargs):
    subprocess.run(args,check=True,**kwargs)


@contextmanager
def oci_builder():
    # A task-owned container driver supports OCI export on stock Actions hosts.
    with tempfile.TemporaryDirectory(prefix='loomhelm-oci-') as owner:
        name = Path(owner).name.lower().replace('_', '-')
        run('docker', 'buildx', 'create', '--name', name, '--driver', 'docker-container')
        try:
            yield name
        finally:
            run('docker', 'buildx', 'rm', name)


def archive(source, output, epoch):
    with output.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as tar:
        def normalize(info):
            info.uid=info.gid=0
            info.uname=info.gname=''
            info.mtime=epoch
            return info
        tar.add(source,arcname='.',filter=normalize)


def build(record, part, output):
    os.chdir(ROOT)
    sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    fixture = record.get('fixture') is True and record['id'] == '0'*64 and record['version'] == '0.0.0-ci'
    projected = check_projections()
    if record['state']!='bound' or record['merge_sha']!=sha or (not fixture and (projected == 'dev' or projected!=record['version'])):
        raise ReleaseError('build source/identity mismatch')
    # PR-only synthetic version proves formal guards without allocating a release.
    # Real publication records cannot enable this path or use this version source.
    os.environ.pop('LOOMHELM_FIXTURE_BUILD_VERSION', None)
    if fixture:
        os.environ['LOOMHELM_FIXTURE_BUILD_VERSION'] = record['version']
    if subprocess.check_output(['git','status','--porcelain']):
        raise ReleaseError('build requires a clean source checkout')
    if output.exists(): raise ReleaseError('refusing to overwrite product output')
    output.mkdir(parents=True)
    epoch=int(subprocess.check_output(['git','show','-s','--format=%ct','HEAD']))
    machine=('darwin' if platform.system()=='Darwin' else 'linux')+'-'+({'arm64':'arm64','aarch64':'arm64','x86_64':'amd64'}[platform.machine()])
    with tempfile.TemporaryDirectory(prefix='loomhelm-product-') as tmp:
        stage=Path(tmp)
        if part=='server':
            if machine!='linux-amd64': raise ReleaseError('server requires native Linux amd64')
            candidate=stage/'candidate'
            run('scripts/build-candidate','--source-sha',sha,'--output',str(candidate))
            archive(candidate/'web',output/'web.tar.gz',epoch)
            client=stage/'client';client.mkdir()
            shutil.copy2(candidate/'bin/connector',client/'loomhelm-connector')
            archive(client,output/'go-client-linux-amd64.tar.gz',epoch)
            migration=stage/'loomhelm-migrate'
            flags=f'-s -w -buildid= -X github.com/IvanLi-CN/Loomhelm/internal/buildinfo.Version={record["version"]} -X github.com/IvanLi-CN/Loomhelm/internal/buildinfo.SourceSHA={sha}'
            run('go','build','-trimpath','-buildvcs=false','-ldflags',flags,'-o',str(migration),'./internal/platform/database/cmd/migrate',env=dict(os.environ,CGO_ENABLED='0'))
            images= stage/'images';images.mkdir()
            receipts={}
            with oci_builder() as builder:
                for component in ('server','worker'):
                    context=stage/component;context.mkdir()
                    shutil.copy2(candidate/'bin'/component,context/component)
                    shutil.copy2('/etc/ssl/certs/ca-certificates.crt',context/'ca-certificates.crt')
                    shutil.copy2(migration,context/'loomhelm-migrate')
                    (context/'Dockerfile').write_text(f'FROM scratch\nCOPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt\nCOPY {component} /{component}\nCOPY loomhelm-migrate /loomhelm-migrate\nUSER 65532:65532\nENTRYPOINT ["/{component}"]\n')
                    path=images/(component+'.oci.tar')
                    run('docker','buildx','build','--builder',builder,'--platform','linux/amd64','--provenance=false','--output','type=oci,dest='+str(path),str(context))
                    with tarfile.open(path) as tar:
                        index=json.load(tar.extractfile('index.json'))
                        receipts[component]=dict(archive=path.name,manifest_digest=index['manifests'][0]['digest'],sha256=hashlib.sha256(path.read_bytes()).hexdigest())
                    # Load the same OCI artifact for the native smoke test, no rebuild.
            (images/'images.json').write_bytes(canonical(receipts)+b'\n')
            bundle=stage/'server-package';bundle.mkdir()
            (bundle/'bin').mkdir()
            shutil.copy2(migration,bundle/'bin/loomhelm-migrate')
            shutil.copytree(candidate,bundle/'candidate')
            shutil.copytree(images,bundle/'images')
            archive(bundle,output/'server-linux-amd64.tar.gz',epoch)
        elif part=='go-client':
            if machine!='darwin-arm64': raise ReleaseError('Go macOS package requires native macOS arm64')
            flags=f'-s -w -buildid= -X github.com/IvanLi-CN/Loomhelm/internal/buildinfo.Version={record["version"]} -X github.com/IvanLi-CN/Loomhelm/internal/buildinfo.SourceSHA={sha}'
            run('go','build','-trimpath','-buildvcs=false','-ldflags',flags,'-o',str(stage/'loomhelm-connector'),'./cmd/connector')
            archive(stage,output/f'go-client-{machine}.tar.gz',epoch)
        elif part=='ts-client':
            if machine not in ('darwin-arm64','linux-amd64'): raise ReleaseError('unsupported TS native target')
            run('bun','install','--cwd','skills','--frozen-lockfile','--ignore-scripts','--backend=copy')
            run('bun','install','--cwd','skills/multi-task-flow','--frozen-lockfile','--ignore-scripts','--backend=copy')
            run('bun','run','--cwd','skills/multi-task-flow','build')
            run('bun','install','--cwd','clients/typescript','--frozen-lockfile','--ignore-scripts','--backend=copy')
            run('bun','run','--cwd','clients/typescript','build')
            shutil.copytree(ROOT/'clients/typescript/src',stage/'src')
            shutil.copytree(ROOT/'clients/typescript/toolkit',stage/'toolkit')
            shutil.copy2(ROOT/'clients/typescript/package.json',stage/'package.json')
            shutil.copy2(ROOT/'clients/typescript/bun.lock',stage/'bun.lock')
            metadata=json.loads((stage/'package.json').read_text())
            if fixture:
                metadata['version']=record['version']
                (stage/'package.json').write_text(json.dumps(metadata,indent=2)+'\n')
            info=dict(version=record['version'],source_sha=sha,policy='loomhelm-manual-v1')
            # Freeze identity into the delivered TS source, never edit the checkout.
            (stage/'src/build-info.ts').write_text('export const buildInfo = Object.freeze('+json.dumps(info)+');\n')
            # Bun's root lock omits the root package version. Frozen install proves
            # dependency consistency; package.json and source stamp own identity.
            run('bun','install','--cwd',str(stage),'--frozen-lockfile','--production','--ignore-scripts','--backend=copy')
            for relative in ('skills/node_modules','skills/multi-task-flow/node_modules'):
                shutil.copytree(ROOT/relative,stage/'toolkit'/relative)
            archive(stage,output/f'ts-client-{machine}.tar.gz',epoch)
        else: raise ReleaseError('unknown build partition')


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--record',type=Path,required=True)
    p.add_argument('--part',choices=['server','go-client','ts-client'],required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    build(json.loads(a.record.read_text()),a.part,a.output.resolve())
