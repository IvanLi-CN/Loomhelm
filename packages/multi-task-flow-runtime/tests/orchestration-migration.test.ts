import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { businessDigest } from "../lib/migration-audit";
import { type RunIdentity, requireRunBinding } from "../lib/orchestration-identity";
import { withRunCommand } from "../lib/orchestration-lifecycle";
import { checkMigration, migrationReport } from "../lib/orchestration-migration";
import { upgradeOrchestration } from "../lib/orchestration-upgrade";
import { fixtureRun, serviceFixture } from "./service-fixture";

const originalCaller = process.env.LOOMHELM_CALLER_IDENTITY;
afterEach(() => {
  if (originalCaller === undefined) delete process.env.LOOMHELM_CALLER_IDENTITY;
  else process.env.LOOMHELM_CALLER_IDENTITY = originalCaller;
});
const source: RunIdentity = {
  package_name: "@loomhelm/multi-task-flow",
  package_version: "0.2.55",
  build_id: "a".repeat(64),
  source_sha: "a".repeat(40),
  compatibility_line: "compat-v1",
  ledger_contract: 3,
  api_contract: 1,
  frontend_contract: 1,
  viewer_contract: 5,
};
const target: RunIdentity = {
  ...source,
  package_version: "0.3.1",
  build_id: "b".repeat(64),
  source_sha: "b".repeat(40),
  ledger_contract: 5,
};
function fixture(contract = 3) {
  process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(target);
  const { state } = serviceFixture(),
    { store } = fixtureRun(state.paths.data, "migration-run", 3);
  const identity = { ...source, ledger_contract: contract };
  if (contract >= 4) {
    const raw = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
    raw.contract_version = contract;
    raw.runtime_identity = identity;
    writeFileSync(store.ledgerPath, JSON.stringify(raw));
  }
  mkdirSync(join(store.runPath, "runtime"));
  writeFileSync(
    join(store.runPath, "runtime/viewer-binding.json"),
    JSON.stringify({
      schema_version: contract >= 4 ? 2 : 1,
      run_id: "migration-run",
      ...identity,
      revision: 0,
      request_id: "fixture-binding",
      updated_at: new Date().toISOString(),
    }),
  );
  return store;
}
function tree(path: string): unknown {
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [
      entry.name,
      entry.isDirectory()
        ? tree(join(path, entry.name))
        : createHash("sha256")
            .update(readFileSync(join(path, entry.name)))
            .digest("hex"),
    ]);
}
test("upgrade-check and dry-run preserve all files, including absent lock files", () => {
  const store = fixture();
  unlinkSync(store.lockPath);
  const before = tree(store.rootPath);
  const report = checkMigration(store, target);
  migrationReport.parse(report);
  expect(report.migration_ready).toBe(true);
  expect(report.native_quiescence).toBe("not_asserted");
  expect((upgradeOrchestration(store, target, target, {}, true) as any).migration_ready).toBe(true);
  expect(tree(store.rootPath)).toEqual(before);
  expect(existsSync(join(store.runPath, "locks/lifecycle.lock"))).toBe(false);
});
for (const contract of [3, 4, 5]) {
  test(`contract ${contract} migrates mechanically to 5 with its audit and unknown state preserved`, () => {
    const store = fixture(contract);
    const before = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
    upgradeOrchestration(store, target, target);
    const after = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
    expect(after.contract_version).toBe(5);
    expect(after.upgrade.phase).toBe("completed");
    expect(after.upgrade.migration_audit.source_contract).toBe(contract);
    expect(after.upgrade.migration_audit.business_digest).toBe(businessDigest(before));
    expect(businessDigest(after)).toBe(businessDigest(before));
    requireRunBinding(store.rootPath, "migration-run", store.read(), target);
    expect((upgradeOrchestration(store, target, target) as any).changed).toBe(false);
  });
}
test("read-only observation detects a concurrent source change and rejects links", () => {
  const store = fixture();
  const report = checkMigration(store, target, target, () =>
    writeFileSync(store.ledgerPath, readFileSync(store.ledgerPath, "utf8") + " "),
  );
  expect(report.migration_ready).toBe(false);
  expect(report.blockers[0]?.code).toBe("observation_stale");
  const original = readFileSync(store.ledgerPath);
  const other = join(store.rootPath, "saved-ledger");
  writeFileSync(other, original);
  unlinkSync(store.ledgerPath);
  symlinkSync(other, store.ledgerPath);
  expect(checkMigration(store, target).migration_ready).toBe(false);
  migrationReport.parse(checkMigration(store, target));
  unlinkSync(store.ledgerPath);
  linkSync(other, store.ledgerPath);
  expect(checkMigration(store, target).migration_ready).toBe(false);
});
test("dry-run reports every independent blocker without writing", () => {
  const store = fixture();
  const path = join(store.runPath, "runtime/viewer-binding.json");
  unlinkSync(path);
  const before = tree(store.rootPath);
  const report = checkMigration(store, target, { ...target, ledger_contract: 4 });
  expect(report.blockers.map((item) => item.code)).toEqual(
    expect.arrayContaining(["identity_missing", "migration_unsupported", "executor_mismatch"]),
  );
  expect(() => upgradeOrchestration(store, target, target, {}, true)).toThrow(
    "Mechanical migration checks failed",
  );
  expect(tree(store.rootPath)).toEqual(before);
});
test("a prepared audit is frozen, checked against its source, and cannot be retargeted", () => {
  const store = fixture();
  expect(() =>
    upgradeOrchestration(store, target, target, {
      afterStage: (phase) => {
        if (phase === "prepared") throw new Error("crash");
      },
    }),
  ).toThrow("crash");
  expect(() =>
    upgradeOrchestration(
      store,
      { ...target, build_id: "c".repeat(64) },
      { ...target, build_id: "c".repeat(64) },
    ),
  ).toThrow("immutable target");
  const raw = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  raw.upgrade.migration_audit.business_digest = "c".repeat(64);
  writeFileSync(store.ledgerPath, JSON.stringify(raw));
  expect(checkMigration(store, target).blockers.map((item) => item.code)).toContain(
    "audit_conflict",
  );
  expect(() => upgradeOrchestration(store, target, target, {}, true)).toThrow(
    "Mechanical migration checks failed",
  );
  expect(() => upgradeOrchestration(store, target, target)).toThrow(
    "Mechanical migration checks failed",
  );
});
test("an exact carried invocation receipt is retained as uncertainty, not forged stopped", async () => {
  const store = fixture();
  const path = join(store.runPath, "runtime/call.json");
  const receipt = JSON.stringify({ invocation_id: "old", identity: source, state: "running" });
  writeFileSync(path, receipt);
  upgradeOrchestration(store, target, target);
  const raw = store.read();
  expect(
    readFileSync(
      join(store.rootPath, "runs", raw.upgrade.source_directory, "runtime/call.json"),
      "utf8",
    ),
  ).toBe(receipt);
  expect(readFileSync(path, "utf8")).toBe(receipt);
  let actions = 0;
  await withRunCommand(store, async () => {
    actions++;
  });
  expect(actions).toBe(1);
  writeFileSync(
    path,
    JSON.stringify({ invocation_id: "new-unjoined", identity: target, state: "running" }),
  );
  await expect(
    withRunCommand(store, async () => {
      actions++;
    }),
  ).rejects.toThrow("safe-stop receipt");
  expect(actions).toBe(1);
});
