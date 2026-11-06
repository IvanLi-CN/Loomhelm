import { constants, openSync, readFileSync, fstatSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const expectedBindingDigest: string | undefined = undefined;
type Binding = { invoke(name: string, args: unknown[]): number; directoryNames(fd: number): string[] };
let binding: Binding | undefined;
function native(): Binding {
  if (!['darwin','linux'].includes(process.platform)) throw new Error('native_platform_unavailable');
  if (binding) return binding;
  const inherited = process.env.PLAN_REVIEW_NATIVE_FD;
  const source = process.env.PLAN_REVIEW_ENTRYPOINT_PATH
    ? new URL('./modules/core/posix.js', 'file://' + process.env.PLAN_REVIEW_ENTRYPOINT_PATH)
    : new URL(import.meta.url);
  const fd = inherited === undefined
    ? openSync(fileURLToPath(new URL('../../native/posix.node', source)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    : Number(inherited);
  if (!Number.isInteger(fd) || fd < 0 || (inherited !== undefined && fd !== 6)) throw new Error('native_binding_fd_invalid');
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022) !== 0 || (before.uid !== 0 && before.uid !== process.getuid?.())) throw new Error('native_binding_unsafe');
    if (inherited !== undefined && `${before.dev}:${before.ino}` !== process.env.PLAN_REVIEW_NATIVE_IDENTITY) throw new Error('native_binding_identity_changed');
    if (expectedBindingDigest && createHash('sha256').update(readFileSync(fd)).digest('hex') !== expectedBindingDigest) throw new Error('native_binding_digest_mismatch');
    const loaded = { exports: {} };
    process.dlopen(loaded, '/dev/fd/' + fd);
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw new Error('native_binding_changed');
    binding = loaded.exports as Binding;
    return binding;
  } finally { closeSync(fd); if (inherited !== undefined) delete process.env.PLAN_REVIEW_NATIVE_FD; }
}
const common = ['openat','flock','close','fchmod','mkdirat','unlinkat','renameat'];
export const FFIType = { i32: 'i32', u32: 'u32', ptr: 'ptr', cstring: 'cstring' };
// Preserve typed-array ownership for the whole synchronous native call. No raw JS pointers.
export function ptr(value: Uint8Array): number { return value as unknown as number; }
export function dlopen(_library: string, definitions: Record<string, unknown>) {
  const allowed = [...common, ...(process.platform === 'darwin' ? ['renameatx_np','clonefile'] : ['renameat2'])];
  native();
  const symbols: Record<string, (...args: unknown[]) => number> = {};
  for (const name of Object.keys(definitions)) {
    if (!allowed.includes(name)) throw new Error('native_symbol_unavailable: ' + name);
    symbols[name] = (...args) => native().invoke(name, args.map((value, index) => {
      if ((definitions[name] as { args?: unknown[] }).args?.[index] !== FFIType.cstring) return value;
      if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Native cstring must be a string without NUL');
      return new TextEncoder().encode(value + '\0');
    }));
  }
  return { symbols, close() {} };
}
export function directoryNames(fd: number): string[] { return native().directoryNames(fd); }
