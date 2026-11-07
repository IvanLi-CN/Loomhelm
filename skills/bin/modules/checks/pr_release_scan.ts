import { eventTexts, isRecord, readJsonLines } from "./replay";
import { callCommand } from "./pr_support";
import {
  boundSha,
  candidateTag,
  mergeSha,
  publicationFact,
  releaseEpoch,
  releaseIntent,
  releaseStatus,
  reportedTag,
  reportedTime,
  reportedUrl,
  reportedVersion,
  reportedWorkflow,
  shaMatches,
  stringValue,
  targetBranch,
  targetRepo,
  targetSha,
  jsonObjects,
} from "./pr_release_support";
import {
  confirmCard,
  confirmNegated,
  dispositionProof,
  dispositionSeparation,
  mergeSuccess,
  releaseCardText,
} from "./pr_release_rules";
import {
  isTaskComplete,
  payloadOf,
  taskMessage,
  textExpectation,
  captureUserRetryAuthorization,
  type ReleaseState,
} from "./pr_release_state";
import {
  commandLabels,
  decisionFrom,
  routeFactsFrom,
  routeFrom,
  routeIsStale,
} from "./pr_release_routes";
import { processReleaseCards } from "./pr_release_cards";
import { processReleaseCommand } from "./pr_release_commands";
import { evaluateRelease } from "./pr_release_evaluate";
import { add } from "./pr_release_state";
import { flowLock, flowType } from "./pr_terminal_support";

