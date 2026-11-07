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
  normalizePostMergeEvidence,
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
          toolchainFingerprint: "bun@1.4.4",
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
          toolchainFingerprint: "bun@1.4.4",
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
          toolchainFingerprint: "bun@1.4.4",
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
      { lane: "contract", model: "gpt-5.6-luna", effort: "medium" },
      { lane: "state-concurrency", model: "gpt-5.6-luna", effort: "xhigh" },
      { lane: "failure-data-safety", model: "gpt-5.6-luna", effort: "max" },
      { lane: "test-platform", model: "gpt-6.1-sol", effort: "high" },
    ];
    const opened = openReviewWaveState(ledger, {
      stage: "initial",
      baseSha: sha,
      headSha: sha,
      laneSpecs: lanes,
    });
    const wave = opened.wave as Record<string, unknown>;
    for (const lane of lanes) {
      const result = recordSubagentReviewState(ledger, {
        reviewProfile: "pr-convergence",
        baseRef: sha,
        reviewModel: lane.model,
        reviewEffort: lane.effort,
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
    const finalized = finalizeReviewWaveState(ledger, String(wave.wave_id), {
      groups: [],
      invariants: ["all lanes covered"],
      coverage: lanes.map(({ lane }) => lane),
      conflicts: [],
      acceptance: [],
    });
    expect(finalized.next).toBe("merge-ready");
    expect((finalized.blockers as unknown[]).length).toBe(0);
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
