import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicNode } from "../lib/atomic-orchestration";
import { inspectInvocation, registerInvocationResource } from "../lib/invocation-journal";
import { businessDigest } from "../lib/migration-audit";
import { type RunIdentity, requireRunBinding } from "../lib/orchestration-identity";
import { withRunCommand } from "../lib/orchestration-lifecycle";
import {
  checkMigration,
  migrationReport,
  readMigrationInput,
} from "../lib/orchestration-migration";
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
  package_version: "0.6.0",
  build_id: "b".repeat(64),
  source_sha: "b".repeat(40),
  ledger_contract: 6,
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
      schema_version: contract >= 6 ? 4 : contract >= 5 ? 3 : contract >= 4 ? 2 : 1,
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
  test(`contract ${contract} migrates mechanically to 6 with its audit and unknown state preserved`, () => {
    const store = fixture(contract);
    const before = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
    upgradeOrchestration(store, target, target);
    const after = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
    expect(after.contract_version).toBe(6);
    expect(after.upgrade.phase).toBe("completed");
    expect(after.upgrade.migration_audit.source_contract).toBe(contract);
    expect(after.upgrade.migration_audit.business_digest).toBe(businessDigest(before));
    expect(businessDigest(after)).toBe(businessDigest(before));
    requireRunBinding(store.rootPath, "migration-run", store.read(), target);
    expect((upgradeOrchestration(store, target, target) as any).changed).toBe(false);
  });
}

test("legacy canonical lifecycle graphs survive mechanical upgrade to contract 6", () => {
  const store = fixture(3);
  const raw = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  const plan = raw.plans[0];
  const groupByTask = new Map(raw.tasks.map((task: any) => [task.id, task.group_id]));
  const definitions = [...plan.atoms, ...plan.group_atoms];
  plan.atomic_nodes = definitions.map((atom: any) => {
    const isGroup = typeof atom.group_id === "string";
    const node = {
      kind: "work" as const,
      id: atom.id,
      title: atom.title,
      purpose: atom.purpose,
      output: atom.output,
      acceptance: [],
      activity_type: "verification" as const,
      state: "planned" as const,
      scope: isGroup
        ? { kind: "delivery_unit" as const, delivery_unit_id: atom.group_id }
        : {
            kind: "task" as const,
            task_id: atom.task_id,
            delivery_unit_id: groupByTask.get(atom.task_id) ?? "unknown-group",
          },
    };
    return atomicNode.parse(node);
  });
  plan.atomic_edges = raw.groups.flatMap((group: any) => {
    const atoms = plan.group_atoms.filter((atom: any) => atom.group_id === group.id);
    return atoms.slice(1).map((atom: any, index: number) => ({
      id: `${group.id}-legacy-lifecycle-${index}`,
      from_node_id: atoms[index]!.id,
      to_node_id: atom.id,
      requires: { kind: "source_terminal_success" },
    }));
  });
  writeFileSync(store.ledgerPath, JSON.stringify(raw));

  expect(() => upgradeOrchestration(store, target, target)).not.toThrow();
  const after = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  expect(after.contract_version).toBe(6);
  expect(after.upgrade.migration_audit.source_contract).toBe(3);
  expect(after.plans[0].atomic_nodes.every((node: any) => !node.lifecycle_role)).toBe(true);

  const nextTarget: RunIdentity = {
    ...target,
    package_version: "0.6.1",
    build_id: "c".repeat(64),
    source_sha: "c".repeat(40),
  };
  process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(nextTarget);
  expect(() => upgradeOrchestration(store, nextTarget, nextTarget)).not.toThrow();
  const upgradedAgain = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  expect(upgradedAgain.upgrade.migration_audit.source_contract).toBe(3);
});