export function scanRelease(state: ReleaseState, path: string): void {
  for (const { line, value } of readJsonLines(path)) {
    const payload = payloadOf(value);
    const { kind, role, texts } = eventTexts(value);
    const joined = texts.join("\n");
    const message = taskMessage(value);
    const output = kind === "function_call_output" ? payload.output : undefined;
    const cards = kind === "function_call_output" ? jsonObjects(output) : [];
    const callId =
      kind === "function_call_output" && typeof payload.call_id === "string"
        ? payload.call_id
        : "";
    if (/post-merge|decision-card/i.test(callId)) state.modernContract = true;
    const epochMatch = releaseEpoch.exec(joined)?.[1];
    const currentEpoch =
      epochMatch ??
      cards.map((card) => stringValue(card.release_epoch)).find(Boolean) ??
      state.epoch;
    const flowRoute = role ? flowType.test(joined) : false;
    const lockRoute = role ? flowLock.test(joined) : false;
    if (
      role &&
      (flowRoute || lockRoute) &&
      state.routeResetLine &&
      line > state.routeResetLine
    )
      state.route = undefined;
    if (role && (flowRoute || lockRoute)) state.routeResetLine = line;
    if (role && /flow[_ -]?type|lock[_ -]?status/i.test(joined))
      state.flowMetadataSeen = true;
    if (releaseIntent.test(joined)) state.releaseIntentLine ||= line;
    if (
      releaseIntent.test(joined) ||
      /current[\s_-]?(?:head|PR)|当前.{0,24}(?:head|PR)/i.test(joined)
    )
      state.routeSignal = true;
    if (/(?:Step\s*5C\s*Ready|merge-ready)/i.test(joined))
      state.routeStep5cLine ||= line;
    const decisionFound =
      kind === "function_call_output" ? decisionFrom(output) : undefined;
    if (decisionFound) {
      if (
        state.decision.fingerprint &&
        decisionFound.fingerprint &&
        state.decision.fingerprint !== decisionFound.fingerprint
      )
        state.decisionConfirmLine = 0;
      state.decision = { ...decisionFound, line };
      state.modernContract = true;
      if (!decisionFound.valid) {
        add(
          state.findings,
          decisionFound.routeAbsence
            ? "RELEASE_DECISION_ROUTE_ABSENCE_AS_NO_RELEASE"
            : "RELEASE_DECISION_CARD_INVALID",
          line,
          decisionFound.invalidReason ?? "release decision card is invalid",
        );
      }
    } else if (role === "assistant" && releaseCardText.test(joined))
      state.decision.seen = true;
    if (
      role === "user" &&
      confirmCard.test(joined) &&
      !confirmNegated.test(joined)
    )
      state.decisionConfirmLine = line;
    if (kind === "function_call_output") {
      if (
        jsonObjects(output).some((card) =>
          /malformed-policy|invalid-policy/i.test(
            String(card.route_source ?? card.policy_source ?? ""),
          ),
        )
      )
        state.malformedPolicyRoute = true;
      const routeFound = routeFrom(output);
      if (routeFound) state.route = { ...routeFound, line };
      const routeFacts = routeFactsFrom(output);
      if (
        routeFacts &&
        state.route &&
        !routeFound &&
        line > state.route.line &&
        routeIsStale(state.route, routeFacts)
      )
        state.route = undefined;
    }
    processReleaseCards(state, line, cards, currentEpoch);
    const textualExpected = textExpectation(joined);
    if (role !== "user" && textualExpected !== undefined) {
      if (
        role === "assistant" &&
        /release_expected|release_enabled/i.test(joined)
      )
        state.reportContractDeclared = true;
      if (state.expected === undefined) {
        state.expected = textualExpected;
        state.releaseExpectationLine = line;
      } else if (state.expected !== textualExpected) {
        state.identityConflictLine ||= line;
      }
    }
    const outputEpochs = cards
      .map((card) => stringValue(card.release_epoch))
      .filter((item): item is string => Boolean(item));
    if (
      kind === "function_call_output" &&
      state.expected === true &&
      state.epoch &&
      outputEpochs.every((item) => item === state.epoch)
    )
      state.publicationFacts.push(...publicationFact(line, output));
    const targetMatch = targetSha.exec(joined)?.[1];
    const repoMatch = joined.match(targetRepo)?.[1]?.toLowerCase();
    if (repoMatch) state.target.repo ||= repoMatch;
    const branchMatch = joined.match(targetBranch)?.[1];
    if (branchMatch)
      state.target.branch ||= branchMatch.replace(/^refs\/heads\//i, "");
    if (
      targetMatch &&
      (!state.target.sha || !shaMatches(state.target.sha, targetMatch))
    )
      state.target.sha ||= targetMatch.toLowerCase();
    const mergeMatch = mergeSha.exec(joined)?.[1];
    if (mergeMatch) state.mergeShaValue ||= mergeMatch.toLowerCase();
    const boundMatch = boundSha.exec(joined)?.[1];
    if (boundMatch) state.bound ||= boundMatch.toLowerCase();
    const tagMatch = candidateTag.exec(joined)?.[1];
    if (tagMatch) state.candidate ||= tagMatch;
    const reportTag = reportedTag.exec(joined)?.[1];
    if (reportTag) state.reported.tag = reportTag;
    const reportVersion = reportedVersion.exec(joined)?.[1];
    if (reportVersion) state.reported.version = reportVersion;
    const reportUrl = reportedUrl.exec(joined)?.[1];
    if (reportUrl) state.reported.url = reportUrl;
    const reportWorkflow = reportedWorkflow.exec(joined)?.[1];
    if (reportWorkflow) state.reported.workflow = reportWorkflow;
    const reportTime = reportedTime.exec(joined)?.[1];
    if (reportTime) state.reported.time = reportTime;
    if (
      releaseStatus.test(joined) &&
      (role === "assistant" ||
        kind === "function_call_output" ||
        isTaskComplete(value))
    ) {
      const match = releaseStatus.exec(joined);
      if (match) {
        state.status = match[1];
        state.statusLine = line;
      }
    }
    if (mergeSuccess.test(joined)) state.mergeLine ||= line;
    if (role === "user") captureUserRetryAuthorization(state, joined);
    if (kind === "function_call")
      processReleaseCommand(state, line, callCommand(value));
    if (isTaskComplete(value)) {
      const taskTurn =
        typeof payload.turn_id === "string" ||
        typeof payload.turn_id === "number"
          ? String(payload.turn_id)
          : undefined;
      const duplicate =
        taskTurn !== undefined && state.taskTurns.get(taskTurn) === message;
      if (taskTurn) state.taskTurns.set(taskTurn, message);
      if (!duplicate) {
        state.taskLines.add(line);
        evaluateRelease(state, line, message);
        if (state.mergeLine && state.route && state.modernContract) {
          if (
            !state.decision.seen ||
            !state.decision.line ||
            state.decision.line > state.mergeLine
          )
            add(
              state.findings,
              "RELEASE_DECISION_CARD_MISSING_BEFORE_MERGE",
              line,
              "release decision card was not present before merge",
            );
          else if (!state.decision.valid && state.decision.routeAbsence)
            add(
              state.findings,
              "RELEASE_DECISION_ROUTE_ABSENCE_AS_NO_RELEASE",
              state.decision.line,
              "route absence cannot establish no release",
            );
          else if (!state.decision.valid && state.decision.blocked)
            add(
              state.findings,
              "RELEASE_DECISION_BLOCKED_BEFORE_MERGE",
              state.decision.line,
              "conflicting release policy must block merge",
            );
          else if (state.decision.valid && !state.decisionConfirmLine)
            add(
              state.findings,
              "RELEASE_DECISION_CONFIRMATION_MISSING",
              line,
              "release decision card lacks owner confirmation",
            );
        }
        if (state.decision.seen && state.mergeLine && !state.route) {
          if (!state.decision.line || state.decision.line > state.mergeLine)
            add(
              state.findings,
              "RELEASE_DECISION_CARD_MISSING_BEFORE_MERGE",
              line,
              "release decision card was not present before merge",
            );
          else if (!state.decision.valid && state.decision.routeAbsence)
            add(
              state.findings,
              "RELEASE_DECISION_ROUTE_ABSENCE_AS_NO_RELEASE",
              state.decision.line,
              "route absence cannot establish no release",
            );
          else if (!state.decision.valid && state.decision.blocked)
            add(
              state.findings,
              "RELEASE_DECISION_BLOCKED_BEFORE_MERGE",
              state.decision.line,
              "conflicting release policy must block merge",
            );
          else if (state.decision.valid && !state.decisionConfirmLine)
            add(
              state.findings,
              "RELEASE_DECISION_CONFIRMATION_MISSING",
              line,
              "release decision card lacks owner confirmation",
            );
        }
      }
    }
    if (dispositionProof.test(joined) && !dispositionSeparation.test(joined))
      add(
        state.findings,
        "RELEASE_DISPOSITION_USED_AS_PUBLICATION_PROOF",
        line,
        "release disposition is not publication proof",
      );
  }
  if (
    state.mergeShaValue &&
    state.target.sha &&
    !shaMatches(state.mergeShaValue, state.target.sha)
  )
    state.identityConflictLine ||= state.statusLine || state.mergeLine || 1;
  if (
    state.mergeLine &&
    state.route &&
    state.modernContract &&
    state.expected === false &&
    !state.mergeShaValue
  )
    add(
      state.findings,
      "RELEASE_MERGE_SHA_MISSING_AFTER_MERGE",
      state.mergeLine,
      "release decision requires the actual merge SHA",
    );
  if (state.identityConflictLine && state.taskLines.size)
    add(
      state.findings,
      "RELEASE_EPOCH_IDENTITY_CONFLICT",
      Math.max(...state.taskLines),
      `identity_conflict_line=${state.identityConflictLine}`,
    );
  for (const item of state.routeMutationLines)
    if (
      (!state.route || state.route.line > item.line) &&
      !(state.malformedPolicyRoute && commandLabels(item.command).size)
    )
      add(
        state.findings,
        "RELEASE_ROUTE_RESOLUTION_MISSING_BEFORE_MUTATION",
        item.line,
        "release route must be resolved before PR mutation",
      );
  for (const line of state.nullRouteMutationLines)
    if (state.route && state.route.line > line)
      add(
        state.findings,
        "RELEASE_ROUTE_RESOLUTION_MISSING_BEFORE_MUTATION",
        line,
        "PR creation must be followed by a fresh open-PR route resolution",
      );
  if (
    state.routeStep5cLine &&
    state.routeSignal &&
    (Boolean(state.releaseIntentLine) || !state.flowMetadataSeen) &&
    (!state.route || state.route.line > state.routeStep5cLine)
  )
    add(
      state.findings,
      "RELEASE_ROUTE_RESOLUTION_MISSING_BEFORE_STEP5C",
      state.routeStep5cLine,
      "Step 5C requires current release route facts",
    );
}
