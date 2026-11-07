import { parseArguments, writeJson } from "../core/cli";
import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_START_BASE,
  DEFAULT_STEP,
  DEFAULT_TTL_HOURS,
  FIELDS,
  PortRegistry,
  RegistryError,
  defaultRegistryDir,
  type LeaseRow,
} from "./port_registry";

class UsageError extends Error {}

function option(
  options: Map<string, string | true>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = options.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

function required(
  options: Map<string, string | true>,
  ...names: string[]
): string {
  const value = option(options, ...names);
  if (!value) throw new UsageError(`missing required option: --${names[0]}`);
  return value;
}

function numberOption(
  options: Map<string, string | true>,
  name: string,
  fallback: number,
): number {
  const value = option(options, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new UsageError(`invalid number for --${name}: ${value}`);
  return parsed;
}

function integerOption(
  options: Map<string, string | true>,
  name: string,
): number | undefined {
  const value = option(options, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new UsageError(`invalid integer for --${name}: ${value}`);
  return parsed;
}

function requiredInteger(
  options: Map<string, string | true>,
  name: string,
): number {
  const value = integerOption(options, name);
  if (value === undefined)
    throw new UsageError(`missing required option: --${name}`);
  return value;
}

function expectedPidOption(
  options: Map<string, string | true>,
): number | null | undefined {
  const value = option(options, "expected-pid");
  if (options.has("expect-empty-pid")) {
    if (value !== undefined)
      throw new UsageError(
        "--expected-pid and --expect-empty-pid cannot be combined",
      );
    return null;
  }
  return integerOption(options, "expected-pid");
}

function setIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function outputText(result: Record<string, unknown>): void {
  if (Array.isArray(result.rows)) {
    console.log(`count=${result.count ?? result.rows.length}`);
    console.log(FIELDS.join("\t"));
    for (const value of result.rows) {
      const row = value as LeaseRow;
      console.log(FIELDS.map((field) => row[field] ?? "").join("\t"));
    }
    for (const key of ["released", "gc_removed"]) {
      if (key in result) console.log(`${key}=${result[key]}`);
    }
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    console.log(
      `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`,
    );
  }
}

function common(options: Map<string, string | true>): {
  scopeId: string;
  service: string;
} {
  return {
    scopeId: required(options, "scope-id", "workspace-id"),
    service: required(options, "service"),
  };
}

function normalizeArguments(argv: string[]): string[] {
  const flags = new Set([
    "--json",
    "--refresh-claimed-at",
    "--expect-empty-pid",
  ]);
  const positional = argv.filter((value) => !flags.has(value));
  return [...positional, ...argv.filter((value) => flags.has(value))];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(normalizeArguments(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const command = parsed.positional[0];
  if (!command) {
    console.error(
      "usage: allocate|suggest|register|heartbeat|release-service|release-scope|inspect|gc",
    );
    return 2;
  }
  const options = parsed.options;
  try {
    const registry = new PortRegistry(
      option(options, "registry-dir") ?? defaultRegistryDir(),
    );
    const lockTimeoutSec = numberOption(options, "lock-timeout-sec", 10);
    const ttlHours = numberOption(options, "ttl-hours", DEFAULT_TTL_HOURS);
    const lock = { lockTimeoutSec, ttlHours };
    let result: Record<string, unknown>;
    if (command === "allocate") {
      const { scopeId, service } = common(options);
      const input: Parameters<PortRegistry["allocate"]>[0] = {
        ...lock,
        scopeId,
        service,
        project: required(options, "project"),
        repoRoot: required(options, "repo-root"),
        branch: required(options, "branch"),
        worktreePath: required(options, "worktree-path"),
        startBase: numberOption(options, "start-base", DEFAULT_START_BASE),
        step: numberOption(options, "step", DEFAULT_STEP),
        blockSize: numberOption(options, "block-size", DEFAULT_BLOCK_SIZE),
      };
      setIfDefined(input, "agentSession", option(options, "agent-session"));
      setIfDefined(input, "pid", integerOption(options, "pid"));
      result = await registry.allocate(input);
    } else if (command === "suggest") {
      const { scopeId, service } = common(options);
      result = await registry.suggest({
        ...lock,
        scopeId,
        service,
        startBase: numberOption(options, "start-base", DEFAULT_START_BASE),
        step: numberOption(options, "step", DEFAULT_STEP),
        blockSize: numberOption(options, "block-size", DEFAULT_BLOCK_SIZE),
      });
    } else if (command === "register") {
      const { scopeId, service } = common(options);
      const input: Parameters<PortRegistry["register"]>[0] = {
        ...lock,
        scopeId,
        service,
        port: requiredInteger(options, "port"),
        blockSize: numberOption(options, "block-size", DEFAULT_BLOCK_SIZE),
        refreshClaimedAt: options.has("refresh-claimed-at"),
      };
      setIfDefined(input, "project", option(options, "project"));
      setIfDefined(input, "repoRoot", option(options, "repo-root"));
      setIfDefined(input, "branch", option(options, "branch"));
      setIfDefined(input, "worktreePath", option(options, "worktree-path"));
      setIfDefined(input, "portBase", integerOption(options, "port-base"));
      setIfDefined(input, "agentSession", option(options, "agent-session"));
      setIfDefined(input, "pid", integerOption(options, "pid"));
      setIfDefined(input, "expectedPid", expectedPidOption(options));
      result = await registry.register(input);
    } else if (command === "heartbeat") {
      const { scopeId, service } = common(options);
      const input: Parameters<PortRegistry["heartbeat"]>[0] = {
        ...lock,
        scopeId,
        service,
      };
      setIfDefined(input, "agentSession", option(options, "agent-session"));
      setIfDefined(input, "pid", integerOption(options, "pid"));
      setIfDefined(
        input,
        "expectedPid",
        integerOption(options, "expected-pid"),
      );
      setIfDefined(input, "port", integerOption(options, "port"));
      result = await registry.heartbeat(input);
    } else if (command === "release-service") {
      const { scopeId, service } = common(options);
      const expected: { port?: number; pid?: number } = {};
      setIfDefined(expected, "port", integerOption(options, "port"));
      setIfDefined(expected, "pid", integerOption(options, "pid"));
      result = await registry.releaseService(
        scopeId,
        service,
        ttlHours,
        lockTimeoutSec,
        expected,
      );
    } else if (command === "release-scope" || command === "release-worktree") {
      result = await registry.releaseScope(
        required(options, "scope-id", "workspace-id"),
        ttlHours,
        lockTimeoutSec,
      );
    } else if (command === "inspect") {
      const filters: Parameters<PortRegistry["inspect"]>[0] = {};
      setIfDefined(
        filters,
        "scopeId",
        option(options, "scope-id", "workspace-id"),
      );
      setIfDefined(filters, "project", option(options, "project"));
      setIfDefined(filters, "repoRoot", option(options, "repo-root"));
      setIfDefined(filters, "branch", option(options, "branch"));
      setIfDefined(filters, "worktreePath", option(options, "worktree-path"));
      setIfDefined(filters, "service", option(options, "service"));
      setIfDefined(filters, "port", integerOption(options, "port"));
      result = await registry.inspect(filters, ttlHours, lockTimeoutSec);
    } else if (command === "gc") {
      result = await registry.gc(ttlHours, lockTimeoutSec);
    } else {
      throw new UsageError(`unsupported command: ${command}`);
    }
    if (options.has("json")) writeJson(result);
    else outputText(result);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${error.message}`);
      return 2;
    }
    if (error instanceof RegistryError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
