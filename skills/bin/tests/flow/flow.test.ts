import { describe, expect, test } from "bun:test";
import { readFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FlowError,
  canonicalJson,
  stableHash,
} from "../../modules/flow/common";
import {
  assertAcceptanceAssertionsComplete,
  normalizeAcceptanceEvidence,
  normalizeAcceptanceManifest,
  validateAcceptanceEvidence,
} from "../../modules/flow/acceptance";
import { FlowLedger } from "../../modules/flow/ledger";
import { gitCommit, gitTree } from "../../modules/flow/git";
import { runValidationCommand } from "../../modules/flow/process";
import {
  openReviewWaveState,
  recordSubagentReviewState,
  finalizeReviewWaveState,
} from "../../modules/flow/review-ledger";
import {
  initialLedger,
  isCurrentClearWave,
  normalizePostMergeEvidence,
  normalizeLedger,
} from "../../modules/flow/state";
import { recordValidationState } from "../../modules/flow/validation";
import { tryLockFile } from "../../modules/core/security_file";
import { withExclusiveLock } from "../../modules/flow/storage";

const sha = "a".repeat(40);

async function withTemp<T>(
  prefix: string,
  callback: (root: string) => Promise<T>,
): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function manifest(phase = "pre_merge") {
  return normalizeAcceptanceManifest({
    plan_digest: "b".repeat(64),
    items: [
      {
        id: phase === "pre_merge" ? "FLOW_TEST" : "FLOW_DEPLOY",
        category: phase === "post_deploy" ? "data-integrity" : "behavior",
        mode: "direct",
        gate: phase === "pre_merge" ? "validation" : "delivery",
        scope: "plan",
        phase,
        target:
          phase === "pre_merge" ? "bun run test:flow" : "deployment receipt",
        evidence: [
          phase === "pre_merge" ? "flow test output" : "provider receipt",
        ],
        assertions: [
          phase === "pre_merge"
            ? "all flow tests pass"
            : "deployment binds merge SHA",
        ],
      },
    ],
  });
}

class FailingArchiveLedger extends FlowLedger {
  override archive(_value: Record<string, unknown>): string {
    throw new Error("archive failure");
  }
}

