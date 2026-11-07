import { isRecord, type Finding, type JsonRecord } from "./replay";
import {
  asSha,
  jsonObjects,
  releaseExpectedFalse,
  releaseExpectedTrue,
  releaseExpectedUnknown,
  shaMatches,
  stringValue,
} from "./pr_release_support";
import type { DecisionState, RouteState } from "./pr_release_routes";
import type { PublicationFact, ReleaseExpected } from "./pr_release_support";

export interface ReleaseIdentity {
  repo: string | undefined;
  branch: string | undefined;
  sha: string | undefined;
  epoch: string | undefined;
  tag: string | undefined;
}

export interface ReportedRelease {
  tag: string | undefined;
  version: string | undefined;
  url: string | undefined;
  workflow: string | undefined;
  time: string | undefined;
}

export interface ReleaseRetryAuthorization {
  allowed: true;
  epoch: string;
  repo: string;
  branch: string;
  sha: string;
  runId: string;
}

export interface ReleaseState {
  findings: Finding[];
  expected: ReleaseExpected;
  epoch: string | undefined;
  target: ReleaseIdentity;
  bound: string | undefined;
  reported: ReportedRelease;
  candidate: string | undefined;
  statusLine: number;
  status: string | undefined;
  mergeLine: number;
  releaseIntentLine: number;
  releaseExpectationLine: number;
  mergeShaValue: string | undefined;
  publicationFacts: PublicationFact[];
  expectedSurfaceSet: Set<string>;
  surfaceIdentities: Map<string, Set<string>>;
  actualRunId: string | undefined;
  failureEvidence: boolean;
  failureEvidenceLine: number;
  idempotentRun: boolean;
  rerunCount: number;
  rerunViolation: number;
  route: RouteState | undefined;
  routeResetLine: number;
  routeMutationLines: Array<{ line: number; command: string }>;
  routeStep5cLine: number;
  routeSignal: boolean;
  flowMetadataSeen: boolean;
  nullRouteMutationLines: number[];
  decision: DecisionState;
  decisionConfirmLine: number;
  identityConflictLine: number;
  epochResetMissingIdentity: boolean;
  taskLines: Set<number>;
  taskTurns: Map<string, string>;
  userAuthorizedRerun: boolean;
  userRetryAuthorization: ReleaseRetryAuthorization | undefined;
  modernContract: boolean;
  reportContractDeclared: boolean;
  malformedPolicyRoute: boolean;
  lastRerunLine: number;
  releaseRerunAttempted: boolean;
  targetCiRuns: Map<string, string>;
  prCiRuns: Map<string, string>;
}

export function createReleaseState(): ReleaseState {
  return {
    findings: [],
    expected: undefined,
    epoch: undefined,
    target: {
      repo: undefined,
      branch: undefined,
      sha: undefined,
      epoch: undefined,
      tag: undefined,
    },
    reported: {
      tag: undefined,
      version: undefined,
      url: undefined,
      workflow: undefined,
      time: undefined,
    },
    bound: undefined,
    candidate: undefined,
    statusLine: 0,
    status: undefined,
    mergeLine: 0,
    releaseIntentLine: 0,
    releaseExpectationLine: 0,
    mergeShaValue: undefined,
    publicationFacts: [],
    expectedSurfaceSet: new Set(),
    surfaceIdentities: new Map(),
    actualRunId: undefined,
    failureEvidence: false,
    failureEvidenceLine: 0,
    idempotentRun: false,
    rerunCount: 0,
    rerunViolation: 0,
    route: undefined,
    routeResetLine: 0,
    routeMutationLines: [],
    routeStep5cLine: 0,
    routeSignal: false,
    flowMetadataSeen: false,
    nullRouteMutationLines: [],
    decision: {
      seen: false,
      line: 0,
      valid: false,
      blocked: false,
      routeAbsence: false,
      invalidReason: undefined,
      fingerprint: undefined,
    },
    decisionConfirmLine: 0,
    identityConflictLine: 0,
    epochResetMissingIdentity: false,
    taskLines: new Set(),
    taskTurns: new Map(),
    userAuthorizedRerun: false,
    userRetryAuthorization: undefined,
    modernContract: false,
    reportContractDeclared: false,
    malformedPolicyRoute: false,
    lastRerunLine: 0,
    releaseRerunAttempted: false,
    targetCiRuns: new Map(),
    prCiRuns: new Map(),
  };
}

