import { Runtime } from "../core/runtime";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FlowError,
  canonicalJson,
  isRecord,
  nonemptyString,
  stableHash,
} from "./common";
import {
  atomicWriteBytes,
  canonicalText,
  ensureDirectory,
  readJson,
  withExclusiveLock,
} from "./storage";

export const SUPPORTED_MODEL_EFFORTS: Record<string, ReadonlySet<string>> = {
  "gpt-5.6-luna": new Set(["low", "medium", "high", "xhigh", "max"]),
  "gpt-5.6-terra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-6.1-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-6.1-terra": new Set(["xhigh"]),
  "gpt-6-luna": new Set(["low", "medium", "high", "xhigh", "max"]),
  "gpt-6-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-6-astra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
};
export const AUTONOMOUS_MODELS = new Set([
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-5.6-luna",
]);

export interface LogicalIdentity {
  session_id: string;
  task_name: string;
  agent_type: string;
  fork_turns: string;
  message_digest: string;
}

export interface ExplicitProfile {
  model: string;
  effort: string;
}

export function stateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = nonemptyString(environment.CODEX_AGENT_PROFILE_STATE_DIR);
  if (configured) return configured;
  const home = nonemptyString(environment.CODEX_HOME);
  return home
    ? join(home, "state", "agent-profile-runtime")
    : join(realpathSync(tmpdir()), "codex-agent-profile-runtime");
}

export function statePaths(root: string): [string, string] {
  return [join(root, "permits.json"), join(root, "permits.lock")];
}

export function modelOverridePaths(root: string): [string, string] {
  return [
    join(root, "model_overrides.json"),
    join(root, "model_overrides.lock"),
  ];
}

export function canonicalSessionsRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const home =
    nonemptyString(environment.CODEX_HOME) ?? join(homedir(), ".codex");
  return join(home, "sessions");
}

export function supportedExplicitProfile(
  value: unknown,
): value is ExplicitProfile {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const model = nonemptyString(value.model);
  const effort = nonemptyString(value.effort);
  return (
    model !== undefined &&
    effort !== undefined &&
    SUPPORTED_MODEL_EFFORTS[model]?.has(effort) === true
  );
}

export function validExplicitProfile(value: unknown): value is ExplicitProfile {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    supportedExplicitProfile(value)
  );
}

export function autonomousModelAllowed(
  model: string,
  override?: string,
): boolean {
  return override === undefined
    ? AUTONOMOUS_MODELS.has(model)
    : model === override;
}

export function validLogicalIdentity(value: unknown): value is LogicalIdentity {
  if (!isRecord(value)) return false;
  const keys = [
    "session_id",
    "task_name",
    "agent_type",
    "fork_turns",
    "message_digest",
  ];
  return (
    keys.length === Object.keys(value).length &&
    keys.every((key) => nonemptyString(value[key]) !== undefined) &&
    /^[0-9a-f]{64}$/.test(String(value.message_digest))
  );
}

export function validFallbackPermit(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = [
    "identity",
    "failed_requested",
    "failure_tool_use_id",
    "failure_evidence_sha256",
    "status",
    "consumed_tool_use_id",
    "fallback_requested",
  ];
  return (
    keys.length === Object.keys(value).length &&
    value.status === "consumed" &&
    validLogicalIdentity(value.identity) &&
    supportedExplicitProfile(value.failed_requested) &&
    supportedExplicitProfile(value.fallback_requested) &&
    nonemptyString(value.failure_tool_use_id) !== undefined &&
    /^[0-9a-f]{64}$/.test(String(value.failure_evidence_sha256)) &&
    nonemptyString(value.consumed_tool_use_id) !== undefined
  );
}

function validOverrideState(
  value: unknown,
): value is { version: 1; sessions: Record<string, { model: string }> } {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sessions))
    return false;
  return Object.entries(value.sessions).every(
    ([session, record]) =>
      Boolean(nonemptyString(session)) &&
      isRecord(record) &&
      Object.keys(record).length === 1 &&
      typeof record.model === "string" &&
      SUPPORTED_MODEL_EFFORTS[record.model] !== undefined,
  );
}

function readState(path: string, message: string): unknown {
  return readJson(path, message);
}

export function readModelOverrideState(root: string): {
  version: 1;
  sessions: Record<string, { model: string }>;
} {
  const [path, lock] = modelOverridePaths(root);
  ensureDirectory(root);
  return withExclusiveLock(lock, () => {
    const state = requireJsonState(
      path,
      { version: 1, sessions: {} },
      "agent model override state is invalid",
    );
    if (!validOverrideState(state))
      throw new FlowError(
        "agent model override state does not match the required schema",
      );
    return state;
  });
}

export function updateModelOverrideState<T>(
  root: string,
  callback: (state: {
    version: 1;
    sessions: Record<string, { model: string }>;
  }) => T,
): T {
  const [path, lock] = modelOverridePaths(root);
  ensureDirectory(root);
  return withExclusiveLock(lock, () => {
    const state = requireJsonState(
      path,
      { version: 1, sessions: {} },
      "agent model override state is invalid",
    );
    if (!validOverrideState(state))
      throw new FlowError(
        "agent model override state does not match the required schema",
      );
    const result = callback(state);
    atomicWriteBytes(path, Buffer.from(canonicalText(state), "utf8"));
    return result;
  });
}

export function updatePermitState<T>(
  root: string,
  callback: (state: { version: 2; permits: Record<string, unknown> }) => T,
): T {
  const [path, lock] = statePaths(root);
  ensureDirectory(root);
  return withExclusiveLock(lock, () => {
    const state = requireJsonState(
      path,
      { version: 2, permits: {} },
      "agent profile permit state is invalid",
    );
    if (!isRecord(state) || state.version !== 2 || !isRecord(state.permits)) {
      throw new FlowError(
        "agent profile permit state does not match the required schema",
      );
    }
    const result = callback(
      state as { version: 2; permits: Record<string, unknown> },
    );
    atomicWriteBytes(path, Buffer.from(canonicalText(state), "utf8"));
    return result;
  });
}

export function loadPermit(
  root: string,
  identity: LogicalIdentity,
): Record<string, unknown> | undefined {
  const [path] = statePaths(root);
  if (!Runtime.file(path).size) return undefined;
  const state = readState(path, "agent profile permit state is invalid");
  if (!isRecord(state) || state.version !== 2 || !isRecord(state.permits)) {
    throw new FlowError(
      "agent profile permit state has an unsupported version",
    );
  }
  for (const [key, value] of Object.entries(state.permits)) {
    const identityValue = isRecord(value) ? value.identity : undefined;
    if (
      !validFallbackPermit(value) ||
      !validLogicalIdentity(identityValue) ||
      permitKey(identityValue) !== key
    ) {
      throw new FlowError(
        "agent profile permit state does not match the required schema",
      );
    }
  }
  const permit = state.permits[permitKey(identity)];
  if (permit === undefined) return undefined;
  if (
    !isRecord(permit) ||
    !isRecord(permit.identity) ||
    canonicalJson(permit.identity) !== canonicalJson(identity) ||
    !validFallbackPermit(permit)
  ) {
    throw new FlowError(
      "agent profile permit does not match the required schema",
    );
  }
  return permit;
}

export function permitKey(identity: LogicalIdentity): string {
  return stableHash(identity);
}

function requireJsonState(
  path: string,
  fallback: unknown,
  message: string,
): any {
  if (!Runtime.file(path).size) return fallback;
  return readJson(path, message);
}
