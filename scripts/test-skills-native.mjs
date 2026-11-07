#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { constants, openSync, closeSync, mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const binding = createRequire(import.meta.url)('../bin/native/posix.node');
const c = text => new TextEncoder().encode(text + '\0');
const root = mkdtempSync(join(tmpdir(), 'loomhelm-posix-'));
try {
  const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    writeFileSync(join(root, 'one'), 'one'); writeFileSync(join(root, 'two'), 'two');
    symlinkSync('one', join(root, 'link'));
    assert.equal(binding.invoke('openat', [directory, c('link'), constants.O_RDONLY | constants.O_NOFOLLOW, 0]), -1);
    const symbol = process.platform === 'darwin' ? 'renameatx_np' : 'renameat2';
    const noReplace = process.platform === 'darwin' ? 4 : 1;
    assert.equal(binding.invoke(symbol, [directory, c('one'), directory, c('two'), noReplace]), -1);
    assert.equal(readFileSync(join(root, 'two'), 'utf8'), 'two');
    assert.throws(() => binding.invoke('openat', [directory, new Uint8Array([97,0,98,0]), 0, 0]));
    assert.throws(() => binding.invoke('close', [NaN]));
    const lockPath = join(root, 'lock'); writeFileSync(lockPath, '');
    const lock = openSync(lockPath, constants.O_RDWR);
    assert.equal(binding.invoke('flock', [lock, 6]), 0);
    // Use the original Bun libc FFI, independently of the migrated facade.
    const legacy = 'import {dlopen,FFIType} from "bun:ffi"; import {openSync,closeSync} from "node:fs"; const fd=openSync(process.argv[1],"r+"); const api=dlopen(process.platform==="darwin"?"libSystem.B.dylib":"libc.so.6",{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32}});const result=api.symbols.flock(fd,6);closeSync(fd);process.exit(result===0?0:7);';
    const blocked = spawnSync('bun', ['-e', legacy, lockPath]);
    assert.equal(blocked.status, 7, blocked.stderr.toString());
    binding.invoke('flock', [lock, 8]); closeSync(lock);
    const free = spawnSync('bun', ['-e', legacy, lockPath]);
    assert.equal(free.status, 0, free.stderr.toString());
  } finally { closeSync(directory); }
  console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, nativeNoReplace: true, crossImplementationFlock: true, symlinkRefusal: true }));
} finally { rmSync(root, { recursive: true, force: true }); }
