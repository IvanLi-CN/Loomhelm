import { basename } from "node:path";
import { docs } from "./compatibility_docs";

export async function runCompatibilityCli(name: string, argv: string[] = process.argv.slice(2)): Promise<number> {
  const smoke = argv.includes("--compatibility-smoke");
  const help = argv.includes("--help") || argv.includes("-h");
  if (help && !smoke) { console.log(`Usage: bun ${name}.ts [options]`); return 0; }
  const result = docs(basename(name).replace(/\.ts$/, ""), argv.filter(value => value !== "--compatibility-smoke"));
  if (smoke && (result === 0 || help)) console.log(`SMOKE dispatched=${basename(name).replace(/\.ts$/, "")}`);
  if (help) { if (result === 0) return 0; console.log(`Usage: bun ${name}.ts [options]`); return 0; }
  return result;
}
