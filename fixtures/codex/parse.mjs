#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURE_SCHEMA = "loomhelm.codex.fixture/v1";

const VALID_STREAMS = new Set(["app-server", "host-observation", "artifact"]);
const SENSITIVE_KEY = /^(authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password)$/i;
const USER_PATH = /\/(?:Users|home)\/[^\s/]+/;
const PRIVATE_RUN_PATH = /\/private\/tmp\/loomhelm-[^\s"']+/;

export function parseFixtureText(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("fixture text must be a string");

  const records = [];
  let expectedSequence = 1;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch (error) {
      throw new Error(`${options.source ?? "<fixture>"}:${index + 1}: invalid JSON (${error.message})`);
    }

    validateEnvelope(envelope, index + 1, options.source);
    if (options.requireSequential !== false && envelope.sequence !== expectedSequence) {
      throw new Error(`${options.source ?? "<fixture>"}:${index + 1}: sequence must be ${expectedSequence}`);
    }
    expectedSequence += 1;
    const payload = envelope.payload;
    const classification = classifyPayload(payload, envelope.stream);
    records.push({
      line: index + 1,
      rawLine: line,
      envelope,
      payload,
      method: typeof payload.method === "string" ? payload.method : null,
      itemType: classification.itemType,
      category: classification.category,
    });
  }

  const parsed = {
    schema: FIXTURE_SCHEMA,
    source: options.source ?? null,
    records,
    summary: summarizeRecords(records),
  };

  if (options.validateSanitized !== false) validateSanitized(parsed);
  return parsed;
}

export async function parseFixtureFile(path, options = {}) {
  const source = options.source ?? path;
  return parseFixtureText(await readFile(path, "utf8"), { ...options, source });
}

export function validateFixtureText(text, options = {}) {
  return parseFixtureText(text, { ...options, validateSanitized: true });
}

export function classifyPayload(payload, stream = "app-server") {
  if (!isObject(payload)) return { category: "unknown", itemType: null };

  const method = typeof payload.method === "string" ? payload.method : "";
  const params = isObject(payload.params) ? payload.params : {};
  const item = isObject(params.item) ? params.item : isObject(payload.item) ? payload.item : null;
  const itemType = typeof item?.type === "string" ? item.type : null;
  const turn = isObject(params.turn) ? params.turn : isObject(payload.turn) ? payload.turn : null;
  const event = typeof payload.event === "string" ? payload.event : "";

  if (stream === "artifact" || method === "turn/diff/updated" || itemType === "fileChange" || itemType === "artifact") {
    return { category: "artifact", itemType };
  }
  if (stream === "host-observation" && /(disconnect|reconnect|resume)/i.test(event)) {
    return { category: "reconnect", itemType };
  }
  if (method === "turn/interrupt" || turn?.status === "interrupted") {
    return { category: "interrupt", itemType };
  }
  if (method === "thread/resume" || method === "thread/read" || method === "thread/turns/list") {
    return { category: "reconnect", itemType };
  }
  if (/requestApproval$/i.test(method) || method === "serverRequest/resolved" || method === "tool/requestUserInput") {
    return { category: "approval", itemType };
  }
  if (method === "item/agentMessage/delta" || itemType === "agentMessage" || itemType === "userMessage") {
    return { category: "message", itemType };
  }
  if (
    itemType === "commandExecution" ||
    itemType === "mcpToolCall" ||
    itemType === "dynamicToolCall" ||
    itemType === "collabToolCall" ||
    itemType === "webSearch" ||
    method.includes("commandExecution") ||
    method === "item/tool/call"
  ) {
    return { category: "tool", itemType };
  }
  if (method.startsWith("thread/") || method.startsWith("turn/") || method === "item/started" || method === "item/completed") {
    return { category: "lifecycle", itemType };
  }
  if (payload.result || payload.error) return { category: "rpc", itemType };
  if (method) return { category: "unknown", itemType };
  return { category: "unknown", itemType };
}

export function summarizeRecords(records) {
  const summary = { total: records.length, categories: {}, methods: {}, itemTypes: {} };
  for (const record of records) {
    summary.categories[record.category] = (summary.categories[record.category] ?? 0) + 1;
    if (record.method) summary.methods[record.method] = (summary.methods[record.method] ?? 0) + 1;
    if (record.itemType) summary.itemTypes[record.itemType] = (summary.itemTypes[record.itemType] ?? 0) + 1;
  }
  return summary;
}

export function serializeFixture(parsed) {
  if (!parsed || !Array.isArray(parsed.records)) throw new TypeError("parsed fixture is required");
  return `${parsed.records.map((record) => JSON.stringify(record.envelope)).join("\n")}\n`;
}

function validateEnvelope(envelope, line, source) {
  if (!isObject(envelope)) fail(source, line, "record must be an object");
  if (envelope.schema !== FIXTURE_SCHEMA) fail(source, line, `schema must be ${FIXTURE_SCHEMA}`);
  if (!VALID_STREAMS.has(envelope.stream)) fail(source, line, "stream must be app-server, host-observation, or artifact");
  if (typeof envelope.source !== "string" || envelope.source.length === 0) fail(source, line, "source must be a non-empty string");
  if (!Number.isInteger(envelope.sequence) || envelope.sequence < 1) fail(source, line, "sequence must be a positive integer");
  if (!Object.hasOwn(envelope, "payload") || !isObject(envelope.payload)) fail(source, line, "payload must be an object");
}

function validateSanitized(parsed) {
  for (const record of parsed.records) {
    assertSafeValue(record.envelope, `${parsed.source ?? "<fixture>"}:${record.line}`);
  }
}

function assertSafeValue(value, location, key = null) {
  if (key && SENSITIVE_KEY.test(key)) throw new Error(`${location}: sensitive field ${key} must not appear in a fixture`);
  if (typeof value === "string") {
    if (USER_PATH.test(value) || PRIVATE_RUN_PATH.test(value)) throw new Error(`${location}: user or private-run path must be redacted`);
    if (/\b(?:sk|sess|access|refresh)[_-][A-Za-z0-9]{12,}\b/i.test(value)) throw new Error(`${location}: credential-like value must be redacted`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item, location);
    return;
  }
  if (isObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) assertSafeValue(childValue, location, childKey);
  }
}

function fail(source, line, message) {
  throw new Error(`${source ?? "<fixture>"}:${line}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath && import.meta.url === entryPath) {
  const paths = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  if (paths.length === 0) {
    console.error("usage: node fixtures/codex/parse.mjs <fixture.jsonl> [...]");
    process.exitCode = 2;
  } else {
    const summaries = [];
    for (const path of paths) summaries.push({ path, summary: (await parseFixtureFile(path)).summary });
    process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
  }
}
