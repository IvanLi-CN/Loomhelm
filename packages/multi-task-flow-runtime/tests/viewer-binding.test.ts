import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  ensureViewerBinding,
  readViewerBinding,
  viewerBindingPath,
  writeViewerBinding,
} from "../lib/viewer-binding";
import { fixtureRun, serviceFixture } from "./service-fixture";

test("missing historical binding never bootstraps from current Gateway or fallback identity", () => {
  const { root, state } = serviceFixture();
  const { store } = fixtureRun(state.paths.data, "binding-run", 3);
  const ledgerBefore = store.readRaw();
  const manifest = {
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.31",
    build_id: "a".repeat(64),
    source_sha: "b".repeat(40),
    compatibility_line: "compat-v1",
    ledger_contract: 3,
    api_contract: 1,
    frontend_contract: 1,
    viewer_contract: 5,
  };
  expect(() => ensureViewerBinding(state, "binding-run", manifest)).toThrow(
    "Historical run identity is missing",
  );
  expect(readViewerBinding(state, "binding-run")).toBeNull();
  expect(store.readRaw()).toBe(ledgerBefore);
  expect(join(root, "data/runs/binding-run/runtime/viewer-binding.json")).toBe(
    viewerBindingPath(state, "binding-run"),
  );
});

test("viewer binding writes increment its runtime revision without changing ledger", () => {
  const { state } = serviceFixture();
  fixtureRun(state.paths.data, "binding-run", 3);
  const base = writeViewerBinding(state, {
    schema_version: 1,
    run_id: "binding-run",
    revision: 0,
    request_id: "historical-fixture",
    updated_at: new Date().toISOString(),
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.31",
    build_id: "a".repeat(64),
    source_sha: "b".repeat(40),
    compatibility_line: "compat-v1",
    ledger_contract: 3,
    api_contract: 1,
    frontend_contract: 1,
    viewer_contract: 5,
  });
  const next = writeViewerBinding(state, {
    ...base,
    package_version: "0.2.32",
    request_id: "upgrade-request",
  });
  expect(next.revision).toBe(base.revision + 1);
  expect(next.package_version).toBe("0.2.32");
});
