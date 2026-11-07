import {
  isRecord,
  parseJsonArguments,
  parseJsonValue,
  type JsonRecord,
} from "./replay";
import { apiEndpoint } from "./flow_release_commands";

export interface CommandTarget {
  repository?: string;
  number?: string;
}

const prTargetValueOptions = new Set([
  "-R",
  "--repo",
  "--json",
  "--jq",
  "--template",
  "-q",
  "-t",
]);

function prTargetNumber(
  tokens: string[],
  start: number,
): { number?: string; valid: boolean } {
  let number: string | undefined;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (prTargetValueOptions.has(token)) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) return { valid: false };
      index += 1;
      continue;
    }
    const inlineOption = [
      "--json=",
      "--jq=",
      "--template=",
      "--repo=",
      "-R=",
      "-q=",
      "-t=",
    ].find((prefix) => token.startsWith(prefix));
    if (inlineOption) {
      const value = token.slice(inlineOption.length);
      if (!value || value.startsWith("-")) return { valid: false };
      continue;
    }
    if (token.startsWith("-")) return { valid: false };
    if (/^[0-9]+$/.test(token)) {
      if (!/^[1-9][0-9]*$/.test(token) || number) return { valid: false };
      number = token;
      continue;
    }
    return { valid: false };
  }
  return number ? { number, valid: true } : { valid: true };
}

export function preservePendingCallBindings(
  outputCallIds: ReadonlySet<string>,
  callIds: Set<string>,
  targets: Map<string, CommandTarget>,
): void {
  const pending = [...callIds].filter((id) => !outputCallIds.has(id));
  const pendingTargets = new Map(
    pending.flatMap((id) => {
      const target = targets.get(id);
      return target ? [[id, target] as const] : [];
    }),
  );
  callIds.clear();
  targets.clear();
  for (const id of pending) {
    callIds.add(id);
    const target = pendingTargets.get(id);
    if (target) targets.set(id, target);
  }
}