describe("flow compatibility primitives", () => {
  test("post-merge evidence requires terminal finality bound to one merge", () => {
    const valid = {
      pr_ref: "IvanLi-CN/dot-codex#197",
      base_sha: "b".repeat(40),
      head_sha: "c".repeat(40),
      merge_sha: sha,
      merged_at: "2026-10-31T03:00:00Z",
      finality: {
        target_ci: { status: "passed", bound_sha: sha },
        release: { status: "published", bound_sha: sha },
      },
    };
    expect(normalizePostMergeEvidence(valid)).toMatchObject({
      merge_sha: sha,
      pr_ref: valid.pr_ref,
    });
    expect(() =>
      normalizePostMergeEvidence({ ...valid, finality: undefined }),
    ).toThrow("post-merge evidence does not match the required schema");
    expect(() =>
      normalizePostMergeEvidence({
        ...valid,
        finality: {
          ...valid.finality,
          target_ci: { status: "passed", bound_sha: "d".repeat(40) },
        },
      }),
    ).toThrow("post-merge finality facts must bind the merge SHA");
  });

  test("canonical JSON and hashes match the Python contract", () => {
    expect(canonicalJson({ b: 2, a: "中文" })).toBe(
      '{"a":"\\u4e2d\\u6587","b":2}',
    );
    expect(stableHash({ b: 2, a: "中文" })).toBe(
      "391b0dc79ab882e0353da94406bf8cfcf913656d501591f0ab9dcbedcfaa5bf5",
    );
    expect(stableHash(["flow", 3, true])).toBe(
      "a34929b1e5feb74c12e2a98c69cd5851fc07286d2e789985a67d32d39ebebf74",
    );
  });

  test("lock contention times out and releases cleanly", async () => {
    await withTemp("flow-lock-", async (root) => {
      const path = join(root, "ledger.lock");
      const held = tryLockFile(path);
      expect(held).not.toBeNull();
      expect(() => withExclusiveLock(path, () => "unreachable", 20)).toThrow(
        FlowError,
      );
      held?.release();
      expect(withExclusiveLock(path, () => "released", 20)).toBe("released");
    });
  });

  test("terminal sealing archives immutable state and is idempotent", async () => {
    await withTemp("flow-ledger-", async (root) => {
      const ledger = new FlowLedger(root);
      ledger.init("flow-run", "implement-only", sha, sha);
      const result = ledger.close("failed");
      expect(result.state).toBe("failed");
      const archive = ledger.archivePath("flow-run");
      expect(await readFile(archive, "utf8")).toBe(
        await readFile(join(root, "active.json"), "utf8"),
      );
      expect(ledger.close("failed").state).toBe("failed");
      expect(() => ledger.close("cancelled")).toThrow(
        "flow receipt ledger is terminal",
      );
    });
  });

  test("terminal seal failure restores the active ledger", async () => {
    await withTemp("flow-rollback-", async (root) => {
      const ledger = new FailingArchiveLedger(root);
      ledger.init("rollback-run", "implement-only", sha, sha);
      await expect(
        Promise.resolve().then(() => ledger.close("failed")),
      ).rejects.toThrow("terminal sealing failed");
      expect(ledger.readRaw().state).toBe("active");
      expect(await readFile(join(root, "active.json"), "utf8")).toContain(
        '"state": "active"',
      );
    });
  });

  test("validation receipts preserve proof identity and candidate advancement", async () => {
    await withTemp("flow-validation-", async (root) => {
      const ledger = new FlowLedger(root);
      ledger.init("validation-run", "implement-only", sha, "c".repeat(40));
      const payload = ledger.read();
      const result = recordValidationState(
        payload,
        {
          command: "bun run test:flow",
          toolchainFingerprint: "bun@1.4.5",
          inputFingerprint: "scope-hash",
          exitCode: 0,
          logPath: "",
          headSha: sha,
          observedTree: "d".repeat(40),
          executionVerified: true,
          postExecutionClean: true,
        },
        sha,
      );
      expect(result.reused).toBe(false);
      expect(result.candidate_head_advanced).toBe(true);
      expect((payload.events as unknown[]).at(-1)).toMatchObject({
        type: "candidate_head_advanced",
      });
    });
  });

  test("current-head attestation only reuses a receipt for an equivalent delta", async () => {
    await withTemp("flow-attestation-", async (root) => {
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      git(["init", "-q"]);
      git(["config", "user.email", "flow@example.test"]);
      git(["config", "user.name", "Flow Test"]);
      await writeFile(join(root, "README.md"), "base\n");
      git(["add", "README.md"]);
      git(["commit", "-qm", "base"]);
      const base = gitCommit(root, "HEAD");
      const tree = gitTree(root, "HEAD");
      const ledger = new FlowLedger(join(root, ".git", "codex-flow"), root);
      ledger.init("attest-run", "implement-only", base, base);
      const payload = ledger.read();
      const recorded = recordValidationState(
        payload,
        {
          command: "bun run test:flow",
          toolchainFingerprint: "bun@1.4.5",
          inputFingerprint: "scope-hash",
          inputPaths: ["README.md"],
          exitCode: 0,
          logPath: "",
          headSha: base,
          observedTree: tree,
          executionVerified: true,
          postExecutionClean: true,
        },
        base,
      );
      ledger.write(payload);
      git(["commit", "--allow-empty", "-qm", "equivalent"]);
      const target = gitCommit(root, "HEAD");
      const attested = ledger.recordAttestation(
        String((recorded.receipt as Record<string, unknown>).receipt_id),
        target,
        "HEAD^",
      );
      expect(attested.reused).toBe(false);
      expect(
        (ledger.read().receipts as Record<string, unknown>[]).at(-1),
      ).toMatchObject({
        kind: "attestation",
        head_sha: target,
      });

      await writeFile(join(root, "docs-note.md"), "documentation\n");
      git(["add", "docs-note.md"]);
      git(["commit", "-qm", "docs"]);
      const changedTarget = gitCommit(root, "HEAD");
      const blockedLedger = new FlowLedger(
        join(root, ".git", "blocked-flow"),
        root,
      );
      blockedLedger.init("blocked-attest", "implement-only", base, base);
      const blockedPayload = blockedLedger.read();
      const blockedRecorded = recordValidationState(
        blockedPayload,
        {
          command: "bun run test:flow",
          toolchainFingerprint: "bun@1.4.5",
          inputFingerprint: "scope-hash",
          inputPaths: ["README.md"],
          exitCode: 0,
          logPath: "",
          headSha: base,
          observedTree: tree,
          executionVerified: true,
          postExecutionClean: true,
        },
        base,
      );
      blockedLedger.write(blockedPayload);
      expect(() =>
        blockedLedger.recordAttestation(
          String(
            (blockedRecorded.receipt as Record<string, unknown>).receipt_id,
          ),
          changedTarget,
          base,
        ),
      ).toThrow("effective_merge_result_changed");
    });
  });

  test("validation supervision writes timeout logs and returns after process cleanup", async () => {
    await withTemp("flow-process-", async (root) => {
      const logPath = join(root, "logs", "validation.log");
      const result = await runValidationCommand({
        command: `${process.execPath} -e 'setTimeout(() => {}, 5000)'`,
        repo: root,
        budgetSeconds: 0.05,
        logPath,
      });
      expect(result.timedOut).toBe(true);
      expect(result.logPath).toBe(logPath);
      expect(await readFile(logPath, "utf8")).toContain(
        "flow_receipt: command timed out after 0.05 seconds",
      );
    });
  });
});

