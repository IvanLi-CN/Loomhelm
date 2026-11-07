import type { CliArguments } from "../core/cli";

export interface PlanArgumentSpec {
  flags: readonly string[];
  values: readonly string[];
}

export class PlanArgumentError extends Error {}

export function normalizePlanArgumentAliases(
  args: readonly string[],
): string[] {
  const normalized = args.map((argument) =>
    argument === "-h" ? "--help" : argument,
  );
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    if (argument === "--") break;
    if (argument !== "--input" && argument !== "--output") continue;
    const next = normalized[index + 1];
    if (next === undefined || next.startsWith("--"))
      throw new PlanArgumentError(`option ${argument} requires a value`);
  }
  return normalized;
}

export function assertPlanArguments(
  args: CliArguments,
  spec: PlanArgumentSpec,
): void {
  const allowed = new Set([...spec.flags, ...spec.values]);
  for (const name of spec.values)
    if (args.options.get(name) === true)
      throw new PlanArgumentError(`option --${name} requires a value`);
  const unknown = [...args.options.keys()].filter((name) => !allowed.has(name));
  if (unknown.length)
    throw new PlanArgumentError(`unrecognized option: --${unknown.sort()[0]}`);
  if (args.positional.length)
    throw new PlanArgumentError(`unrecognized argument: ${args.positional[0]}`);
  for (const name of spec.flags)
    if (args.options.has(name) && args.options.get(name) !== true)
      throw new PlanArgumentError(`option --${name} does not accept a value`);
}

export const ACCEPTANCE_USAGE = `usage: plan_acceptance_manifest.ts [-h] [--input INPUT] [--output OUTPUT]
                                   [--require-empirical]
                                   [--require-scoped-acceptance] [--require-phase]

options:
  -h, --help            show this help message and exit
  --input INPUT
  --output OUTPUT
  --require-empirical
  --require-scoped-acceptance
  --require-phase
`;

export const REVIEW_USAGE = `usage: plan_review_view.ts [-h] [--input INPUT]

Finalize an explicit dev-plan and render its transient owner-facing view.

options:
  -h, --help     show this help message and exit
  --input INPUT  canonical raw-plan Markdown path inside the candidate
                 Worktree, or - for stdin
`;
