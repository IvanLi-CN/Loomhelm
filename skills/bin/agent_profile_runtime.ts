import { Runtime } from "./modules/core/runtime";
import { parseArguments } from "./modules/core/cli";
import { attestNativeProfile } from "./modules/flow/profile-attest";
import { runHook } from "./modules/flow/profile-hook";
import { canonicalJson, FlowError } from "./modules/flow/common";

async function readStdinJson(): Promise<Record<string, unknown>> {
  const text = await new Response(Runtime.stdin.stream()).text();
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new FlowError("hook input is not an object");
  return value as Record<string, unknown>;
}

function required(options: Map<string, string | true>, name: string): string {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim())
    throw new FlowError(`missing required option --${name}`);
  return value;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${canonicalJson(value)}\n`);
}

async function main(): Promise<number> {
  if (
    process.argv.slice(2).some((value) => value === "--help" || value === "-h")
  ) {
    console.log(
      "Usage: bun skills/bin/agent_profile_runtime.ts <hook|attest> [options]",
    );
    return 0;
  }
  const args = parseArguments(process.argv.slice(2));
  const action = args.positional[0];
  if (action === "hook") {
    const permitsRoot =
      typeof args.options.get("permit-state-dir") === "string"
        ? (args.options.get("permit-state-dir") as string)
        : undefined;
    writeJson(runHook(await readStdinJson(), permitsRoot));
    return 0;
  }
  if (action !== "attest")
    throw new FlowError("an action is required: hook or attest");
  writeJson(
    attestNativeProfile({
      sessionsRoot: required(args.options, "sessions-root"),
      taskName: required(args.options, "task-name"),
      agentType: required(args.options, "agent-type"),
      preferredModel: required(args.options, "preferred-model"),
      preferredEffort: required(args.options, "preferred-effort"),
      permitsRoot:
        typeof args.options.get("permit-state-dir") === "string"
          ? (args.options.get("permit-state-dir") as string)
          : undefined,
      expectedChildThreadId:
        typeof args.options.get("child-thread-id") === "string"
          ? (args.options.get("child-thread-id") as string)
          : undefined,
      expectedRepositoryHead:
        typeof args.options.get("expected-repository-head") === "string"
          ? (args.options.get("expected-repository-head") as string)
          : undefined,
      requiredForkTurns:
        typeof args.options.get("required-fork-turns") === "string"
          ? (args.options.get("required-fork-turns") as string)
          : undefined,
      expectedResultSha256:
        typeof args.options.get("expected-result-sha256") === "string"
          ? (args.options.get("expected-result-sha256") as string)
          : undefined,
    }),
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  writeJson({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 2;
}
