import { describe, expect, test } from "bun:test";
import { backendFor } from "../../modules/hosting/backend";
import {
  assetUrl,
  bindingFromRemote,
  parseGitRemote,
} from "../../modules/hosting/remote";
import { HostingError } from "../../modules/hosting/types";
import { redactProviderValue } from "../../modules/hosting/redact";
import { positional } from "../../compatibility_shared";
import { fakeBackend, head, response } from "./test_helpers";
import {
  branchEndpointFor,
  detailedPullRequestFacts,
  mergeRequestFor,
  requiredProviderObject,
  renderMarkdownFact,
  treeFacts,
} from "../../compatibility_hosting";
import {
  assertPullRequestResponse,
  normalizePullRequestFacts,
} from "../../modules/hosting/pull-request";

describe("hosting identity adapters", () => {
  test("hosting operation parsing skips the selected remote value", () => {
    expect(
      positional([
        "--remote",
        "base",
        "pr-merge",
        "--number",
        "210",
        "--expected-base",
        head,
        "--expected-head",
        head,
      ]),
    ).toEqual(["pr-merge"]);
  });

  test("supported remote forms resolve to one canonical identity", () => {
    for (const raw of [
      "git@git.ivanli.cc:owner/demo.git",
      "ssh://git@git.ivanli.cc/owner/demo.git",
      "https://git.ivanli.cc/owner/demo.git",
    ])
      expect(parseGitRemote(raw)).toEqual(["git.ivanli.cc", "owner", "demo"]);
  });

  test("provider PR identity mismatch fails closed", () => {
    const binding = bindingFromRemote(
      "git@github.com:owner/demo.git",
      "origin",
    );
    const payload = {
      number: 1,
      html_url: "https://github.com/owner/demo/pull/1",
      state: "open",
      body: "body",
      base: {
        ref: "main",
        sha: "a".repeat(40),
        repo: { full_name: "owner/demo" },
      },
      head: {
        ref: "feature",
        sha: "b".repeat(40),
        repo: { full_name: "owner/demo" },
      },
    };
    expect(normalizePullRequestFacts(payload, binding, 1)).toMatchObject({
      number: 1,
      base_repository: "owner/demo",
      head_repository: "owner/demo",
    });
    expect(() =>
      normalizePullRequestFacts({ ...payload, number: 2 }, binding, 1),
    ).toThrow(HostingError);
    expect(() =>
      normalizePullRequestFacts(
        {
          ...payload,
          base: { ...payload.base, repo: { full_name: "other/demo" } },
        },
        binding,
        1,
      ),
    ).toThrow(HostingError);
    expect(() =>
      normalizePullRequestFacts(
        { ...payload, html_url: "https://github.com/other/demo/pull/1" },
        binding,
        1,
      ),
    ).toThrow(HostingError);
    expect(() => assertPullRequestResponse({}, binding, 1, "body")).toThrow(
      HostingError,
    );
    expect(() =>
      assertPullRequestResponse(
        { ...payload, body: "other" },
        binding,
        1,
        "body",
      ),
    ).toThrow(HostingError);
  });

  test("PR facts retain mergeability and related review diagnostics", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const backend = fakeBackend(github, [
      response({
        number: 1,
        html_url: "https://github.com/owner/demo/pulls/1",
        state: "open",
        body: "body",
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        base: {
          ref: "main",
          sha: "b".repeat(40),
          repo: { full_name: "owner/demo" },
        },
        head: {
          ref: "feature",
          sha: head,
          repo: { full_name: "owner/demo" },
        },
      }),
      response([{ id: 2, state: "APPROVED" }]),
      response([{ id: 3, body: "comment" }]),
    ]);
    await expect(
      detailedPullRequestFacts(github, backend, 1),
    ).resolves.toMatchObject({
      body: "body",
      mergeable: true,
      merge_state: "clean",
      reviews: [{ id: 2, state: "APPROVED" }],
      comments: [{ id: 3, body: "comment" }],
    });
  });

  test("Gitea PR fields bind facts to the selected repository", () => {
    const binding = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const payload = {
      number: 1,
      html_url: "https://git.ivanli.cc/owner/demo/pulls/1",
      state: "closed",
      merged: true,
      merge_commit_sha: "c".repeat(40),
      body: "body",
      base: {
        ref: "main",
        sha: "a".repeat(40),
        repo: { html_url: "https://git.ivanli.cc/owner/demo" },
      },
      head: {
        ref: "feature",
        sha: "b".repeat(40),
        repo: { url: "https://git.ivanli.cc/api/v1/repos/owner/demo" },
      },
    };
    expect(normalizePullRequestFacts(payload, binding, 1)).toMatchObject({
      base_repository: "owner/demo",
      head_repository: "owner/demo",
      state: "MERGED",
      merge_sha: "c".repeat(40),
    });
  });

  test("provider identity requires one stable login field", () => {
    expect(() => requiredProviderObject({}, "identity")).toThrow(HostingError);
    expect(() =>
      requiredProviderObject(
        { login: "owner", username: "different" },
        "identity",
      ),
    ).toThrow(HostingError);
    expect(requiredProviderObject({ login: "owner" }, "identity")).toEqual({
      login: "owner",
    });
  });

  test("merge and branch cleanup commands use provider semantics", () => {
    expect(mergeRequestFor("github", head, "squash")).toEqual({
      method: "PUT",
      data: { sha: head, merge_method: "squash" },
    });
    expect(mergeRequestFor("gitea", head, "rebase")).toEqual({
      method: "POST",
      data: { head_commit_id: head, do: "rebase" },
    });
    expect(
      branchEndpointFor(
        bindingFromRemote("git@github.com:owner/demo.git", "origin"),
        "feature/topic",
      ),
    ).toBe("repos/owner/demo/git/refs/heads/feature%2Ftopic");
    expect(
      branchEndpointFor(
        bindingFromRemote("git@git.ivanli.cc:owner/demo.git", "origin"),
        "feature/topic",
      ),
    ).toBe("repos/owner/demo/branches/feature%2Ftopic");
  });

  test("tree and Markdown operations stay repository-bound", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    const treeBackend = fakeBackend(github, [
      response({
        truncated: false,
        tree: [{ path: "docs/readme.md", type: "blob" }],
      }),
    ]);
    await expect(
      treeFacts(github, treeBackend, head, "docs/readme.md"),
    ).resolves.toMatchObject({ exists: true, sha: head });
    const markdownBackend = fakeBackend(github, [
      response({ html: "<p>ok</p>" }),
    ]);
    await expect(
      renderMarkdownFact(github, markdownBackend, "**ok**", "owner/demo"),
    ).resolves.toMatchObject({ html: "<p>ok</p>" });
    expect(markdownBackend.calls[0]?.options).toMatchObject({
      method: "POST",
      data: { text: "**ok**", mode: "gfm", context: "owner/demo" },
    });
  });

  test("unknown hosts and encoded separators fail closed", () => {
    expect(() =>
      bindingFromRemote("https://example.invalid/owner/demo.git", "origin"),
    ).toThrow(HostingError);
    expect(() =>
      parseGitRemote("https://git.ivanli.cc/owner%2Ffork/demo.git"),
    ).toThrow("invalid_repository");
    for (const raw of [
      "https://github.com/owner%3Fignored/repo.git",
      "https://github.com/owner%23ignored/repo.git",
      "https://github.com/owner/repo%3Fignored.git",
      "https://github.com/owner/repo%23ignored.git",
      "https://github.com/owner/repo%252Fother.git",
    ]) {
      expect(() => parseGitRemote(raw)).toThrow("invalid_repository");
    }
    for (const host of ["constructor", "toString", "__proto__"]) {
      expect(() =>
        bindingFromRemote(`https://${host}/owner/demo.git`, "origin"),
      ).toThrow("unsupported_host");
    }
  });

  test("asset URLs are provider-specific and pinned to a revision", () => {
    expect(
      assetUrl(
        bindingFromRemote("git@github.com:owner/demo.git", "origin"),
        head,
        "captures/screen.png",
      ),
    ).toBe(
      `https://github.com/owner/demo/blob/${head}/captures/screen.png?raw=1`,
    );
    expect(
      assetUrl(
        bindingFromRemote("git@git.ivanli.cc:owner/demo.git", "origin"),
        head,
        "captures/screen.png",
      ),
    ).toBe(`https://git.ivanli.cc/owner/demo/raw/${head}/captures/screen.png`);
  });

  test("provider evidence redacts secret fields and URL credentials", () => {
    const safe = redactProviderValue({
      token: "secret",
      url: "https://user:secret@example.test/x?access_token=secret&api_key=secret&ok=1",
      nested: "https://user:secret@example.test/private?token=secret",
    }) as Record<string, string>;
    expect(safe.token).toBe("[REDACTED]");
    expect(safe.url).not.toContain("secret");
    expect(safe.url).not.toContain("user:");
    expect(safe.nested).not.toContain("secret");
  });

  test("provider commands stay repository-bound and forward JSON bodies", async () => {
    const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
    let githubCall:
      { command: string; args: string[]; stdin?: string } | undefined;
    const githubBackend = backendFor(github, {
      runner: async (request) => {
        githubCall = request;
        return {
          exitCode: 0,
          stdout: '{"number":1}',
          stderr: "",
          timedOut: false,
        };
      },
    });
    await githubBackend.request("repos/owner/demo/pulls", {
      method: "POST",
      data: { title: "task" },
      include: true,
    });
    expect(githubCall?.command).toBe("gh");
    expect(githubCall?.args).toEqual([
      "api",
      "repos/owner/demo/pulls",
      "--method",
      "POST",
      "--include",
      "--input",
      "-",
    ]);
    expect(githubCall?.stdin).toBe('{"title":"task"}');

    const gitea = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "gitea",
    );
    let giteaCall: { command: string; args: string[] } | undefined;
    await backendFor(gitea, {
      runner: async (request) => {
        giteaCall = request;
        return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
      },
    }).request("repos/owner/demo/issues", {
      method: "POST",
      data: { title: "task" },
    });
    expect(giteaCall?.args).toContain("--data");
    expect(giteaCall?.args).toContain("@-");
    expect(giteaCall?.args).toContain("--remote");
  });

  test("provider headers and response ETags support conditional requests", async () => {
    let call: { args: string[] } | undefined;
    const response = await backendFor(
      bindingFromRemote("git@github.com:owner/demo.git", "origin"),
      {
        runner: async (request) => {
          call = request;
          return {
            exitCode: 0,
            stdout: 'HTTP/1.1 200 OK\nETag: "v1"\n\n{"number":1}',
            stderr: "",
            timedOut: false,
          };
        },
      },
    ).request("repos/owner/demo/pulls/1", {
      include: true,
      headers: { "If-Match": '"v0"' },
    });
    expect(response.etag).toBe('"v1"');
    expect(call?.args).toContain("--header");
    expect(call?.args).toContain('If-Match: "v0"');
  });

  test("included provider responses retain HTTP status for CI observations", async () => {
    const backend = backendFor(
      bindingFromRemote("git@github.com:owner/demo.git", "origin"),
      {
        runner: async () => ({
          exitCode: 1,
          stdout:
            'HTTP/2.0 429 Too Many Requests\n\n{"message":"rate limited"}',
          stderr: "",
          timedOut: false,
        }),
      },
    );
    await expect(
      backend.request("repos/owner/demo/commits/a/status", {
        include: true,
        check: false,
        operation: "ci-status",
      }),
    ).resolves.toMatchObject({
      status: 429,
      payload: { message: "rate limited" },
    });
  });

  test("Markdown requests preserve raw HTML provider responses", async () => {
    const binding = bindingFromRemote(
      "git@github.com:owner/demo.git",
      "origin",
    );
    const backend = backendFor(binding, {
      runner: async () => ({
        exitCode: 0,
        stdout: "<p>rendered</p>",
        stderr: "",
        timedOut: false,
      }),
    });
    await expect(
      renderMarkdownFact(binding, backend, "**rendered**", "owner/demo"),
    ).resolves.toMatchObject({ html: "<p>rendered</p>" });
  });

  test("provider endpoint cannot escape the bound repository", async () => {
    const backend = backendFor(
      bindingFromRemote("git@github.com:owner/demo.git", "origin"),
    );
    await expect(backend.request("repos/other/repo/pulls")).rejects.toThrow(
      "invalid_endpoint",
    );
    await expect(
      backend.request("repos/owner/demo/%2e%2e/other/pulls"),
    ).rejects.toThrow("invalid_endpoint");
    await expect(
      backend.request("repos/owner/demo/pulls%2F..%2F..%2Fother/pulls", {
        method: "POST",
      }),
    ).rejects.toThrow("invalid_endpoint");
  });

  test("repository-bound branch endpoints accept encoded slash refs", async () => {
    let endpoint = "";
    const binding = bindingFromRemote(
      "git@git.ivanli.cc:owner/demo.git",
      "origin",
    );
    const backend = backendFor(binding, {
      runner: async (request) => {
        endpoint = request.args.at(-1) ?? "";
        return {
          exitCode: 0,
          stdout: "HTTP/1.1 204 No Content\n\n",
          stderr: "",
          timedOut: false,
        };
      },
    });
    await backend.request(branchEndpointFor(binding, "feature/topic"), {
      method: "DELETE",
      include: true,
      check: false,
    });
    expect(endpoint).toBe("repos/owner/demo/branches/feature%2Ftopic");
    await expect(
      backend.request("repos/owner/demo/branches/feature%2F..%2Fmain"),
    ).rejects.toThrow("invalid_endpoint");
  });

  test("GitHub protected branch endpoints accept encoded slash refs", async () => {
    let endpoint = "";
    const binding = bindingFromRemote(
      "git@github.com:owner/demo.git",
      "origin",
    );
    const backend = backendFor(binding, {
      runner: async (request) => {
        endpoint = request.args[1] ?? "";
        return {
          exitCode: 0,
          stdout: '{"contexts":[]}',
          stderr: "",
          timedOut: false,
        };
      },
    });
    await expect(
      backend.request(
        "repos/owner/demo/branches/feature%2Ftopic/protection/required_status_checks",
        { include: true, check: false, operation: "ci-protection" },
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(endpoint).toBe(
      "repos/owner/demo/branches/feature%2Ftopic/protection/required_status_checks",
    );
  });

  test("checked provider requests reject a timed out runner", async () => {
    const backend = backendFor(
      bindingFromRemote("git@github.com:owner/demo.git", "origin"),
      {
        runner: async () => ({
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          timedOut: true,
        }),
      },
    );
    await expect(
      backend.request("repos/owner/demo/pulls", {
        method: "POST",
        check: false,
      }),
    ).rejects.toMatchObject({ code: "provider_request_failed" });
  });

  test("provider responses preserve facts without exposing credentials", async () => {
    const response = await backendFor(
      bindingFromRemote("git@github.com:owner/demo.git", "origin"),
      {
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            token: "secret-token",
            title: "task",
            html_url:
              "https://user:password@example.test/pull/1?api_key=secret-key",
          }),
          stderr: "",
          timedOut: false,
        }),
      },
    ).request("repos/owner/demo/pulls");
    expect(response.payload).toEqual({
      token: "[REDACTED]",
      title: "task",
      html_url: "https://example.test/pull/1?api_key=%5BREDACTED%5D",
    });
    expect(response).not.toHaveProperty("stdout");
    expect(response).not.toHaveProperty("stderr");
  });

  test("provider responses do not expose unparsable output", async () => {
    const response = await backendFor(
      bindingFromRemote("git@github.com:owner/demo.git", "origin"),
      {
        runner: async () => ({
          exitCode: 0,
          stdout:
            "HTTP/1.1 200 OK\r\nSet-Cookie: session=secret\r\n\r\nnot-json",
          stderr: "",
          timedOut: false,
        }),
      },
    ).request("repos/owner/demo/pulls");
    expect(response.payload).toBeNull();
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  test("provider startup errors use a stable safe error", async () => {
    const backend = backendFor(
      bindingFromRemote("git@github.com:owner/demo.git", "origin"),
      {
        runner: async () => {
          throw new Error("ENOENT /private/path/gh");
        },
      },
    );
    await expect(
      backend.request("repos/owner/demo/pulls", { operation: "list_pulls" }),
    ).rejects.toMatchObject({
      code: "command_unavailable",
      message: "command_unavailable: provider command is unavailable",
      operation: "list_pulls",
    });
  });
});
