import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { linuxLibraries } from "@loomhelm/runtime-core/modules/visual/native_rename";
import { z } from "zod";
import { ContractError } from "./errors";
import {
  auditMatchesSource,
  businessDigest,
  migrationDigest,
  unresolvedCall,
  unresolvedCalls,
} from "./migration-audit";
import {
  identityOf,
  type RunIdentity,
  runIdentity,
  sameRunIdentity,
  upgradeState,
} from "./orchestration-identity";
import { validateLedger } from "./schema";
import type { LedgerStore } from "./store";
import { viewerBindingSchema } from "./viewer-binding";

const digestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
export const migrationReport = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string(),
    source: runIdentity.nullable(),
    caller: runIdentity,
    target: runIdentity,
    revision: z.number().int().nonnegative().nullable(),
    source_digest: digestSchema,
    source_binding_digest: digestSchema,
    source_call_digest: digestSchema,
    directory: z.object({ dev: z.number(), ino: z.number() }).nullable(),
    business_digest: digestSchema,
    unresolved_digest: digestSchema,
    unresolved: z.array(unresolvedCall),
    migration_supported: z.boolean(),
    migration_ready: z.boolean(),
    native_quiescence: z.literal("not_asserted"),
    blockers: z.array(z.object({ code: z.string(), reason: z.string() })),
    consequences: z.array(z.string()),
    next_action: z.string(),
  })
  .strict();
const consequences = [
  "Existing native calls may still complete; late results may remain unknown.",
  "Migration does not retry or resolve notifications, creation, recovery or archive.",
];

export type MigrationSnapshot = {
  runId: string;
  raw: any;
  content: string;
  binding: any;
  bindingContent: string | null;
  callContent: string | null;
  directory: { dev: number; ino: number };
  retained?: { backup: string; ledger: string; binding: string; call: string | null };
};
const fingerprint = (stat: ReturnType<typeof lstatSync>) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.uid, stat.nlink].join(":");

type DirectoryIdentity = { dev: number; ino: number };
let nativeOpen: ReturnType<typeof loadOpen> | undefined;
function loadOpen() {
  const libraries = process.platform === "darwin" ? ["libSystem.B.dylib"] : linuxLibraries();
  for (const library of libraries) {
    try {
      return dlopen(library, {
        openat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
      });
    } catch {
      /* Try the next platform library. */
    }
  }
  throw new ContractError("UNSUPPORTED_PLATFORM", "Migration requires native no-follow reads", 4);
}
function openMigrationFile(path: string, expectedParent: DirectoryIdentity): number {
  if (!["darwin", "linux"].includes(process.platform) || path.includes("\0"))
    throw new ContractError("UNSAFE_PATH", "Migration path is unsupported", 4);
  const api = (nativeOpen ??= loadOpen());
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let parent = openSync(sep, directoryFlags);
  const parts = resolve(path).split(sep).filter(Boolean);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = api.symbols.openat(
        parent,
        new TextEncoder().encode(`${part}\0`),
        directoryFlags,
        0,
      );
      if (next < 0)
        throw new ContractError(
          "UNSAFE_PATH",
          "Migration parent cannot be opened without following links",
          4,
        );
      closeSync(parent);
      parent = next;
    }
    const opened = fstatSync(parent);
    if (opened.dev !== expectedParent.dev || opened.ino !== expectedParent.ino)
      throw new ContractError("OBSERVATION_STALE", "Migration parent identity changed", 4);
    const descriptor = api.symbols.openat(
      parent,
      new TextEncoder().encode(`${parts.at(-1)}\0`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    );
    if (descriptor < 0)
      throw new ContractError(
        "UNSAFE_PATH",
        "Migration input cannot be opened without following links",
        4,
      );
    return descriptor;
  } finally {
    closeSync(parent);
  }
}

