import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const read = (relative: string): string =>
  readFileSync(resolve(root, relative), "utf8");

test("fresh-thread default selects worktree without owner clarification", () => {
  const skill = read("skills/fresh-thread-dispatch/SKILL.md");
  const envelope = read(
    "skills/fresh-thread-dispatch/references/handoff-envelope.md",
  );
  const spec = read("docs/vendor/dot-codex/specs/fresh-thread-dispatch/SPEC.md");

  expect(skill).toContain(
    "If unstated, use `worktree` for a Git project and `local` otherwise.",
  );
  expect(skill).not.toContain(
    "ask the owner to explicitly choose an environment for an unstated Git project",
  );
  expect(envelope).toContain(
    "| no environment stated, Git project | `worktree` |",
  );
  expect(spec).toContain(
    "When the environment is unstated, it MUST use `worktree` for a Git project and `local` otherwise.",
  );
  expect(spec).not.toContain("Naming the Skill alone MUST NOT");
});

test("fresh-thread title resolution stays intent-scoped and explicit", () => {
  const skill = read("skills/fresh-thread-dispatch/SKILL.md");
  const envelope = read(
    "skills/fresh-thread-dispatch/references/handoff-envelope.md",
  );
  const spec = read("docs/vendor/dot-codex/specs/fresh-thread-dispatch/SPEC.md");
  const implementation = read(
    "docs/vendor/dot-codex/specs/fresh-thread-dispatch/IMPLEMENTATION.md",
  );

  expect(skill).toContain(
    "Resolve the task title before composing the handoff prompt",
  );
  expect(skill).toContain(
    "derive the title only from the transferred task intent",
  );
  expect(skill).toContain("action + subject + decision boundary");
  expect(skill).toContain("no more than 24 Unicode code points");
  expect(skill).toContain("`移交任务`");
  expect(skill).toContain(
    "Do not derive a title from the complete handoff prompt",
  );
  expect(skill).toContain(
    "Always pass the resolved title as native `create_thread.title`",
  );
  expect(skill).not.toContain("when no title was provided, omit the field");
  expect(envelope).toContain(
    "always pass the resolved title as native `title`",
  );
  expect(envelope).not.toContain(
    "when absent, omit it rather than inferring one",
  );
  expect(spec).toMatch(
    /The native request MUST always include the resolved title as `title`; it MUST NOT be omitted or inferred by the platform\./,
  );
  expect(spec).not.toContain("when absent,\n  the field MUST be omitted");
  expect(implementation).toMatch(/requires a\s+resolved task title/);
});
