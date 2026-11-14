#!/usr/bin/env -S bun --no-install
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLockFile, readRegularNoFollow } from '../../../skills/bin/modules/core/security_file.ts';
import { renameNoReplace } from '../../../skills/bin/modules/visual/secure_io.ts';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'loomhelm-posix-')));
try {
  writeFileSync(join(root, 'one'), 'one'); writeFileSync(join(root, 'two'), 'two');
  symlinkSync('one', join(root, 'link'));
  await assert.rejects(readRegularNoFollow(join(root, 'link')));
  assert.throws(() => renameNoReplace(join(root, 'one'), join(root, 'two'), root));
  assert.equal(readFileSync(join(root, 'two'), 'utf8'), 'two');
  const lockPath = join(root, 'lock');
  const lock = tryLockFile(lockPath); assert.ok(lock);
  try {
    // Fixed source protocol: independently call libc flock through Bun FFI.
    const legacy = 'import {dlopen,FFIType} from "bun:ffi"; import {openSync,closeSync} from "node:fs"; const fd=openSync(process.argv[1],"r+"); const api=dlopen(process.platform==="darwin"?"libSystem.B.dylib":"libc.so.6",{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32}});const result=api.symbols.flock(fd,6);closeSync(fd);process.exit(result===0?0:7);';
    const blocked = spawnSync(process.execPath, ['-e', legacy, lockPath], { env: process.env });
    assert.equal(blocked.status, 7, blocked.stderr.toString());
    lock.release();
    const free = spawnSync(process.execPath, ['-e', legacy, lockPath], { env: process.env });
    assert.equal(free.status, 0, free.stderr.toString());
  } finally { lock.release(); }
  console.log(JSON.stringify({ ok: true, runtime: 'bun', platform: process.platform, arch: process.arch, noProjectAddon: true, nativeNoReplace: true, crossImplementationFlock: true, symlinkRefusal: true }));
} finally { rmSync(root, { recursive: true, force: true }); }
