import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const version = readFileSync(new URL('../../VERSION', import.meta.url),'utf8').trim();
const source_sha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if (version !== 'dev' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\dA-Za-z-]+(\.[\dA-Za-z-]+)*)?$/.test(version)) throw new Error('Invalid canonical version');
const info = {version, source_sha, policy:'loomhelm-manual-v1'};
writeFileSync(new URL('../../clients/typescript/dist/build-info.js',import.meta.url),`export const buildInfo = Object.freeze(${JSON.stringify(info)});\n`);
