import { FlowError } from "./common";

export const FRESH_THREAD_DEFAULT_PROFILE = Object.freeze({
  model: "gpt-5.6-luna",
  thinking: "max",
});

const FRESH_THREAD_MAX_TITLE_CODE_POINTS = 32;

export type FreshThreadEnvironment = "local" | "worktree";

export type FreshThreadStartingState =
  | { type: "working-tree" }
  | {
      type: "branch";
      branchName: string;
      onMissing?: "error" | "create-branch";
    };

export interface FreshThreadCreateThreadInput {
  prompt: string;
  projectId: string;
  environment?: FreshThreadEnvironment;
  isGitRepository?: boolean;
  model?: string;
  thinking?: string;
  startingState?: FreshThreadStartingState;
  title: string;
}

export type FreshThreadNativeEnvironment =
  | { type: "local" }
  | { type: "worktree"; startingState?: FreshThreadStartingState };

export interface FreshThreadCreateThreadRequest {
  prompt: string;
  target: {
    type: "project";
    projectId: string;
    environment: FreshThreadNativeEnvironment;
  };
  model: string;
  thinking: string;
  title: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new FlowError(`${field} must be non-empty text`);
  return value;
}

function normalizeResolvedTitle(value: unknown): string {
  const title = requiredText(value, "title").trim().replace(/\s+/gu, " ");
  if (Array.from(title).length > FRESH_THREAD_MAX_TITLE_CODE_POINTS)
    throw new FlowError(
      `title must be ${FRESH_THREAD_MAX_TITLE_CODE_POINTS} Unicode code points or fewer`,
    );
  return title;
}

function resolveProfile(
  model: unknown,
  thinking: unknown,
): { model: string; thinking: string } {
  if (model === undefined && thinking === undefined)
    return { ...FRESH_THREAD_DEFAULT_PROFILE };
  if (model === undefined || thinking === undefined)
    throw new FlowError(
      "fresh thread profile requires the complete model and thinking pair",
    );
  return {
    model: requiredText(model, "model"),
    thinking: requiredText(thinking, "thinking"),
  };
}

function resolveStartingState(
  value: FreshThreadStartingState | undefined,
): FreshThreadStartingState | undefined {
  if (value === undefined) return undefined;
  if (value.type === "working-tree") return { type: "working-tree" };
  if (value.type !== "branch")
    throw new FlowError("startingState.type must be working-tree or branch");
  const branchName = requiredText(value.branchName, "startingState.branchName");
  if (
    value.onMissing !== undefined &&
    value.onMissing !== "error" &&
    value.onMissing !== "create-branch"
  )
    throw new FlowError(
      "startingState.onMissing must be error or create-branch",
    );
  return {
    type: "branch",
    branchName,
    ...(value.onMissing === undefined ? {} : { onMissing: value.onMissing }),
  };
}

/** Build the only native create_thread request shape used by fresh dispatch. */
export function buildFreshThreadCreateThreadRequest(
  input: FreshThreadCreateThreadInput,
): FreshThreadCreateThreadRequest {
  const prompt = requiredText(input.prompt, "prompt");
  const projectId = requiredText(input.projectId, "projectId");
  const profile = resolveProfile(input.model, input.thinking);
  const startingState = resolveStartingState(input.startingState);
  if (
    input.isGitRepository !== undefined &&
    typeof input.isGitRepository !== "boolean"
  )
    throw new FlowError("isGitRepository must be boolean");
  if (input.environment === undefined && input.isGitRepository === undefined)
    throw new FlowError(
      "isGitRepository is required when environment is omitted",
    );

  const resolvedEnvironment: FreshThreadEnvironment =
    input.environment ??
    (input.isGitRepository === false ? "local" : "worktree");

  if (resolvedEnvironment !== "local" && resolvedEnvironment !== "worktree")
    throw new FlowError("environment must be local or worktree");
  if (input.isGitRepository === false && resolvedEnvironment === "worktree")
    throw new FlowError("non-Git projects require a local environment");
  if (resolvedEnvironment === "local" && startingState !== undefined)
    throw new FlowError(
      "startingState is only valid for a worktree environment",
    );

  const nativeEnvironment: FreshThreadNativeEnvironment =
    resolvedEnvironment === "local"
      ? { type: "local" }
      : {
          type: "worktree",
          ...(startingState === undefined ? {} : { startingState }),
        };
  const title = normalizeResolvedTitle(input.title);

  return {
    prompt,
    target: { type: "project", projectId, environment: nativeEnvironment },
    ...profile,
    title,
  };
}
