import { finding, isRecord, type Finding, type JsonRecord } from "./replay";
import {
  extractFlowLock,
  isNegatedContinue,
  unfencedText,
} from "./flow_support";
import {
  isMergeFactCommand,
  isPrCreateCommand,
  isRouteResolutionCommand,
  commandTarget,
  commandTargetMatches,
  preservePendingCallBindings,
  type CommandTarget,
  structuredMergedTarget,
} from "./flow_release_evidence";
import { validPreMergeRouteCard } from "./flow_release_cards";

const genericContinue =
  /\[\$flow-continue\]|继续|推进流程|接着做|你直接做吧|你直接收尾吧|合并并收尾|收尾|合并/i;
const preMergeRouteResolution =
  /pre[_ -]?merge[_ -]?release[_ -]?route\s*[:=]|release[_ -]?route[_ -]?(?:re)?resolved|current[_ -]?release[_ -]?route\s*[:=]|当前发布路由(?:已重新解析)?\s*[:=]|发布路由已重新解析/i;
const legacyDisposition =
  /(?<![A-Za-z0-9_])[`"']?release[_ -]?disposition[`"']?\s*[:=]/i;
export interface ReleaseRouteState {
  routeGateSeen: boolean;
  continueLine: number;
  lastContinueLine: number;
  routeResolutionLine: number;
  currentFactsLine: number;
  refreshLine: number;
  prCreated: boolean;
  routeResolutionCallIds: Set<string>;
  mergeFactCallIds: Set<string>;
  routeResolutionTargets: Map<string, CommandTarget>;
  mergeFactTargets: Map<string, CommandTarget>;
  seenCallIds: Set<string>;
  invalidCallIds: Set<string>;
  outputCallIds: Set<string>;
  targetRepo: string | undefined;
  targetPr: string | undefined;
}

export function createReleaseRouteState(): ReleaseRouteState {
  return {
    routeGateSeen: false,
    continueLine: 0,
    lastContinueLine: 0,
    routeResolutionLine: 0,
    currentFactsLine: 0,
    refreshLine: 0,
    prCreated: false,
    routeResolutionCallIds: new Set(),
    mergeFactCallIds: new Set(),
    routeResolutionTargets: new Map(),
    mergeFactTargets: new Map(),
    seenCallIds: new Set(),
    invalidCallIds: new Set(),
    outputCallIds: new Set(),
    targetRepo: undefined,
    targetPr: undefined,
  };
}

function hasUserFlowLock(text: string): boolean {
  return extractFlowLock(text, "user") !== undefined;
}

function isGenericContinue(text: string): boolean {
  const visible = unfencedText(text);
  return (
    genericContinue.test(visible) &&
    !isNegatedContinue(visible) &&
    !hasUserFlowLock(visible)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function callId(value: JsonRecord): string | undefined {
  const payload = isRecord(value.payload) ? value.payload : {};
  const raw = payload.call_id;
  if (
    typeof raw === "boolean" ||
    (typeof raw !== "string" && typeof raw !== "number")
  )
    return undefined;
  const text = String(raw).trim();
  return text || undefined;
}

export function hasBoundStructuredMergedFact(
  state: ReleaseRouteState,
  value: JsonRecord,
): boolean {
  const id = callId(value);
  const payload = isRecord(value.payload) ? value.payload : {};
  const target = structuredMergedTarget(payload.output);
  const command = id ? state.mergeFactTargets.get(id) : undefined;
  return Boolean(
    id &&
    state.routeResolutionLine > 0 &&
    !state.invalidCallIds.has(id) &&
    state.mergeFactCallIds.has(id) &&
    state.targetRepo &&
    state.targetPr &&
    target &&
    commandTargetMatches(target.repository, target.number, command) &&
    target.repository.toLowerCase() === state.targetRepo.toLowerCase() &&
    target.number === state.targetPr,
  );
}

export function updateReleaseRouteState(
  state: ReleaseRouteState,
  value: JsonRecord,
  kind: string | undefined,
  role: string | undefined,
  joined: string,
  line: number,
): void {
  const routeResolutionCommand =
    kind === "function_call" && isRouteResolutionCommand(value);
  const mergeFactCommand =
    kind === "function_call" && isMergeFactCommand(value);
  const prCreateCommand = kind === "function_call" && isPrCreateCommand(value);
  const id = callId(value);
  const target = commandTarget(value);
  const routeRefreshCommand =
    routeResolutionCommand &&
    (!state.routeGateSeen ||
      state.lastContinueLine > state.routeResolutionLine);
  const relevantCommand =
    routeResolutionCommand || mergeFactCommand || prCreateCommand;
  const freshRelevantCallId = Boolean(
    id && relevantCommand && !state.seenCallIds.has(id),
  );
  const reusedCallId = Boolean(id && state.seenCallIds.has(id));
  if (kind === "function_call" && id && (relevantCommand || reusedCallId)) {
    if (state.seenCallIds.has(id)) {
      state.invalidCallIds.add(id);
      state.routeResolutionCallIds.delete(id);
      state.mergeFactCallIds.delete(id);
      state.routeResolutionTargets.delete(id);
      state.mergeFactTargets.delete(id);
    } else {
      state.seenCallIds.add(id);
    }
  }
  if (routeRefreshCommand || prCreateCommand) {
    state.routeGateSeen = false;
    state.routeResolutionLine = 0;
    state.currentFactsLine = 0;
    state.refreshLine = line;
    state.targetRepo = undefined;
    state.targetPr = undefined;
    state.routeResolutionCallIds.clear();
    state.mergeFactCallIds.clear();
    state.routeResolutionTargets.clear();
    state.mergeFactTargets.clear();
    state.targetRepo = target?.repository;
    state.targetPr = target?.number;
  } else if (mergeFactCommand) {
    state.refreshLine = line;
    state.routeResolutionCallIds.clear();
    state.mergeFactCallIds.clear();
    state.routeResolutionTargets.clear();
    state.mergeFactTargets.clear();
  }
  const trusted =
    kind === "function_call_output" ||
    (kind === "message" && role === "assistant");
  if (trusted && preMergeRouteResolution.test(joined)) {
    const pendingRouteBindings = new Map(
      [...state.routeResolutionCallIds]
        .filter((callId) => !state.outputCallIds.has(callId))
        .flatMap((callId) => {
          const target = state.routeResolutionTargets.get(callId);
          return target ? [[callId, target] as const] : [];
        }),
    );
    const pendingMergeBindings = new Map(
      [...state.mergeFactCallIds]
        .filter((callId) => !state.outputCallIds.has(callId))
        .flatMap((callId) => {
          const target = state.mergeFactTargets.get(callId);
          return target ? [[callId, target] as const] : [];
        }),
    );
    state.routeGateSeen = false;
    state.routeResolutionLine = 0;
    state.currentFactsLine = 0;
    state.refreshLine = line;
    state.targetRepo = undefined;
    state.targetPr = undefined;
    state.routeResolutionCallIds.clear();
    state.mergeFactCallIds.clear();
    state.routeResolutionTargets.clear();
    state.mergeFactTargets.clear();
    for (const [callId, target] of pendingRouteBindings) {
      state.routeResolutionCallIds.add(callId);
      state.routeResolutionTargets.set(callId, target);
    }
    for (const [callId, target] of pendingMergeBindings) {
      state.mergeFactCallIds.add(callId);
      state.mergeFactTargets.set(callId, target);
    }
  }
  if (routeRefreshCommand && id && freshRelevantCallId) {
    state.routeResolutionCallIds.add(id);
    if (target) state.routeResolutionTargets.set(id, target);
  }
  if (mergeFactCommand && id && freshRelevantCallId) {
    state.mergeFactCallIds.add(id);
    if (target) state.mergeFactTargets.set(id, target);
  }
  if (prCreateCommand) state.prCreated = true;
  if (legacyDisposition.test(joined)) state.routeGateSeen = true;
  if (
    validPreMergeRouteCard(
      value,
      state.prCreated,
      Boolean(id && state.routeResolutionCallIds.has(id)),
      id ? state.routeResolutionTargets.get(id) : undefined,
    )
  ) {
    state.routeGateSeen = true;
    state.routeResolutionLine = line;
    state.currentFactsLine = line;
    const output = isRecord(value.payload) ? value.payload.output : undefined;
    if (isRecord(output)) {
      const targetRepo = stringValue(output.target_repo);
      const targetPr = output.target_pr;
      state.targetRepo = targetRepo;
      state.targetPr =
        typeof targetPr === "number" &&
        Number.isInteger(targetPr) &&
        targetPr > 0
          ? String(targetPr)
          : typeof targetPr === "string" &&
              /^[1-9][0-9]*$/.test(targetPr.trim())
            ? targetPr.trim()
            : undefined;
    }
  }
  if (
    kind === "function_call_output" &&
    id &&
    (state.routeResolutionCallIds.has(id) || state.mergeFactCallIds.has(id))
  )
    state.outputCallIds.add(id);
}

export function noteReleaseContinue(
  state: ReleaseRouteState,
  locked: string | undefined,
  mergedLine: number,
  text: string,
  line: number,
): void {
  if (!isGenericContinue(text)) return;
  state.lastContinueLine = line;
  const mergedForCurrentRefresh =
    mergedLine > 0 && mergedLine > state.refreshLine;
  if (mergedForCurrentRefresh) state.continueLine = 0;
  else if (
    locked === "normal" ||
    locked === "fast-track" ||
    (state.routeGateSeen && locked === "local-merge")
  )
    state.continueLine = line;
  state.routeGateSeen = false;
  state.routeResolutionLine = 0;
  state.currentFactsLine = 0;
  state.refreshLine = line;
  state.targetRepo = undefined;
  state.targetPr = undefined;
  preservePendingCallBindings(
    state.outputCallIds,
    state.routeResolutionCallIds,
    state.routeResolutionTargets,
  );
  preservePendingCallBindings(
    state.outputCallIds,
    state.mergeFactCallIds,
    state.mergeFactTargets,
  );
}

export function releaseRouteFinding(
  state: ReleaseRouteState,
): Finding | undefined {
  if (
    state.continueLine > 0 &&
    (!state.routeResolutionLine ||
      !state.currentFactsLine ||
      state.routeResolutionLine <= state.continueLine ||
      state.currentFactsLine <= state.continueLine)
  )
    return finding(
      "RELEASE_ROUTE_NOT_RERESOLVED_ON_CONTINUE",
      state.continueLine,
      "continuation must refresh current repository/PR facts and re-run pre-merge route resolution",
    );
  return undefined;
}
