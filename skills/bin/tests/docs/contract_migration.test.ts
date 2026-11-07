import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSpec } from "../../modules/docs/spec_contract";
import { generateLegacySpecIds } from "../../modules/docs/legacy_spec_id";
import {
  planSpecsHygiene,
  planSpecsMigration,
} from "../../modules/docs/spec_migration";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "docs-contract-"));
  temporaryRoots.push(root);
  run(root, ["init", "-q"]);
  run(root, ["config", "user.name", "Koha Test"]);
  run(root, ["config", "user.email", "koha@example.com"]);
  return root;
}

function run(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function write(root: string, path: string, content: string): string {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
  return target;
}

function validSpec(related = "None"): string {
  return `# Topic

## Context and Scope

The topic owns a stable contract.

## Requirements

### REQ-TOPIC-001

The system MUST preserve the contract.

## Verification

### VER-TOPIC-001

- Method: focused test.
- covers: \`REQ-TOPIC-001\`

## Related ADRs

${related}
`;
}

describe("Spec contract", () => {
  test("accepts a complete requirement and verification trace", () => {
    const root = repo();
    write(root, "docs/adr/0004-scope-boundaries.md", "# ADR\n");
    const path = write(
      root,
      "docs/specs/topic/SPEC.md",
      validSpec("- [Scope](../../adr/0004-scope-boundaries.md)"),
    );
    expect(checkSpec(path, root)).toEqual([]);
  });

  test("rejects task-state sections, checkboxes, and missing traceability", () => {
    const root = repo();
    const path = write(
      root,
      "docs/specs/topic/SPEC.md",
      validSpec()
        .replace(
          "## Verification",
          "## Acceptance checklist\n\n- [ ] pending\n\n## Verification",
        )
        .replace("- covers: `REQ-TOPIC-001`", "- Method: focused test."),
    );
    const codes = checkSpec(path, root).map((issue) => issue.code);
    expect(codes).toContain("SPEC_FORBIDDEN_SECTION");
    expect(codes).toContain("SPEC_CHECKBOX_FORBIDDEN");
    expect(codes).toContain("SPEC_TRACEABILITY_MISSING");
  });

  test("only accepts bare None for an empty Related ADR section", () => {
    const root = repo();
    const path = write(root, "docs/specs/topic/SPEC.md", validSpec());
    expect(checkSpec(path, root)).toEqual([]);
    writeFileSync(path, validSpec("- None"), "utf8");
    expect(
      checkSpec(path, root).some(
        (issue) => issue.code === "SPEC_RELATED_ADRS_INVALID",
      ),
    ).toBe(true);
  });
});

describe("Spec migration planning", () => {
  test("maps a proven legacy plan and reports inbound links", () => {
    const root = repo();
    const source = write(
      root,
      "docs/plan/a1111-api-cleanup/PLAN.md",
      "# Cleanup\n",
    );
    write(
      root,
      "docs/guides/migration.md",
      "[Legacy plan](../plan/a1111-api-cleanup/PLAN.md)\n",
    );
    const result = planSpecsMigration(root, source, {
      branch: "feature/docs",
      legacyId: "a1111",
    });
    expect(result.topic).toBe("api-cleanup");
    expect(result.target_spec).toBe("docs/specs/api-cleanup/SPEC.md");
    expect(result.pending_delete_approval).toEqual([
      "docs/plan/a1111-api-cleanup/PLAN.md",
    ]);
    expect(result.inbound_links).toEqual(["docs/guides/migration.md"]);
  });

  test("requires a slug and confirmation before hygiene rename", () => {
    const root = repo();
    const source = write(
      root,
      "docs/specs/a1111-API Cleanup/SPEC.md",
      "# Existing\n",
    );
    write(
      root,
      "docs/specs/README.md",
      "| ID | Title | Spec |\n| --- | --- | --- |\n| a1111 | API | `a1111-API Cleanup/SPEC.md` |\n",
    );
    const blocked = planSpecsHygiene(
      root,
      join(root, "docs/specs/a1111-API Cleanup"),
      { branch: "feature/docs" },
    );
    expect(blocked.blocked_reason).toBe("topic_slug_required");
    const resolved = planSpecsHygiene(
      root,
      join(root, "docs/specs/a1111-API Cleanup"),
      { branch: "feature/docs", topic: "api-cleanup", renameConfirmed: true },
    );
    expect(resolved.action).toBe("git_mv");
    expect(resolved.target_spec).toBe("docs/specs/api-cleanup/SPEC.md");
    expect(source).toContain("a1111-API");
  });
});

describe("Legacy ID compatibility", () => {
  test("keeps generation migration-only and avoids existing IDs", () => {
    const root = repo();
    write(root, "docs/specs/abcde-topic/SPEC.md", "# Topic\n");
    write(
      root,
      "docs/specs/README.md",
      "| ID | Title | Spec |\n| --- | --- | --- |\n| 23456 | Existing | `topic/SPEC.md` |\n",
    );
    expect(generateLegacySpecIds({ repoRoot: root }).exitCode).toBe(2);
    const result = generateLegacySpecIds({
      repoRoot: root,
      legacyCompat: true,
      count: 2,
      length: 5,
      alphabet: "23456",
    });
    expect(result.exitCode).toBe(0);
    const ids = result.stdout.trim().split("\n");
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("23456");
  });
});
