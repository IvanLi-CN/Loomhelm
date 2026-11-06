import { expect, test } from "bun:test";
import {
  FRESH_THREAD_DEFAULT_PROFILE,
  buildFreshThreadCreateThreadRequest,
} from "../../modules/flow/fresh-thread-dispatch";

test("fresh dispatch materializes the default profile and native target shape", () => {
  expect(
    buildFreshThreadCreateThreadRequest({
      prompt: "Implement the bounded task",
      projectId: "dot-codex",
      environment: "worktree",
      title: "Implement the bounded task",
    }),
  ).toEqual({
    prompt: "Implement the bounded task",
    target: {
      type: "project",
      projectId: "dot-codex",
      environment: { type: "worktree" },
    },
    model: "gpt-5.6-luna",
    thinking: "max",
    title: "Implement the bounded task",
  });
  expect(FRESH_THREAD_DEFAULT_PROFILE).toEqual({
    model: "gpt-5.6-luna",
    thinking: "max",
  });
});

test("fresh dispatch forwards an explicit profile and requested branch state", () => {
  expect(
    buildFreshThreadCreateThreadRequest({
      prompt: "Use the owner-selected profile",
      projectId: "dot-codex",
      environment: "worktree",
      model: "owner-model",
      thinking: "owner-thinking",
      startingState: {
        type: "branch",
        branchName: "th/owner-branch",
        onMissing: "create-branch",
      },
      title: "  Owner   task\n",
    }),
  ).toEqual({
    prompt: "Use the owner-selected profile",
    target: {
      type: "project",
      projectId: "dot-codex",
      environment: {
        type: "worktree",
        startingState: {
          type: "branch",
          branchName: "th/owner-branch",
          onMissing: "create-branch",
        },
      },
    },
    model: "owner-model",
    thinking: "owner-thinking",
    title: "Owner task",
  });
});

test("fresh dispatch requires a resolved title and validates its bounds", () => {
  expect(() =>
    buildFreshThreadCreateThreadRequest({
      prompt: "Missing title",
      projectId: "dot-codex",
      environment: "local",
    } as unknown as Parameters<typeof buildFreshThreadCreateThreadRequest>[0]),
  ).toThrow("title must be non-empty text");

  expect(() =>
    buildFreshThreadCreateThreadRequest({
      prompt: "Blank title",
      projectId: "dot-codex",
      environment: "local",
      title: " \n\t ",
    }),
  ).toThrow("title must be non-empty text");

  expect(() =>
    buildFreshThreadCreateThreadRequest({
      prompt: "Overlong title",
      projectId: "dot-codex",
      environment: "local",
      title: "😀".repeat(33),
    }),
  ).toThrow("32 Unicode code points or fewer");

  expect(
    buildFreshThreadCreateThreadRequest({
      prompt: "Boundary title",
      projectId: "dot-codex",
      environment: "local",
      title: "😀".repeat(32),
    }).title,
  ).toBe("😀".repeat(32));
});

test("fresh dispatch forwards a resolved title without parsing the prompt", () => {
  const request = buildFreshThreadCreateThreadRequest({
    prompt:
      "Goal: derive from this prompt\nSkill: /skills/fresh-thread-dispatch\nURL: https://example.test/task",
    projectId: "dot-codex",
    environment: "local",
    title: "  Resolved   title  ",
  });

  expect(request.title).toBe("Resolved title");
});

test("fresh dispatch keeps ledger metadata out of native arguments", () => {
  const request = buildFreshThreadCreateThreadRequest({
    prompt: "Keep metadata local",
    projectId: "dot-codex",
    environment: "local",
    title: "Keep metadata local",
  });

  expect(request).not.toHaveProperty("task_id");
  expect(request).not.toHaveProperty("dispatch_operation_id");
  expect(request.target).not.toHaveProperty("dispatch_operation_id");
});

test("fresh dispatch defaults an unstated Git project to a worktree", () => {
  expect(
    buildFreshThreadCreateThreadRequest({
      prompt: "Use the Git project default",
      projectId: "dot-codex",
      isGitRepository: true,
      title: "Use the Git project default",
    }),
  ).toMatchObject({
    target: {
      environment: { type: "worktree" },
    },
  });
});

test("fresh dispatch honors an explicit Git worktree environment", () => {
  expect(
    buildFreshThreadCreateThreadRequest({
      prompt: "Use the explicit Git project fact",
      projectId: "dot-codex",
      isGitRepository: true,
      environment: "worktree",
      title: "Explicit Git worktree",
    }),
  ).toMatchObject({
    target: {
      environment: { type: "worktree" },
    },
  });
});

test("fresh dispatch defaults an unstated non-Git project to local", () => {
  expect(
    buildFreshThreadCreateThreadRequest({
      prompt: "Use the non-Git project default",
      projectId: "external-project",
      isGitRepository: false,
      title: "Use the non-Git project default",
    }),
  ).toMatchObject({
    target: {
      environment: { type: "local" },
    },
  });
  expect(() =>
    buildFreshThreadCreateThreadRequest({
      prompt: "Reject a non-Git worktree request",
      projectId: "external-project",
      isGitRepository: false,
      environment: "worktree",
      title: "Reject a non-Git worktree request",
    }),
  ).toThrow("require a local environment");
});

test("fresh dispatch rejects partial profiles and invalid environment state", () => {
  expect(() =>
    buildFreshThreadCreateThreadRequest({
      prompt: "Resolve project metadata first",
      projectId: "unknown-project",
      title: "Resolve project metadata first",
    }),
  ).toThrow("isGitRepository is required when environment is omitted");
  expect(() =>
    buildFreshThreadCreateThreadRequest({
      prompt: "Missing thinking",
      projectId: "dot-codex",
      environment: "worktree",
      model: "owner-model",
      title: "Missing thinking",
    }),
  ).toThrow("complete model and thinking pair");

  expect(() =>
    buildFreshThreadCreateThreadRequest({
      prompt: "Local cannot carry worktree state",
      projectId: "dot-codex",
      environment: "local",
      startingState: { type: "working-tree" },
      title: "Local cannot carry worktree state",
    }),
  ).toThrow("only valid for a worktree environment");
});
