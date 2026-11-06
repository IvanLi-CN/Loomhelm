import { existsSync } from "node:fs";
import {
  FlowError,
  canonicalJson,
  isRecord,
  nonemptyString,
  stableHash,
} from "./common";
import {
  callOutputWithIndex,
  completedTurn,
  functionArguments,
  linkedChildActivity,
  linkedChildId,
  recordIndex,
  spawnRecords,
  turnProfile,
  validateNativeChildActivityLinks,
} from "./profile-attest-utils";
import {
  eligibleFailure,
  normaliseProfileResolution,
} from "./profile-resolution";
import {
  findChildRollout,
  findParentRollout,
} from "./profile-attest-discovery";
import { eventToolUseId, logicalIdentity } from "./profile-hook";
import {
  canonicalSessionsRoot,
  loadPermit,
  stateDir,
  supportedExplicitProfile,
} from "./profile-state";
import {
  childSessionProvenance,
  requireUnchangedTranscripts,
  type TranscriptSnapshot,
} from "./profile-transcript";

export interface AttestationOptions {
  sessionsRoot?: string | undefined;
  taskName: string;
  agentType: string;
  preferredModel: string;
  preferredEffort: string;
  permitsRoot?: string | undefined;
  requiredForkTurns?: string | undefined;
  expectedChildThreadId?: string | undefined;
  expectedResultSha256?: string | undefined;
  expectedRepositoryHead?: string | undefined;
}

