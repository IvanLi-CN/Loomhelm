import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { checkAgentVmRoutes } from "../../modules/checks";

const root = resolve(import.meta.dir, "../../../..");

test("Agent VM migration preserves clean routes and rejects retired fixtures", () => {
  expect(checkAgentVmRoutes(root)).toEqual([]);

  const fixture = mkdtempSync(join(tmpdir(), "agent-vm-routes-"));
  mkdirSync(join(fixture, "skills"), { recursive: true });
  writeFileSync(
    join(fixture, "skills/README.md"),
    "| `agent-vm` | daily |\n| `agent-vm-ops` | operations |\n| `agent-vm` | duplicate |\n",
  );
  mkdirSync(join(fixture, "skills/shared-testbox"));
  for (const [path, value] of [
    ["nested/AGENTS.md", "$shared-testbox"],
    ["rules/example.rules", "codex-testbox"],
    ["skills/new/scripts/example.ts", "shared-testbox-bootstrap"],
    ["skills/new/scripts/a.py", "testbox-clean.sh"],
    ["docs/other/HISTORY.md", "192.168.31.15"],
  ] as const) {
    const target = join(fixture, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, value);
  }
  const findings = checkAgentVmRoutes(fixture);
  expect(findings).toEqual(
    expect.arrayContaining([
      "new Skill index count is 2: agent-vm",
      "retired Skill directory exists: shared-testbox",
    ]),
  );
  expect(
    findings.filter((item) => item.startsWith("retired active reference:")),
  ).toHaveLength(5);
});
