import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { finding, type Finding } from "./replay";

const retired =
  /shared-testbox(?:-bootstrap)?(?![\w-])|codex-testbox|192\.168\.31\.15|\/srv\/codex(?:\/|\b)|testbox-(?:agent-dir|sync-worktree|status|clean|common)\.sh/i;
const historical = new Set([
  "docs/adr/0015-agent-owned-shared-testbox-workspace.md",
  "docs/specs/shared-testbox-heavy-validation/SPEC.md",
  "docs/specs/shared-testbox-heavy-validation/IMPLEMENTATION.md",
  "docs/specs/shared-testbox-heavy-validation/HISTORY.md",
]);
const literalFiles = new Set([
  "skills/bin/agent_vm_migration_check.py",
  "skills/bin/test_agent_vm_migration_check.py",
  "skills/bin/agent_vm_migration_check.ts",
  "skills/bin/test_agent_vm_migration_check.ts",
  "skills/bin/modules/checks/routes.ts",
  "skills/bin/tests/checks/agent_vm.test.ts",
]);
const suffixes = new Set([
  ".md",
  ".py",
  ".sh",
  ".ts",
  ".rules",
  ".toml",
  ".yaml",
  ".yml",
  ".json",
]);

function walk(root: string, directory = root): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if ([".git", "__pycache__", "node_modules", "dist", ".tmp"].includes(entry.name) || relative(root, path).replaceAll("\\", "/") === "skills/docs/vendor") continue;
    if (entry.isDirectory()) output.push(...walk(root, path));
    else output.push(path);
  }
  return output;
}

export function checkAgentVmRoutes(root: string): string[] {
  const findings: string[] = [];
  for (const path of walk(root)) {
    const rel = relative(root, path).replaceAll("\\", "/");
    const suffix = rel.slice(rel.lastIndexOf("."));
    if (!suffixes.has(suffix) || literalFiles.has(rel)) continue;
    const text = readFileSync(path, "utf8");
    if (historical.has(rel)) {
      if (
        !text.toLowerCase().includes("superseded") ||
        !text.includes("agent-vm")
      )
        findings.push(`historical document lacks explicit successor: ${rel}`);
      if (
        /\$shared-testbox|skills\/shared-testbox\/(?:|[^\n]*)|(?:bash|ssh|rsync)\s+[^\n]*(?:testbox|\/srv\/codex)/.test(
          text,
        )
      )
        findings.push(
          `historical document contains an operating entrypoint: ${rel}`,
        );
      continue;
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (retired.test(line))
        findings.push(`retired active reference: ${rel}:${index + 1}`);
    });
  }
  for (const name of ["shared-testbox", "shared-testbox-bootstrap"])
    if (existsSync(join(root, "skills", name)))
      findings.push(`retired Skill directory exists: ${name}`);
  const index = readFileSync(join(root, "skills/README.md"), "utf8");
  for (const name of ["agent-vm", "agent-vm-ops"]) {
    const count = [
      ...index.matchAll(new RegExp("^\\| `" + name + "` \\|", "gm")),
    ].length;
    // These Skills are supplied by the external agent-toolkit; only enforce a
    // private index row when this checkout owns the Skill or lists it locally.
    if (!existsSync(join(root, "skills", name)) && count === 0) continue;
    if (count !== 1)
      findings.push(`new Skill index count is ${count}: ${name}`);
  }
  return findings;
}
