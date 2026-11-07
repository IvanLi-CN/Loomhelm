import { parseArguments } from "../core/cli";
import { evaluateLocalMergeCloseoutGate } from "./local_merge_closeout_gate";

function option(
  options: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    const input = option(parsed.options, "input-json");
    if (!input) throw new Error("--input-json is required");
    const result = evaluateLocalMergeCloseoutGate(
      JSON.parse(input) as Record<string, unknown>,
    );
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(
      `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