function commandTokens(value: JsonRecord): string[] | undefined {
  if (value.type !== "response_item" || !isRecord(value.payload))
    return undefined;
  const payload = value.payload;
  if (payload.type !== "function_call") return undefined;
  const name = typeof payload.name === "string" ? payload.name : "";
  if (name !== "exec" && name !== "exec_command") return undefined;
  if (typeof payload.arguments !== "string") return undefined;
  const args = parseJsonArguments(payload.arguments);
  const command = typeof args.cmd === "string" ? args.cmd : undefined;
  if (command?.endsWith("\\") === true) return undefined;
  if (command?.includes("\\") === true) return undefined;
  if (!command || /[;&|<>`$()\r\n*?\[\]{}~]/.test(command)) return undefined;
  const tokens: string[] = [];
  const tokenPattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  let cursor = 0;
  for (const match of command.matchAll(tokenPattern)) {
    const start = match.index;
    if (start === undefined || command.slice(cursor, start).trim())
      return undefined;
    tokens.push(match[0]!);
    cursor = start + match[0]!.length;
  }
  if (!tokens.length || command.slice(cursor).trim()) return undefined;
  return tokens.map((token) =>
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
      ? token.slice(1, -1)
      : token,
  );
}

export function commandTarget(value: JsonRecord): CommandTarget | undefined {
  const tokens = commandTokens(value);
  if (!tokens || tokens[0] !== "gh") return undefined;
  if (tokens.some((token) => token === "--help" || token === "-h"))
    return undefined;
  if (tokens[1] === "api") {
    const endpoint = apiEndpoint(tokens);
    if (!endpoint) return undefined;
    return {
      repository: `${endpoint[1]}/${endpoint[2]}`,
      ...(endpoint[3] ? { number: endpoint[3] } : {}),
    };
  }
  let repository: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (prTargetValueOptions.has(token)) {
      const candidate = tokens[index + 1];
      if (!candidate || candidate.startsWith("-")) return undefined;
      if (token === "-R" || token === "--repo") repository = candidate;
      index += 1;
      continue;
    }
    const inlineOption = token.match(
      /^(?:-R|--repo|--json|--jq|--template|-q|-t)=/,
    );
    if (inlineOption) {
      const candidate = token.slice(inlineOption[0].length);
      if (!candidate || candidate.startsWith("-")) return undefined;
      if (inlineOption[0] === "-R=" || inlineOption[0] === "--repo=")
        repository = candidate;
      continue;
    }
    if (token.startsWith("-")) return undefined;
  }
  const prIndex = tokens.findIndex((token) => token === "pr");
  if (prIndex >= 0 && typeof tokens[prIndex + 1] === "string") {
    const target = prTargetNumber(tokens, prIndex + 2);
    if (!target.valid) return undefined;
    return {
      ...(repository ? { repository } : {}),
      ...(target.number ? { number: target.number } : {}),
    };
  }
  return repository ? { repository } : undefined;
}

export function commandTargetMatches(
  repository: string,
  number: string | undefined,
  expected: CommandTarget | undefined,
): boolean {
  if (!expected?.repository) return false;
  if (repository.trim().toLowerCase() !== expected.repository.toLowerCase())
    return false;
  return number === undefined
    ? expected.number === undefined
    : number === expected.number;
}

function ghPrCommand(
  tokens: string[] | undefined,
  subcommands: ReadonlySet<string>,
): boolean {
  if (!tokens || tokens[0] !== "gh") return false;
  if (tokens.some((token) => token === "--help" || token === "-h"))
    return false;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "-R" || token === "--repo") {
      if (!tokens[index + 1] || tokens[index + 1]!.startsWith("-"))
        return false;
      index += 2;
    } else if (token.startsWith("-R=") || token.startsWith("--repo=")) {
      if (token.slice(token.indexOf("=") + 1).startsWith("-")) return false;
      index += 1;
    } else break;
  }
  if (
    tokens[index] !== "pr" ||
    typeof tokens[index + 1] !== "string" ||
    !subcommands.has(tokens[index + 1]!.toLowerCase())
  )
    return false;
  return subcommands.has("view") || subcommands.has("status")
    ? prTargetNumber(tokens, index + 2).valid
    : true;
}

function ghApiPullRequest(
  tokens: string[] | undefined,
  requireWrite = false,
): boolean {
  if (!tokens || tokens[0] !== "gh" || tokens[1] !== "api") return false;
  if (!apiEndpoint(tokens)) return false;
  let write = false;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]!.toLowerCase();
    if (
      token === "--input" ||
      token === "--raw-field" ||
      token === "--field" ||
      token === "-f" ||
      token.startsWith("--input=") ||
      token.startsWith("--raw-field=") ||
      token.startsWith("--field=") ||
      token.startsWith("-f=")
    )
      write = true;
    if (token === "--method" || token === "-x") {
      const method = tokens[index + 1];
      if (!method || method.startsWith("-")) return false;
      write = write || method.toUpperCase() !== "GET";
    } else if (token.startsWith("--method=") || token.startsWith("-x=")) {
      const method = token.slice(token.indexOf("=") + 1);
      if (!method || method.startsWith("-")) return false;
      write = write || method.toUpperCase() !== "GET";
    } else if (token.startsWith("-x") && token.length > 2) {
      const method = token.slice(2);
      if (!method || method.startsWith("-")) return false;
      write = write || method.toUpperCase() !== "GET";
    }
  }
  return write === requireWrite;
}

function codeHostingCommand(
  tokens: string[] | undefined,
  subcommands: ReadonlySet<string>,
): boolean {
  if (!tokens) return false;
  if (tokens.some((token) => token === "--help" || token === "-h"))
    return false;
  const python = /(?:^|\/)python3(?:\.\d+)?$/.test(tokens[0]!);
  const bun = /(?:^|\/)bun$/.test(tokens[0]!);
  const index = python || bun ? 1 : 0;
  const executable = tokens[index]?.split("/").at(-1)?.toLowerCase();
  const accepted = /^code_hosting(?:\.(?:py|ts))?$/.test(executable ?? "");
  return (
    accepted &&
    typeof tokens[index + 1] === "string" &&
    subcommands.has(tokens[index + 1]!.toLowerCase())
  );
}

export function isPrCreateCommand(value: JsonRecord): boolean {
  const tokens = commandTokens(value);
  return (
    ghPrCommand(tokens, new Set(["create"])) ||
    ghApiPullRequest(tokens, true) ||
    codeHostingCommand(tokens, new Set(["pr-create"]))
  );
}

export function isRouteResolutionCommand(value: JsonRecord): boolean {
  const tokens = commandTokens(value);
  return (
    ghPrCommand(tokens, new Set(["view", "status"])) ||
    ghApiPullRequest(tokens) ||
    codeHostingCommand(tokens, new Set(["pr-view", "pr-status"]))
  );
}

export function isMergeFactCommand(value: JsonRecord): boolean {
  const tokens = commandTokens(value);
  return (
    ghPrCommand(tokens, new Set(["view", "status", "merge"])) ||
    ghApiPullRequest(tokens) ||
    codeHostingCommand(tokens, new Set(["pr-view", "pr-status", "pr-merge"]))
  );
}

export function repositoryFactsMatchTarget(
  facts: string,
  targetRepo: string,
): boolean {
  const text = facts.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    const parsed = parseJsonValue(text);
    if (!isRecord(parsed)) return false;
    const jsonMatches: string[] = [];
    for (const key of ["repo", "repository", "target_repo"]) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      const value = parsed[key];
      if (typeof value !== "string" || !value.trim()) return false;
      jsonMatches.push(value.trim());
    }
    return (
      jsonMatches.length > 0 &&
      jsonMatches.every(
        (match) => match.toLowerCase() === targetRepo.trim().toLowerCase(),
      )
    );
  }
  const matches = [
    ...text.matchAll(
      /(?:^|[;\s,])(?:repo|repository|target_repo)\s*[:=]\s*([^;\s,]+)/gi,
    ),
  ].map((match) => match[1]!.trim().replace(/^['"]|['"]$/g, ""));
  if (matches.length)
    return matches.every(
      (match) => match.toLowerCase() === targetRepo.trim().toLowerCase(),
    );
  return false;
}

export function hasStructuredMergedFact(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return false;
    const parsed = parseJsonValue(text);
    return parsed !== undefined && hasStructuredMergedFact(parsed);
  }
  if (Array.isArray(value)) return value.some(hasStructuredMergedFact);
  if (!isRecord(value)) return false;
  if (typeof value.state === "string" && value.state.toUpperCase() === "MERGED")
    return true;
  if (typeof value.mergedAt === "string" && value.mergedAt.trim()) return true;
  return false;
}

export function structuredMergedTarget(
  value: unknown,
): { repository: string; number: string } | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
    const parsed = parseJsonValue(text);
    return parsed === undefined ? undefined : structuredMergedTarget(parsed);
  }
  if (Array.isArray(value)) {
    const targets: Array<{ repository: string; number: string }> = [];
    for (const item of value) {
      if (!hasStructuredMergedFact(item)) continue;
      const target = structuredMergedTarget(item);
      if (!target) return undefined;
      targets.push(target);
    }
    if (!targets.length) return undefined;
    const first = targets[0]!;
    return targets.every(
      (target) =>
        target.repository.toLowerCase() === first.repository.toLowerCase() &&
        target.number === first.number,
    )
      ? first
      : undefined;
  }
  if (!isRecord(value) || !hasStructuredMergedFact(value)) return undefined;
  const repositories: string[] = [];
  for (const key of ["repository", "repo", "target_repo"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const item = value[key];
    if (typeof item !== "string" || !item.trim()) return undefined;
    repositories.push(item.trim());
  }
  if (!repositories.length) return undefined;
  if (
    repositories.some(
      (repository) =>
        repository.toLowerCase() !== repositories[0]!.toLowerCase(),
    )
  )
    return undefined;
  const numbers: string[] = [];
  for (const key of ["number", "target_pr"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const rawNumber = value[key];
    const number =
      typeof rawNumber === "number" &&
      Number.isInteger(rawNumber) &&
      rawNumber > 0
        ? String(rawNumber)
        : typeof rawNumber === "string" &&
            /^[1-9][0-9]*$/.test(rawNumber.trim())
          ? rawNumber.trim()
          : undefined;
    if (!number) return undefined;
    numbers.push(number);
  }
  if (!numbers.length || numbers.some((number) => number !== numbers[0]))
    return undefined;
  return { repository: repositories[0]!, number: numbers[0]! };
}
