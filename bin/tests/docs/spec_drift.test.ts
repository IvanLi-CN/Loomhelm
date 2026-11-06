import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecDrift } from "../../modules/docs/spec_drift";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "docs-drift-"));
  temporaryRoots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Koha Test"]);
  git(root, ["config", "user.email", "koha@example.com"]);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: process.env,
  }).trim();
}

function put(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function commit(root: string, message: string): void {
  git(root, ["add", "."]);
  git(root, ["commit", "--allow-empty", "-m", message]);
}

function spec(related = "None"): string {
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

function addCompleteSpec(root: string, slug = "topic"): string {
  const specPath = `docs/specs/${slug}/SPEC.md`;
  put(root, specPath, spec());
  put(root, `docs/specs/${slug}/IMPLEMENTATION.md`, "# Implementation\n");
  put(root, `docs/specs/${slug}/HISTORY.md`, "# History\n");
  return specPath;
}

describe("Spec drift modes", () => {
  test("allows a declared spec-free implementation change", () => {
    const root = repo();
    commit(root, "baseline");
    put(root, "src/new.ts", "export const value = 0;\n");
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specFree: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.reason).toContain("spec-free run");
  });

  test("reports an implementation change without SPEC_PATHS as unchecked", () => {
    const root = repo();
    commit(root, "baseline");
    put(root, "config.yaml", "value: 1\n");
    const result = runSpecDrift({ repoRoot: root, baseRef: "HEAD" });
    expect(result.exitCode).toBe(3);
    expect(result.reason).toContain("no SPEC_PATHS");
  });

  test("accepts TOML and YAML implementation changes when the companion set is present", () => {
    const root = repo();
    commit(root, "baseline");
    const specPath = addCompleteSpec(root);
    put(root, "settings.toml", "enabled = true\n");
    put(root, "config.yaml", "enabled: true\n");
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specPaths: [specPath],
    });
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("通过");
    expect(result.evidence).toContain(specPath);
  });

  test("blocks spec-free runs that touch a Spec", () => {
    const root = repo();
    commit(root, "baseline");
    put(root, "docs/specs/topic/SPEC.md", spec());
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specFree: true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain("touched spec files");
  });

  test("validates every changed Spec when one implementation sync is requested", () => {
    const root = repo();
    put(
      root,
      "docs/adr/0001-current-decision.md",
      "---\nstatus: accepted\n---\n# ADR\n",
    );
    const primary = addCompleteSpec(root, "primary");
    const secondary = addCompleteSpec(root, "secondary");
    put(
      root,
      secondary,
      spec("- [Decision](../../adr/0001-current-decision.md)"),
    );
    commit(root, "baseline");
    put(root, "src/new.ts", "export const value = 1;\n");
    put(root, primary, spec());
    put(
      root,
      secondary,
      spec("- [Decision](../../adr/0001-current-decision.md)"),
    );
    put(
      root,
      "docs/adr/0001-current-decision.md",
      "---\nstatus: superseded\n---\n# ADR\n",
    );
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specPaths: [primary],
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain("secondary");
    expect(result.reason).toContain("superseded");
  });

  test("maps a new proven legacy plan to its canonical companion set", () => {
    const root = repo();
    put(root, "src/new.ts", "export const value = 0;\n");
    commit(root, "baseline");
    const planPath = "docs/plan/a1111-topic/PLAN.md";
    put(root, planPath, "# Legacy plan\n");
    put(
      root,
      "docs/plan/README.md",
      "| ID | Title | Plan |\n| --- | --- | --- |\n| a1111 | Topic | `a1111-topic/PLAN.md` |\n",
    );
    put(root, "src/new.ts", "export const value = 1;\n");
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specPaths: [planPath],
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe("associated spec files are missing");
    expect(result.evidence).toContain("docs/specs/topic/SPEC.md");
    expect(result.evidence).toContain("docs/specs/topic/IMPLEMENTATION.md");
    expect(result.evidence).toContain("docs/specs/topic/HISTORY.md");
  });
});

describe("staged ADR validation", () => {
  test("validates the staged Spec independently from the working tree", () => {
    const root = repo();
    const specPath = addCompleteSpec(root);
    commit(root, "baseline");
    put(root, "src/new.ts", "export const value = 1;\n");
    put(root, specPath, spec("- None"));
    git(root, ["add", specPath]);
    put(root, specPath, spec());
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specPaths: [specPath],
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain("index");
  });

  test("validates changed ADR status through a referencing Spec", () => {
    const root = repo();
    put(
      root,
      "docs/adr/0004-scope-boundaries.md",
      "---\nstatus: accepted\n---\n# ADR\n",
    );
    const specPath = addCompleteSpec(root);
    put(root, specPath, spec("- [Scope](../../adr/0004-scope-boundaries.md)"));
    commit(root, "baseline");
    put(
      root,
      "docs/adr/0004-scope-boundaries.md",
      "---\nstatus: superseded\n---\n# ADR\n",
    );
    const result = runSpecDrift({ repoRoot: root, baseRef: "HEAD" });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain("superseded");
  });

  test("freezes the candidate ADR blob and staged membership", () => {
    const root = repo();
    put(
      root,
      "docs/adr/0004-scope-boundaries.md",
      "---\nstatus: accepted\n---\n# ADR\n",
    );
    const specPath = addCompleteSpec(root, "topic");
    put(root, specPath, spec("- [Scope](../../adr/0004-scope-boundaries.md)"));
    commit(root, "baseline");
    const blob = git(root, [
      "rev-parse",
      "HEAD:docs/adr/0004-scope-boundaries.md",
    ]);
    put(root, specPath, spec("None"));
    git(root, ["add", specPath]);
    put(root, specPath, spec("- [Scope](../../adr/0004-scope-boundaries.md)"));
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specPaths: [specPath],
      env: { ADR_REFS: `docs/adr/0004-scope-boundaries.md@${blob}` },
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain("membership drifted in index");
  });

  test("rejects symlinked candidate Specs in frozen ADR refs", () => {
    const root = repo();
    const specPath = addCompleteSpec(root);
    commit(root, "baseline");
    const outside = mkdtempSync(join(tmpdir(), "docs-drift-target-"));
    temporaryRoots.push(outside);
    put(outside, "SPEC.md", spec());
    rmSync(join(root, specPath));
    symlinkSync(join(outside, "SPEC.md"), join(root, specPath), "file");
    const result = runSpecDrift({
      repoRoot: root,
      baseRef: "HEAD",
      specPaths: [specPath],
      env: { ADR_REFS: "none" },
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain("regular candidate Spec");
  });
});
