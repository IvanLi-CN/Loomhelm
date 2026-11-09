import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sourceLineLimit,
  sourcePolicyFailure,
  testLineLimit,
} from "./modules/core/source_policy";

const root = fileURLToPath(new URL("../../", import.meta.url));
const failures: string[] = [];
// Existing modules are intentionally tracked while their decomposition is staged.
// New files continue to use the normal physical-line limits.
const grandfathered = new Set([
  "skills/bin/tests/checks/checks.test.ts",
  "skills/bin/tests/workspace/workspace.test.ts",
  "skills/bin/modules/checks/flow.ts",
  "skills/bin/modules/plan/contract.ts",
  "skills/bin/modules/workspace/port_registry.ts",
  "skills/bin/modules/visual/secure_io.ts",
  "skills/multi-task-flow/web/app.ts",
  "skills/multi-task-flow/web/graph-projection.ts",
  "skills/multi-task-flow/lib/schema.ts",
  "skills/multi-task-flow/lib/engine.ts",
  "skills/multi-task-flow/scripts/orchestrate.ts",
  "skills/multi-task-flow/tests/engine.test.ts",
  "skills/multi-task-flow/tests/orchestrate.test.ts",
]);

async function checkFile(path: string): Promise<void> {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  if (grandfathered.has(relativePath)) return;
  const contents = await readFile(path, "utf8");
  const failure = sourcePolicyFailure(path, contents);
  if (failure) failures.push(failure);
}

async function visit(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      failures.push(
        `${path}: symbolic links are not allowed in the TypeScript source tree`,
      );
      continue;
    }
    if (entry.isDirectory()) await visit(path);
    else if (entry.name.endsWith(".ts")) await checkFile(path);
  }
}


await visit(join(root, "skills"));
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.name.endsWith(".ts")) continue;
  const path = join(root, entry.name);
  if (entry.isSymbolicLink()) {
    failures.push(
      `${path}: symbolic links are not allowed in the TypeScript source tree`,
    );
  } else if (entry.isFile()) {
    await checkFile(path);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `TypeScript physical-line policy passed (source <= ${sourceLineLimit}, tests <= ${testLineLimit}).`,
  );
}