test("historical four-role canonical lifecycle graphs remain mechanically migratable", () => {
  const store = fixture(3);
  const raw = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  const plan = raw.plans[0];
  const isIntegration = (atom: any) => atom.lifecycle_role === "integrate";
  plan.group_atoms = plan.group_atoms.filter((atom: any) => !isIntegration(atom));
  for (const group of raw.groups)
    group.atoms = group.atoms.filter((atom: any) => !isIntegration(atom));
  for (const event of raw.events) {
    for (const field of ["old_group_snapshot", "group_snapshot"] as const) {
      const snapshot = event.data?.[field];
      if (snapshot?.atoms)
        snapshot.atoms = snapshot.atoms.filter((atom: any) => !isIntegration(atom));
    }
  }
  const groupByTask = new Map(raw.tasks.map((task: any) => [task.id, task.group_id]));
  const definitions = [...plan.atoms, ...plan.group_atoms];
  plan.atomic_nodes = definitions.map((atom: any) =>
    atomicNode.parse({
      kind: "work" as const,
      id: atom.id,
      title: atom.title,
      purpose: atom.purpose,
      output: atom.output,
      acceptance: [],
      activity_type: "verification" as const,
      state: "planned" as const,
      scope:
        typeof atom.group_id === "string"
          ? { kind: "delivery_unit" as const, delivery_unit_id: atom.group_id }
          : {
              kind: "task" as const,
              task_id: atom.task_id,
              delivery_unit_id: groupByTask.get(atom.task_id) ?? "unknown-group",
            },
    }),
  );
  plan.atomic_edges = raw.groups.flatMap((group: any) => {
    const atoms = plan.group_atoms.filter((atom: any) => atom.group_id === group.id);
    return atoms.slice(1).map((atom: any, index: number) => ({
      id: `${group.id}-legacy-four-role-${index}`,
      from_node_id: atoms[index]!.id,
      to_node_id: atom.id,
      requires: { kind: "source_terminal_success" },
    }));
  });
  writeFileSync(store.ledgerPath, JSON.stringify(raw));

  expect(checkMigration(store, target).migration_ready).toBe(true);
  expect(() => upgradeOrchestration(store, target, target)).not.toThrow();
  const after = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  expect(after.contract_version).toBe(6);
  expect(after.upgrade.migration_audit.source_contract).toBe(3);
  expect(after.plans[0].group_atoms).toHaveLength(8);
});

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

test("legacy status-only unknown is listed in the report and frozen audit without backfill", () => {
  const store = fixture();
  const raw = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  raw.notifications.push({
    id: "legacy-unknown",
    event_id: "legacy-event",
    recipient_thread_id: "legacy-recipient",
    status: "unknown",
    attempts: 1,
    updated_at: new Date().toISOString(),
  });
  writeFileSync(store.ledgerPath, JSON.stringify(raw));
  const report = checkMigration(store, target);
  expect(report.migration_ready).toBe(true);
  expect(report.unresolved).toContainEqual({
    kind: "notification",
    object_id: "legacy-unknown",
    attempt_id: null,
    native_request_id: null,
    thread_id: "legacy-recipient",
  });
  upgradeOrchestration(store, target, target);
  const after = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  expect(after.upgrade.migration_audit.unresolved).toEqual(report.unresolved);
  expect(businessDigest(after)).toBe(businessDigest(raw));
  expect(after.notifications[0].delivery_status).toBeUndefined();
});
test("a substituted opened descriptor is rejected and closed before reading its bytes", () => {
  const store = fixture();
  const other = join(store.rootPath, "unrelated-file");
  writeFileSync(other, "unrelated bytes");
  const before = tree(store.rootPath);
  let descriptor = -1;
  expect(() =>
    readMigrationInput(store.ledgerPath, store.rootPath, undefined, () => {
      descriptor = openSync(other, "r");
      return descriptor;
    }),
  ).toThrow("Opened migration input identity changed");
  expect(() => fstatSync(descriptor)).toThrow();
  expect(tree(store.rootPath)).toEqual(before);
});
for (const contract of ["api_contract", "frontend_contract", "viewer_contract"] as const) {
  test(`mechanical migration refuses a changed ${contract}`, () => {
    const store = fixture();
    const other = { ...target, [contract]: target[contract] + 1 };
    const beforeLedger = readFileSync(store.ledgerPath, "utf8");
    const before = tree(store.rootPath);
    expect(checkMigration(store, other).migration_ready).toBe(false);
    expect(() => upgradeOrchestration(store, other, other, {}, true)).toThrow(
      "Mechanical migration checks failed",
    );
    expect(tree(store.rootPath)).toEqual(before);
    expect(() => upgradeOrchestration(store, other, other)).toThrow(
      "Mechanical migration checks failed",
    );
    expect(readFileSync(store.ledgerPath, "utf8")).toBe(beforeLedger);
  });
}
for (const phase of ["migrated", "binding_switched"]) {
  test(`pending ${phase} refuses source identity tampering after binding switch`, () => {
    const store = fixture();
    expect(() =>
      upgradeOrchestration(store, target, target, {
        afterStage: (stage) => {
          if (stage === "binding_switched") throw new Error("interrupted");
        },
      }),
    ).toThrow("interrupted");
    const raw = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
    raw.upgrade.phase = phase;
    raw.upgrade.source.build_id = "d".repeat(64);
    writeFileSync(store.ledgerPath, JSON.stringify(raw));
    expect(checkMigration(store, target).migration_ready).toBe(false);
    expect(() => upgradeOrchestration(store, target, target, {}, true)).toThrow(
      "Mechanical migration checks failed",
    );
    expect(() => upgradeOrchestration(store, target, target)).toThrow(
      "Mechanical migration checks failed",
    );
  });
}

