"""Observe exact archived bytes on a native runner, without user Codex credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import uuid
import urllib.request
import urllib.error
from policy import ReleaseError


def run_version(argv, record):
    result=subprocess.run(argv,capture_output=True,text=True,check=True)
    info=json.loads(result.stdout)
    if (info['version'],info['source_sha'])!=(record['version'],record['merge_sha']):raise ReleaseError('native package identity mismatch')


def runtime_smoke(tags, record):
    owner='loomhelm-package-'+uuid.uuid4().hex[:12]
    containers=[]
    subprocess.run(['docker','network','create',owner],check=True,stdout=subprocess.DEVNULL)
    try:
        database=owner+'-db';containers.append(database)
        subprocess.run(['docker','run','-d','--name',database,'--network',owner,'--network-alias','db','-e','POSTGRES_DB=loomhelm','-e','POSTGRES_USER=loomhelm','-e','POSTGRES_PASSWORD=package-smoke-only','postgres:17-alpine'],check=True,stdout=subprocess.DEVNULL)
        for attempt in range(60):
            probe=subprocess.run(['docker','exec',database,'pg_isready','-U','loomhelm'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if probe.returncode==0:break
            time.sleep(1)
        else:raise ReleaseError('native package database did not become ready')
        for component in ('server','worker'):
            name=owner+'-'+component;containers.append(name)
            port=8080 if component=='server' else 8081
            env=['LOOMHELM_HTTP_ADDR=0.0.0.0:8080','LOOMHELM_DATABASE_URL=postgres://loomhelm:package-smoke-only@db:5432/loomhelm?sslmode=disable','LOOMHELM_DRAIN_TOKEN=package-smoke-only','LOOMHELM_ARTIFACT_ROOT=/tmp/artifacts','LOOMHELM_WORKER_HTTP_ADDR=0.0.0.0:8081']
            command=['docker','run','-d','--name',name,'--network',owner,'--tmpfs','/tmp:rw,mode=1777','-p',f'127.0.0.1::{port}']
            for value in env:command+=['-e',value]
            subprocess.run(command+[tags[component]],check=True,stdout=subprocess.DEVNULL)
            bindings=json.loads(subprocess.check_output(['docker','inspect',name,'--format','{{json .NetworkSettings.Ports}}'],text=True))
            base='http://127.0.0.1:'+bindings[str(port)+'/tcp'][0]['HostPort']
            for attempt in range(90):
                try:
                    with urllib.request.urlopen(base+'/readyz',timeout=2) as response:
                        if response.status==200:break
                except (OSError, urllib.error.URLError):pass
                time.sleep(1)
            else:
                subprocess.run(['docker','logs',name],check=False)
                raise ReleaseError('native '+component+' OCI package failed readiness')
            with urllib.request.urlopen(base+'/version',timeout=2) as response:
                info=json.load(response)
            if info['version']!=record['version'] or info['candidate_source_sha']!=record['merge_sha']:
                raise ReleaseError('running service identity differs from archived package')
            if component=='server':
                request=urllib.request.Request(base+'/api/v1/tasks',data=b'{}',headers={'Content-Type':'application/json'},method='POST')
                try:urllib.request.urlopen(request,timeout=2)
                except urllib.error.HTTPError as error:
                    if error.code!=426:raise ReleaseError('server did not reject missing product version')
                else:raise ReleaseError('server accepted a versionless business operation')
    finally:
        for name in reversed(containers):
            subprocess.run(['docker','rm','-f',name],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['docker','network','rm',owner],check=False,stdout=subprocess.DEVNULL)


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
                tags={}
                for name,entry in images.items():
                    # Same frozen OCI archive, imported for local smoke only.
                    tag='loomhelm-smoke-'+name+':'+record['merge_sha']
                    subprocess.run(['skopeo','copy','oci-archive:'+str(root/'images'/entry['archive']),'docker-daemon:'+tag],check=True)
                    run_version(['docker','run','--rm',tag,'--version'],record)
                    tags[name]=tag
                runtime_smoke(tags,record)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--directory',type=Path,required=True);p.add_argument('--record',type=Path,required=True);a=p.parse_args();smoke(a.directory,json.loads(a.record.read_text()))
