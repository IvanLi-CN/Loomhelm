import { parseArguments } from "./modules/core/cli";
import { parseAcceptance } from "./modules/plan/acceptance";
import {
  ACCEPTANCE_USAGE,
  assertPlanArguments,
  normalizePlanArgumentAliases,
  PlanArgumentError,
} from "./modules/plan/cli";
import { readStdinUtf8 } from "./modules/core/utf8";
import {
  candidateRoot,
  readCandidateText,
  writeCandidateText,
} from "./modules/plan/io";
import { isAbsolute, resolve } from "node:path";

try {
  const { options, positional } = parseArguments(
    normalizePlanArgumentAliases(process.argv.slice(2)),
  );
  const spec = {
    values: ["input", "output"],
    flags: [
      "help",
      "require-empirical",
      "require-scoped-acceptance",
      "require-phase",
    ],
  } as const;
  assertPlanArguments({ options, positional }, spec);
  if (options.has("help")) process.stdout.write(ACCEPTANCE_USAGE);
  else {
    const input = options.get("input");
    const output = options.get("output");
    const root = candidateRoot();
    const resolveCliPath = (value: string): string =>
      isAbsolute(value) ? value : resolve(process.cwd(), value);
    const read =
      typeof input === "string"
        ? await readCandidateText(resolveCliPath(input), root)
        : await readStdinUtf8();
    const manifest = parseAcceptance(read, {
      requireEmpirical: options.has("require-empirical"),
      requireScopedAcceptance: options.has("require-scoped-acceptance"),
      requirePhase: options.has("require-phase"),
    });
    const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
    if (typeof output === "string")
      await writeCandidateText(resolveCliPath(output), rendered, root);
    else process.stdout.write(rendered);
  }
} catch (error) {
  if (error instanceof PlanArgumentError) {
    process.stderr.write(`${ACCEPTANCE_USAGE}\nerror: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
