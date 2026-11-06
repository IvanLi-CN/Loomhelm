import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { existsFile, pathFor } from "./architecture_contract_helpers";

type TomlValue = string | number | boolean | TomlTable | TomlValue[];
interface TomlTable {
  [key: string]: TomlValue;
}

function tomlComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if ((character === '"' || character === "'") && !quote) quote = character;
    else if (character === quote && line[index - 1] !== "\\") quote = "";
    else if (character === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function tomlPath(value: string): string[] {
  const result: string[] = [];
  const pattern = /(?:^|\.)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index !== consumed && value.slice(consumed, match.index).trim())
      throw new Error(`invalid table path: ${value}`);
    result.push(match[1] ?? match[2] ?? match[3]!);
    consumed = pattern.lastIndex;
  }
  if (!result.length || value.slice(consumed).trim())
    throw new Error(`invalid table path: ${value}`);
  return result;
}

function tomlValue(value: string): TomlValue {
  const source = value.trim();
  if (source.startsWith('"')) {
    if (!source.endsWith('"')) throw new Error("unterminated string");
    return JSON.parse(source) as string;
  }
  if (source.startsWith("'")) {
    if (!source.endsWith("'")) throw new Error("unterminated literal");
    return source.slice(1, -1);
  }
  if (source.startsWith("[") || source.startsWith("{")) {
    if (!source.endsWith(source.startsWith("[") ? "]" : "}"))
      throw new Error("unterminated collection");
    return source.startsWith("[") ? [] : {};
  }
  if (/^(?:true|false)$/.test(source)) return source === "true";
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(source)) return Number(source);
  if (/^[A-Za-z0-9_.:+-]+$/.test(source)) return source;
  throw new Error(`invalid value: ${source}`);
}

function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const line = tomlComment(rawLine).trim();
    if (!line) continue;
    if (/^\[\[[^\]]+\]\]$/.test(line)) {
      current = root;
      continue;
    }
    const table = /^\[([^\[]+)\]$/.exec(line);
    if (table) {
      current = root;
      for (const part of tomlPath(table[1]!)) {
        const value = current[part];
        if (
          value !== undefined &&
          (typeof value !== "object" || Array.isArray(value))
        )
          throw new Error(`table conflicts with value: ${part}`);
        if (value === undefined) current[part] = {};
        current = current[part] as TomlTable;
      }
      continue;
    }
    const assignment = /^("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(
      line,
    );
    if (!assignment) throw new Error(`invalid assignment: ${line}`);
    const key = assignment[1]!.trim().replace(/^['"]|['"]$/g, "");
    let value = assignment[2]!;
    if (value === '"""') {
      const block: string[] = [];
      while (++index < lines.length && lines[index]!.trim() !== '"""')
        block.push(lines[index]!);
      if (index >= lines.length)
        throw new Error("unterminated multiline string");
      value = JSON.stringify(block.join("\n"));
    }
    current[key] = tomlValue(value);
  }
  return root;
}

function table(value: TomlValue | undefined): TomlTable | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

export function checkTrackerRoles(root: string): string[] {
  const findings: string[] = [];
  let config: TomlTable;
  try {
    config = parseToml(readFileSync(pathFor(root, "config.toml"), "utf8"));
  } catch (error) {
    return [`TRACKER_CONFIG_INVALID reason=${String(error)}`];
  }
  const roles = table(config.agents);
  if (!roles) return ["TRACKER_CONFIG_INVALID reason=agents must be a table"];
  for (const [contract, role] of [
    ["ci-tracking-short-contract.md", "ci-tracker"],
    ["release-tracking-short-contract.md", "release-tracker"],
  ] as const) {
    const reference = pathFor(
      root,
      `skills/project-engineering-workflow/references/${contract}`,
    );
    if (!existsFile(reference))
      findings.push(`TRACKER_CONTRACT_MISSING role=${role}`);
    else if (
      !/agent_type\s*=\s*["']([^"']+)["']/g.test(
        readFileSync(reference, "utf8"),
      )
    )
      findings.push(`TRACKER_ENTRY_MISSING role=${role}`);
    const registration = table(roles[role]);
    if (!registration) {
      findings.push(`TRACKER_ROLE_UNREGISTERED role=${role}`);
      continue;
    }
    const relativePath = `agents/${role}.toml`;
    if (registration.config_file !== `./${relativePath}`) {
      findings.push(`TRACKER_ROLE_CONFIG_MISMATCH role=${role}`);
      continue;
    }
    const profilePath = resolve(root, relativePath);
    const rootPath = resolve(root);
    if (
      !existsFile(profilePath) ||
      !relative(rootPath, profilePath).match(/^(?!\.\.(?:\/|$))/)
    ) {
      findings.push(`TRACKER_PROFILE_MISSING role=${role}`);
      continue;
    }
    try {
      const profile = parseToml(readFileSync(profilePath, "utf8"));
      if (
        profile.name !== role ||
        !["description", "developer_instructions"].every(
          (field) =>
            typeof profile[field] === "string" && Boolean(profile[field]),
        )
      )
        findings.push(`TRACKER_PROFILE_INVALID role=${role}`);
    } catch (error) {
      findings.push(
        `TRACKER_PROFILE_INVALID role=${role} reason=${String(error)}`,
      );
    }
  }
  return findings;
}
