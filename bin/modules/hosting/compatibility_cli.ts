import { assetUrl } from "./remote";
import { backendFor } from "./backend";
import {
  assertPullRequestResponse,
  pullRequestNumber,
  readLivePullRequestForBinding,
} from "./pull-request";
import { HostingError } from "./types";
import { detailedPullRequestFacts } from "./compatibility_pr";
import { ciFacts, rerunCi } from "./compatibility_ci";
import {
  issueCreate,
  issueFacts,
  releaseCreate,
  releaseList,
  renderMarkdownFact,
  submitReview,
  treeFacts,
} from "./compatibility_resources";
import {
  bindingForRemote,
  branchEndpointFor,
  mergeConfirmationMatches,
  mergeRequestFor,
  missingOperation,
  operationError,
  positiveNumber,
  readBody,
  readTextFile,
  requiredOption,
  requiredProviderObject,
  requiredSha,
} from "./compatibility_cli_helpers";
import { json, option, positional, rootFor } from "../../compatibility_shared";

export async function hosting(argv: string[]): Promise<number> {
  const root = rootFor(argv);
  const remote = option(argv, "remote", "origin")!,
    operation = positional(argv)[0];
  if (!operation) return missingOperation();
  try {
    const binding = bindingForRemote(root, remote);
    const backend = backendFor(binding, { cwd: root });
    if (operation === "resolve") {
      json({ schema_version: 1, operation, outcome: "ok", binding });
      return 0;
    }
    if (operation === "identity") {
      const result = await backend.request("user", { operation });
      requiredProviderObject(result.payload, operation);
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result: result.payload,
      });
      return 0;
    }
    if (operation === "asset-url") {
      const sha = requiredSha(argv, "sha", operation);
      const path = requiredOption(argv, "path", operation);
      json({ url: assetUrl(binding, sha, path), sha, path });
      return 0;
    }
    if (operation === "pr-facts") {
      const number = positiveNumber(argv, "number", operation);
      const facts = await detailedPullRequestFacts(binding, backend, number);
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result: facts,
      });
      return 0;
    }
    if (operation === "ci-facts") {
      const result = await ciFacts(
        binding,
        backend,
        requiredOption(argv, "branch", operation),
        requiredOption(argv, "sha", operation),
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "ci-rerun") {
      const result = await rerunCi(
        binding,
        backend,
        requiredOption(argv, "run-id", operation),
        requiredOption(argv, "expected-sha", operation),
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "tree-has") {
      const result = await treeFacts(
        binding,
        backend,
        requiredOption(argv, "sha", operation),
        requiredOption(argv, "path", operation),
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "render-markdown") {
      const result = await renderMarkdownFact(
        binding,
        backend,
        readTextFile(argv, "text-file", operation),
        option(argv, "context"),
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "pr-create") {
      const title = requiredOption(argv, "title", operation);
      const body = readBody(argv, operation);
      const head = requiredOption(argv, "head", operation);
      const base = requiredOption(argv, "base", operation);
      const result = await backend.request(`repos/${binding.fullName}/pulls`, {
        method: "POST",
        data: { title, body, head, base, draft: argv.includes("--draft") },
        operation,
      });
      const number = pullRequestNumber(result.payload);
      const facts = assertPullRequestResponse(
        result.payload,
        binding,
        number,
        body,
        operation,
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result: facts,
      });
      return 0;
    }
    if (operation === "pr-edit") {
      const number = positiveNumber(argv, "number", operation);
      const body = readBody(argv, operation);
      const result = await backend.request(
        `repos/${binding.fullName}/pulls/${number}`,
        { method: "PATCH", data: { body }, operation },
      );
      const facts = assertPullRequestResponse(
        result.payload,
        binding,
        number,
        body,
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result: facts,
      });
      return 0;
    }
    if (operation === "issue-get") {
      const result = await issueFacts(
        binding,
        backend,
        positiveNumber(argv, "number", operation),
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "issue-create") {
      const result = await issueCreate(
        binding,
        backend,
        requiredOption(argv, "title", operation),
        readBody(argv, operation),
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "review-submit") {
      const result = await submitReview(
        binding,
        backend,
        positiveNumber(argv, "number", operation),
        requiredOption(argv, "event", operation),
        option(argv, "body-file") ? readBody(argv, operation) : "",
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "release-list") {
      const result = await releaseList(binding, backend);
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "release-create") {
      const result = await releaseCreate(
        binding,
        backend,
        requiredOption(argv, "tag", operation),
        requiredOption(argv, "title", operation),
        readTextFile(argv, "note-file", operation),
        option(argv, "target"),
        argv.includes("--draft"),
        argv.includes("--prerelease"),
      );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result,
      });
      return 0;
    }
    if (operation === "pr-merge") {
      const number = positiveNumber(argv, "number", operation);
      const expectedBase = requiredSha(argv, "expected-base", operation);
      const expectedHead = requiredSha(argv, "expected-head", operation);
      const method = requiredOption(argv, "method", operation);
      if (!["merge", "squash", "rebase"].includes(method))
        throw new HostingError(
          "invalid_merge_method",
          "merge method is not allowed",
          operation,
        );
      const live = readLivePullRequestForBinding(root, binding, `PR#${number}`);
      if (live.facts.state !== "OPEN")
        throw new HostingError(
          "pr_not_open",
          "guarded merge requires an open PR",
          operation,
        );
      if (live.facts.base_sha !== expectedBase)
        throw new HostingError(
          "stale_base",
          "live PR base differs from expected base",
          operation,
        );
      if (live.facts.head_sha !== expectedHead)
        throw new HostingError(
          "stale_head",
          "live PR head differs from expected head",
          operation,
        );
      const merge = mergeRequestFor(binding.provider, expectedHead, method);
      await backend.request(`repos/${binding.fullName}/pulls/${number}/merge`, {
        method: merge.method,
        data: merge.data,
        operation,
      });
      const final = readLivePullRequestForBinding(
        root,
        binding,
        `PR#${number}`,
      );
      if (!mergeConfirmationMatches(live.facts, final.facts, expectedHead))
        throw new HostingError(
          "merge_unconfirmed",
          "provider did not confirm the guarded merge against the expected head and base branch",
          operation,
        );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result: {
          state: "merged",
          number,
          base_sha: final.facts.base_sha,
          base_ref: final.facts.base_ref,
          head_sha: expectedHead,
          merge_sha: final.facts.merge_sha,
        },
      });
      return 0;
    }
    if (operation === "branch-delete") {
      const branch = requiredOption(argv, "branch", operation);
      if (branch === "." || branch === ".." || branch.includes("\0"))
        throw new HostingError(
          "invalid_branch",
          "branch name is invalid",
          operation,
        );
      const endpoint = branchEndpointFor(binding, branch);
      const deleted = await backend.request(endpoint, {
        method: "DELETE",
        include: true,
        check: false,
        operation,
      });
      if (![200, 204, 404, 422].includes(deleted.status ?? -1))
        throw new HostingError(
          "branch_delete_failed",
          "provider did not accept branch deletion",
          operation,
          { status: deleted.status },
        );
      const verified = await backend.request(endpoint, {
        method: "GET",
        include: true,
        check: false,
        operation: "branch-verify",
      });
      if (verified.status !== 404)
        throw new HostingError(
          "branch_delete_verify_failed",
          "bound branch is still present or verification is unavailable",
          "branch-verify",
          { status: verified.status, delete_status: deleted.status },
        );
      json({
        schema_version: 1,
        operation,
        outcome: "ok",
        binding,
        result: {
          state:
            deleted.status === 404 || deleted.status === 422
              ? "already_absent"
              : "deleted",
          branch,
          repository: binding.fullName,
        },
      });
      return 0;
    }
    throw new HostingError(
      "unsupported_operation",
      `${operation} is not implemented by the TypeScript compatibility adapter`,
      operation,
    );
  } catch (error) {
    operationError(error);
    return 2;
  }
}
