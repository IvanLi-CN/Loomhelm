import { recoverImport } from "../lib/service-import-recovery";
import { existsSync, lstatSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LedgerStore,
  ensureDirectory,
  readRegular,
  safeId,
  withExclusiveLock,
  writeAtomic,
  syncDirectory,
} from "../lib/store";
import {
  readRegularNoFollow,
  writeExclusiveNoFollow,
  renameNoReplace,
} from "../../bin/modules/visual/secure_io";
import { identity } from "../../bin/modules/visual/isolation";
import { requireLedgerCompatibility } from "../lib/service-contract";
import { validateLedger } from "../lib/schema";
import { requireCondition } from "../lib/errors";
import { digest } from "../lib/service-release";
import type { ServiceState } from "../lib/service-state";

function files(root: string, directory = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    requireCondition(
      !entry.isSymbolicLink(),
      "UNSAFE_IMPORT",
      "Import cannot contain symlinks",
    );
    if (entry.isDirectory()) result.push(...files(root, path));
    else {
      requireCondition(
        entry.isFile(),
        "UNSAFE_IMPORT",
        "Import requires regular files",
      );
      result.push(path.slice(root.length + 1));
    }
  }
  return result.sort();
}
function contentDigest(root: string): string {
  return digest(
    JSON.stringify(
      files(root)
        .filter((path) => !path.startsWith("locks/"))
        .map((path) => [
          path,
          digest(readRegularNoFollow(join(root, path), root)),
        ]),
    ),
  );
}

export function importRun(
  state: ServiceState,
  sourceRoot: string,
  runId: string,
  onStage?: (stage: string) => void,
) {
  safeId(runId);
  sourceRoot = resolve(sourceRoot);
  requireCondition(
    sourceRoot !== state.paths.data && sourceRoot !== "/",
    "INVALID_SOURCE",
    "Import requires a distinct exact data root",
  );
  state.initialize();
  requireCondition(
    existsSync(sourceRoot) &&
      lstatSync(sourceRoot).isDirectory() &&
      !lstatSync(sourceRoot).isSymbolicLink(),
    "INVALID_SOURCE",
    "Source root must already exist as a directory",
  );
  const source = new LedgerStore(sourceRoot, runId);
  const target = new LedgerStore(state.paths.data, runId);
  const marker = join(source.runPath, "migrated.json");
  const url = `http://127.0.0.1:${state.config().port}/runs/${runId}/`;
  const recovered = recoverImport(state, sourceRoot, runId, contentDigest);
  if (recovered)
    return {
      run_id: runId,
      url,
      backup: recovered,
      already_imported: true,
      recovered: true,
    };
  if (existsSync(marker)) {
    const receipt = JSON.parse(readRegular(marker));
    requireCondition(
      receipt.target === target.runPath &&
        existsSync(target.ledgerPath) &&
        existsSync(join(state.paths.state, `import-${receipt.operation}.json`)),
      "IMPORT_CONFLICT",
      "Migration is incomplete; inspect migration journal before recovery",
    );
    return {
      run_id: runId,
      url,
      backup: receipt.backup,
      already_imported: true,
    };
  }
  const sourceIdentity = identity(source.runPath);
  const lockIdentity = identity(source.lockPath);
  const lockParent = identity(join(source.runPath, "locks"));
  return withExclusiveLock(join(state.paths.data, ".maintenance.lock"), () =>
    withExclusiveLock(
      source.lockPath,
      () => {
        const current = identity(source.runPath);
        requireCondition(
          current.dev === sourceIdentity.dev &&
            current.ino === sourceIdentity.ino,
          "SOURCE_CHANGED",
          "Import source identity changed",
        );
        const raw = readRegularNoFollow(source.ledgerPath, sourceRoot);
        const parsed = JSON.parse(raw.toString("utf8"));
        requireLedgerCompatibility(parsed, "write");
        validateLedger(parsed);
        const expected = contentDigest(source.runPath);
        const existingTarget = existsSync(target.runPath);
        if (existingTarget)
          requireCondition(
            contentDigest(target.runPath) === expected,
            "IMPORT_CONFLICT",
            "Run ID exists with different content",
          );
        const operation = randomUUID();
        const backups = join(sourceRoot, "runs");
        const backup = join(backups, `.migrated-${runId}-${operation}`);
        ensureDirectory(join(state.paths.data, "runs"));
        const staging = join(state.paths.data, "runs", `.import-${operation}`);
        ensureDirectory(staging);
        for (const file of files(source.runPath)) {
          const destination = join(staging, file);
          ensureDirectory(join(destination, ".."));
          writeExclusiveNoFollow(
            destination,
            readRegularNoFollow(join(source.runPath, file), sourceRoot),
            state.paths.data,
          );
        }
        requireCondition(
          contentDigest(staging) === expected,
          "IMPORT_VERIFY_FAILED",
          "Import staging digest mismatch",
        );
        const journal = join(state.paths.state, `import-${operation}.json`);
        writeAtomic(
          journal,
          JSON.stringify({
            source: source.runPath,
            target: target.runPath,
            backup,
            staging,
            digest: expected,
            phase: "prepared",
          }),
        );
        // Renaming under the original ledger lock fences old binaries: their bound
        // run/lock identities fail, and the tombstone cannot be initialized again.
        renameNoReplace(source.runPath, backup, sourceRoot);
        syncDirectory(join(sourceRoot, "runs"));
        syncDirectory(backups);
        onStage?.("source_sealed");
        mkdirSync(source.runPath, { mode: 0o700 });
        writeAtomic(
          marker,
          JSON.stringify({
            target: target.runPath,
            backup,
            digest: expected,
            operation,
          }),
        );
        ensureDirectory(join(state.paths.data, "runs"));
        if (!existingTarget)
          renameNoReplace(staging, target.runPath, state.paths.data);
        syncDirectory(join(state.paths.data, "runs"));
        writeAtomic(
          journal,
          JSON.stringify({
            source: source.runPath,
            target: target.runPath,
            backup,
            staging,
            digest: expected,
            phase: "completed",
          }),
        );
        return { run_id: runId, url, backup, already_imported: existingTarget };
      },
      10_000,
      false,
      lockParent,
      lockIdentity,
    ),
  );
}
