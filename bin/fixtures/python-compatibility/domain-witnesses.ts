import { SCENARIO_WITNESSES } from "./scenario-witnesses";
import type { ScenarioWitness } from "./domain-witness-types";

export type { ScenarioWitness } from "./domain-witness-types";

export function selectWitness(
  id: string,
  source: string,
): ScenarioWitness | undefined {
  const witness = SCENARIO_WITNESSES[id];
  if (!witness) return;
  if (!id.startsWith(`${source}::`)) return;
  return witness;
}

export function witnessSources(): string[] {
  return [
    ...new Set(
      Object.keys(SCENARIO_WITNESSES)
        .map((id) => id.split("::")[0])
        .filter((source): source is string => Boolean(source)),
    ),
  ];
}
