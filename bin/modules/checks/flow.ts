import {
  collectTrackerCardStrings,
  collectStrings,
  finding,
  eventTexts,
  isRecord,
  readJsonLines,
  result,
  type Finding,
  type ReplayResult,
} from "./replay";
import {
  extractFlowLock,
  isContinue,
  isNestedTaskFlow,
  isNegatedContinue,
  isRouteAttempt,
  shouldIgnoreUserBlob,
  isUserFlowLockCandidate,
  routeIsValid,
} from "./flow_support";
import {
  createReleaseRouteState,
  noteReleaseContinue,
  releaseRouteFinding,
  updateReleaseRouteState,
} from "./flow_release";
import {
  createFlowCleanupState,
  flowCleanupFindings,
  updateFlowCleanupState,
} from "./flow_cleanup";

const localRoute =
  /skills\/local-merge-flow\/SKILL\.md|\$local-merge-flow\b|local merge flow|本地合主干流程/i;
const publicationRoute =
  /skills\/project-engineering-workflow\/references\/pr-publication-procedure\.md|\$pr-create\b|PR publication procedure/i;
const mergeStop =
  /merge-only|merge\+cleanup|收工条件=.*merge(?:-only|\+cleanup)|当前 stop condition 是 .*merge(?:-only|\+cleanup)/i;
const reviewFeedback =
  /reviewer feedback|review threads|review comments|unresolved human feedback|review 反馈|review threads/i;
const visualPending =
  /视觉比较\s*[:=]\s*(?:需确认|有差异|不可比较|无基线)|(?:截图|图片).{0,36}(?:准确反映|是否准确).{0,24}(?:确认|吗)/i;
const visualAccepted =
  /(?<!不)(?:确认|同意|批准).{0,36}(?:截图|图片|视觉|证据)|(?:这些|当前|该)?\s*(?:截图|图片|视觉|证据).{0,36}(?:准确|正确|没问题|符合)|^(?:可以|没问题|准确|正确|是的|对|好的|确认|同意)\s*[，,、]?\s*(?:继续)?[。！!]?$/i;
const visualRejected =
  /不(?:确认|同意|批准)|(?:截图|图片|视觉|证据).{0,36}(?:不准确|不正确|不可以|不符合|不能反映|不行)/i;
const field = (name: string) =>
  new RegExp(`\\b${name}\\s*[:=]\\s*([A-Za-z][A-Za-z_-]*)\\b`, "ig");
const repairPermitField = () =>
  /\b(?:repair_)?permit_status\s*[:=]\s*([A-Za-z][A-Za-z_-]*)\b/gi;
