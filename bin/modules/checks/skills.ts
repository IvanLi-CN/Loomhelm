import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillIndexEntry {
  name: string;
  line: number;
  external: boolean;
}

const localName = /^`([a-z0-9-]+)`$/;
const externalPath = /~?\/?[^\s|`]*\.agents\/skills\/([a-z0-9-]+)(?:\/|`)/;

export function repositorySkills(skillsRoot: string): Set<string> {
  const names = new Set<string>();
  for (const child of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (child.name.startsWith(".") || !child.isDirectory()) continue;
    if (existsSync(join(skillsRoot, child.name, "SKILL.md")))
      names.add(child.name);
  }
  return names;
}

export function indexEntries(readmePath: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];
  let inTable = false;
  for (const [index, raw] of readFileSync(readmePath, "utf8")
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (line.startsWith("| Skill |")) {
      inTable = true;
      continue;
    }
    if (inTable && (!line || !line.startsWith("|"))) {
      inTable = false;
      continue;
    }
    if (!inTable || line.startsWith("|---")) continue;
    const cells = line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    const match = cells[0]?.match(localName);
    if (!match?.[1]) continue;
    const externalMatch = line.match(externalPath);
    entries.push({
      name: match[1],
      line: index + 1,
      external: externalMatch?.[1] === match[1],
    });
  }
  return entries;
}

export function checkSkillsIndex(repoRoot: string): string[] {
  const actual = repositorySkills(join(repoRoot, "skills"));
  const entries = indexEntries(join(repoRoot, "skills/README.md"));
  const local = entries.filter((entry) => !entry.external);
  const indexed = new Set(local.map((entry) => entry.name));
  const findings: string[] = [];
  for (const name of [...actual].filter((name) => !indexed.has(name)).sort())
    findings.push(`MISSING_INDEX_ENTRY skill=${name}`);
  for (const entry of local)
    if (!actual.has(entry.name))
      findings.push(`STALE_INDEX_ENTRY skill=${entry.name} line=${entry.line}`);
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  for (const [name, count] of [...counts].sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    if (count > 1)
      findings.push(`DUPLICATE_INDEX_ENTRY skill=${name} count=${count}`);
  return findings;
}
