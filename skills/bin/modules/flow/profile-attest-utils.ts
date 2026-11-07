import {
  FlowError,
  canonicalJson,
  isRecord,
  nonemptyString,
  sha256Bytes,
  stableHash,
} from "./common";
import { eventToolUseId, isSpawnTool } from "./profile-hook";

export const FALLBACK_BLOCKERS_RE =
  /authentication|authorization|auth[ _-]*(?:failed|error|denied)|unauthori[sz]ed|(?:invalid|expired|rejected|failed|failure)[ _-]*(?:api[ _-]*)?(?:key|token|credential)|(?:api[ _-]*)?(?:key|token|credential)(?:[ _-]+(?:is|was))?[ _-]*(?:invalid|expired|rejected|failed|failure)|permission[ _-]*denied|access[ _-]*denied|forbidden|not[ _-]*permitted|quota|rate[ _-]*limit|billing|api[ _-]*(?:unavailable|error|failure|outage)|provider|upstream|gateway|network|connection|timeout|sandbox|(?:http(?:[ _-]*status)?|status|code)\D{0,24}\b[45][0-9]{2}\b|(?:internal|server|service)[ _-]*(?:error|failure|unavailable)/i;

export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value))
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...collectStrings(item),
    ]);
  if (typeof value === "number") return [String(value)];
  return [];
}

export function functionArguments(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const payload = record.payload;
  if (!isRecord(payload) || typeof payload.arguments !== "string")
    throw new FlowError(
      "native spawn transcript request has invalid arguments",
    );
  let value: unknown;
  try {
    value = JSON.parse(payload.arguments);
  } catch (error) {
    throw new FlowError(
      "native spawn transcript request has invalid arguments",
      { cause: error },
    );
  }
  if (!isRecord(value))
    throw new FlowError(
      "native spawn transcript request has invalid arguments",
    );
  return value;
}

export function isNativeSpawnName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    (name === "Agent" ||
      name === "spawn_agent" ||
      name.endsWith("__spawn_agent"))
  );
}

export function spawnRecords(
  records: Record<string, unknown>[],
  taskName: string,
  agentType: string,
): Record<string, unknown>[] {
  return records.filter((record) => {
    const payload = record.payload;
    if (
      !isRecord(payload) ||
      record.type !== "response_item" ||
      payload.type !== "function_call" ||
      !isNativeSpawnName(payload.name)
    )
      return false;
    const args = functionArguments(record);
    const actualType = nonemptyString(args.agent_type);
    return (
      args.task_name === taskName &&
      (actualType === undefined || actualType === agentType)
    );
  });
}

export function linkedChildActivity(
  records: Record<string, unknown>[],
  callId: string,
): [number, string] | undefined {
  const matches: [number, string][] = [];
  records.forEach((record, index) => {
    const payload = record.payload;
    if (
      !isRecord(payload) ||
      record.type !== "event_msg" ||
      payload.type !== "sub_agent_activity" ||
      payload.event_id !== callId
    )
      return;
    const child = nonemptyString(payload.agent_thread_id);
    if (!child)
      throw new FlowError(
        `runtime attestation found an invalid child start for tool use ${callId}`,
      );
    matches.push([index, child]);
  });
  if (matches.length > 1)
    throw new FlowError(
      `runtime attestation found ambiguous child start for tool use ${callId}`,
    );
  return matches[0];
}

export function linkedChildId(
  records: Record<string, unknown>[],
  callId: string,
): string | undefined {
  return linkedChildActivity(records, callId)?.[1];
}

export function validateNativeChildActivityLinks(
  records: Record<string, unknown>[],
): void {
  const calls = new Map<string, number>();
  records.forEach((record, index) => {
    const payload = record.payload;
    if (
      !isRecord(payload) ||
      record.type !== "response_item" ||
      payload.type !== "function_call" ||
      !isNativeSpawnName(payload.name)
    )
      return;
    const callId = eventToolUseId(payload);
    if (!callId)
      throw new FlowError("native spawn transcript request has no tool_use_id");
    if (calls.has(callId))
      throw new FlowError("native spawn transcript has duplicate tool_use_id");
    calls.set(callId, index);
  });
  records.forEach((record, index) => {
    const payload = record.payload;
    if (
      !isRecord(payload) ||
      record.type !== "event_msg" ||
      payload.type !== "sub_agent_activity"
    )
      return;
    const eventId = nonemptyString(payload.event_id);
    if (!eventId || !calls.has(eventId)) return;
    if (!nonemptyString(payload.agent_thread_id))
      throw new FlowError("runtime attestation found an unlinked child start");
    if (index <= (calls.get(eventId) ?? -1))
      throw new FlowError(
        "native child start did not follow its spawn request",
      );
  });
}

export function optionalCallOutputWithIndex(
  records: Record<string, unknown>[],
  callId: string,
): [number, unknown] | undefined {
  const outputs: [number, unknown][] = [];
  records.forEach((record, index) => {
    const payload = record.payload;
    if (
      isRecord(payload) &&
      record.type === "response_item" &&
      payload.type === "function_call_output" &&
      payload.call_id === callId
    )
      outputs.push([index, payload.output]);
  });
  if (outputs.length > 1)
    throw new FlowError(
      `runtime attestation requires exactly one tool output for ${callId}`,
    );
  return outputs[0];
}