describe("acceptance and review state", () => {
  test("post-merge acceptance requires every manifest assertion", () => {
    const postManifest = normalizeAcceptanceManifest({
      plan_digest: "b".repeat(64),
      items: [
        {
          id: "FLOW_DEPLOY",
          category: "behavior",
          mode: "direct",
          gate: "delivery",
          scope: "plan",
          phase: "post_merge",
          target: "provider receipt",
          evidence: ["provider receipt"],
          assertions: ["merge is current", "deployment is healthy"],
        },
      ],
    });
    const partial = normalizeAcceptanceEvidence([
      {
        id: "FLOW_DEPLOY",
        phase: "post_merge",
        target: "provider receipt",
        assertions: ["merge is current"],
        merge_sha: sha,
      },
    ]);
    expect(() =>
      assertAcceptanceAssertionsComplete(postManifest, partial, [
        "FLOW_DEPLOY",
      ]),
    ).toThrow("incomplete");
    const complete = normalizeAcceptanceEvidence([
      {
        id: "FLOW_DEPLOY",
        phase: "post_merge",
        target: "provider receipt",
        assertions: ["merge is current", "deployment is healthy"],
        merge_sha: sha,
      },
    ]);
    expect(() =>
      assertAcceptanceAssertionsComplete(postManifest, complete, [
        "FLOW_DEPLOY",
      ]),
    ).not.toThrow();
  });

  test("acceptance evidence binds candidate and deployment identities", () => {
    const preManifest = manifest();
    const pre = normalizeAcceptanceEvidence([
      {
        id: "FLOW_TEST",
        phase: "pre_merge",
        target: "flow test output",
        assertions: ["all flow tests pass"],
        candidate_sha: sha,
      },
    ]);
    expect(() =>
      validateAcceptanceEvidence(preManifest, pre, { candidateSha: sha }),
    ).not.toThrow();
    const deployment = {
      deployment_id: "dep-1",
      source_sha: sha,
      bound_sha: sha,
      relationship: "deployed-from",
      provenance_boundary: "deployment-provider",
      evidence_source: "deployment-receipt",
      operation_id: "op-1",
      observed_state: "verified",
      external_locator: "provider://dep-1",
    };
    const postManifest = manifest("post_deploy");
    const post = normalizeAcceptanceEvidence([
      {
        id: "FLOW_DEPLOY",
        phase: "post_deploy",
        target: "provider receipt",
        assertions: ["deployment binds merge SHA"],
        merge_sha: sha,
        deployment_identity: deployment,
      },
    ]);
    expect(() =>
      validateAcceptanceEvidence(postManifest, post, {
        mergeSha: sha,
        deploymentIdentity: deployment,
        allowPostMerge: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateAcceptanceEvidence(postManifest, post, {
        mergeSha: "c".repeat(40),
        deploymentIdentity: deployment,
        allowPostMerge: true,
      }),
    ).toThrow("merge SHA");
  });

  test("review wave records all lanes and finalizes a clear proof", () => {
    const ledger = initialLedger("review-run", "fast-track", sha, sha, null);
    ledger.review_assessment = {
      tier: 3,
      reason: "shared state and process behavior",
      assessed_at: "2026-10-27T00:00:00.000Z",
      assessed_head_sha: sha,
      source: "agent-assessment",
    };
    const lanes = [
      { lane: "comprehensive", model: "gpt-6-luna", effort: "max" },
    ];
    const opened = openReviewWaveState(ledger, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
    });
    const wave = opened.wave as Record<string, unknown>;
    expect(() =>
      openReviewWaveState(ledger, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    const staleLedger = initialLedger(
      "review-stale-wave-run",
      "fast-track",
      sha,
      sha,
      null,
    );
    staleLedger.review_assessment = ledger.review_assessment;
    const staleOpened = openReviewWaveState(staleLedger, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
    });
    const staleWave = staleOpened.wave as Record<string, unknown>;
    for (const lane of lanes)
      recordSubagentReviewState(staleLedger, {
        reviewProfile: "pr-convergence",
        baseRef: sha,
        reviewAttemptId: `stale-${lane.lane}`,
        reviewResultJson: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation:
            "Inspected the completed stale candidate code and recorded terminal evidence.",
          overall_confidence_score: 1,
        }),
        waveId: String(staleWave.wave_id),
        lane: lane.lane,
      });
    const findingStale = structuredClone(staleLedger) as Record<string, unknown>;
    const findingReview = findingStale.review as Record<string, unknown>;
    const findingWave = (
      findingReview.waves as Record<string, Record<string, unknown>>
    )[String(staleWave.wave_id)];
    const findingReceipt = (
      findingStale.receipts as Record<string, unknown>[]
    ).find((receipt) => receipt.lane === "comprehensive");
    if (!findingReceipt) throw new Error("stale review receipt is missing");
    findingReceipt.review_clear = false;
    findingReceipt.overall_correctness = "patch is incorrect";
    findingReceipt.finding_fingerprints = ["blocking-finding"];
    expect(() =>
      openReviewWaveState(findingStale, {
        stage: "initial",
        baseSha: sha,
        headSha: "c".repeat(40),
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    expect(findingWave.state).toBe("open");
    const missingLane = structuredClone(staleLedger) as Record<string, unknown>;
    const missingReview = missingLane.review as Record<string, unknown>;
    const missingWave = (
      missingReview.waves as Record<string, Record<string, unknown>>
    )[String(staleWave.wave_id)];
    delete (
      missingWave.lanes as Record<string, Record<string, unknown>>
    ).comprehensive;
    expect(() =>
      openReviewWaveState(missingLane, {
        stage: "initial",
        baseSha: sha,
        headSha: "d".repeat(40),
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    expect(missingWave.state).toBe("open");
    const refreshed = openReviewWaveState(staleLedger, {
      stage: "initial",
      baseSha: sha,
      headSha: "b".repeat(40),
      laneSpecs: lanes,
    });
    expect(staleWave.state).toBe("retired");
    expect((refreshed.wave as Record<string, unknown>).head_sha).toBe(
      "b".repeat(40),
    );
    const pendingStale = structuredClone(ledger) as Record<string, unknown>;
    const pendingWave = (
      pendingStale.review as Record<string, unknown>
    ).waves as Record<string, Record<string, unknown>>;
    expect(() =>
      openReviewWaveState(pendingStale, {
        stage: "initial",
        baseSha: sha,
        headSha: "b".repeat(40),
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    expect(pendingWave[String(wave.wave_id)].state).toBe("open");
    const originalScope = wave.scope_class;
    const originalBinding = wave.scope_binding;
    delete wave.scope_binding;
    expect(() =>
      recordSubagentReviewState(ledger, {
        reviewProfile: "pr-convergence",
        baseRef: sha,
        reviewAttemptId: "missing-scope-binding",
        reviewResultJson: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation:
            "Inspected the candidate diff and confirmed the complete result.",
          overall_confidence_score: 1,
        }),
        waveId: String(wave.wave_id),
        lane: "comprehensive",
      }),
    ).toThrow("review wave scope binding is invalid");
    wave.scope_binding = originalBinding;
    wave.scope_class = "document";
    expect(() =>
      recordSubagentReviewState(ledger, {
        reviewProfile: "pr-convergence",
        baseRef: sha,
        reviewAttemptId: "scope-tamper",
        reviewResultJson: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation:
            "Inspected the candidate diff and confirmed the complete result.",
          overall_confidence_score: 1,
        }),
        waveId: String(wave.wave_id),
        lane: "comprehensive",
      }),
    ).toThrow("review wave scope binding is invalid");
    wave.scope_class = originalScope;
    for (const lane of lanes) {
      if (lane.lane === "comprehensive") {
        const unavailable = recordSubagentReviewState(ledger, {
          reviewProfile: "pr-convergence",
          baseRef: sha,
          reviewAttemptId: "comprehensive-startup-1",
          reviewResultJson: "",
          terminalState: "unavailable",
          unavailabilityClassification: "startup-unavailable",
          waveId: String(wave.wave_id),
          lane: lane.lane,
        });
        expect(unavailable.reused).toBe(false);
        const unavailableReceipt = (
          ledger.receipts as Record<string, unknown>[]
        ).find((receipt) => receipt.kind === "review_attempt");
        if (!unavailableReceipt)
          throw new Error("unavailable receipt is missing");
        expect(unavailableReceipt).toMatchObject({
          review_execution_source: "parent-flow-request",
          provenance_boundary: "parent-flow-request-and-startup-observation",
          evidence_source: "parent-request-and-startup-observation",
        });
        unavailableReceipt.requested_profile = {
          model: "tampered-model",
          effort: "tampered-effort",
        };
        expect(() =>
          recordSubagentReviewState(ledger, {
            reviewProfile: "pr-convergence",
            baseRef: sha,
            reviewAttemptId: "comprehensive-startup-1",
            reviewResultJson: "",
            terminalState: "unavailable",
            unavailabilityClassification: "startup-unavailable",
            waveId: String(wave.wave_id),
            lane: lane.lane,
          }),
        ).toThrow("review attempt receipt integrity is invalid");
        unavailableReceipt.requested_profile = {
          model: "gpt-6-luna",
          effort: "max",
        };
        unavailableReceipt.scope_class = "document";
        expect(() =>
          recordSubagentReviewState(ledger, {
            reviewProfile: "pr-convergence",
            baseRef: sha,
            reviewAttemptId: "comprehensive-startup-1",
            reviewResultJson: "",
            terminalState: "unavailable",
            unavailabilityClassification: "startup-unavailable",
            waveId: String(wave.wave_id),
            lane: lane.lane,
          }),
        ).toThrow("review attempt receipt integrity is invalid");
        unavailableReceipt.scope_class = "code";
        unavailableReceipt.review_receipt_schema = 6;
        expect(() =>
          recordSubagentReviewState(ledger, {
            reviewProfile: "pr-convergence",
            baseRef: sha,
            reviewAttemptId: "comprehensive-startup-1",
            reviewResultJson: JSON.stringify({
              findings: [],
              overall_correctness: "patch is correct",
              overall_explanation:
                "Inspected the candidate diff and confirmed the completed result.",
              overall_confidence_score: 1,
            }),
            waveId: String(wave.wave_id),
            lane: lane.lane,
          }),
        ).toThrow("review attempt receipt integrity is invalid");
        unavailableReceipt.review_receipt_schema = 7;
        unavailableReceipt.reported_profile = {
          model: "reviewer-claim",
          effort: "reviewer-claim",
        };
        expect(() =>
          recordSubagentReviewState(ledger, {
            reviewProfile: "pr-convergence",
            baseRef: sha,
            reviewAttemptId: "comprehensive-startup-1",
            reviewResultJson: "",
            terminalState: "unavailable",
            unavailabilityClassification: "startup-unavailable",
            waveId: String(wave.wave_id),
            lane: lane.lane,
          }),
        ).toThrow("review receipt contains unsupported fields");
        delete unavailableReceipt.reported_profile;
      }
      const result = recordSubagentReviewState(ledger, {
        reviewProfile: "pr-convergence",
        baseRef: sha,
        reviewAttemptId: `attempt-${lane.lane}`,
        reviewResultJson: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation:
            "Inspected the candidate diff and tests; the patch is correct.",
          overall_confidence_score: 1,
        }),
        waveId: String(wave.wave_id),
        lane: lane.lane,
      });
      expect(result.reused).toBe(false);
    }
    const contractReceipt = (ledger.receipts as Record<string, unknown>[]).find(
      (receipt) => receipt.kind === "review" && receipt.lane === "comprehensive",
    );
    expect(contractReceipt).toMatchObject({
      review_receipt_schema: 7,
      requested_profile: { model: "gpt-6-luna", effort: "max" },
      profile_verification: "request_recorded",
      effective_profile: null,
      attempt_key: "attempt-comprehensive",
    });
    expect(contractReceipt).not.toHaveProperty("reported_profile");
    if (!contractReceipt) throw new Error("contract receipt is missing");
    contractReceipt.requested_profile = {
      model: "tampered-model",
      effort: "tampered-effort",
    };
    expect(() =>
      recordSubagentReviewState(ledger, {
        reviewProfile: "pr-convergence",
        baseRef: sha,
        reviewAttemptId: "attempt-comprehensive",
        reviewResultJson: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation:
            "Inspected the candidate diff and tests; the patch is correct.",
          overall_confidence_score: 1,
        }),
        waveId: String(wave.wave_id),
        lane: "comprehensive",
      }),
    ).toThrow("review receipt requested profile integrity is invalid");
    contractReceipt.requested_profile = {
      model: "gpt-6-luna",
      effort: "max",
    };
    for (const claim of ["reported_profile", "effective_model"]) {
      contractReceipt[claim] = {
        model: "reviewer-claim",
        effort: "reviewer-claim",
      };
      expect(() =>
        finalizeReviewWaveState(ledger, String(wave.wave_id), {
          groups: [],
          invariants: ["all lanes covered"],
          coverage: lanes.map(({ lane }) => lane),
          conflicts: [],
          acceptance: [],
        }),
      ).toThrow(
        claim === "reported_profile"
          ? "review receipt must not contain reviewer profile claims"
          : "review receipt contains unsupported fields",
      );
      delete contractReceipt[claim];
    }
    const finalized = finalizeReviewWaveState(ledger, String(wave.wave_id), {
      groups: [],
      invariants: ["all lanes covered"],
      coverage: lanes.map(({ lane }) => lane),
      conflicts: [],
      acceptance: [],
    });
    expect(finalized.next).toBe("merge-ready");
    expect((finalized.blockers as unknown[]).length).toBe(0);
    expect(
      (ledger.receipts as Record<string, unknown>[]).filter(
        (receipt) => receipt.kind === "review_attempt",
      ),
    ).toHaveLength(1);
  });

  test("blocks clear when startup unavailability is the only lane result", () => {
    const ledger = initialLedger("review-unavailable-run", "fast-track", sha, sha, null);
    ledger.review_assessment = {
      tier: 3,
      reason: "startup unavailable coverage",
      assessed_at: "2026-10-27T00:00:00.000Z",
      assessed_head_sha: sha,
      source: "agent-assessment",
    };
    const lanes = [
      { lane: "comprehensive", model: "gpt-6-luna", effort: "max" },
    ];
    const opened = openReviewWaveState(ledger, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
    });
    const wave = opened.wave as Record<string, unknown>;
    recordSubagentReviewState(ledger, {
      reviewProfile: "pr-convergence",
      baseRef: sha,
      reviewAttemptId: "startup-only",
      reviewResultJson: "",
      terminalState: "unavailable",
      unavailabilityClassification: "startup-unavailable",
      waveId: String(wave.wave_id),
      lane: "comprehensive",
    });
    expect(() =>
      finalizeReviewWaveState(ledger, String(wave.wave_id), {
        groups: [],
        invariants: ["all lanes covered"],
        coverage: lanes.map(({ lane }) => lane),
        conflicts: [],
        acceptance: [],
      }),
    ).toThrow("review wave requires terminal receipts");
  });

  test("recognizes the retired four-lane topology only for schema 6", () => {
    const synthesis = {
      groups: [],
      invariants: [],
      coverage: [],
      conflicts: [],
      acceptance: [],
    };
    const wave = (lanes: Record<string, unknown>) => ({
      stage: "initial",
      state: "finalized",
      head_sha: sha,
      base_sha: sha,
      synthesis,
      synthesis_sha256: stableHash(synthesis),
      lanes,
    });
    const historicalLanes = Object.fromEntries(
      [
        "contract",
        "state-concurrency",
        "failure-data-safety",
        "test-platform",
      ].map((name) => [name, { state: "completed" }]),
    );
    const currentLanes = { comprehensive: { state: "completed" } };

    expect(
      isCurrentClearWave(wave(historicalLanes), sha, sha, 3, {
        legacySchema: true,
      }),
    ).toBe(true);
    // A current ledger never re-authorizes the retired lanes.
    expect(isCurrentClearWave(wave(historicalLanes), sha, sha, 3)).toBe(false);
    expect(isCurrentClearWave(wave(currentLanes), sha, sha, 3)).toBe(true);
    expect(
      isCurrentClearWave(wave(currentLanes), sha, sha, 3, {
        legacySchema: true,
      }),
    ).toBe(true);
  });

  test("keeps schema 6 review receipts historical and blocks fresh clear", () => {
    const ledger = initialLedger("legacy-review-run", "fast-track", sha, sha, null);
    ledger.review_assessment = {
      tier: 3,
      reason: "historical compatibility",
      assessed_at: "2026-10-27T00:00:00.000Z",
      assessed_head_sha: sha,
      source: "agent-assessment",
    };
    const lanes = [
      { lane: "comprehensive", model: "gpt-6-luna", effort: "max" },
    ];
    const opened = openReviewWaveState(ledger, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
    });
    const wave = opened.wave as Record<string, unknown>;
    for (const lane of lanes)
      recordSubagentReviewState(ledger, {
        reviewProfile: "pr-convergence",
        baseRef: sha,
        reviewAttemptId: `historical-${lane.lane}`,
        reviewResultJson: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation:
            "Reviewed the historical candidate diff and confirmed the complete result.",
          overall_confidence_score: 1,
        }),
        waveId: String(wave.wave_id),
        lane: lane.lane,
      });

    const disguisedCurrent = structuredClone(ledger) as Record<string, unknown>;
    const disguisedReview = disguisedCurrent.review as Record<string, unknown>;
    const disguisedWave = (
      disguisedReview.waves as Record<string, Record<string, unknown>>
    )[String(wave.wave_id)];
    delete disguisedWave.scope_binding;
    for (const lane of Object.values(
      disguisedWave.lanes as Record<string, Record<string, unknown>>,
    ))
      delete lane.requested_profile;
    for (const receipt of disguisedCurrent.receipts as Record<string, unknown>[])
      if (receipt.kind === "review") receipt.review_receipt_schema = 6;
    const disguisedReceipt = (
      disguisedCurrent.receipts as Record<string, unknown>[]
    ).find((receipt) => receipt.lane === "comprehensive");
    if (!disguisedReceipt) throw new Error("disguised review receipt is missing");
    disguisedReceipt.review_clear = false;
    disguisedReceipt.overall_correctness = "patch is incorrect";
    disguisedReceipt.finding_fingerprints = ["blocking-finding"];
    expect(() =>
      openReviewWaveState(disguisedCurrent, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    expect(disguisedWave.state).toBe("open");
    const malformedCurrent = structuredClone(ledger) as Record<string, unknown>;
    const malformedReceipt = (
      malformedCurrent.receipts as Record<string, unknown>[]
    ).find((receipt) => receipt.lane === "comprehensive");
    if (!malformedReceipt) throw new Error("malformed review receipt is missing");
    malformedReceipt.review_result_sha256 = "tampered-result-hash";
    expect(() =>
      openReviewWaveState(malformedCurrent, {
        stage: "initial",
        baseSha: sha,
        headSha: "c".repeat(40),
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");

    const historical = structuredClone(ledger) as Record<string, unknown>;
    historical.schema_version = 6;
    const historicalReceipts = (
      historical.receipts as Record<string, unknown>[]
    ).map((receipt) => {
      const legacy = { ...receipt };
      if (legacy.kind !== "review") return legacy;
      for (const key of [
        "requested_profile",
        "profile_verification",
        "effective_profile",
        "reported_profile",
        "attempt_key",
        "scope_class",
      ])
        delete legacy[key];
      legacy.review_receipt_schema = 6;
      legacy.review_model = "legacy-model-self-report";
      legacy.review_effort = "legacy-effort-self-report";
      legacy.resolved_model = "legacy-model-self-report";
      legacy.resolved_effort = "legacy-effort-self-report";
      legacy.profile_resolution = {
        preferred: {
          model: "gpt-6-luna",
          effort: "max",
        },
        resolved: {
          model: "legacy-model-self-report",
          effort: "legacy-effort-self-report",
        },
        fallback_reason: null,
        attempts: 1,
      };
      legacy.profile_proof_status = "sub-agent-declared";
      legacy.review_execution_source = "sub-agent";
      legacy.provenance_boundary = "sub-agent-structured-result";
      legacy.evidence_source = "sub-agent-structured-result";
      legacy.receipt_id = stableHash([
        String(historical.run_id),
        "sub-agent-review",
        legacy.wave_proof_key,
        legacy.review_result_sha256,
      ]);
      return legacy;
    });
    historical.receipts = historicalReceipts;
    const malformedHistorical = structuredClone(historical) as Record<
      string,
      unknown
    >;
    const malformedHistoricalReview = malformedHistorical.review as Record<
      string,
      unknown
    >;
    const malformedHistoricalWave = (
      malformedHistoricalReview.waves as Record<
        string,
        Record<string, unknown>
      >
    )[String(wave.wave_id)];
    delete malformedHistoricalWave.scope_binding;
    for (const [laneName, lane] of Object.entries(
      malformedHistoricalWave.lanes as Record<string, Record<string, unknown>>,
    )) {
      delete lane.requested_profile;
      const receipt = (
        malformedHistorical.receipts as Record<string, unknown>[]
      ).find((candidate) => candidate.lane === laneName);
      if (receipt) lane.receipt_id = receipt.receipt_id;
    }
    const malformedHistoricalReceipt = (
      malformedHistorical.receipts as Record<string, unknown>[]
    ).find((receipt) => receipt.kind === "review");
    if (!malformedHistoricalReceipt)
      throw new Error("malformed historical receipt is missing");
    delete malformedHistoricalReceipt.review_result;
    expect(() =>
      openReviewWaveState(malformedHistorical, {
        stage: "initial",
        baseSha: sha,
        headSha: "b".repeat(40),
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    const historicalReview = historical.review as Record<string, unknown>;
    const historicalWave = (
      historicalReview.waves as Record<string, Record<string, unknown>>
    )[String(wave.wave_id)];
    for (const [laneName, lane] of Object.entries(
      historicalWave.lanes as Record<string, Record<string, unknown>>,
    )) {
      const receipt = historicalReceipts.find(
        (candidate) => candidate.lane === laneName,
      );
      if (receipt) lane.receipt_id = receipt.receipt_id;
    }
    delete historicalWave.scope_binding;
    for (const lane of Object.values(
      historicalWave.lanes as Record<string, Record<string, unknown>>,
    ))
      delete lane.requested_profile;
    const historicalSnapshot = structuredClone(historicalReceipts);
    const normalized = normalizeLedger(historical);
    expect(normalized.receipts).toEqual(historicalSnapshot);
    expect(normalized.schema_version).toBe(6);
    expect(normalized.legacy_schema_version).toBe(6);
    const forgedSchema7 = structuredClone(historical) as Record<
      string,
      unknown
    >;
    forgedSchema7.schema_version = 7;
    forgedSchema7.legacy_compatibility = true;
    forgedSchema7.legacy_schema_version = 6;
    expect(() =>
      openReviewWaveState(forgedSchema7, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    const malformedHistoricalProof = structuredClone(normalized) as Record<
      string,
      unknown
    >;
    const malformedHistoricalProofReceipt = (
      malformedHistoricalProof.receipts as Record<string, unknown>[]
    ).find((receipt) => receipt.kind === "review");
    if (!malformedHistoricalProofReceipt)
      throw new Error("malformed historical proof receipt is missing");
    malformedHistoricalProofReceipt.proof_key = "tampered-proof-key";
    expect(() =>
      openReviewWaveState(malformedHistoricalProof, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    expect(() =>
      finalizeReviewWaveState(normalized, String(wave.wave_id), {
        groups: [],
        invariants: ["all lanes covered"],
        coverage: lanes.map(({ lane }) => lane),
        conflicts: [],
        acceptance: [],
      }),
    ).toThrow("review receipt integrity is invalid");

    const sameCandidate = structuredClone(normalized) as Record<string, unknown>;
    const sameCandidateWave = (
      sameCandidate.review as Record<string, unknown>
    ).waves as Record<string, Record<string, unknown>>;
    const sameCandidateOldWave = sameCandidateWave[String(wave.wave_id)];
    const sameCandidateFresh = openReviewWaveState(sameCandidate, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      });
    expect(sameCandidateOldWave.state).toBe("retired");
    expect(sameCandidateFresh.next).toBe("record-review");
    expect(sameCandidate.schema_version).toBe(7);

    const danglingReceipt = structuredClone(normalized) as Record<
      string,
      unknown
    >;
    const danglingWave = (
      danglingReceipt.review as Record<string, unknown>
    ).waves as Record<string, Record<string, unknown>>;
    const danglingLane = (
      danglingWave[String(wave.wave_id)].lanes as Record<
        string,
        Record<string, unknown>
      >
    ).comprehensive;
    danglingLane.receipt_id = "missing-review-receipt";
    expect(() =>
      openReviewWaveState(danglingReceipt, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");

    const unfinishedSameCandidate = structuredClone(normalized) as Record<
      string,
      unknown
    >;
    const unfinishedWave = (
      unfinishedSameCandidate.review as Record<string, unknown>
    ).waves as Record<string, Record<string, unknown>>;
    const unfinishedLane = (
      unfinishedWave[String(wave.wave_id)].lanes as Record<
        string,
        Record<string, unknown>
      >
    ).comprehensive;
    unfinishedLane.state = "pending";
    unfinishedLane.receipt_id = null;
    expect(() =>
      openReviewWaveState(unfinishedSameCandidate, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");

    const freshHead = "b".repeat(40);
    const partial = structuredClone(normalized) as Record<string, unknown>;
    const partialReview = partial.review as Record<string, unknown>;
    const partialWave = (
      partialReview.waves as Record<string, Record<string, unknown>>
    )[String(wave.wave_id)];
    const partialLane = (
      partialWave.lanes as Record<string, Record<string, unknown>>
    ).comprehensive;
    partialLane.receipt_id = null;
    partialLane.state = "pending";
    expect(() =>
      openReviewWaveState(partial, {
        stage: "initial",
        baseSha: sha,
        headSha: freshHead,
        laneSpecs: lanes,
      }),
    ).toThrow("another review wave is already active");
    expect(partialWave.state).toBe("open");

    const fresh = openReviewWaveState(normalized, {
      stage: "initial",
      baseSha: sha,
      headSha: freshHead,
      laneSpecs: lanes,
    });
    const freshWave = fresh.wave as Record<string, unknown>;
    expect(freshWave.wave_id).not.toBe(wave.wave_id);
    expect(freshWave.head_sha).toBe(freshHead);
    expect(historicalWave.state).toBe("retired");
    expect(
      Object.values(freshWave.lanes as Record<string, Record<string, unknown>>).every(
        (lane) =>
          canonicalJson(lane.requested_profile) ===
          canonicalJson({ model: "gpt-6-luna", effort: "max" }),
      ),
    ).toBe(true);
    delete (
      freshWave.lanes as Record<string, Record<string, unknown>>
    ).comprehensive;
    expect(() =>
      finalizeReviewWaveState(normalized, String(freshWave.wave_id), {
        groups: [],
        invariants: ["all lanes covered"],
        coverage: lanes.map(({ lane }) => lane),
        conflicts: [],
        acceptance: [],
      }),
    ).toThrow("required review wave lane topology");
  });

  test("rejects retired fixed lane profiles instead of falling back", () => {
    const ledger = initialLedger("review-profile-run", "fast-track", sha, sha, null);
    ledger.review_assessment = {
      tier: 3,
      reason: "profile request contract",
      assessed_at: "2026-10-27T00:00:00.000Z",
      assessed_head_sha: sha,
      source: "agent-assessment",
    };
    expect(() =>
      openReviewWaveState(ledger, {
        stage: "initial",
        baseSha: sha,
        headSha: sha,
        laneSpecs: [
          { lane: "comprehensive", model: "gpt-5.6-luna", effort: "medium" },
        ],
      }),
    ).toThrow("requested gpt-6-luna + max profile");
  });
});

test("acceptance manifest rejects high-risk composed evidence", () => {
  expect(() =>
    normalizeAcceptanceManifest({
      plan_digest: "b".repeat(64),
      items: [
        {
          id: "RISK",
          category: "safety",
          mode: "composed",
          target: "x",
          evidence: ["y"],
          assertions: ["z"],
        },
      ],
    }),
  ).toThrow("high-risk acceptance requires direct evidence");
});

test("flow manifest can be written and read without changing its normalized identity", async () => {
  await withTemp("flow-manifest-", async (root) => {
    const path = join(root, "manifest.json");
    await writeFile(path, JSON.stringify(manifest()));
    const loaded = normalizeAcceptanceManifest(
      JSON.parse(await readFile(path, "utf8")),
    );
    expect(stableHash(loaded)).toBe(stableHash(manifest()));
  });
});
