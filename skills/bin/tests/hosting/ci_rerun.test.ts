import { describe, expect, test } from "bun:test";
import { rerunCi } from "../../compatibility_hosting";
import { backendFor, type HostingBackend } from "../../modules/hosting/backend";
import { bindingFromRemote } from "../../modules/hosting/remote";
import { HostingError } from "../../modules/hosting/types";
import { fakeBackend, head, response } from "./test_helpers";

describe("CI rerun adapter", () => {
  test("verifies the provider response against the expected SHA", async () => {
    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const backend = fakeBackend(gitea, [
      response({ id: 9, head_sha: head }),
      response(null),
    ]);
    await expect(rerunCi(gitea, backend, "9", head)).resolves.toMatchObject({
      run_id: 9,
      head_sha: head,
      state: "rerun_requested",
    });
    expect(backend.calls.map((call) => call.options)).toEqual([
      {
        include: true,
        requireStatus: true,
        check: false,
        operation: "ci-rerun-verify",
      },
      {
        method: "POST",
        include: true,
        requireStatus: true,
        check: false,
        operation: "ci-rerun",
      },
    ]);
    await expect(rerunCi(gitea, backend, "9", head)).rejects.toThrow(
      "rerun_already_requested",
    );

    const mismatched = fakeBackend(gitea, [
      response({ id: 11, head_sha: head }),
    ]);
    await expect(rerunCi(gitea, mismatched, "10", head)).rejects.toThrow(
      "rerun_id_mismatch",
    );
    expect(mismatched.calls.map((call) => call.endpoint)).toEqual([
      `repos/owner/demo/actions/runs/10`,
    ]);

    const failedVerification = fakeBackend(gitea, [
      response({ id: 11, head_sha: head }, 503),
    ]);
    await expect(
      rerunCi(gitea, failedVerification, "11", head),
    ).rejects.toThrow("provider_request_failed");

    const redirected = fakeBackend(gitea, [
      response({ id: 12, head_sha: head }),
      response(null, 302),
    ]);
    await expect(rerunCi(gitea, redirected, "12", head)).rejects.toThrow(
      "provider_request_failed",
    );

    const unsupported = fakeBackend(gitea, [
      response({ id: 13, head_sha: head }),
      response(null, 404),
    ]);
    await expect(rerunCi(gitea, unsupported, "13", head)).rejects.toThrow(
      "unsupported_capability",
    );

    const concurrent = fakeBackend(gitea, [
      response({ id: 14, head_sha: head }),
      response(null),
    ]);
    await expect(
      Promise.all([
        rerunCi(gitea, concurrent, "14", head),
        rerunCi(gitea, concurrent, "14", head),
      ]),
    ).resolves.toHaveLength(2);
    expect(concurrent.calls).toHaveLength(2);
  });

  test("rejects reruns without an observed HTTP status", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    let calls = 0;
    const backend = backendFor(github, {
      runner: async () => {
        calls += 1;
        return {
          exitCode: 0,
          stdout:
            calls === 1
              ? `HTTP/2.0 200 OK\n\n{"id":15,"head_sha":"${head}"}`
              : "{}",
          stderr: "",
          timedOut: false,
        };
      },
    });
    await expect(rerunCi(github, backend, "15", head)).rejects.toMatchObject({
      code: "provider_request_failed",
      details: { status: null },
    });

    const timeoutBackend = backendFor(github, {
      runner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    await expect(rerunCi(github, timeoutBackend, "16", head)).rejects.toThrow(
      "provider_request_failed",
    );
  });

  test("rejects malformed provider run identities", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({ id: true, head_sha: head }),
    ]);
    await expect(rerunCi(github, backend, "17", head)).rejects.toThrow(
      "rerun_id_mismatch",
    );
  });

  test("does not consume the claim when the mutation command is unavailable", async () => {
    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const backend = fakeBackend(gitea, [
      response({ id: 30, head_sha: head }),
      new HostingError(
        "command_unavailable",
        "provider command unavailable",
        "ci-rerun",
      ),
      response({ id: 30, head_sha: head }),
      response(null),
    ]);
    await expect(rerunCi(gitea, backend, "30", head)).rejects.toThrow(
      "command unavailable",
    );
    await expect(rerunCi(gitea, backend, "30", head)).resolves.toMatchObject({
      state: "rerun_requested",
    });
  });

  test("shares the in-flight mutation with concurrent callers", async () => {
    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const calls: Array<{ endpoint: string; options: unknown }> = [];
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const backend: HostingBackend = {
      binding: gitea,
      async request(endpoint, options = {}) {
        calls.push({ endpoint, options });
        if (endpoint.endsWith("/31"))
          return response({ id: 31, head_sha: head });
        markMutationStarted();
        await mutationRelease;
        return response(null);
      },
    };
    const first = rerunCi(gitea, backend, "31", head);
    await mutationStarted;
    const second = rerunCi(gitea, backend, "31", head);
    releaseMutation();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});
