import {
  isRecord,
  readJsonLines,
  result,
  type Finding,
  type ReplayResult,
} from "./replay";

interface HandoffState {
  origin: string | undefined;
  independent: boolean;
  ciRequired: boolean;
  releaseAuthorized: boolean;
  ciStarted: boolean;
  ciPassed: boolean;
  preparationStarted: boolean;
  blocked: boolean;
}

function initialState(): HandoffState {
  return {
    origin: undefined,
    independent: false,
    ciRequired: false,
    releaseAuthorized: false,
    ciStarted: false,
    ciPassed: false,
    preparationStarted: false,
    blocked: false,
  };
}

function error(code: string, line: number, message: string): Finding {
  return { code, line, message };
}

function observe(
  state: HandoffState,
  payload: Record<string, unknown>,
  line: number,
): Finding | undefined {
  const event = payload.event;
  const sha = payload.merge_sha;
  if (event === "merged") {
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
      return error(
        "HANDOFF_INVALID_ORIGIN",
        line,
        "merge_sha must be a full commit",
      );
    if (
      [
        "preparation_independent",
        "ci_required_for_dispatch",
        "release_authorized",
      ].some((key) => typeof payload[key] !== "boolean")
    )
      return error(
        "HANDOFF_INVALID_POLICY",
        line,
        "policy flags must be explicit booleans",
      );
    const next = initialState();
    next.origin = sha;
    next.independent = payload.preparation_independent as boolean;
    next.ciRequired = payload.ci_required_for_dispatch as boolean;
    next.releaseAuthorized = payload.release_authorized as boolean;
    Object.assign(state, next);
    return undefined;
  }

  if (state.origin === undefined || sha !== state.origin)
    return error(
      "HANDOFF_ORIGIN_MISMATCH",
      line,
      "event must bind the confirmed merge SHA",
    );

  if (event === "ci_started") {
    state.ciStarted = true;
  } else if (event === "preparation_started") {
    if (!state.releaseAuthorized)
      return error(
        "HANDOFF_AUTHORIZATION_MISSING",
        line,
        "preparation requires release authorization",
      );
    if (!state.independent && !state.ciPassed)
      return error(
        "HANDOFF_PREPARATION_GATE_PENDING",
        line,
        "preparation requires passed CI",
      );
    state.preparationStarted = true;
  } else if (event === "preparation_blocked") {
    if (typeof payload.reason !== "string" || !payload.reason.trim())
      return error(
        "HANDOFF_BLOCKER_MISSING",
        line,
        "blocked preparation requires a reason",
      );
    state.blocked = true;
  } else if (event === "ci_wait") {
    if (!state.ciStarted)
      return error(
        "HANDOFF_CI_NOT_STARTED",
        line,
        "CI must start before waiting",
      );
    if (
      state.releaseAuthorized &&
      state.independent &&
      !state.preparationStarted &&
      !state.blocked
    )
      return error(
        "HANDOFF_PREPARATION_SERIALIZED",
        line,
        "independent preparation must start before waiting for CI",
      );
  } else if (event === "ci_terminal") {
    if (
      !state.ciStarted ||
      !["passed", "failed"].includes(String(payload.result))
    )
      return error(
        "HANDOFF_CI_INVALID",
        line,
        "terminal CI requires a started tracker and explicit result",
      );
    state.ciPassed = payload.result === "passed";
  } else if (event === "dispatch") {
    if (
      !state.releaseAuthorized ||
      !state.ciStarted ||
      !state.preparationStarted ||
      state.blocked
    )
      return error(
        "HANDOFF_DISPATCH_BLOCKED",
        line,
        "dispatch requires started CI and unblocked preparation",
      );
    if (state.ciRequired && !state.ciPassed)
      return error(
        "HANDOFF_RELEASE_GATE_PENDING",
        line,
        "repository policy requires passed CI before dispatch",
      );
  } else if (event === "handoff_checked") {
    if (!state.ciStarted)
      return error(
        "HANDOFF_CI_NOT_STARTED",
        line,
        "handoff requires started CI tracking",
      );
    if (
      state.releaseAuthorized &&
      state.independent &&
      !state.preparationStarted &&
      !state.blocked
    )
      return error(
        "HANDOFF_PREPARATION_NOT_STARTED",
        line,
        "independent preparation must start or report a blocker",
      );
  } else {
    return error(
      "HANDOFF_EVENT_INVALID",
      line,
      "unknown post-merge handoff event",
    );
  }
  return undefined;
}

/** Check normalized post-merge handoff fixtures; these records are not runtime authorization. */
export function analyzePostMergeHandoff(path: string): ReplayResult {
  const findings: Finding[] = [];
  const state = initialState();
  for (const { line, value } of readJsonLines(path)) {
    if (value.type !== "post_merge_handoff") continue;
    const payload = value.payload;
    if (!isRecord(payload)) {
      findings.push(
        error(
          "HANDOFF_EVENT_INVALID",
          line,
          "handoff payload must be an object",
        ),
      );
      continue;
    }
    const finding = observe(state, payload, line);
    if (finding && !findings.some((item) => item.code === finding.code))
      findings.push(finding);
  }
  return result(findings);
}
