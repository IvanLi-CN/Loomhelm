import { FlowError, isRecord } from "./common";
import {
  childSessionProvenance,
  parseJsonlWithSnapshot,
  sessionMeta,
  sessionTranscriptPaths,
  stableTranscriptBytes,
  type TranscriptSnapshot,
} from "./profile-transcript";

function rawChildCandidateFromBytes(
  path: string,
  taskName: string,
  agentType: string,
  expectedId?: string,
): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      stableTranscriptBytes(path).bytes,
    );
  } catch (error) {
    throw new FlowError(`runtime transcript ${path} cannot be read`, {
      cause: error,
    });
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isRecord(record) ||
      record.type !== "session_meta" ||
      !isRecord(record.payload)
    )
      continue;
    if (expectedId) {
      if (record.payload.id === expectedId) return true;
      continue;
    }
    const source = isRecord(record.payload.source)
      ? record.payload.source
      : undefined;
    const subagent =
      source && isRecord(source.subagent) ? source.subagent : undefined;
    const spawn =
      subagent && isRecord(subagent.thread_spawn)
        ? subagent.thread_spawn
        : undefined;
    return (
      spawn?.agent_path === `/root/${taskName}` &&
      spawn.agent_role === agentType
    );
  }
  return false;
}

export function findChildRollout(
  root: string,
  taskName: string,
  agentType: string,
  expectedId?: string,
): [
  string,
  Record<string, unknown>[],
  Record<string, unknown>,
  TranscriptSnapshot,
] {
  const pattern = expectedId ? `*${expectedId}*.jsonl` : "*.jsonl";
  const matches: [
    string,
    Record<string, unknown>[],
    Record<string, unknown>,
    TranscriptSnapshot,
  ][] = [];
  for (const path of sessionTranscriptPaths(root, pattern)) {
    if (!rawChildCandidateFromBytes(path, taskName, agentType, expectedId))
      continue;
    const parsed = parseJsonlWithSnapshot(path);
    const meta = sessionMeta(parsed.records, path, {
      expectedSessionId: expectedId,
      expectedAgentPath: `/root/${taskName}`,
      expectedAgentRole: agentType,
    });
    const provenance = childSessionProvenance(meta, path);
    if (
      provenance?.agent_path !== `/root/${taskName}` ||
      provenance.agent_role !== agentType
    )
      continue;
    matches.push([path, parsed.records, meta, parsed.snapshot]);
  }
  if (matches.length !== 1)
    throw new FlowError(
      `runtime attestation requires exactly one child rollout for ${taskName}/${agentType}; found ${matches.length}`,
    );
  return matches[0] as [
    string,
    Record<string, unknown>[],
    Record<string, unknown>,
    TranscriptSnapshot,
  ];
}

export function findParentRollout(
  root: string,
  parentId: string,
): [string, Record<string, unknown>[], TranscriptSnapshot] {
  const matches: [string, Record<string, unknown>[], TranscriptSnapshot][] = [];
  for (const path of sessionTranscriptPaths(root, `*${parentId}*.jsonl`)) {
    const parsed = parseJsonlWithSnapshot(path);
    try {
      const meta = sessionMeta(parsed.records, path, {
        expectedSessionId: parentId,
      });
      if (meta.id === parentId)
        matches.push([path, parsed.records, parsed.snapshot]);
    } catch (error) {
      if (
        !(error instanceof FlowError) ||
        !error.message.includes(
          "does not contain the expected session_meta identity",
        )
      )
        throw error;
    }
  }
  if (matches.length !== 1)
    throw new FlowError(
      `runtime attestation requires exactly one parent rollout for ${parentId}; found ${matches.length}`,
    );
  return matches[0] as [string, Record<string, unknown>[], TranscriptSnapshot];
}
