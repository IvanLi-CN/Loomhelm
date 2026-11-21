import { randomInt } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const DEFAULT_LENGTH = 5;

export interface LegacyIdOptions {
  repoRoot?: string;
  legacyCompat?: boolean;
  count?: number;
  length?: number;
  alphabet?: string;
  maxAttempts?: number;
}

export interface LegacyIdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function idsInRoot(
  root: string,
  alphabet: string,
  length: number,
): Set<string> {
  const ids = new Set<string>();
  const idPattern = new RegExp(
    `^(?:\\d{4}|[${escapeRegex(alphabet)}]{${length}})$`,
  );
  for (const relativeRoot of ["docs/specs", "docs/plan"]) {
    const directory = resolve(root, relativeRoot);
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const prefix = entry.name.split(/[-:]/, 1)[0]?.trim() ?? "";
        if (idPattern.test(prefix)) ids.add(prefix);
      }
    }
    const readme = resolve(directory, "README.md");
    if (!existsSync(readme)) continue;
    for (const line of readFileSync(readme, "utf8").split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const id =
        line
          .replace(/^\||\|$/g, "")
          .split("|")[0]
          ?.trim() ?? "";
      if (idPattern.test(id)) ids.add(id);
    }
  }
  return ids;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneId(alphabet: string, length: number): string {
  return Array.from(
    { length },
    () => alphabet[randomInt(alphabet.length)] ?? alphabet[0],
  ).join("");
}

export function generateLegacySpecIds(
  options: LegacyIdOptions = {},
): LegacyIdResult {
  if (!options.legacyCompat)
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "[ERROR] legacy ID generation is migration-only; create new specs with docs/specs/<topic>/ instead.\n",
    };
  const count = options.count ?? 1;
  const length = options.length ?? DEFAULT_LENGTH;
  const alphabet = (options.alphabet ?? DEFAULT_ALPHABET).trim();
  const maxAttempts = options.maxAttempts ?? 10_000;
  if (count < 1)
    return {
      exitCode: 2,
      stdout: "",
      stderr: "[ERROR] --count must be >= 1\n",
    };
  if (length < 1)
    return {
      exitCode: 2,
      stdout: "",
      stderr: "[ERROR] --length must be >= 1\n",
    };
  if (!alphabet)
    return {
      exitCode: 2,
      stdout: "",
      stderr: "[ERROR] --alphabet must be non-empty\n",
    };
  if (new Set(alphabet).size !== alphabet.length)
    return {
      exitCode: 2,
      stdout: "",
      stderr: "[ERROR] --alphabet must not contain duplicate characters\n",
    };

  const existing = idsInRoot(
    resolve(options.repoRoot ?? "."),
    alphabet,
    length,
  );
  const generated: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let candidate: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const next = oneId(alphabet, length);
      if (!existing.has(next)) {
        candidate = next;
        existing.add(next);
        break;
      }
    }
    if (!candidate)
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[ERROR] Failed to generate a unique id after ${maxAttempts} attempts.\n`,
      };
    generated.push(candidate);
  }
  return { exitCode: 0, stdout: `${generated.join("\n")}\n`, stderr: "" };
}
