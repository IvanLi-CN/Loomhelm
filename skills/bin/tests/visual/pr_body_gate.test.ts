import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bindingFromRemote } from "../../modules/hosting/remote";
import type { HostingBackend } from "../../modules/hosting/backend";
import type { PullRequest } from "../../modules/visual/pr_body_gate_provider";
import { treeHas } from "../../modules/visual/pr_body_gate_tree";
import { evaluateContractCase } from "../../modules/visual/pr_body_gate_contract";
import {
  parseManaged,
  renderSection,
  replaceManaged,
} from "../../modules/visual/pr_body_gate_markdown";
import {
  bodyUpdateRequest,
  PullRequestUpdateError,
} from "../../modules/visual/pr_body_gate_update";

test("PR body image gate replays both managed-section phases", () => {
  const cases = JSON.parse(
    readFileSync(
      resolve("skills/ui-visual-evidence/replay/cases.json"),
      "utf8",
    ),
  ) as Array<Record<string, unknown>>;
  expect(cases.map((item) => evaluateContractCase(item).ok)).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
});

test("PR body Phase B parses fork URLs before rebinding to the base merge", () => {
  const head = bindingFromRemote("https://github.com/fork/demo.git", "origin");
  const base = bindingFromRemote("https://github.com/base/demo.git", "origin");
  const images = [{ path: "captures/view.png", alt: "view" }];
  const headBody = renderSection(images, head, "feature");
  expect(parseManaged(headBody, head, "feature").state).toBe("selected");
  expect(parseManaged(headBody, base, "feature").state).toBe("blocked");
  const merge = "a".repeat(40);
  const mergedBody = replaceManaged(
    headBody,
    renderSection(images, base, merge),
  );
  expect(parseManaged(mergedBody, base, merge).state).toBe("selected");
});

test("PR body tree checks fall back to the bound remote merge tree", async () => {
  const binding = bindingFromRemote("git@github.com:owner/demo.git", "origin");
  const sha = "c".repeat(40);
  const calls: string[] = [];
  const backend: HostingBackend = {
    binding,
    async request(endpoint) {
      calls.push(endpoint);
      return {
        status: 200,
        payload: {
          truncated: false,
          tree: [{ path: "captures/view.png", type: "blob" }],
        },
        exitCode: 0,
        observedAt: "2026-10-31T00:00:00.000Z",
      };
    },
  };
  await expect(
    treeHas("/tmp", binding, sha, "captures/view.png", backend),
  ).resolves.toBe(true);
  expect(calls).toEqual([`repos/owner/demo/git/trees/${sha}?recursive=true`]);
});

test("PR body updates use provider-compatible concurrency boundaries", () => {
  const github = bindingFromRemote("git@github.com:owner/demo.git", "origin");
  const gitea = bindingFromRemote("git@git.ivanli.cc:owner/demo.git", "origin");
  const current: PullRequest = {
    number: 1,
    state: "OPEN",
    body: "before",
    url: "https://git.ivanli.cc/owner/demo/pulls/1",
    base_sha: "a".repeat(40),
    base_ref: "main",
    base_repository: "owner/demo",
    head_sha: "b".repeat(40),
    head_ref: "feature",
    merge_sha: "",
    head_repository: "owner/demo",
    etag: '"v1"',
    content_version: 7,
  };
  expect(bodyUpdateRequest(github, current, "after")).toEqual({
    data: { body: "after" },
  });
  expect(bodyUpdateRequest(gitea, current, "after")).toEqual({
    data: { body: "after", content_version: 7 },
  });
  const missingVersion = { ...current };
  delete missingVersion.content_version;
  expect(() => bodyUpdateRequest(gitea, missingVersion, "after")).toThrow(
    "pr_body_update_requires_provider_content_version",
  );
  const missingEtag = { ...current };
  delete missingEtag.etag;
  expect(bodyUpdateRequest(github, missingEtag, "after")).toEqual({
    data: { body: "after" },
  });
});
