import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('released network gate rejects mismatch before business mutation and preserves local mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loomhelm-version-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'version.js'), await readFile(new URL('../dist/version.js', import.meta.url)));
    await writeFile(join(directory, 'build-info.js'), 'export const buildInfo=Object.freeze({version:"1.2.3",source_sha:"'+'a'.repeat(40)+'",policy:"loomhelm-manual-v1"});');
    const { versionedFetch } = await import(pathToFileURL(join(directory, 'version.js')).href);
    const calls = [];
    const mismatch = async (url, init) => { calls.push([String(url), init]); return Response.json({ version:'1.2.4',policy:'loomhelm-manual-v1' }); };
    await assert.rejects(versionedFetch('https://example.invalid', '/api/v1/tasks', {method:'POST'}, mismatch), /Update the client/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://example.invalid/version');
    const same = async (url, init) => {
      if (String(url).endsWith('/version')) return Response.json({version:'1.2.3',policy:'loomhelm-manual-v1'});
      assert.equal(init.headers.get('X-Loomhelm-Version'),'1.2.3');
      return new Response(null,{status:204});
    };
    assert.equal((await versionedFetch('https://example.invalid', '/api/v1/tasks', {method:'POST'}, same)).status,204);
    await assert.rejects(versionedFetch('https://example.invalid', 'https://other.invalid', {}, same), /Cross-origin/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
