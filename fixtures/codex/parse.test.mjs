import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyPayload,
  parseFixtureText,
  serializeFixture,
  validateFixtureText,
} from "./parse.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const samples = resolve(root, "samples");

async function samplePaths() {
  return (await readdir(samples)).filter((name) => name.endsWith(".jsonl")).sort().map((name) => join(samples, name));
}

test("all Codex samples parse deterministically", async () => {
  for (const path of await samplePaths()) {
    const source = await readFile(path, "utf8");
    const first = validateFixtureText(source, { source: path });
    const second = validateFixtureText(source, { source: path });
    assert.deepEqual(first.summary, second.summary, path);
    assert.deepEqual(first.records.map((record) => record.envelope), second.records.map((record) => record.envelope), path);
    assert.equal(first.records.at(-1).envelope.sequence, first.records.length, path);
  }
});

test("manifest paths resolve to the committed sample set", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const expected = new Set(manifest.scenarios.map((scenario) => scenario.path));
  const actual = new Set(["samples/content-and-artifacts.jsonl", "samples/observed-control.jsonl", "samples/unknown-event.jsonl"]);
  assert.deepEqual(expected, actual);
  for (const path of expected) await access(resolve(root, path));
});

test("round trip retains every envelope field and unknown payload field", async () => {
  const path = join(samples, "unknown-event.jsonl");
  const source = await readFile(path, "utf8");
  const parsed = validateFixtureText(source, { source: path });
  const reparsed = parseFixtureText(serializeFixture(parsed), { source: "round-trip" });
  assert.deepEqual(reparsed.records.map((record) => record.envelope), parsed.records.map((record) => record.envelope));
  assert.equal(reparsed.records[0].payload.params.xFutureField.nested, "preserve-me");
  assert.equal(reparsed.records[1].payload.params.item.xFutureItemField, "preserve-me-too");
});

test("fixtures cover messages, tools, approvals, interruption, reconnect, artifacts, and unknown content", async () => {
  const combined = (await Promise.all(await samplePaths().then((paths) => paths.map((path) => readFile(path, "utf8"))))).join("\n");
  const summary = parseFixtureText(combined, { source: "combined", validateSanitized: true, requireSequential: false }).summary;
  for (const category of ["message", "tool", "approval", "interrupt", "reconnect", "artifact", "unknown"]) {
    assert.ok(summary.categories[category] > 0, `missing category ${category}`);
  }
});

test("classification is additive and keeps unknown types inspectable", () => {
  const unknown = {
    jsonrpc: "2.0",
    method: "item/futureRenderer/v9",
    params: { item: { type: "futureContent", value: "keep" } },
  };
  assert.deepEqual(classifyPayload(unknown), { category: "unknown", itemType: "futureContent" });
});

test("sanitization rejects user-specific paths and credentials", () => {
  assert.throws(
    () => validateFixtureText(JSON.stringify({
      schema: "loomhelm.codex.fixture/v1",
      source: "fixture-test",
      stream: "app-server",
      sequence: 1,
      payload: { method: "warning", params: { path: "/Users/alice/private.txt" } },
    })),
    /user or private-run path must be redacted/,
  );
  assert.throws(
    () => validateFixtureText(JSON.stringify({
      schema: "loomhelm.codex.fixture/v1",
      source: "fixture-test",
      stream: "app-server",
      sequence: 1,
      payload: { method: "warning", params: { access_token: "redacted-but-not-allowed" } },
    })),
    /sensitive field access_token/,
  );
});
