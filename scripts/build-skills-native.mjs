#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

if (!['darwin','linux'].includes(process.platform)) throw new Error('POSIX adapter supports macOS and Linux');
const version = '22.14.0';
const cache = resolve('.tmp/skills-native');
mkdirSync(cache, { recursive: true });
const archive = resolve(cache, `node-v${version}-headers.tar.gz`);
const base = `https://nodejs.org/dist/v${version}`;
const expected = '715aedf641a024efdeeccd545ce4acdc4759155e08c32efdfe9069921fcfa86b';
if (!existsSync(archive)) execFileSync('curl',['--fail','--location','--silent','--show-error','--connect-timeout','15','--max-time','120',`${base}/node-v${version}-headers.tar.gz`,'--output',archive]);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (digest !== expected) throw new Error('Node header checksum mismatch');
execFileSync('tar',['-xzf',archive,'-C',cache]);
const output = resolve('bin/native/posix.node');
execFileSync(process.env.CC || 'cc', ['-std=c11','-Wall','-Wextra','-Werror','-shared','-fPIC','-DNAPI_VERSION=8',`-I${cache}/node-v${version}/include/node`,...(process.platform==='darwin'?['-undefined','dynamic_lookup']:[]),'bin/native/posix.c','-o',output],{stdio:'inherit'});
writeFileSync(resolve(dirname(output),'build.json'),JSON.stringify({nodeHeaders:version,headersSha256:digest,platform:process.platform,arch:process.arch,sourceSha256:createHash('sha256').update(readFileSync('bin/native/posix.c')).digest('hex')},null,2)+'\n');