/** Pin the actual opened file, not only its pathname; never consume a replacement's bytes. */
export function readMigrationInput(
  path: string,
  root: string,
  expectedParent?: DirectoryIdentity,
  openFile = openMigrationFile,
): { content: string; stat: string } {
  const delta = relative(resolve(root), resolve(path));
  if (delta === ".." || delta.startsWith(`..${sep}`) || delta.startsWith(sep))
    throw new ContractError("UNSAFE_PATH", "Migration input escapes its root", 4);
  const parent = lstatSync(dirname(path)),
    before = lstatSync(path);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid!() ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid!()
  )
    throw new ContractError(
      "UNSAFE_PATH",
      "Migration inputs must be private regular files owned by the current user",
      4,
    );
  if (expectedParent && (parent.dev !== expectedParent.dev || parent.ino !== expectedParent.ino))
    throw new ContractError("OBSERVATION_STALE", "Migration parent identity changed", 4);
  const descriptor = openFile(path, parent);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid!() ||
      opened.nlink !== 1 ||
      fingerprint(opened) !== fingerprint(before)
    )
      throw new ContractError("OBSERVATION_STALE", "Opened migration input identity changed", 4);
    const maxBytes = 256 * 1024 * 1024;
    if (opened.size > maxBytes)
      throw new ContractError("UNSAFE_PATH", "Migration input exceeds read limit", 4);
    const chunks: Buffer[] = [],
      chunk = Buffer.alloc(64 * 1024);
    let total = 0,
      length: number;
    while ((length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      total += length;
      if (total > maxBytes)
        throw new ContractError("UNSAFE_PATH", "Migration input exceeds read limit", 4);
      chunks.push(Buffer.from(chunk.subarray(0, length)));
    }
    const afterParent = lstatSync(dirname(path));
    if (
      fingerprint(opened) !== fingerprint(fstatSync(descriptor)) ||
      fingerprint(before) !== fingerprint(lstatSync(path)) ||
      parent.dev !== afterParent.dev ||
      parent.ino !== afterParent.ino ||
      afterParent.isSymbolicLink()
    )
      throw new ContractError("OBSERVATION_STALE", "Migration input changed while reading", 4);
    return { content: Buffer.concat(chunks, total).toString("utf8"), stat: fingerprint(opened) };
  } finally {
    closeSync(descriptor);
  }
}

/** No store wrapper: even an absent lock file must remain absent on a read-only path. */
export function readMigrationSnapshot(
  store: LedgerStore,
  afterRead?: () => void,
): MigrationSnapshot {
  const directory = lstatSync(store.runPath);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    realpathSync(store.rootPath) !== resolve(store.rootPath) ||
    realpathSync(store.runPath) !== resolve(store.runPath) ||
    directory.uid !== process.getuid!()
  )
    throw new ContractError(
      "UNSAFE_PATH",
      "Run directory must belong to the current user and not traverse links",
      4,
    );
  const names = ["ledger.json", "runtime/viewer-binding.json", "runtime/call.json"];
  const read = (name: string): { content: string; stat: string } | null => {
    const path = join(store.runPath, name);
    try {
      return readMigrationInput(
        path,
        store.rootPath,
        name === "ledger.json" ? directory : undefined,
      );
    } catch (error: any) {
      if (
        error.code === "ENOENT" &&
        (name === "runtime/viewer-binding.json" || name.endsWith("runtime/call.json"))
      )
        return null;
      throw error;
    }
  };
  const first = names.map(read);
  const initial = JSON.parse(first[0]!.content);
  const pending =
    initial?.upgrade && initial.upgrade.phase !== "completed"
      ? upgradeState.parse(initial.upgrade)
      : null;
  const retainedNames = pending
    ? [
        pending.backup,
        join("..", pending.source_directory, "ledger.json"),
        join("..", pending.source_directory, "runtime/viewer-binding.json"),
        join("..", pending.source_directory, "runtime/call.json"),
      ]
    : [];
  const retained = retainedNames.map(read);
  afterRead?.();
  const second = names.map(read);
  const retainedAfter = retainedNames.map(read);
  const current = lstatSync(store.runPath);
  if (
    directory.dev !== current.dev ||
    directory.ino !== current.ino ||
    JSON.stringify(first) !== JSON.stringify(second) ||
    JSON.stringify(retained) !== JSON.stringify(retainedAfter)
  )
    throw new ContractError("OBSERVATION_STALE", "Run changed during the migration observation", 4);
  const content = first[0]!.content,
    bindingContent = first[1]?.content ?? null;
  return {
    runId: basename(store.runPath),
    raw: JSON.parse(content),
    content,
    bindingContent,
    binding: bindingContent === null ? null : JSON.parse(bindingContent),
    callContent: first[2]?.content ?? null,
    directory: { dev: directory.dev, ino: directory.ino },
    ...(pending
      ? {
          retained: {
            backup: retained[0]!.content,
            ledger: retained[1]!.content,
            binding: retained[2]!.content,
            call: retained[3]?.content ?? null,
          },
        }
      : {}),
  };
}

