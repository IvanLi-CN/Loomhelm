import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  FlowError,
  isRecord,
  nonemptyString,
  canonicalJson,
  sha256Bytes,
} from "./common";

export const SUPPORTED_TRANSCRIPT_RECORD_TYPES = new Set([
  "compacted",
  "event_msg",
  "inter_agent_communication_metadata",
  "response_item",
  "session_meta",
  "turn_context",
  "world_state",
]);

export interface TranscriptSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  digest: string;
}

function snapshot(status: Stats): Omit<TranscriptSnapshot, "digest"> {
  return {
    dev: status.dev,
    ino: status.ino,
    size: status.size,
    mtimeNs: BigInt(Math.trunc(status.mtimeMs * 1_000_000)),
    ctimeNs: BigInt(Math.trunc(status.ctimeMs * 1_000_000)),
  };
}

function sameSnapshot(
  left: Omit<TranscriptSnapshot, "digest">,
  right: Omit<TranscriptSnapshot, "digest">,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function stableTranscriptBytes(path: string): {
  bytes: Uint8Array;
  snapshot: TranscriptSnapshot;
} {
  try {
    if (typeof constants.O_NOFOLLOW !== "number")
      throw new FlowError(
        "runtime transcript cannot be opened without no-follow support",
      );
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    let before: Omit<TranscriptSnapshot, "digest">;
    let after: Omit<TranscriptSnapshot, "digest">;
    try {
      before = snapshot(fstatSync(fd));
      bytes = readFileSync(fd);
      after = snapshot(fstatSync(fd));
    } finally {
      closeSync(fd);
    }
    if (!sameSnapshot(before, after) || bytes.byteLength !== after.size)
      throw new FlowError(
        `runtime transcript ${path} changed while being read`,
      );
    return { bytes, snapshot: { ...after, digest: sha256Bytes(bytes) } };
  } catch (error) {
    if (error instanceof FlowError) throw error;
    throw new FlowError(`runtime transcript ${path} cannot be read`, {
      cause: error,
    });
  }
}

export function parseJsonlWithSnapshot(path: string): {
  records: Record<string, unknown>[];
  snapshot: TranscriptSnapshot;
} {
  const { bytes, snapshot: identity } = stableTranscriptBytes(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FlowError(`runtime transcript ${path} is not UTF-8`, {
      cause: error,
    });
  }
  const records: Record<string, unknown>[] = [];
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new FlowError(
        `runtime transcript ${path}:${lineIndex + 1} is not valid JSON`,
        { cause: error },
      );
    }
    if (!isRecord(value))
      throw new FlowError(
        `runtime transcript ${path}:${lineIndex + 1} is not an object`,
      );
    const type = nonemptyString(value.type);
    if (!type || !SUPPORTED_TRANSCRIPT_RECORD_TYPES.has(type))
      throw new FlowError(
        `runtime transcript ${path}:${lineIndex + 1} has unsupported record type`,
      );
    records.push(value);
  }
  if (!records.length)
    throw new FlowError(`runtime transcript ${path} is empty`);
  return { records, snapshot: identity };
}

export function requireUnchangedTranscripts(
  snapshots: Map<string, TranscriptSnapshot>,
): void {
  for (const [path, expected] of snapshots) {
    const actual = stableTranscriptBytes(path).snapshot;
    if (
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.size !== expected.size ||
      actual.mtimeNs !== expected.mtimeNs ||
      actual.ctimeNs !== expected.ctimeNs ||
      actual.digest !== expected.digest
    )
      throw new FlowError(
        `runtime transcript ${path} changed during attestation`,
      );
  }
}

export interface ChildProvenance {
  id: string;
  parent_thread_id: string;
  agent_path: string;
  agent_role: string;
}

export function childSessionProvenance(
  meta: Record<string, unknown>,
  path: string,
): ChildProvenance | undefined {
  const parent = nonemptyString(meta.parent_thread_id);
  const source = isRecord(meta.source) ? meta.source : undefined;
  const subagent =
    source && isRecord(source.subagent) ? source.subagent : undefined;
  const spawn =
    subagent && isRecord(subagent.thread_spawn)
      ? subagent.thread_spawn
      : undefined;
  if (!parent && !source?.subagent) return undefined;
  if (!parent || !spawn)
    throw new FlowError(
      `runtime transcript ${path} has incomplete session_meta provenance`,
    );
  const id = nonemptyString(meta.id);
  const spawnParent = nonemptyString(spawn.parent_thread_id);
  const agentPath = nonemptyString(spawn.agent_path);
  const agentRole = nonemptyString(spawn.agent_role);
  if (!id)
    throw new FlowError(
      `runtime transcript ${path} has ambiguous session_meta identity`,
    );
  if (spawnParent !== parent || !agentPath || !agentRole)
    throw new FlowError(
      `runtime transcript ${path} has invalid session_meta provenance`,
    );
  return {
    id,
    parent_thread_id: parent,
    agent_path: agentPath,
    agent_role: agentRole,
  };
}

