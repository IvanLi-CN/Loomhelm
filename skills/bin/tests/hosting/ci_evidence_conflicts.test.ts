import { describe, expect, test } from "bun:test";
import { ciFacts } from "../../compatibility_hosting";
import { bindingFromRemote } from "../../modules/hosting/remote";
import { fakeBackend, head, response } from "./test_helpers";

describe("CI evidence conflict reduction", () => {
  test("fails closed on contradictory status and conclusion", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const checkBackend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({ sha: head, statuses: [] }),
      response({
        sha: head,
        check_runs: [
          {
            name: "quality",
            head_sha: head,
            status: "failure",
            conclusion: "success",
          },
        ],
      }),
      response({ workflow_runs: [] }),
    ]);
    await expect(
      ciFacts(github, checkBackend, "main", head),
    ).resolves.toMatchObject({
      ci_evidence: "failed",
      gate_effect: "blocking",
    });

    const runBackend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({ sha: head, statuses: [] }),
      response({ sha: head, check_runs: [] }),
      response({
        workflow_runs: [
          {
            id: 18,
            name: "quality",
            head_sha: head,
            event: "push",
            status: "failure",
            conclusion: "success",
          },
        ],
      }),
    ]);
    await expect(
      ciFacts(github, runBackend, "main", head),
    ).resolves.toMatchObject({
      ci_evidence: "failed",
      gate_effect: "blocking",
    });
  });

  test("uses a higher rerun attempt when the newer observation lacks a timestamp", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({ sha: head, statuses: [] }),
      response({
        sha: head,
        check_runs: [
          {
            id: 19,
            name: "quality",
            head_sha: head,
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
            updated_at: "2026-10-30T00:00:02.000Z",
          },
          {
            id: 20,
            name: "quality",
            head_sha: head,
            status: "completed",
            conclusion: "failure",
            run_attempt: 2,
          },
        ],
      }),
      response({ workflow_runs: [] }),
    ]);
    await expect(ciFacts(github, backend, "main", head)).resolves.toMatchObject(
      {
        ci_evidence: "failed",
        gate_effect: "blocking",
      },
    );
  });

  test("uses run id when equal attempts have partial timestamps", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    for (const observations of [
      [
        {
          id: 100,
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "failure",
          run_attempt: 1,
          updated_at: "2026-10-30T00:00:02.000Z",
        },
        {
          id: 101,
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
        },
      ],
      [
        {
          id: 101,
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
        },
        {
          id: 100,
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "failure",
          run_attempt: 1,
          updated_at: "2026-10-30T00:00:02.000Z",
        },
      ],
    ]) {
      const backend = fakeBackend(github, [
        response({ contexts: ["quality"] }),
        response({ sha: head, statuses: [] }),
        response({ sha: head, check_runs: observations }),
        response({ workflow_runs: [] }),
      ]);
      await expect(
        ciFacts(github, backend, "main", head),
      ).resolves.toMatchObject({
        ci_evidence: "passed",
        gate_effect: "non_blocking",
      });
    }
  });

  test("uses failure severity when repeated observations are incomparable", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    for (const observations of [
      [
        {
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "success",
        },
        {
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "failure",
        },
      ],
      [
        {
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "failure",
        },
        {
          name: "quality",
          head_sha: head,
          status: "completed",
          conclusion: "success",
        },
      ],
    ]) {
      const backend = fakeBackend(github, [
        response({ contexts: ["quality"] }),
        response({ sha: head, statuses: [] }),
        response({ sha: head, check_runs: observations }),
        response({ workflow_runs: [] }),
      ]);
      await expect(
        ciFacts(github, backend, "main", head),
      ).resolves.toMatchObject({
        ci_evidence: "failed",
        gate_effect: "blocking",
      });
    }
  });

  test("keeps malformed check rows typed as unavailable", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    for (const check of [
      { name: "quality", status: "completed" },
      { name: "quality", status: "completed", head_sha: "not-a-sha" },
      null,
    ]) {
      const backend = fakeBackend(github, [
        response({ contexts: ["quality"] }),
        response({ sha: head, statuses: [] }),
        response({ sha: head, check_runs: [check] }),
        response({ workflow_runs: [] }),
      ]);
      await expect(
        ciFacts(github, backend, "main", head),
      ).resolves.toMatchObject({
        ci_evidence: "unavailable",
        gate_effect: "blocking",
        observation_errors: [
          {
            surface: "ci-checks",
            error: {
              code: "ci_surface_unavailable",
              source_code: "invalid_provider_response",
            },
          },
        ],
      });
    }
  });

  test("redacts credentials and sensitive query values in normalized URLs", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const secretUrl =
      "https://user:pass@example.test/check?api_key=secret&ok=1";
    const backend = fakeBackend(github, [
      response({ contexts: ["quality"] }),
      response({
        sha: head,
        statuses: [
          {
            context: "quality",
            state: "success",
            target_url: secretUrl,
          },
        ],
      }),
      response({
        sha: head,
        check_runs: [
          {
            name: "other",
            head_sha: head,
            status: "completed",
            conclusion: "success",
            details_url: secretUrl,
          },
        ],
      }),
      response({
        workflow_runs: [
          {
            id: 21,
            name: "other-run",
            head_sha: head,
            event: "push",
            status: "completed",
            conclusion: "success",
            html_url: secretUrl,
          },
        ],
      }),
    ]);
    const facts = await ciFacts(github, backend, "main", head);
    for (const surface of [facts.statuses, facts.checks, facts.runs]) {
      const url = (surface as Array<Record<string, unknown>>)[0]?.url;
      expect(String(url)).not.toContain("user");
      expect(String(url)).not.toContain("pass");
      expect(String(url)).not.toContain("api_key=secret");
    }
  });
});
