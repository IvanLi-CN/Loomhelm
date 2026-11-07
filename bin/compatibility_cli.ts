import { basename } from "node:path";
import { dispatch } from "./compatibility_dispatch";

export async function runCompatibilityCli(
  name: string,
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const smoke = argv.includes("--compatibility-smoke");
  const help = argv.includes("--help") || argv.includes("-h");
  if (help && !smoke) {
    console.log(`Usage: bun ${name}.ts [options]`);
    return 0;
  }
  const result = await dispatch(
    basename(name).replace(/\.ts$/, ""),
    argv.filter((value) => value !== "--compatibility-smoke"),
  );
  if (smoke && (result === 0 || help))
    console.log(`SMOKE dispatched=${basename(name).replace(/\.ts$/, "")}`);
  if (help) {
    if (result === 0) return 0;
    console.log(`Usage: bun ${name}.ts [options]`);
    return 0;
  }
  return result;
}

if (import.meta.main) {
  const rawArguments = process.argv.slice(2);
  const command = rawArguments[0]?.startsWith("--")
    ? undefined
    : rawArguments[0];
  process.exitCode = await runCompatibilityCli(
    command ?? process.argv[1] ?? "compatibility_cli.ts",
    command ? rawArguments.slice(1) : rawArguments,
  );
}
