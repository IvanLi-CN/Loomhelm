import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore } from "../lib/store";

const created: string[] = [];
function temporaryRoot(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "orchestration-test-"));
  created.push(path);
  return path;
}
afterEach(() => {
  for (const path of created.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("ledger store", () => {
  test("persists the previous complete snapshot", () => {
    const store = new LedgerStore(temporaryRoot(), "test-run");
      store.create({ schema_version: 2, contract_version: 2, revision: 0 });
    store.update((ledger) => {
      ledger.revision = 1;
    });
    expect(store.read().revision).toBe(1);
    expect(
      JSON.parse(
        readFileSync(join(store.runPath, "ledger.previous.json"), "utf8"),
      ).revision,
    ).toBe(0);
  });

  test("requires explicit migration before writing an unversioned ledger", () => {
    const store = new LedgerStore(temporaryRoot(), "legacy-run");
    store.create({ revision: 0 });
    expect(() => store.update((ledger) => { ledger.revision = 1; })).toThrow("read-only");
    expect(JSON.parse(readFileSync(join(store.runPath, "ledger.json"), "utf8"))).toEqual({ revision: 0 });
  });

  test("refuses to overwrite an existing run", () => {
    const store = new LedgerStore(temporaryRoot(), "test-run");
    store.create({ schema_version: 2, contract_version: 2, revision: 0 });
    expect(() => store.create({ revision: 3 })).toThrow("already exists");
    expect(store.read().revision).toBe(0);
  });

  test("fails closed when the ledger lock is missing", () => {
    const store = new LedgerStore(temporaryRoot(), "test-run");
    store.create({ schema_version: 2, contract_version: 2, revision: 0 });
    unlinkSync(store.lockPath);

    expect(() => store.read()).toThrow();
    expect(existsSync(store.lockPath)).toBe(false);
  });

  test("fails closed when the run directory changes under an acquired lock", () => {
    const root = temporaryRoot();
    const store = new LedgerStore(root, "test-run");
    store.create({ schema_version: 2, contract_version: 2, revision: 0 });
    const moved = join(root, "moved-run");
    const replacement = join(root, "replacement-run");
    cpSync(store.runPath, replacement, { recursive: true });

    expect(() =>
      store.withLock(() => {
        renameSync(store.runPath, moved);
        renameSync(replacement, store.runPath);
        store.readUnlocked();
      }),
    ).toThrow("Ledger is unreadable");
  });

  test("cleans up a failed initialization before publishing the run", () => {
    const root = temporaryRoot();
    const store = new LedgerStore(root, "test-run");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => store.create(circular)).toThrow();
    expect(() => store.read()).toThrow("Run does not exist");
    expect(existsSync(join(root, "runs", "test-run", "ledger.json"))).toBe(
      false,
    );
    expect([
      ...new Bun.Glob(".run-test-run-*").scanSync(join(root, "runs")),
    ]).toEqual([]);
  });

  test("cleans up an atomic candidate when the commit hook fails", () => {
    const root = temporaryRoot();
    const store = new LedgerStore(root, "test-run");
    store.create({ schema_version: 2, contract_version: 2, revision: 0 });
    const interrupted = new LedgerStore(root, "test-run", (stage) => {
      if (stage === "candidate_synced") throw new Error("simulated interruption");
    });

    expect(() => interrupted.update((ledger) => { ledger.revision = 1; })).toThrow(
      "simulated interruption",
    );
    expect([...new Bun.Glob(".ledger-*.tmp").scanSync(store.runPath)]).toEqual(
      [],
    );
    expect(store.read().revision).toBe(0);
  });

  test("refuses unsafe run identifiers", () => {
    expect(() => new LedgerStore(temporaryRoot(), "../other")).toThrow(
      "Invalid identifier",
    );
  });

  test("serializes competing process updates", async () => {
    const root = temporaryRoot();
    const store = new LedgerStore(root, "test-run");
    store.create({ schema_version: 2, contract_version: 2, revision: 0 });
    const processes = Array.from({ length: 4 }, () =>
      Bun.spawn(
        [process.execPath, join(import.meta.dir, "increment-worker.ts"), root],
        { stderr: "pipe" },
      ),
    );
    const codes = await Promise.all(processes.map((process) => process.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(store.read().revision).toBe(60);
  });

  for (const [stage, expected] of [
    ["snapshot_committed", 0],
    ["candidate_synced", 0],
    ["ledger_committed", 1],
  ] as const) {
    test(`recovers the committed ledger when the writer dies at ${stage}`, async () => {
      const root = temporaryRoot();
      const store = new LedgerStore(root, "test-run");
    store.create({ schema_version: 2, contract_version: 2, revision: 0 });
      const process = Bun.spawn(
        [
          Bun.which("bun")!,
          join(import.meta.dir, "crash-worker.ts"),
          root,
          stage,
        ],
        { stderr: "pipe" },
      );
      expect(await process.exited).not.toBe(0);
      expect(store.read().revision).toBe(expected);
      expect(
        JSON.parse(
          readFileSync(join(store.runPath, "ledger.previous.json"), "utf8"),
        ).revision,
      ).toBe(0);
    });
  }
});
