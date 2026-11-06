import { Runtime } from "./modules/core/runtime";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditReport } from "./modules/visual/report_audit";
import { createReport } from "./modules/visual/report_create";
import { compareVisualEvidence } from "./modules/visual/compare";
import { documentMain } from "./modules/visual/document";
import { gateMain } from "./modules/visual/gate";
import { snapshotMain } from "./modules/visual/snapshot";
import { trimFile } from "./modules/visual/trim";
import { runPrBodyGate } from "./modules/visual/pr_body_gate";
import { exitCodeForGateState } from "./modules/visual/pr_body_gate_result";
import { evaluateContractCase } from "./modules/visual/pr_body_gate_contract";
import {
  groups,
  json,
  option,
  positional,
  rootFor,
  values,
} from "./compatibility_shared";

export async function visual(name: string, argv: string[]): Promise<number> {
  if (name === "owner_facing_image_gate")
    return gateMain(await new Response(Runtime.stdin.stream()).text());
  if (name === "pr_body_image_gate") {
    try {
      const result = await runPrBodyGate(argv, rootFor(argv));
      json(result);
      return exitCodeForGateState(result.state);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 30;
    }
  }
  if (name === "snapshot_local_image") return snapshotMain(argv);
  if (name === "visual_evidence_document") return documentMain(argv);
  if (name === "pr_body_image_contract_check") return contractCases(argv);
  if (name === "create_reg_cli_report") return report(argv);
  if (name === "compare_visual_evidence") return compare(argv);
  if (name === "trim_whitespace") return trim(argv);
  return 2;
}

function contractCases(argv: string[]): number {
  const casesPath = option(
    argv,
    "cases",
    resolve("skills/ui-visual-evidence/replay/cases.json"),
  )!;
  try {
    const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    let failed = 0;
    for (const item of cases) {
      const ok = evaluateContractCase(item).ok;
      console.log(`${ok ? "PASS" : "FAIL"} ${String(item.name ?? "case")}`);
      if (!ok) failed += 1;
    }
    return failed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function report(argv: string[]): number {
  const action = positional(argv)[0];
  try {
    if (action === "audit") {
      const result = auditReport(positional(argv)[1]!);
      json(result);
      return result.status === "ok" ? 0 : 1;
    }
    const pairs = groups(argv, "pair", 3).map(([name, expected, actual]) => ({
      name: name!,
      expected: expected!,
      actual: actual!,
    }));
    json(createReport({ cwd: option(argv, "cwd", process.cwd())!, pairs }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function compare(argv: string[]): Promise<number> {
  const raw = values(argv, "candidate");
  const candidates: Array<[string, string]> = [];
  for (let index = 0; index < raw.length; index += 2)
    candidates.push([raw[index]!, raw[index + 1]!]);
  try {
    json(
      await compareVisualEvidence(
        option(argv, "base-sha")!,
        candidates,
        option(argv, "output-dir")!,
        rootFor(argv),
      ),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function trim(argv: string[]): Promise<number> {
  const [input, output] = positional(argv);
  if (!input || !output) return 2;
  try {
    const options: Parameters<typeof trimFile>[2] = {
      borderWidth: Number(option(argv, "border-width", "2")),
      tolerance: Number(option(argv, "tolerance", "12")),
      minUniformity: Number(option(argv, "min-uniformity", "0.95")),
      minTrimPixels: Number(option(argv, "min-trim-pixels", "8")),
    };
    const marginPolicy = option(argv, "margin-policy");
    const evidenceSurface = option(argv, "evidence-surface");
    if (marginPolicy !== undefined) options.marginPolicy = marginPolicy;
    if (evidenceSurface !== undefined)
      options.evidenceSurface = evidenceSurface;
    json(await trimFile(input, output, options));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
