import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { LedgerStore } from "./store";
import { validateLedger } from "./schema";

export function safeCompare(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export async function readBodyWithinLimit(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function readSafeFile(path: string): Uint8Array | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    if (!fstatSync(descriptor).isFile()) return null;
    return readFileSync(descriptor);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function readRegisteredDocument(
  store: LedgerStore,
  documentId: string,
): string | null {
  const ledger = validateLedger(store.read());
  const match = /^(task|group)-([A-Za-z0-9_-]{1,128})$/.exec(documentId);
  if (!match) return null;
  const target =
    match[1] === "task"
      ? ledger.tasks.find((item) => item.id === match[2])
      : ledger.groups.find((item) => item.id === match[2]);
  if (!target?.requirements_path) return null;
  const docRoot = join(store.runPath, "requirements");
  if (!existsSync(docRoot) || lstatSync(docRoot).isSymbolicLink()) return null;
  const canonicalRoot = realpathSync(docRoot);
  const requested = resolve(store.runPath, target.requirements_path);
  const requestedRelative = relative(docRoot, requested);
  if (requestedRelative.startsWith("..") || isAbsolute(requestedRelative))
    return null;
  if (!requested.endsWith(".md") || !existsSync(requested)) return null;
  const canonicalParent = realpathSync(dirname(requested));
  const canonical = join(canonicalParent, basename(requested));
  const canonicalRelative = relative(canonicalRoot, canonical);
  if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative))
    return null;
  if (lstatSync(canonical).isSymbolicLink() || !lstatSync(canonical).isFile())
    return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      canonical,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    if (!fstatSync(descriptor).isFile()) return null;
    return readFileSync(descriptor, "utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
