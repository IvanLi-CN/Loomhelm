import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkArchitectureContracts } from "./architecture_contracts";

export const coreBaselineLines = 2405;
export const coreSkills = [
  "project-engineering-workflow",
  "normal-flow",
  "fast-flow",
  "local-merge-flow",
  "flow-continue",
] as const;
export const coreLineLimits: Record<string, number> = {
  "project-engineering-workflow": 300,
};

const retiredDirs = ["plan-sync", "docs-plan-id"];
const retiredPublicSkills = ["pr-create", "pr-merge", "github-pr-body-images"];
const instructionSuffixes = new Set([
  ".md",
  ".rules",
  ".sh",
  ".toml",
  ".yaml",
  ".yml",
]);
const instructionRoots = [
  "agents",
  "prompts",
  "rules",
  "skills",
  "docs/agents",
];
const rootInstructionFiles = [
  "AGENTS.md",
  "README.md",
  "instruction.md",
  "config.toml",
  "hooks.json",
  "keybindings.json",
];
export interface ArchitectureOptions {
  root: string;
  includeSummary?: boolean;
}

function files(root: string, directory: string): string[] {
  if (!existsSync(directory)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (relative(root, path).replaceAll("\\", "/") === "skills/docs/vendor") continue;
    if ([".git", "node_modules", "__pycache__"].includes(entry.name)) continue;
    if (entry.isDirectory()) output.push(...files(root, path));
    else if (instructionSuffixes.has(path.slice(path.lastIndexOf("."))))
      output.push(path);
  }
  return output;
}

function instructionFiles(root: string): string[] {
  const output = rootInstructionFiles
    .map((name) => join(root, name))
    .filter((path) => existsSync(path));
  for (const path of instructionRoots.flatMap((name) =>
    files(root, join(root, name)),
  )) {
    if (!output.includes(path)) output.push(path);
  }
  return output;
}

function text(path: string): string {
  const source = readFileSync(path, "utf8");
  return (
    source
      .split(/\r?\n/)
      .filter(
        (line) =>
          !line.trimStart().startsWith("```") &&
          !line.trimStart().startsWith(">"),
      )
      .join("\n")
      .split("## Historical rollout snapshot", 1)[0] ?? ""
  );
}

function lower(path: string): string {
  return text(path).toLowerCase();
}

function lineCount(path: string): number {
  const source = readFileSync(path, "utf8");
  return source === ""
    ? 0
    : source.split(/\r\n|[\n\r\u2028\u2029]/).length -
        Number(/[\n\r\u2028\u2029]$/.test(source));
}

function addMissing(
  findings: string[],
  owner: string,
  source: string,
  phrases: readonly string[],
): void {
  const value = source.toLowerCase();
  for (const phrase of phrases)
    if (!value.includes(phrase.toLowerCase()))
      findings.push(`CONTRACT_MISSING owner=${owner} phrase=${phrase}`);
}

function checkBrokenReferences(root: string, findings: string[]): void {
  for (const skill of ["project-engineering-workflow"]) {
    const path = join(root, "skills", skill, "SKILL.md");
    if (!existsSync(path)) continue;
    for (const reference of text(path).matchAll(
      /`([^`]*references\/[^`]+\.md)`/g,
    )) {
      const target = join(root, "skills", skill, reference[1]!);
      if (!existsSync(target) || !statSync(target).isFile())
        findings.push(`BROKEN_REFERENCE skill=${skill} path=${reference[1]}`);
    }
  }
}

export function checkInstructionArchitecture(
  options: ArchitectureOptions | string,
): string[] {
  const root = typeof options === "string" ? options : options.root;
  const findings: string[] = [];
  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) findings.push("ROOT_AGENTS_MISSING");
  else {
    const content = lower(agents);
    for (const [label, phrase] of [
      ["authorization", "授权"],
      ["destructive", "破坏|删除或覆盖"],
      ["privacy", "凭据|敏感数据"],
      ["remote-protection", "remote url|upstream|push url"],
      ["research-trigger", "最新、外部、高风险或不确定"],
    ] as const)
      if (!new RegExp(phrase, "i").test(content))
        findings.push(`RISK_CORE_MISSING item=${label}`);
  }

  let currentLines = 0;
  for (const skill of coreSkills) {
    const path = join(root, "skills", skill, "SKILL.md");
    if (!existsSync(path)) {
      findings.push(`CORE_SKILL_MISSING skill=${skill}`);
      continue;
    }
    const count = lineCount(path);
    currentLines += count;
    if (coreLineLimits[skill] !== undefined && count > coreLineLimits[skill]!)
      findings.push(`SKILL_TOO_LONG skill=${skill} lines=${count}`);
  }
  if (1 - currentLines / coreBaselineLines < 0.3)
    findings.push(
      `CORE_REDUCTION_LOW baseline=${coreBaselineLines} current=${currentLines}`,
    );

  for (const name of [...retiredDirs, ...retiredPublicSkills])
    if (existsSync(join(root, "skills", name)))
      findings.push(`RETIRED_SKILL_PRESENT skill=${name}`);
  for (const path of instructionFiles(root)) {
    const rel = relative(root, path).replaceAll("\\", "/");
    const content = text(path);
    for (const name of retiredPublicSkills)
      if (content.includes(`$${name}`))
        findings.push(`ACTIVE_RETIRED_REFERENCE file=${rel} token=$${name}`);
    if (
      /bin\/flow_receipt\.ts(?![\w.-])/i.test(content) &&
      !/\$\{CODEX_HOME:-\$HOME\/\.codex\}\/bin\/flow_receipt\.ts|\$HOME\/\.codex\/bin\/flow_receipt\.ts/i.test(
        content,
      )
    )
      findings.push(`TARGET_RELATIVE_RECEIPT_COMMAND_PRESENT file=${rel}`);
  }

  const adapters: Record<string, string> = {};
  for (const skill of [
    "normal-flow",
    "fast-flow",
    "multi-task-flow",
    "local-merge-flow",
    "flow-continue",
  ]) {
    const path = join(root, "skills", skill, "SKILL.md");
    if (existsSync(path)) adapters[skill] = lower(path);
  }
  const required: Record<string, string[]> = {
    "normal-flow": ["push, pr creation", "are not authorized"],
    "fast-flow": ["push", "step 5c ready"],
    "multi-task-flow": [
      "active top-level",
      "two task nodes",
      "authoritative runtime ledger",
    ],
    "local-merge-flow": [
      "do not create/update/merge a pr or push",
      "step 5l ready",
    ],
    "flow-continue": ["not a delivery mode", "locked"],
  };
  for (const [owner, phrases] of Object.entries(required))
    addMissing(findings, owner, adapters[owner] ?? "", phrases);
  findings.push(...checkArchitectureContracts(root));
  checkBrokenReferences(root, findings);
  return findings;
}

export function architectureSummary(root: string): string {
  const current = coreSkills.reduce((sum, skill) => {
    const path = join(root, "skills", skill, "SKILL.md");
    return sum + (existsSync(path) ? lineCount(path) : 0);
  }, 0);
  return `core=${current}/${coreBaselineLines} lines (${(100 * (1 - current / coreBaselineLines)).toFixed(1)}% reduction)`;
}