export function sessionMetaBinding(
  meta: Record<string, unknown>,
  path: string,
  includeChildGit: boolean,
): string {
  const id = nonemptyString(meta.id);
  if (!id)
    throw new FlowError(
      `runtime transcript ${path} has ambiguous session_meta identity`,
    );
  const provenance = childSessionProvenance(meta, path);
  if (!provenance) {
    if (meta.source !== undefined && typeof meta.source !== "string")
      throw new FlowError(
        `runtime transcript ${path} has invalid non-child session_meta source`,
      );
    if (typeof meta.source === "string" && !meta.source.trim())
      throw new FlowError(
        `runtime transcript ${path} has invalid non-child session_meta source`,
      );
    return canonicalJson({ id, source: meta.source ?? null });
  }
  const result: Record<string, unknown> = { provenance };
  if (includeChildGit)
    result.git_commit_hash = isRecord(meta.git)
      ? (nonemptyString(meta.git.commit_hash) ?? null)
      : null;
  return canonicalJson(result);
}

export function sessionMeta(
  records: Record<string, unknown>[],
  path: string,
  options: {
    expectedSessionId?: string | undefined;
    expectedAgentPath?: string | undefined;
    expectedAgentRole?: string | undefined;
  } = {},
): Record<string, unknown> {
  const metas = records
    .filter((record) => record.type === "session_meta")
    .map((record) => record.payload);
  if (!metas.length || metas.some((meta) => !isRecord(meta)))
    throw new FlowError(
      `runtime transcript ${path} has ambiguous session_meta identity`,
    );
  const objects = metas.filter(isRecord);
  const identifiers = objects.map((meta) => nonemptyString(meta.id));
  if (identifiers.some((id) => !id))
    throw new FlowError(
      `runtime transcript ${path} has ambiguous session_meta identity`,
    );
  const { expectedSessionId, expectedAgentPath, expectedAgentRole } = options;
  if (expectedSessionId) {
    const selected = objects.filter((meta) => meta.id === expectedSessionId);
    if (!selected.length)
      throw new FlowError(
        `runtime transcript ${path} does not contain the expected session_meta identity`,
      );
    if (!expectedAgentPath && !expectedAgentRole) {
      if (
        new Set(identifiers).size !== 1 ||
        new Set(selected.map((meta) => sessionMetaBinding(meta, path, false)))
          .size !== 1
      )
        throw new FlowError(
          `runtime transcript ${path} has ambiguous session_meta metadata`,
        );
      return selected[0] as Record<string, unknown>;
    }
    if (!expectedAgentPath || !expectedAgentRole)
      throw new FlowError(
        "runtime attestation has incomplete expected child provenance",
      );
    const child = selected.filter((meta) => {
      const provenance = childSessionProvenance(meta, path);
      return (
        provenance?.agent_path === expectedAgentPath &&
        provenance.agent_role === expectedAgentRole
      );
    });
    if (
      !child.length ||
      new Set(
        child.map((meta) => canonicalJson(childSessionProvenance(meta, path))),
      ).size !== 1 ||
      new Set(child.map((meta) => sessionMetaBinding(meta, path, true)))
        .size !== 1
    )
      throw new FlowError(
        `runtime transcript ${path} has ambiguous session_meta provenance`,
      );
    return child[0] as Record<string, unknown>;
  }
  if (expectedAgentPath || expectedAgentRole) {
    if (!expectedAgentPath || !expectedAgentRole)
      throw new FlowError(
        "runtime attestation has incomplete expected child provenance",
      );
    const child = objects.filter((meta) => {
      const provenance = childSessionProvenance(meta, path);
      return (
        provenance?.agent_path === expectedAgentPath &&
        provenance.agent_role === expectedAgentRole
      );
    });
    if (
      !child.length ||
      new Set(
        child.map((meta) => canonicalJson(childSessionProvenance(meta, path))),
      ).size !== 1 ||
      new Set(child.map((meta) => sessionMetaBinding(meta, path, true)))
        .size !== 1
    )
      throw new FlowError(
        `runtime transcript ${path} has ambiguous session_meta identity`,
      );
    return child[0] as Record<string, unknown>;
  }
  if (new Set(identifiers).size !== 1)
    throw new FlowError(
      `runtime transcript ${path} has ambiguous session_meta identity`,
    );
  return objects[0] as Record<string, unknown>;
}

export function resolvedSessionPath(
  path: string,
  sessionsRoot: string,
): string {
  const root = realpathSync(resolve(sessionsRoot));
  const target = realpathSync(resolve(path));
  if (relative(root, target).startsWith(".."))
    throw new FlowError("runtime transcript path escapes the sessions root");
  if (!statSync(target).isFile())
    throw new FlowError(`runtime transcript ${target} does not exist`);
  return target;
}

function matching(pattern: string, name: string): boolean {
  const regex = new RegExp(
    `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
  );
  return regex.test(name);
}

export function sessionTranscriptPaths(
  rootPath: string,
  pattern: string,
): string[] {
  const root = resolve(rootPath);
  const result: string[] = [];
  const walk = (directory: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new FlowError(
        `runtime transcript discovery cannot read ${directory}`,
        { cause: error },
      );
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && matching(pattern, basename(path)))
        result.push(resolvedSessionPath(path, root));
    }
  };
  walk(root);
  return result.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