const flowLockStatus =
  /(?<![A-Za-z0-9_])[`"']?(?:lock[_ -]?status|flow[_ -]?status)[`"']?\s*[:=]\s*[`"']?(locked|pending|unlocked)\b/i;

type RepairMarkers = [
  number | undefined,
  number | undefined,
  number | undefined,
];

type RepairSnapshot = {
  permit: string;
  relation: string;
  match: string;
  line: number;
  valid: boolean;
  trusted: boolean;
  flowEpoch: number;
  markerLines: RepairMarkers;
};

type RepairContinuation = {
  line: number;
  valid: boolean;
  markerLines: RepairMarkers;
};

type InvalidRepairContinuation = RepairContinuation & { routeLine?: number };

export function analyzeFlowReplay(path: string): ReplayResult {
  const findings: Finding[] = [];
  let parentFlow: string | undefined;
  let parentLockLine = 0;
  let taskFlow: string | undefined;
  let taskLockLine = 0;
  let genericLine = 0;
  let visualPendingLine = 0;
  let flowLockEpoch = 0;
  let parentLockStatus: string | undefined;
  let taskLockStatus: string | undefined;
  let repair: RepairSnapshot | undefined;
  let repairContinue: RepairContinuation | undefined;
  let invalidRepairContinue: InvalidRepairContinuation | undefined;
  let repairSwitchPending = false;
  let repairRoute = false;
  let mergeStopLine = 0;
  let feedbackLine = 0;
  let authBlockLine = 0;
  let publicationRouteLine = 0;
  let mergedLine = 0;
  const releaseRouteState = createReleaseRouteState();
  const cleanupState = createFlowCleanupState();
  for (const { line, value } of readJsonLines(path)) {
    const payload = isRecord(value.payload) ? value.payload : {};
    const { kind, role, texts } = eventTexts(value);
    const joined = (
      kind === "function_call_output"
        ? isRecord(payload.output)
          ? collectTrackerCardStrings(payload.output)
          : Array.isArray(payload.output)
            ? collectStrings(payload.output)
            : texts
        : texts
    ).join("\n");
    const content =
      role === "assistant" ||
      role === "user" ||
      kind === "function_call" ||
      kind === "function_call_output" ||
      value.type === "event_msg";
    if (!content) continue;
    updateReleaseRouteState(releaseRouteState, value, kind, role, joined, line);
    const nextFlow =
      role === "assistant"
        ? extractFlowLock(joined, role)
        : role === "user" && isUserFlowLockCandidate(joined)
          ? extractFlowLock(joined, role)
          : undefined;
    const nextLockStatus = joined.match(flowLockStatus)?.[1]?.toLowerCase();
    if (role === "assistant" || role === "user") {
      if (nextFlow) {
        const nestedTaskFlow = isNestedTaskFlow(
          parentFlow,
          nextFlow,
          role,
          joined,
        );
        const currentFlow = nestedTaskFlow ? taskFlow : parentFlow;
        const currentLockStatus = nestedTaskFlow
          ? taskLockStatus
          : parentLockStatus;
        const changedFlow = Boolean(currentFlow && currentFlow !== nextFlow);
        const changedLockStatus = Boolean(
          nextLockStatus &&
          currentLockStatus &&
          nextLockStatus !== currentLockStatus,
        );
        if (!currentFlow || changedFlow || changedLockStatus) {
          flowLockEpoch += 1;
          repair = undefined;
        }
        if (changedFlow && repairContinue) {
          invalidRepairContinue = {
            ...repairContinue,
          };
          repairContinue = undefined;
        }
        if (nestedTaskFlow) {
          taskFlow = nextFlow;
          taskLockLine = line;
        } else {
          parentFlow = nextFlow;
          parentLockLine = line;
          taskFlow = undefined;
          taskLockLine = 0;
          taskLockStatus = undefined;
        }
      } else if (nextLockStatus) {
        const currentLockStatus = taskFlow ? taskLockStatus : parentLockStatus;
        if (currentLockStatus && nextLockStatus !== currentLockStatus) {
          flowLockEpoch += 1;
          repair = undefined;
        }
        if (taskFlow) taskLockStatus = nextLockStatus;
        else parentLockStatus = nextLockStatus;
      }
    }
    const locked = taskFlow ?? parentFlow;
    const lockLine = taskFlow ? taskLockLine : parentLockLine;
    if (
      role === "user" &&
      !shouldIgnoreUserBlob(joined) &&
      locked !== undefined &&
      line > lockLine
    )
      noteReleaseContinue(releaseRouteState, locked, mergedLine, joined, line);
    if (role === "assistant" && visualPending.test(joined))
      visualPendingLine = line;
    if (
      role === "user" &&
      visualPendingLine &&
      visualAccepted.test(joined) &&
      !visualRejected.test(joined)
    )
      visualPendingLine = 0;
    if (
      role === "assistant" &&
      /候选(?:渲染|截图|图片).{0,24}(?:变化|变更|更新)|render(?:ed)?\s*(?:surface|input)s?.{0,24}changed/i.test(
        joined,
      )
    )
      visualPendingLine = line;
    const eligibleUserContinuation =
      role === "user" &&
      !shouldIgnoreUserBlob(joined) &&
      locked !== undefined &&
      line > lockLine;
    if (eligibleUserContinuation && isContinue(joined)) {
      genericLine = line;
      repairRoute = false;
      repairSwitchPending = false;
      repairContinue = undefined;
      if (
        repair &&
        locked &&
        ["normal", "fast-track", "multi-task-flow"].includes(locked) &&
        repair.line < line &&
        repair.flowEpoch === flowLockEpoch
      ) {
        repairContinue = {
          line,
          valid: repair.trusted && repair.valid,
          markerLines: repair.markerLines,
        };
        if (!repairContinue.valid) {
          invalidRepairContinue = {
            ...repairContinue,
          };
          repairContinue = undefined;
        }
      }
    } else if (
      eligibleUserContinuation &&
      isNegatedContinue(joined) &&
      locked &&
      ["normal", "fast-track", "multi-task-flow"].includes(locked) &&
      repair &&
      repair.line < line &&
      repair.flowEpoch === flowLockEpoch
    ) {
      invalidRepairContinue = {
        line,
        valid: false,
        markerLines: repair.markerLines,
      };
    }
    if (
      role === "user" &&
      repairContinue &&
      /(?:改为|切到|切换到|锁定|选择|采用|设为).*(?:local[-_ ]merge|本地合主干)/i.test(
        joined,
      )
    )
      repairSwitchPending = true;
    const repairMarkerValues = [
      [...joined.matchAll(repairPermitField())].map((match) =>
        match[1]!.toLowerCase(),
      ),
      [...joined.matchAll(field("base_relation"))].map((match) =>
        match[1]!.toLowerCase(),
      ),
      [...joined.matchAll(field("live_pr_match"))].map((match) =>
        match[1]!.toLowerCase(),
      ),
    ];
    if (repairMarkerValues.some((values) => values.length)) {
      const valid = repairMarkerValues.every((values) => values.length === 1);
      const snapshot = {
        permit: repairMarkerValues[0]?.[0] ?? "",
        relation: repairMarkerValues[1]?.[0] ?? "",
        match: repairMarkerValues[2]?.[0] ?? "",
        line,
        valid:
          valid &&
          repairMarkerValues[0]?.[0] === "issued" &&
          repairMarkerValues[1]?.[0] === "fast-forward" &&
          repairMarkerValues[2]?.[0] === "true",
        trusted: kind === "message" && role === "assistant",
        flowEpoch: flowLockEpoch,
        markerLines: [
          repairMarkerValues[0]?.length ? line : undefined,
          repairMarkerValues[1]?.length ? line : undefined,
          repairMarkerValues[2]?.length ? line : undefined,
        ] as RepairMarkers,
      };
      repair = snapshot;
      if (snapshot.trusted) invalidRepairContinue = undefined;
      if (genericLine && line > genericLine) {
        invalidRepairContinue = {
          line: genericLine,
          valid: false,
          markerLines: snapshot.markerLines,
        };
        repairContinue = undefined;
      }
      if (repairContinue && line > repairContinue.line) {
        invalidRepairContinue = {
          ...repairContinue,
        };
        repairContinue = undefined;
      }
    }
    if (isRouteAttempt(kind, payload)) {
      repairRoute = routeIsValid(payload);
      if (repairContinue) {
        if (repairContinue.valid && repairRoute && !repairSwitchPending) {
          repairContinue = undefined;
        } else {
          invalidRepairContinue = {
            ...repairContinue,
            routeLine: line,
          };
          repairContinue = undefined;
        }
      } else if (
        invalidRepairContinue &&
        invalidRepairContinue.routeLine === undefined
      ) {
        invalidRepairContinue.routeLine = line;
      }
      if (
        invalidRepairContinue &&
        invalidRepairContinue.routeLine === undefined &&
        !repairRoute
      )
        invalidRepairContinue.routeLine = line;
    }
    if (kind === "function_call" && localRoute.test(joined)) {
      if (
        genericLine &&
        locked !== "local-merge" &&
        !findings.some(
          (item) => item.code === "LOCKED_FLOW_DRIFT_TO_LOCAL_MERGE",
        )
      )
        findings.push(
          finding(
            "LOCKED_FLOW_DRIFT_TO_LOCAL_MERGE",
            line,
            `locked_flow=${locked ?? "unknown"} lock_line=${lockLine} generic_continue_line=${genericLine}`,
          ),
        );
    }
    if (
      mergeStopLine === 0 &&
      (role === "assistant" || role === "user") &&
      mergeStop.test(joined)
    )
      mergeStopLine = line;
    if (role === "assistant" && reviewFeedback.test(joined))
      feedbackLine = line;
    if (
      authBlockLine === 0 &&
      role === "assistant" &&
      /需要显式授权进入 PR convergence|switch into PR convergence|显式授权.*PR convergence/i.test(
        joined,
      )
    )
      authBlockLine = line;
    if (publicationRouteLine === 0 && publicationRoute.test(joined))
      publicationRouteLine = line;
    mergedLine = updateFlowCleanupState(
      cleanupState,
      releaseRouteState,
      value,
      kind,
      role,
      joined,
      line,
    );
    if (
      visualPendingLine &&
      (publicationRoute.test(joined) ||
        /(?:\$pr-create|PR publication procedure|调用 .*PR 收敛)/i.test(joined))
    )
      findings.push(
        finding(
          "PENDING_VISUAL_RESPONSE_ROUTED_TO_PR_CREATE",
          line,
          `visual_response_line=${visualPendingLine}`,
        ),
      );
  }
  if (repairContinue && repairContinue.valid)
    findings.push(
      finding(
        "REPAIR_PERMIT_BASE_ADVANCE_NOT_RESUMED",
        repairContinue.line,
        "issued fast-forward permit continuation was not resumed",
      ),
    );
  if (invalidRepairContinue?.routeLine)
    findings.push(
      finding(
        "REPAIR_PERMIT_BASE_ADVANCE_INVALID_ROUTE",
        invalidRepairContinue.routeLine,
        "invalid permit/base facts were routed as repair continuation",
      ),
    );
  if (
    mergeStopLine &&
    feedbackLine > genericLine &&
    authBlockLine > genericLine &&
    publicationRouteLine < authBlockLine
  )
    findings.push(
      finding(
        "MERGE_PATH_REVIEW_FEEDBACK_NOT_ROUTED",
        authBlockLine,
        "review feedback remained blocked without PR convergence route",
      ),
    );
  findings.push(...flowCleanupFindings(cleanupState));
  const releaseFinding = releaseRouteFinding(releaseRouteState);
  if (releaseFinding) findings.push(releaseFinding);
  const deduped = findings.filter(
    (item, index, all) =>
      all.findIndex(
        (other) => other.code === item.code && other.line === item.line,
      ) === index,
  );
  return result(deduped);
}