export function assessMigration(snapshot: MigrationSnapshot, caller: RunIdentity, target = caller) {
  const { raw, binding } = snapshot;
  const blockers: { code: string; reason: string }[] = [];
  const block = (code: string, reason: string) => blockers.push({ code, reason });
  const pending = raw.upgrade && raw.upgrade.phase !== "completed" ? raw.upgrade : null;
  const sourceValue = pending?.source ?? raw.runtime_identity ?? (binding && identityOf(binding));
  const parsed = runIdentity.safeParse(sourceValue);
  const source = parsed.success ? parsed.data : null;
  if (raw.orchestration_id !== snapshot.runId)
    block("identity_conflict", "Ledger identity does not match its run directory");
  if (!source)
    block(
      "identity_missing",
      "A complete source identity is required; it cannot be inferred from the current installation",
    );
  if (!viewerBindingSchema.safeParse(binding).success || binding.run_id !== raw.orchestration_id)
    block("identity_missing", "A supported binding for the exact run is required");
  else if (
    source &&
    !sameRunIdentity(identityOf(binding), source) &&
    !(pending && sameRunIdentity(identityOf(binding), pending.target))
  )
    block("identity_conflict", "Ledger and binding identities disagree");
  const migrationSupported =
    raw.schema_version === 2 &&
    [3, 4, 5].includes(raw.contract_version) &&
    target.ledger_contract === 5 &&
    (!source ||
      (source.compatibility_line === target.compatibility_line &&
        source.api_contract === target.api_contract &&
        source.frontend_contract === target.frontend_contract &&
        source.viewer_contract === target.viewer_contract));
  if (!migrationSupported)
    block(
      "migration_unsupported",
      "Only schema 2 contract 3/4/5 to contract 5 on the same compatibility line with unchanged API/frontend/viewer contracts has a mechanical migration",
    );
  if (source && !pending && source.ledger_contract !== raw.contract_version)
    block("identity_conflict", "Source identity and ledger contract disagree");
  if (
    (raw.contract_version === 4 && binding?.schema_version !== 2) ||
    (raw.contract_version === 5 && ![2, 3].includes(binding?.schema_version))
  )
    block("writer_unfenced", "Identity-bound ledgers require the fenced binding schema");
  if (
    source &&
    !sameRunIdentity(source, target) &&
    Bun.semver.order(target.package_version, source.package_version) <= 0
  )
    block("downgrade_forbidden", "The target must be a newer immutable identity");
  if (!sameRunIdentity(caller, target))
    block("executor_mismatch", "Use the verified target package CLI");
  if (pending && !sameRunIdentity(pending.target, target))
    block("upgrade_target_frozen", "Only the registered immutable target may resume");
  try {
    validateLedger(raw);
  } catch {
    block("business_invalid", "The source ledger does not satisfy its declared domain contract");
  }
  if (pending && (!snapshot.retained || !auditMatchesSource(raw, pending, snapshot.retained)))
    block("audit_conflict", "Migration audit does not match the retained source");
  const unresolved = unresolvedCalls(raw);
  return {
    schema_version: 1 as const,
    run_id: raw.orchestration_id,
    source,
    caller,
    target,
    revision: raw.revision,
    source_digest: migrationDigest(snapshot.content),
    source_binding_digest:
      snapshot.bindingContent === null ? null : migrationDigest(JSON.stringify(binding)),
    source_call_digest:
      snapshot.callContent === null ? null : migrationDigest(snapshot.callContent),
    directory: snapshot.directory,
    business_digest: businessDigest(raw),
    unresolved,
    unresolved_digest: migrationDigest(JSON.stringify(unresolved)),
    migration_supported: migrationSupported,
    migration_ready: blockers.length === 0,
    native_quiescence: "not_asserted" as const,
    blockers,
    consequences,
    next_action: blockers.length
      ? "Resolve the reported migration blockers"
      : "Explicit orchestration upgrade; unresolved business requires separate reconciliation",
  };
}
export function checkMigration(
  store: LedgerStore,
  caller: RunIdentity,
  target = caller,
  afterRead?: () => void,
) {
  try {
    return assessMigration(readMigrationSnapshot(store, afterRead), caller, target);
  } catch (error) {
    return {
      schema_version: 1 as const,
      run_id: basename(store.runPath),
      source: null,
      caller,
      target,
      revision: null,
      source_digest: null,
      source_binding_digest: null,
      source_call_digest: null,
      directory: null,
      business_digest: null,
      unresolved_digest: null,
      unresolved: [],
      consequences,
      migration_supported: false,
      migration_ready: false,
      native_quiescence: "not_asserted" as const,
      blockers: [
        {
          code:
            error instanceof ContractError && error.code === "OBSERVATION_STALE"
              ? "observation_stale"
              : "source_unavailable",
          reason:
            error instanceof ContractError
              ? error.message
              : "Source snapshot could not be safely read",
        },
      ],
      next_action: "Inspect the source without changing its files",
    };
  }
}
