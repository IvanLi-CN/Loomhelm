import { describe, expect, test } from "bun:test";
import { ciFacts } from "../../compatibility_hosting";
import { bindingFromRemote } from "../../modules/hosting/remote";
import { HostingError } from "../../modules/hosting/types";
import { fakeBackend, head, response } from "./test_helpers";

describe("CI facts adapters", () => {
  test("binds status, checks, and runs to the requested SHA", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({
        workflow_runs: [
          {
            id: 9,
            name: "quality",
            head_sha: head,
            event: "push",
            status: "success",
          },
        ],
      }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        required_contexts: ["quality"],
        policy_state: "required",
        checks_expected: "yes",
        runs: [{ id: 9, head_sha: head }],
      },
    );
    expect(backend.calls.map((call) => call.endpoint)).toEqual([
      "repos/owner/demo/branches/main/protection/required_status_checks",
      `repos/owner/demo/commits/${head}/status`,
      `repos/owner/demo/commits/${head}/check-runs`,
      `repos/owner/demo/actions/runs?head_sha=${head}&per_page=100`,
    ]);
    expect(backend.calls.slice(1).map((call) => call.options)).toEqual([
      { include: true, check: false, operation: "ci-status" },
      { include: true, check: false, operation: "ci-checks" },
      { include: true, check: false, operation: "ci-runs" },
    ]);
  });

  test("rejects stale status response", async () => {
    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const backend = fakeBackend(gitea, [
      response({ status_check_contexts: [] }),
      response({ sha: "b".repeat(40), statuses: [] }),
      response({ tasks: [] }),
    ]);
    await expect(ciFacts(gitea, backend, "main", head)).rejects.toThrow(
      "stale_ci_evidence",
    );
  });

  test("treats manual-only absence as non-blocking", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response(null, 404),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({
        workflow_runs: [
          {
            id: 1,
            head_sha: head,
            name: "native",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 2,
            head_sha: "b".repeat(40),
            name: "quality",
            event: "push",
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 3,
            head_sha: head,
            name: "release",
            event: "release",
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 4,
            head_sha: head,
            name: "unknown-event",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        policy_state: "none",
        checks_expected: "no",
        ci_evidence: "not_applicable",
        gate_effect: "non_blocking",
        runs: [],
      },
    );
  });

  test("does not let a manual workflow run satisfy a required context", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({
        workflow_runs: [
          {
            id: 20,
            head_sha: head,
            name: "quality",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        policy_state: "required",
        checks_expected: "yes",
        ci_evidence: "absent",
        gate_effect: "blocking",
        runs: [],
      },
    );
  });

  test("marks required evidence as passed", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({
        sha: head,
        statuses: [{ context: "quality", state: "success" }],
      }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        policy_state: "required",
        checks_expected: "yes",
        ci_evidence: "passed",
        gate_effect: "non_blocking",
      },
    );
  });

  test("reads required contexts from the GitHub checks policy form", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: [], checks: [{ context: "quality" }] }),
      response({
        sha: head,
        statuses: [{ context: "quality", state: "success" }],
      }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        required_contexts: ["quality"],
        policy_state: "required",
        checks_expected: "yes",
        ci_evidence: "passed",
      },
    );
  });

  test("uses the freshest outcome for a repeated required context", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({
        sha: head,
        statuses: [
          {
            context: "quality",
            state: "success",
            updated_at: "2026-10-30T00:00:02.000Z",
          },
          {
            context: "quality",
            state: "failure",
            updated_at: "2026-10-30T00:00:01.000Z",
          },
        ],
      }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        ci_evidence: "passed",
        gate_effect: "non_blocking",
      },
    );
  });

  test("treats a neutral required check conclusion as passed", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({ sha: head, statuses: [] }),
      response({
        sha: head,
        check_runs: [
          {
            name: "quality",
            head_sha: head,
            status: "completed",
            conclusion: "neutral",
          },
        ],
      }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        ci_evidence: "passed",
        gate_effect: "non_blocking",
      },
    );
  });

  test("preserves required pending and failed states", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    for (const [state, expected] of [
      ["pending", "pending"],
      ["failure", "failed"],
    ] as const) {
      const backend = fakeBackend(github, [
        response({ contexts: ["quality"] }),
        response({
          sha: head,
          statuses: [{ context: "quality", state }],
        }),
        response({ sha: head, check_runs: [] }),
        response({ workflow_runs: [] }),
      ]);
      await expect(
        ciFacts(github, backend, "main", head),
      ).resolves.toMatchObject({
        policy_state: "required",
        ci_evidence: expected,
        gate_effect: "blocking",
      });
    }
  });

  test("keeps malformed status evidence unavailable", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    for (const statuses of [
      { context: "quality" },
      [{ context: "quality", state: "success", sha: 123 }],
    ]) {
      const backend = fakeBackend(github, [
        response({ contexts: ["quality"] }),
        response({ sha: head, statuses }),
        response({ sha: head, check_runs: [] }),
        response({ workflow_runs: [] }),
      ]);
      await expect(
        ciFacts(github, backend, "main", head),
      ).resolves.toMatchObject({
        ci_evidence: "unavailable",
        gate_effect: "blocking",
        observation_errors: [
          {
            surface: "ci-status",
            error: {
              code: "ci_surface_unavailable",
              source_code: "invalid_provider_response",
            },
          },
        ],
      });
    }
  });

  test("keeps policy errors typed while collecting independent facts", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ message: "forbidden" }, 403),
      response({
        sha: head,
        statuses: [{ context: "quality", state: "success" }],
      }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        policy_state: "unavailable",
        checks_expected: "unknown",
        ci_evidence: "unavailable",
        gate_effect: "not_applicable",
        policy_observation: {
          error: { code: "ci_policy_unavailable", source_code: "http_status" },
        },
        statuses: [{ context: "quality" }],
      },
    );
    expect(backend.calls).toHaveLength(4);
  });

  test("classifies provider permission, rate-limit, and timeout failures as unavailable", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    for (const policyResponse of [
      response({ message: "forbidden" }, 401),
      response({ message: "forbidden" }, 429),
      new HostingError(
        "provider_request_failed",
        "timed out",
        "ci-protection",
        { status: null },
      ),
    ]) {
      const backend = fakeBackend(github, [
        policyResponse,
        response({ sha: head, statuses: [] }),
        response({ sha: head, check_runs: [] }),
        response({ workflow_runs: [] }),
      ]);
      await expect(
        ciFacts(github, backend, "main", head),
      ).resolves.toMatchObject({
        policy_state: "unavailable",
        checks_expected: "unknown",
        ci_evidence: "unavailable",
        policy_observation: {
          error: { code: "ci_policy_unavailable" },
        },
      });
    }

    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    for (const status of [401, 403, 429]) {
      const backend = fakeBackend(gitea, [
        response({ message: "provider unavailable" }, status),
        response({ sha: head, statuses: [] }),
        response({ tasks: [] }),
      ]);
      await expect(
        ciFacts(gitea, backend, "main", head),
      ).resolves.toMatchObject({
        policy_state: "unavailable",
        checks_expected: "unknown",
        ci_evidence: "unavailable",
      });
    }

    const surfaceTimeout = fakeBackend(github, [
      response({ contexts: [] }),
      new HostingError("provider_request_failed", "timed out", "ci-status", {
        status: null,
      }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(
      ciFacts(github, surfaceTimeout, "main", head),
    ).resolves.toMatchObject({
      observation_errors: [
        {
          surface: "ci-status",
          error: { code: "ci_surface_unavailable", status: null },
        },
      ],
    });
  });

  test("keeps GitHub plan-limit fallback transport failures unavailable", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const planLimit = {
      message:
        "Upgrade to GitHub Pro or make this repository public to enable this feature.",
    };
    const backend = fakeBackend(github, [
      response(planLimit, 403),
      response({ message: "upstream failure" }, 503),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        policy_state: "unavailable",
        checks_expected: "unknown",
        ci_evidence: "unavailable",
        policy_observation: {
          error: { code: "ci_policy_unavailable", status: 503 },
        },
      },
    );
  });

  test("uses the Gitea runs fallback only for an unsupported tasks endpoint", async () => {
    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const backend = fakeBackend(gitea, [
      response({ status_check_contexts: [] }),
      response({ sha: head, statuses: [] }),
      response({ message: "not found" }, 404),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(gitea, backend, "main", head)).resolves.toMatchObject({
      policy_state: "none",
      ci_evidence: "not_applicable",
      observation_errors: [],
      runs: [],
    });
    expect(backend.calls.map((call) => call.endpoint)).toEqual([
      "repos/owner/demo/branches/main",
      `repos/owner/demo/commits/${head}/status`,
      `repos/owner/demo/actions/tasks?head_sha=${head}&limit=100`,
      `repos/owner/demo/actions/runs?head_sha=${head}&limit=100`,
    ]);
  });

  test("normalizes a direct Gitea tasks response for the exact SHA", async () => {
    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const backend = fakeBackend(gitea, [
      response({ status_check_contexts: ["quality"] }),
      response({ sha: head, statuses: [] }),
      response({
        tasks: [
          {
            id: 22,
            workflow_name: "quality",
            head_sha: head,
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    ]);
    await expect(ciFacts(gitea, backend, "main", head)).resolves.toMatchObject({
      policy_state: "required",
      checks_expected: "yes",
      ci_evidence: "passed",
      gate_effect: "non_blocking",
      runs: [{ id: 22, name: "quality", head_sha: head }],
    });
  });

  test("does not replace an unavailable Gitea task surface with a malformed fallback", async () => {
    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const backend = fakeBackend(gitea, [
      response({ status_check_contexts: [] }),
      response({ sha: head, statuses: [] }),
      response({ message: "forbidden" }, 403),
      response({ runs: "not-an-array" }),
    ]);
    await expect(ciFacts(gitea, backend, "main", head)).resolves.toMatchObject({
      policy_state: "none",
      ci_evidence: "not_applicable",
      observation_errors: [
        {
          surface: "ci-runs",
          error: { code: "ci_surface_unavailable", status: 403 },
        },
      ],
    });
    expect(backend.calls.map((call) => call.endpoint)).toEqual([
      "repos/owner/demo/branches/main",
      `repos/owner/demo/commits/${head}/status`,
      `repos/owner/demo/actions/tasks?head_sha=${head}&limit=100`,
    ]);
  });

  test("uses unprotected branch metadata for the plan-limited no-policy fallback", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const planLimit = {
      message:
        "Upgrade to GitHub Pro or make this repository public to enable this feature.",
    };
    const unprotected = fakeBackend(github, [
      response(planLimit, 403),
      response({ name: "main", protected: false }),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(
      ciFacts(github, unprotected, "main", head),
    ).resolves.toMatchObject({
      policy_state: "none",
      checks_expected: "no",
      ci_evidence: "not_applicable",
    });

    const protectedBranch = fakeBackend(github, [
      response(planLimit, 403),
      response({ name: "main", protected: true }),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(
      ciFacts(github, protectedBranch, "main", head),
    ).resolves.toMatchObject({
      policy_state: "unknown",
      checks_expected: "unknown",
      ci_evidence: "unavailable",
      policy_observation: {
        error: { source_code: "branch_policy_mismatch" },
      },
    });
  });

  test("treats an invalid policy endpoint as observation evidence", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      new HostingError(
        "invalid_endpoint",
        "provider endpoint is malformed",
        "ci-protection",
      ),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        policy_state: "unavailable",
        checks_expected: "unknown",
        ci_evidence: "unavailable",
        gate_effect: "not_applicable",
        observation_errors: [
          {
            surface: "ci-policy",
            error: {
              code: "ci_policy_unavailable",
              source_code: "invalid_endpoint",
            },
          },
        ],
      },
    );
  });

  test("keeps malformed policy unknown while surfaces remain available", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: "quality" }),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        policy_state: "unknown",
        checks_expected: "unknown",
        ci_evidence: "unavailable",
        gate_effect: "not_applicable",
        policy_observation: {
          error: {
            code: "ci_policy_unknown",
            source_code: "invalid_provider_response",
          },
        },
      },
    );
  });
});
