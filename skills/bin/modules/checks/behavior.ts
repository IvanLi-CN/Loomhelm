import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "route",
    "stop",
    "confirmation",
    "research",
    "visual",
    "forbidden",
  ],
} as const;

export const relevantSkills: Record<string, readonly string[]> = {
  "normal-local": ["normal-flow", "project-engineering-workflow"],
  "fast-pr": ["fast-flow", "project-engineering-workflow"],
  "local-merge": ["local-merge-flow", "project-engineering-workflow"],
  "generic-continue": ["flow-continue"],
  "remote-change": ["git-remote-troubleshoot"],
  "ui-evidence": ["ui-visual-evidence"],
  "non-ui": ["project-engineering-workflow"],
  "latest-fact": [],
  "stable-local-fact": [],
  "legacy-migration": ["docs-migrate"],
  "fresh-thread-default": ["fresh-thread-dispatch"],
  "fresh-thread-local": ["fresh-thread-dispatch"],
  "fresh-thread-parent-continues": ["fresh-thread-dispatch"],
};

export const routes = [
  "normal-flow",
  "fast-flow",
  "local-merge-flow",
  "flow-continue",
  "git-remote-troubleshoot",
  "ui-visual-evidence",
  "project-engineering-workflow",
  "research",
  "local-inspection",
  "docs-migrate",
  "fresh-thread-dispatch",
] as const;
export const stops = [
  "local-can-open-pr",
  "step-5c-ready",
  "step-5l-ready",
  "resume-first-gate",
  "blocked-for-confirmation",
  "visual-evidence-gate",
  "next-applicable-gate",
  "research-before-answer",
  "answer",
  "migration-validation",
  "fresh-task-created",
  "parent-scope-continues",
] as const;

export interface BehaviorExpectation {
  route: string;
  stop: string;
  confirmation: boolean;
  research: boolean;
  visual: boolean;
  forbidden: string[];
  allowed?: string[];
}

export function score(
  expected: BehaviorExpectation,
  actual: Partial<BehaviorExpectation>,
): string[] {
  const errors: string[] = [];
  for (const field of [
    "route",
    "stop",
    "confirmation",
    "research",
    "visual",
  ] as const)
    if (actual[field] !== expected[field])
      errors.push(
        `${field}: expected=${JSON.stringify(expected[field])} actual=${JSON.stringify(actual[field])}`,
      );
  const expectedForbidden = new Set(expected.forbidden);
  const allowed = new Set(expected.allowed ?? []);
  const actualForbidden = new Set(actual.forbidden ?? []);
  const missing = [...expectedForbidden]
    .filter((value) => !actualForbidden.has(value))
    .sort();
  const unexpected = [...actualForbidden]
    .filter((value) => !expectedForbidden.has(value))
    .sort();
  const disallowed = [...allowed]
    .filter((value) => actualForbidden.has(value))
    .sort();
  if (missing.length || unexpected.length || disallowed.length)
    errors.push(
      `forbidden: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)} allowed_but_forbidden=${JSON.stringify(disallowed)} actual=${JSON.stringify([...actualForbidden].sort())}`,
    );
  return errors;
}

export function instructionText(
  root: string,
  relative: string,
  ref?: string,
): string {
  if (!ref) return readFileSync(join(root, relative), "utf8");
  return execFileSync("git", ["show", `${ref}:${relative}`], {
    cwd: root,
    encoding: "utf8",
  });
}

export function suiteDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