export function attestNativeProfile(
  options: AttestationOptions,
): Record<string, unknown> {
  const preferredModel = nonemptyString(options.preferredModel);
  const preferredEffort = nonemptyString(options.preferredEffort);
  if (!preferredModel || !preferredEffort)
    throw new FlowError(
      "runtime attestation requires a preferred model and effort",
    );
  const root = options.sessionsRoot ?? canonicalSessionsRoot();
  if (!existsSync(root))
    throw new FlowError("runtime attestation sessions root does not exist");
  if (
    options.expectedChildThreadId &&
    !/^[A-Za-z0-9-]+$/.test(options.expectedChildThreadId)
  )
    throw new FlowError(
      "runtime attestation has an invalid expected child thread id",
    );
  if (
    options.expectedRepositoryHead &&
    !/^[0-9a-f]{40,64}$/.test(options.expectedRepositoryHead)
  )
    throw new FlowError(
      "runtime attestation has an invalid expected repository head",
    );
  if (
    options.expectedResultSha256 &&
    !/^[0-9a-f]{64}$/.test(options.expectedResultSha256)
  )
    throw new FlowError(
      "runtime attestation has an invalid expected result digest",
    );
  const [childPath, childRecords, childMeta, childSnapshot] = findChildRollout(
    root,
    options.taskName,
    options.agentType,
    options.expectedChildThreadId,
  );
  const childId = nonemptyString(childMeta.id);
  const parentId = nonemptyString(childMeta.parent_thread_id);
  const provenance = childSessionProvenance(childMeta, childPath);
  if (
    !childId ||
    !parentId ||
    !provenance ||
    provenance.parent_thread_id !== parentId ||
    provenance.agent_path !== `/root/${options.taskName}` ||
    provenance.agent_role !== options.agentType
  )
    throw new FlowError(
      "child session_meta does not uniquely bind the native parent/task",
    );
  if (
    options.expectedRepositoryHead &&
    (!isRecord(childMeta.git) ||
      childMeta.git.commit_hash !== options.expectedRepositoryHead)
  )
    throw new FlowError(
      "child session_meta does not bind the expected candidate head",
    );
  const [parentPath, parentRecords, parentSnapshot] = findParentRollout(
    root,
    parentId,
  );
  const snapshots = new Map<string, TranscriptSnapshot>([
    [childPath, childSnapshot],
    [parentPath, parentSnapshot],
  ]);
  validateNativeChildActivityLinks(parentRecords);
  const replayed = new Set(
    parentRecords.map((record) => canonicalJson(record)),
  );
  const calls = spawnRecords(
    parentRecords,
    options.taskName,
    options.agentType,
  );
  if (!calls.length)
    throw new FlowError(
      "runtime attestation found no matching native spawn request",
    );
  const linked = calls.flatMap((call) => {
    const payload = call.payload as Record<string, unknown>;
    const callId = eventToolUseId(payload);
    if (!callId) throw new FlowError("native spawn request has no tool use id");
    const activity = linkedChildActivity(parentRecords, callId);
    if (activity && activity[0] <= recordIndex(parentRecords, call))
      throw new FlowError(
        "native child start did not follow its spawn request",
      );
    return activity
      ? [[call, activity[1]] as [Record<string, unknown>, string]]
      : [];
  });
  if (linked.length !== 1 || linked[0]?.[1] !== childId)
    throw new FlowError(
      "native spawn request and child session do not have a unique runtime link",
    );
  const [startedCall, startedChildId] = linked[0] as [
    Record<string, unknown>,
    string,
  ];
  const startedPayload = startedCall.payload as Record<string, unknown>;
  const startedCallId = eventToolUseId(startedPayload);
  if (!startedCallId)
    throw new FlowError("native spawn request has no tool use id");
  const startedArgs = functionArguments(startedCall);
  const startedModel = nonemptyString(startedArgs.model);
  const startedEffort = nonemptyString(startedArgs.reasoning_effort);
  if (
    !startedModel ||
    !startedEffort ||
    !supportedExplicitProfile({ model: startedModel, effort: startedEffort })
  )
    throw new FlowError(
      "native started spawn omitted or used an unsupported profile",
    );
  const [completed, _message] = completedTurn(
    childRecords,
    startedModel,
    startedEffort,
    options.expectedResultSha256,
    replayed,
  );
  const [childModel, childEffort, childTurn] = turnProfile(
    childRecords,
    completed,
    replayed,
  );
  const message = nonemptyString(startedArgs.message);
  if (!message) throw new FlowError("native spawn request has no message");
  const identity = logicalIdentity(parentId, startedArgs);
  if (
    identity.task_name !== options.taskName ||
    (nonemptyString(startedArgs.agent_type) &&
      startedArgs.agent_type !== options.agentType)
  )
    throw new FlowError("native spawn identity does not match child session");
  if (
    options.requiredForkTurns &&
    identity.fork_turns !== options.requiredForkTurns
  )
    throw new FlowError(
      `native spawn requires fork_turns=${options.requiredForkTurns} for this proof`,
    );
  const preferred = { model: preferredModel, effort: preferredEffort };
  const resolved = {
    model: childModel,
    effort: childEffort,
    child_thread_id: startedChildId,
    turn_id: childTurn,
  };
  if (calls.length === 1) {
    if (childModel !== startedModel || childEffort !== startedEffort)
      throw new FlowError(
        "native direct request did not resolve to its requested profile",
      );
    requireUnchangedTranscripts(snapshots);
    return normaliseProfileResolution({
      preferred,
      attempts: [
        {
          tool_use_id: startedCallId,
          request_mode: "explicit",
          requested: { model: startedModel, effort: startedEffort },
          outcome: "started",
          evidence_sha256: stableHash([startedCall, childId]),
        },
      ],
      resolved,
      fallback_reason: null,
    });
  }
  if (calls.length !== 2 || calls[1] !== startedCall)
    throw new FlowError(
      "native profile fallback must have exactly two equivalent spawn calls",
    );
  const first = calls[0] as Record<string, unknown>;
  const firstPayload = first.payload as Record<string, unknown>;
  const firstId = eventToolUseId(firstPayload);
  if (!firstId)
    throw new FlowError("native fallback request has no tool use id");
  const firstArgs = functionArguments(first);
  const firstModel = nonemptyString(firstArgs.model);
  const firstEffort = nonemptyString(firstArgs.reasoning_effort);
  if (
    !firstModel ||
    !firstEffort ||
    !supportedExplicitProfile({ model: firstModel, effort: firstEffort })
  )
    throw new FlowError(
      "native fallback first request omitted or used an unsupported profile",
    );
  if (firstModel === startedModel && firstEffort === startedEffort)
    throw new FlowError(
      "native fallback retry must use a different explicit profile",
    );
  if (
    childModel !== startedModel ||
    childEffort !== startedEffort ||
    linkedChildId(parentRecords, firstId)
  )
    throw new FlowError(
      "native fallback request did not resolve to its requested profile",
    );
  if (
    canonicalJson(logicalIdentity(parentId, firstArgs)) !==
    canonicalJson(identity)
  )
    throw new FlowError(
      "native fallback retry changed its logical task identity",
    );
  const [firstOutputIndex, firstOutput] = callOutputWithIndex(
    parentRecords,
    firstId,
  );
  if (!(
    recordIndex(parentRecords, first) < firstOutputIndex &&
    firstOutputIndex < recordIndex(parentRecords, startedCall)
  ))
    throw new FlowError("native fallback failure did not precede its retry");
  if (!eligibleFailure(firstOutput, firstModel, firstEffort))
    throw new FlowError(
      "native fallback first request was not an eligible pre-start profile failure",
    );
  const permit = loadPermit(options.permitsRoot ?? stateDir(), identity);
  if (
    !permit ||
    permit.failure_tool_use_id !== firstId ||
    permit.consumed_tool_use_id !== startedCallId ||
    permit.failure_evidence_sha256 !== stableHash(firstOutput) ||
    canonicalJson(permit.failed_requested) !==
      canonicalJson({ model: firstModel, effort: firstEffort }) ||
    canonicalJson(permit.fallback_requested) !==
      canonicalJson({ model: startedModel, effort: startedEffort })
  )
    throw new FlowError(
      "native fallback did not consume a matching profile fallback permit",
    );
  requireUnchangedTranscripts(snapshots);
  return normaliseProfileResolution({
    preferred,
    attempts: [
      {
        tool_use_id: firstId,
        request_mode: "explicit",
        requested: { model: firstModel, effort: firstEffort },
        outcome: "unsupported",
        evidence_sha256: stableHash(firstOutput),
      },
      {
        tool_use_id: startedCallId,
        request_mode: "explicit",
        requested: { model: startedModel, effort: startedEffort },
        outcome: "started",
        evidence_sha256: stableHash([startedCall, childId]),
      },
    ],
    resolved,
    fallback_reason: "profile_override_unavailable",
  });
}