test("0.4 contract-5 source upgrades behind schema-4 barrier without proving old stop, while new calls remain fenced", async () => {
  const store = fixture(5);
  const oldIdentity = { ...source, package_version: "0.4.0", ledger_contract: 5 };
  const nextIdentity = { ...target, package_version: "0.6.0" };
  const raw = JSON.parse(readFileSync(store.ledgerPath, "utf8"));
  raw.runtime_identity = oldIdentity;
  writeFileSync(store.ledgerPath, JSON.stringify(raw));
  const bindingPath = join(store.runPath, "runtime/viewer-binding.json");
  const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  writeFileSync(bindingPath, JSON.stringify({ ...binding, ...oldIdentity }));
  const callPath = join(store.runPath, "runtime/call.json");
  const oldCall = JSON.stringify({
    invocation_id: randomUUID(),
    identity: oldIdentity,
    state: "running",
  });
  writeFileSync(callPath, oldCall);
  const before = businessDigest(raw);
  process.env.LOOMHELM_CALLER_IDENTITY = JSON.stringify(nextIdentity);
  const report = checkMigration(store, nextIdentity);
  expect(report.migration_ready).toBe(true);
  expect(report.native_quiescence).toBe("not_asserted");
  upgradeOrchestration(store, nextIdentity, nextIdentity);
  expect(JSON.parse(readFileSync(bindingPath, "utf8")).schema_version).toBe(4);
  expect(store.read().upgrade.migration_audit.writer_barrier).toBe(
    "ledger-contract-6-and-binding-schema-4",
  );
  expect(readFileSync(callPath, "utf8")).toBe(oldCall);
  expect(inspectInvocation(store)?.quiescent).toBe(false);
  requireRunBinding(store.rootPath, "migration-run", store.read(), nextIdentity);
  expect(() =>
    requireRunBinding(store.rootPath, "migration-run", store.read(), oldIdentity),
  ).toThrow();
  let actions = 0;
  await withRunCommand(store, async () => {
    actions++;
    registerInvocationResource("test-native", { request_id: "new-call" }).unknown();
  });
  expect(inspectInvocation(store)?.quiescent).toBe(false);
  await expect(
    withRunCommand(store, async () => {
      actions++;
    }),
  ).rejects.toThrow("safe-stop receipt");
  expect(actions).toBe(1);
  expect(businessDigest(JSON.parse(readFileSync(store.ledgerPath, "utf8")))).toBe(before);
  expect(
    readFileSync(
      join(store.rootPath, "runs", store.read().upgrade.source_directory, "runtime/call.json"),
      "utf8",
    ),
  ).toBe(oldCall);
  expect(checkMigration(store, { ...nextIdentity, package_version: "0.6.0" }).migration_ready).toBe(
    true,
  );
});
