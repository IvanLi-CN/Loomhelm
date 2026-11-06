import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalPreferencesStore } from "../scripts/preferences";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("global UI preferences", () => {
  test("falls back to system without creating a preference file", () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "orchestration-preferences-"))); roots.push(root);
    const store = new GlobalPreferencesStore(root);
    expect(store.read()).toEqual({ schema_version: 1, theme: "system" });
    expect(existsSync(store.path)).toBe(false);
  });

  test("recovers from corrupt data and writes an atomic 0600 schema-1 value", () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "orchestration-preferences-"))); roots.push(root);
    const store = new GlobalPreferencesStore(root);
    writeFileSync(store.path, "not-json\n", { mode: 0o600 });
    expect(store.read().theme).toBe("system");
    expect(store.write("dark")).toEqual({ schema_version: 1, theme: "dark" });
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ schema_version: 1, theme: "dark" });
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect([...new Bun.Glob(".ledger-*.tmp").scanSync(root)].length).toBe(0);
  });

  test("does not accept unsupported themes", () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "orchestration-preferences-"))); roots.push(root);
    const store = new GlobalPreferencesStore(root);
    expect(() => store.write("blue" as never)).toThrow();
  });

  test("accepts a lock created by a concurrent initializer", () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "orchestration-preferences-"))); roots.push(root);
    const first = new GlobalPreferencesStore(root);
    const second = new GlobalPreferencesStore(root);
    expect(first.lockPath).toBe(second.lockPath);
    expect(second.read().theme).toBe("system");
  });

  test("tightens an existing preference lock to 0600", () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "orchestration-preferences-"))); roots.push(root);
    const first = new GlobalPreferencesStore(root);
    chmodSync(first.lockPath, 0o666);
    new GlobalPreferencesStore(root);
    expect(statSync(first.lockPath).mode & 0o777).toBe(0o600);
  });

  test("falls back for a special preference path and rejects a special lock path", () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "orchestration-preferences-"))); roots.push(root);
    const store = new GlobalPreferencesStore(root);
    mkdirSync(store.path);
    expect(store.read().theme).toBe("system");
    rmSync(store.lockPath);
    mkdirSync(store.lockPath);
    expect(() => store.read()).toThrow();
  });
});