export function add(
  findings: Finding[],
  code: string,
  line: number,
  message: string,
): void {
  if (!findings.some((item) => item.code === code))
    findings.push({ code, line, message });
}

export function payloadOf(record: JsonRecord): JsonRecord {
  return isRecord(record.payload) ? record.payload : {};
}

export function isTaskComplete(record: JsonRecord): boolean {
  const payload = payloadOf(record);
  return record.type === "event_msg" && payload.type === "task_complete";
}

export function taskMessage(record: JsonRecord): string {
  const payload = payloadOf(record);
  return isTaskComplete(record) &&
    typeof payload.last_agent_message === "string"
    ? payload.last_agent_message
    : "";
}

export function structuredExpectation(
  card: Record<string, unknown>,
): ReleaseExpected {
  const value = card.release_expected ?? card.release_enabled;
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string" && value.toLowerCase() === "unknown")
    return "unknown";
  return undefined;
}

export function textExpectation(text: string): ReleaseExpected {
  if (releaseExpectedTrue.test(text)) return true;
  if (releaseExpectedFalse.test(text)) return false;
  if (releaseExpectedUnknown.test(text)) return "unknown";
  return undefined;
}

export function captureUserRetryAuthorization(
  state: ReleaseState,
  text: string,
): void {
  for (const object of jsonObjects(text)) {
    const value = object.release_retry_authorization;
    if (!isRecord(value) || typeof value.allowed !== "boolean") continue;
    const epoch = stringValue(value.release_epoch);
    const repo = stringValue(value.target_repo)?.toLowerCase();
    const branch = stringValue(value.target_branch)?.replace(
      /^refs\/heads\//i,
      "",
    );
    const sha = asSha(value.target_sha);
    const runId =
      ![true, false].includes(value.release_run_id as boolean) &&
      (typeof value.release_run_id === "string" ||
        typeof value.release_run_id === "number") &&
      /^[1-9]\d*$/.test(String(value.release_run_id))
        ? String(value.release_run_id)
        : undefined;
    if (!epoch || !repo || !branch || !sha || !runId) continue;
    if (!value.allowed) {
      state.userRetryAuthorization = undefined;
      continue;
    }
    state.userRetryAuthorization = {
      allowed: true,
      epoch,
      repo,
      branch,
      sha,
      runId,
    };
  }
}

export function releaseRerunAuthorizationMatches(
  state: ReleaseState,
  runId: string | undefined,
  repoFlag: string | undefined,
): boolean {
  const authorization = state.userRetryAuthorization;
  const targetRepo = state.target.repo?.toLowerCase();
  const targetBranch = state.target.branch?.replace(/^refs\/heads\//i, "");
  return Boolean(
    authorization?.allowed &&
    state.epoch === authorization.epoch &&
    targetRepo &&
    targetRepo === authorization.repo &&
    targetBranch &&
    targetBranch === authorization.branch &&
    state.target.sha &&
    shaMatches(state.target.sha, authorization.sha) &&
    state.actualRunId === authorization.runId &&
    runId === authorization.runId &&
    (!repoFlag || repoFlag === authorization.repo),
  );
}

export function cardIdentity(card: Record<string, unknown>): ReleaseIdentity {
  const value = (candidate: unknown): string | undefined =>
    typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : undefined;
  const sha = value(card.target_sha ?? card.merge_sha)?.toLowerCase();
  return {
    repo: value(card.target_repo)?.toLowerCase(),
    branch: value(card.target_branch)?.replace(/^refs\/heads\//i, ""),
    sha: sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined,
    epoch: value(card.release_epoch),
    tag: value(card.release_tag),
  };
}
