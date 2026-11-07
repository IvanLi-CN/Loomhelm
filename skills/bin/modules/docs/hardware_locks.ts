import {
  accessSync,
  constants,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const LOCK_SCHEMA = "codex.hardware-doc-ingest.lock.v1";

interface JsonObject {
  [key: string]: unknown;
}

export interface LockCheckOptions {
  strictPdf?: boolean;
  checkPerms?: boolean;
}

export interface LockCheckResult {
  exitCode: number;
  docs: number;
  errors: number;
  warnings: number;
  lines: string[];
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function lockFiles(root: string): string[] {
  const found: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith(".assets")) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".lock.json"))
        found.push(path);
    }
  }
  visit(root);
  return found.sort();
}

function verifyLock(
  path: string,
  options: Required<LockCheckOptions>,
): { errors: number; warnings: number; docs: number; lines: string[] } {
  const lines: string[] = [];
  let data: JsonObject;
  try {
    data = object(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    lines.push(`[ERROR] ${path}: invalid JSON (${String(error)})`);
    return { errors: 1, warnings: 0, docs: 0, lines };
  }
  let errors = 0;
  let warnings = 0;
  if (data.schema !== LOCK_SCHEMA) {
    lines.push(
      `[WARN] ${path}: unknown schema ${JSON.stringify(data.schema)} (expected ${JSON.stringify(LOCK_SCHEMA)})`,
    );
    warnings += 1;
  }
  const artifacts = object(data.artifacts);
  const md = object(artifacts.md);
  const pdf = object(artifacts.pdf);
  const mdRel = typeof md.path === "string" ? md.path : "";
  const pdfRel = typeof pdf.path === "string" ? pdf.path : "";
  const mdExpected = typeof md.sha256 === "string" ? md.sha256 : "";
  const pdfExpected = typeof pdf.sha256 === "string" ? pdf.sha256 : "";
  if (!mdRel || !mdExpected) {
    lines.push(`[ERROR] ${path}: missing artifacts.md fields`);
    return { errors: 1, warnings, docs: 0, lines };
  }
  const checkArtifact = (
    relative: string,
    expected: string,
    kind: "Markdown" | "PDF",
    strictMissing: boolean,
  ): void => {
    const artifact = resolve(dirname(path), relative);
    if (!lstatSafe(artifact)) {
      const prefix = strictMissing ? "[ERROR]" : "[WARN]";
      const label = kind === "Markdown" ? "generated Markdown" : "source PDF";
      lines.push(`${prefix} ${path}: missing ${label}: ${relative}`);
      if (strictMissing) errors += 1;
      else warnings += 1;
      return;
    }
    const actual = sha256(artifact);
    if (actual !== expected) {
      lines.push(`[ERROR] ${path}: ${kind} SHA mismatch: ${relative}`);
      errors += 1;
    } else if (options.checkPerms && writable(artifact)) {
      lines.push(
        `[WARN] ${path}: ${kind} is writable (expected read-only): ${relative}`,
      );
      warnings += 1;
    }
  };
  checkArtifact(mdRel, mdExpected, "Markdown", true);
  if (pdfRel && pdfExpected)
    checkArtifact(pdfRel, pdfExpected, "PDF", options.strictPdf);
  return { errors, warnings, docs: 1, lines };
}

function lstatSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function verifyDocLocks(
  rootInput = ".",
  options: LockCheckOptions = {},
): LockCheckResult {
  const root = resolve(rootInput);
  const lines: string[] = [];
  if (!lstatSafe(root) && !directoryExists(root))
    return {
      exitCode: 2,
      docs: 0,
      errors: 1,
      warnings: 0,
      lines: [`[ERROR] root does not exist: ${rootInput}`],
    };
  const locks = lockFiles(root);
  if (locks.length === 0)
    return {
      exitCode: 0,
      docs: 0,
      errors: 0,
      warnings: 0,
      lines: [`[INFO] No *.lock.json found under ${rootInput}`],
    };
  let errors = 0;
  let warnings = 0;
  let docs = 0;
  const normalized = {
    strictPdf: options.strictPdf ?? false,
    checkPerms: options.checkPerms ?? true,
  };
  for (const lock of locks) {
    const result = verifyLock(lock, normalized);
    errors += result.errors;
    warnings += result.warnings;
    docs += result.docs;
    lines.push(...result.lines);
  }
  lines.push(`[SUMMARY] docs=${docs} errors=${errors} warnings=${warnings}`);
  return { exitCode: errors ? 1 : 0, docs, errors, warnings, lines };
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
