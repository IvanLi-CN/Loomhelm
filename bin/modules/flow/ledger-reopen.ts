import {
  FlowError,
  PR_BOUND_FLOW_TYPES,
  isoNow,
  isRecord,
  sha256Bytes,
  stableHash,
} from "./common";
import {
  gitCommit,
  gitIsAncestor,
  gitPatchFingerprint,
  requireCleanCurrentHead,
} from "./git";
import { PR_REF_PATTERN } from "./state";
import type { FlowLedger } from "./ledger";

export function reopenConvergence(
  ledger: FlowLedger,
  options: {
    authorizationRef: string;
    authorizationTextSha256: string;
    reason: string;
    prRef: string;
    userMessageId: string;
    baseRef: string;
    headSha?: string | undefined;
  },
): Record<string, unknown> {
  if (!ledger.repo)
    throw new FlowError(
      "convergence reopen requires a repository-bound ledger",
    );
  const reason = options.reason.trim();
  const messageId = options.userMessageId.trim();
  const prRef = options.prRef.trim();
  const explicit =
    reason.toLowerCase().includes("continue current pr") &&
    (reason.toLowerCase().includes("reopen") ||
      reason.toLowerCase().includes("explicit owner approval"));
  if (
    !/^owner:[A-Za-z0-9-]+(?::[^\s:]+)?$/.test(options.authorizationRef) ||
    !/^[0-9a-f]{64}$/i.test(options.authorizationTextSha256) ||
    sha256Bytes(new TextEncoder().encode(reason)) !==
      options.authorizationTextSha256.toLowerCase() ||
    !messageId ||
    !explicit ||
    !PR_BOUND_FLOW_TYPES.has(String(ledger.read().flow_type)) ||
    !PR_REF_PATTERN.test(prRef)
  )
    throw new FlowError(
      "convergence reopen requires explicit owner authorization, PR ref, user message id, matching text digest, and explicit reopen reason",
    );
  return ledger.withLifecycleLock(() =>
    ledger.activeUpdate((current) => {
      const review = current.review as Record<string, unknown>;
      const ids = Array.isArray(review.authorization_message_ids)
        ? (review.authorization_message_ids as string[])
        : [];
      if (ids.includes(messageId))
        throw new FlowError(
          "convergence reopen user message id was already consumed",
        );
      if (review.active_wave_id)
        throw new FlowError(
          "cannot reopen convergence while a review wave is active",
        );
      const epochs = Array.isArray(review.epochs)
        ? (review.epochs as Record<string, unknown>[])
        : [];
      const blocked = epochs.at(-1);
      if (
        !blocked ||
        review.active_epoch_id !== blocked.epoch_id ||
        blocked.status !== "blocked" ||
        !isRecord(current.convergence) ||
        current.convergence.state !== "NON_CONVERGENT" ||
        !review.pr_ref ||
        review.pr_ref !== prRef
      )
        throw new FlowError(
          "convergence reopen requires a blocked review epoch",
        );
      const previousBase = String(current.base_sha);
      const previousHead = String(current.head_sha);
      const [head] = requireCleanCurrentHead(ledger.repo!, options.headSha);
      const base = gitCommit(ledger.repo!, options.baseRef);
      const rebound = base !== previousBase || head !== previousHead;
      if (rebound) {
        if (
          base === previousBase ||
          head === previousHead ||
          !gitIsAncestor(ledger.repo!, previousBase, base) ||
          gitPatchFingerprint(ledger.repo!, previousBase, previousHead) !==
            gitPatchFingerprint(ledger.repo!, base, head)
        )
          throw new FlowError(
            "convergence reopen inputs are not an equivalent rebased current PR",
          );
        blocked.evidence_state = "input_stale";
        blocked.stale_reason = "base_advanced";
        blocked.stale_base_sha = base;
        blocked.stale_head_sha = head;
        current.base_sha = base;
        current.head_sha = head;
        review.pr_base_sha = base;
        review.pr_head_sha = head;
        current.events = [
          ...(Array.isArray(current.events) ? current.events : []),
          {
            type: "convergence_reopen_inputs_rebound",
            from_base_sha: previousBase,
            to_base_sha: base,
            from_head_sha: previousHead,
            to_head_sha: head,
            patch_fingerprint: gitPatchFingerprint(
              ledger.repo!,
              previousBase,
              previousHead,
            ),
            at: isoNow(),
          },
        ];
      }
      const number = Number(review.next_epoch ?? 1);
      const epoch = {
        epoch_id: stableHash([
          current.run_id,
          "epoch",
          number,
          head,
          current.base_sha,
        ]).slice(0, 16),
        number,
        base_sha: current.base_sha,
        start_head_sha: head,
        status: "active",
        repair_rounds_used: 0,
        risk_arbitration_used: false,
        blocker_history: [],
        arbitration_history: [],
        invariants:
          isRecord(review.cumulative) &&
          Array.isArray(review.cumulative.invariants)
            ? [...(review.cumulative.invariants as string[])]
            : [],
        waves: [],
        permits: [],
        authorization: {
          kind: "owner-explicit-reopen",
          ref: options.authorizationRef,
          text_sha256: options.authorizationTextSha256.toLowerCase(),
          reason,
          reason_sha256: sha256Bytes(new TextEncoder().encode(reason)),
          pr_ref: prRef,
          user_message_id: messageId,
          start_head_sha: head,
          at: isoNow(),
        },
      };
      epochs.push(epoch);
      review.epochs = epochs;
      review.next_epoch = number + 1;
      review.active_epoch_id = epoch.epoch_id;
      review.authorization_message_ids = [...ids, messageId];
      current.convergence = {
        state: "pending",
        round: 0,
        repair_round: 0,
        diagnostic_used: false,
        blockers: [],
      };
      current.state = "active";
      current.events = [
        ...(Array.isArray(current.events) ? current.events : []),
        {
          type: "convergence_reopened",
          epoch_id: epoch.epoch_id,
          authorization_ref: options.authorizationRef,
          user_message_id: messageId,
          at: isoNow(),
        },
      ];
      return { epoch };
    }),
  );
}
