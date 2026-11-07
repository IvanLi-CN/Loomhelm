import { readFile } from "node:fs/promises";
import { parseArguments, writeJson } from "../core/cli";
import { evaluateCloseoutGate } from "./closeout_gate";

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
    const inputFile = option(parsed.options, "input-file");
    const inputJson = option(parsed.options, "input-json");
    if (!inputFile && !inputJson)
      throw new Error("one of --input-file or --input-json is required");
    const raw = JSON.parse(
      inputFile ? await readFile(inputFile, "utf8") : inputJson!,
    );
    const result = evaluateCloseoutGate(raw as Record<string, unknown>);
    if (parsed.options.has("pretty"))
      console.log(JSON.stringify(result, null, 2));
    else writeJson(result);
    return 0;
  } catch (error) {
    console.error(
      `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