export function callOutputWithIndex(
  records: Record<string, unknown>[],
  callId: string,
): [number, unknown] {
  const output = optionalCallOutputWithIndex(records, callId);
  if (!output)
    throw new FlowError(
      `runtime attestation requires exactly one tool output for ${callId}`,
    );
  return output;
}

export function recordIndex(
  records: Record<string, unknown>[],
  target: Record<string, unknown>,
): number {
  const index = records.indexOf(target);
  if (index < 0)
    throw new FlowError(
      "runtime attestation found an ambiguous native spawn record",
    );
  return index;
}

export function responseStartedChild(value: unknown): boolean {
  if (isRecord(value))
    return (
      Object.keys(value).some((key) =>
        [
          "agent_thread_id",
          "agentThreadId",
          "agent_path",
          "agentPath",
        ].includes(key),
      ) || Object.values(value).some(responseStartedChild)
    );
  if (Array.isArray(value)) return value.some(responseStartedChild);
  return (
    typeof value === "string" &&
    /"?(?:agent_thread_id|agentThreadId|agent_path|agentPath)"?\s*[:=]/.test(
      value,
    )
  );
}

export function completedTurn(
  records: Record<string, unknown>[],
  expectedModel: string,
  expectedEffort: string,
  expectedResultSha?: string,
  replayed: Set<string> = new Set(),
): [string, string | undefined] {
  const contexts = new Map<string, Set<string>>();
  records.forEach((record) => {
    const payload = record.payload;
    if (
      replayed.has(canonicalJson(record)) ||
      !isRecord(payload) ||
      record.type !== "turn_context"
    )
      return;
    const turn = nonemptyString(payload.turn_id);
    const model = nonemptyString(payload.model);
    const effort = nonemptyString(payload.effort);
    if (!turn || !model || !effort)
      throw new FlowError(
        "runtime attestation found an incomplete child turn_context profile",
      );
    contexts.set(
      turn,
      new Set([...(contexts.get(turn) ?? []), `${model}:${effort}`]),
    );
  });
  const candidates: [number, string, string | undefined][] = [];
  records.forEach((record, index) => {
    const payload = record.payload;
    if (
      replayed.has(canonicalJson(record)) ||
      !isRecord(payload) ||
      record.type !== "event_msg" ||
      payload.type !== "task_complete"
    )
      return;
    const turn = nonemptyString(payload.turn_id);
    if (!turn)
      throw new FlowError(
        "runtime attestation found a terminal child event without turn_id",
      );
    if (!contexts.get(turn)?.has(`${expectedModel}:${expectedEffort}`))
      throw new FlowError(
        "runtime attestation found a child completion without its requested profile",
      );
    if (
      payload.last_agent_message !== undefined &&
      typeof payload.last_agent_message !== "string"
    )
      throw new FlowError(
        "runtime attestation found a terminal child event with invalid result",
      );
    candidates.push([
      index,
      turn,
      payload.last_agent_message as string | undefined,
    ]);
  });
  if (!candidates.length)
    throw new FlowError(
      "runtime attestation requires exactly one completed child turn",
    );
  let selected = candidates[0];
  if (expectedResultSha) {
    const matching = candidates.filter(
      (candidate) =>
        candidate[2] !== undefined &&
        sha256Bytes(new TextEncoder().encode(candidate[2])) ===
          expectedResultSha,
    );
    if (matching.length !== 1 || matching[0] !== candidates.at(-1))
      throw new FlowError(
        "runtime attestation requires the unique final child completion",
      );
    selected = matching[0];
  } else if (candidates.length !== 1)
    throw new FlowError(
      "runtime attestation requires exactly one completed child turn",
    );
  if (!selected)
    throw new FlowError(
      "runtime attestation requires a selected child completion",
    );
  for (const record of records.slice(selected[0] + 1))
    if (!replayed.has(canonicalJson(record)))
      throw new FlowError(
        "runtime attestation requires final child completion to be the last child activity",
      );
  return [selected[1], selected[2]];
}

export function turnProfile(
  records: Record<string, unknown>[],
  completed: string,
  replayed: Set<string>,
): [string, string, string] {
  const profiles: [string, string, string][] = [];
  for (const record of records) {
    const payload = record.payload;
    if (
      replayed.has(canonicalJson(record)) ||
      !isRecord(payload) ||
      record.type !== "turn_context"
    )
      continue;
    const model = nonemptyString(payload.model);
    const effort = nonemptyString(payload.effort);
    const turn = nonemptyString(payload.turn_id);
    if (!model || !effort || !turn)
      throw new FlowError(
        "runtime attestation found an incomplete child turn_context profile",
      );
    profiles.push([model, effort, turn]);
  }
  if (!profiles.length)
    throw new FlowError(
      "runtime attestation child turns have no runtime profile",
    );
  if (
    new Set(profiles.map(([model, effort]) => `${model}:${effort}`)).size !== 1
  )
    throw new FlowError("runtime attestation found conflicting child profiles");
  const selected = profiles.find((profile) => profile[2] === completed);
  if (!selected)
    throw new FlowError(
      "runtime attestation terminal child turn has no runtime profile",
    );
  return selected;
}
