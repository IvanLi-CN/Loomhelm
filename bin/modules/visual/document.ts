import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import {
  activeSelectorLines,
  DocumentError,
  isTargetPath,
  migrateText,
  normalizeRelativePath,
  readDocument,
  relativePath,
  readDocumentSnapshot,
  sameDocumentSnapshot,
  sections,
  hasUnterminatedFence,
} from "./document_parse";
import { writeAtomicNoFollow } from "./secure_io";

export const CHECK_FAILED_EXIT = 20;

export function migratePath(
  root: string,
  rawPath: string,
): Record<string, unknown> {
  const normalized = relativePath(rawPath, root);
  const path = resolve(root, normalized);
  const snapshot = readDocumentSnapshot(path);
  const migrated = migrateText(snapshot.text);
  if (migrated.text !== snapshot.text) {
    if (!sameDocumentSnapshot(snapshot, readDocumentSnapshot(path)))
      throw new DocumentError("target document changed during migration");
    writeAtomicNoFollow(path, migrated.text, root);
  }
  return {
    path: normalized,
    changed: migrated.text !== snapshot.text,
    changes: migrated.changes,
  };
}

export function checkPath(
  root: string,
  rawPath: string,
): Record<string, unknown> {
  const normalized = relativePath(rawPath, root);
  const lines = readDocument(resolve(root, normalized)).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (hasUnterminatedFence(lines))
    throw new DocumentError(`${normalized}: unterminated_code_fence`);
  const found = sections(lines);
  const reasons: string[] = [];
  try {
    migrateText(lines.join("\n"));
  } catch (error) {
    if (error instanceof DocumentError) reasons.push(error.message);
  }
  if (activeSelectorLines(lines).length)
    reasons.push("retired_selector_markup_present");
  if (found.some((section) => section.kind === "legacy"))
    reasons.push("legacy_visual_evidence_heading_present");
  if (reasons.length)
    throw new DocumentError(
      `${normalized}: ${[...new Set(reasons)].sort().join(",")}`,
    );
  return { path: normalized, state: "passed" };
}

function changedTargetPaths(root: string, baseSha: string): string[] {
  const result = spawnSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", baseSha, "--"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new DocumentError(
      `unable to inspect changed paths: ${(result.stderr || result.stdout).trim()}`,
    );
  const fields = result.stdout.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++] ?? "";
    const code = status[0];
    const path =
      code === "R" || code === "C" ? fields[index + 1] : fields[index];
    index += code === "R" || code === "C" ? 2 : 1;
    if (code !== "D" && path && isTargetPath(path.trim()))
      paths.add(path.trim());
  }
  return [...paths].sort();
}

function patchPaths(command: string): string[] {
  const paths = new Set<string>();
  for (const match of command.matchAll(/^(?:\+\+\+|---)\s+([^\t\r\n]+)/gm)) {
    let path = (match[1] ?? "").trim().replace(/^"|"$/g, "");
    if (path === "/dev/null") continue;
    if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
    paths.add(path);
  }
  let pendingUpdate: string | undefined;
  for (const line of command.split(/\r?\n/)) {
    const file = /^\*\*\*\s+(Update|Add|Delete)\s+File:\s+([^\t\r\n]+)/.exec(
      line,
    );
    if (file) {
      const path = (file[2] ?? "").trim().replace(/^"|"$/g, "");
      pendingUpdate = file[1] === "Update" ? path : undefined;
      if (file[1] !== "Delete") paths.add(path);
      continue;
    }
    const move = /^\*\*\*\s+Move\s+to:\s+([^\t\r\n]+)/.exec(line);
    if (move) {
      if (pendingUpdate) paths.delete(pendingUpdate);
      paths.add((move[1] ?? "").trim().replace(/^"|"$/g, ""));
      pendingUpdate = undefined;
    }
  }
  return [...paths];
}

export function hookPaths(
  event: Record<string, unknown>,
  root: string,
): string[] {
  const paths = new Set<string>();
  const input = event.tool_input ?? event.toolInput ?? event.input;
  const collect = (value: unknown) => {
    if (typeof value === "string")
      for (const path of patchPaths(value)) paths.add(path);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const key of ["file_path", "path"])
      if (typeof record[key] === "string") paths.add(record[key] as string);
    for (const key of ["command", "patch", "input", "text"])
      collect(record[key]);
  };
  collect(input);
  for (const key of ["file_path", "path"])
    if (typeof event[key] === "string") paths.add(event[key] as string);
  const normalized = new Set<string>();
  for (const raw of paths) {
    let candidate = raw.trim();
    if (isAbsolute(candidate)) {
      const delta = relative(resolve(root), resolve(candidate));
      if (delta.startsWith("..")) continue;
      candidate = delta;
    }
    candidate = normalizeRelativePath(candidate);
    if (isTargetPath(candidate)) normalized.add(candidate);
  }
  return [...normalized].sort();
}

export function runHook(root: string, input: string): number {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return 0;
  const paths = hookPaths(payload as Record<string, unknown>, root);
  if (!paths.length) return 0;
  const results: Record<string, unknown>[] = [];
  const blockers: string[] = [];
  for (const path of paths) {
    try {
      results.push({
        migration: migratePath(root, path),
        check: checkPath(root, path),
      });
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  const context: string[] = [
    "Visual-evidence document hook inspected the edited target files.",
  ];
  const changed = results
    .map((item) => (item.migration as Record<string, unknown>).path)
    .filter(
      (path) =>
        (
          results.find(
            (item) => (item.migration as Record<string, unknown>).path === path,
          )?.migration as Record<string, unknown>
        ).changed,
    );
  if (changed.length)
    context.push(`Safe migration applied: ${changed.join(", ")}.`);
  if (results.length)
    context.push("Run the final document check before PR convergence.");
  if (blockers.length)
    context.push(
      `BLOCKER: ${blockers.join(" | ")}`,
      "Do not continue to PR convergence until the document ambiguity is resolved.",
    );
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context.join(" ") } })}\n`,
  );
  return 0;
}

export function documentMain(
  argv: string[] = process.argv.slice(2),
  input = "",
): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun visual_evidence_document.ts <migrate|check|hook> --path <path>",
    );
    return 0;
  }
  const rootIndex = argv.indexOf("--repo-root");
  const root = resolve(
    rootIndex >= 0 ? (argv[rootIndex + 1] ?? process.cwd()) : process.cwd(),
  );
  const command = argv.find((value) =>
    ["migrate", "check", "hook"].includes(value),
  );
  if (command === "hook") return runHook(root, input);
  const paths = argv
    .flatMap((value, index) =>
      value === "--path" ? [argv[index + 1] ?? ""] : [],
    )
    .filter(Boolean);
  const changedIndex = argv.indexOf("--changed-from");
  const changedFrom =
    command === "check" && changedIndex >= 0
      ? argv[changedIndex + 1]
      : undefined;
  try {
    if (changedIndex >= 0 && (!changedFrom || changedFrom.startsWith("--")))
      throw new DocumentError("--changed-from requires a base revision");
    if (changedFrom) paths.push(...changedTargetPaths(root, changedFrom));
    if (!command || !paths.length)
      throw new DocumentError(
        "at least one --path or --changed-from is required",
      );
    const results = [...new Set(paths)].map((path) =>
      command === "migrate" ? migratePath(root, path) : checkPath(root, path),
    );
    process.stdout.write(
      `${JSON.stringify({ state: "passed", results }, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return CHECK_FAILED_EXIT;
  }
}
