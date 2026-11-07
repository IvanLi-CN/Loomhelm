import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments } from "../core/cli";
import {
  assertUtf8Text,
  InputEncodingError,
  readStdinUtf8,
} from "../core/utf8";
import {
  assertPlanArguments,
  normalizePlanArgumentAliases,
  PlanArgumentError,
  REVIEW_USAGE,
} from "./cli";
import {
  assertCandidateRootStable,
  readCandidateText as readSecureCandidateText,
} from "./io";
import {
  canonicalFacts,
  acceptanceOptions,
  expectedAcceptanceLines,
  expectedBatchCardLines,
  expectedTaskCardLines,
  projectionFindings,
  renderProjection,
  type Finding,
} from "./projection";
import {
  sectionHeadingCount,
  unfencedMarkerLines,
  validateFencedBlocks,
} from "./markdown";
import { parseAcceptance } from "./acceptance";
import { validateCanonicalRawPlan } from "./contract";

export interface PlanValidationResult {
  status: "pass" | "reject";
  mode: "explicit-dev-plan";
  findings: Finding[];
  output: string | null;
  execution: "allowed" | "blocked";
}
function sourcePath(): string {
  return process.env.PLAN_REVIEW_ENTRYPOINT_PATH ?? fileURLToPath(import.meta.url);
}
function moduleRoot(): string {
  return process.env.PLAN_REVIEW_ENTRYPOINT_PATH
    ? resolve(dirname(sourcePath()), "../..")
    : resolve(dirname(sourcePath()), "../../../..");
}
export function candidateRoot(): string {
  return process.env.PLAN_CONTRACT_REPO_ROOT ?? moduleRoot();
}
function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = current.endsWith("/")
      ? `${current}${part}`
      : `${current}/${part}`;
    const entry = lstatSync(current);
    if (entry.isSymbolicLink())
      throw new Error(`DEV_PLAN_SOURCE_SYMLINK_FORBIDDEN: ${current}`);
  }
}
function assertNotHardlink(path: string): void {
  const entry = lstatSync(path);
  if (entry.isFile() && entry.nlink !== 1)
    throw new Error(`DEV_PLAN_SOURCE_HARDLINK_FORBIDDEN: ${path}`);
}
export function validatedCandidateRoot(): string {
  const source = sourcePath();
  assertNoSymlinkComponents(source);
  assertNotHardlink(source);
  const root = candidateRoot();
  assertNoSymlinkComponents(root);
  assertCandidateRootStable(root);
  return root;
}
export async function readCandidateInput(rawPath: string): Promise<string> {
  const root = validatedCandidateRoot();
  const requested =
    rawPath === "-"
      ? root
      : isAbsolute(rawPath)
        ? resolve(rawPath)
        : resolve(root, rawPath);
  const relativePath = relative(root, requested);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  )
    throw new Error(
      "PLAN_REVIEW_VIEW_INPUT_OUTSIDE_CANDIDATE: --input must resolve inside the candidate Worktree",
    );
  return readSecureCandidateText(requested, root);
}

export async function validateRawPlan(
  plan: string,
  signal?: AbortSignal,
): Promise<Finding[]> {
  try {
    assertUtf8Text(plan);
  } catch {
    return [
      {
        code: "DEV_PLAN_INPUT_ENCODING_INVALID",
        message: "projection input must be valid UTF-8",
      },
    ];
  }
  if (plan.includes("\0"))
    return [
      {
        code: "DEV_PLAN_INPUT_NUL_FORBIDDEN",
        message: "projection input must not contain NUL bytes",
      },
    ];
  if (
    unfencedMarkerLines(plan, "<proposed_plan>").length ||
    unfencedMarkerLines(plan, "</proposed_plan>").length
  )
    return [
      {
        code: "DEV_PLAN_LEGACY_INPUT_FORBIDDEN",
        message:
          "projection accepts canonical raw-plan Markdown, not a proposed_plan wrapper",
      },
    ];
  try {
    validateFencedBlocks(plan);
  } catch (error) {
    return [
      {
        code: "DEV_PLAN_FENCED_BLOCK_INVALID",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  try {
    validatedCandidateRoot();
    if (signal?.aborted) throw new Error("plan review aborted");
    return validateCanonicalRawPlan(plan);
  } catch (error) {
    if (signal?.aborted) throw error;
    return [
      {
        code: "DEV_PLAN_FINALIZER_CHECKER_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

export async function finalize(
  plan: string,
  signal?: AbortSignal,
): Promise<PlanValidationResult> {
  if (signal?.aborted) throw new Error("plan review aborted");
  const hasWrapper =
    unfencedMarkerLines(plan, "<proposed_plan>").length > 0 ||
    unfencedMarkerLines(plan, "</proposed_plan>").length > 0;
  if (!hasWrapper)
    for (const name of ["Flow Decision", "Task Orchestration"])
      if (sectionHeadingCount(plan, name) > 1)
        return {
          status: "reject",
          mode: "explicit-dev-plan",
          findings: [
            {
              code: "DEV_PLAN_DUPLICATE_ROUTING_SECTION",
              message: `explicit dev-plan contains more than one ${name} section`,
            },
          ],
          output: null,
          execution: "blocked",
        };
  const rawFindings = await validateRawPlan(plan, signal);
  if (signal?.aborted) throw new Error("plan review aborted");
  if (rawFindings.length)
    return {
      status: "reject",
      mode: "explicit-dev-plan",
      findings: rawFindings,
      output: null,
      execution: "blocked",
    };
  try {
    const [batches] = canonicalFacts(plan);
    const output = renderProjection(plan, batches);
    const acceptance = parseAcceptance(plan, acceptanceOptions(plan));
    const findings = projectionFindings(
      output,
      batches,
      new Set(acceptance.items.map((item) => item.id)),
      expectedBatchCardLines(batches),
      expectedTaskCardLines(batches),
      expectedAcceptanceLines(plan),
    );
    if (findings.length)
      return {
        status: "reject",
        mode: "explicit-dev-plan",
        findings,
        output: null,
        execution: "blocked",
      };
    return {
      status: "pass",
      mode: "explicit-dev-plan",
      findings: [],
      output,
      execution: "allowed",
    };
  } catch {
    return {
      status: "reject",
      mode: "explicit-dev-plan",
      findings: [
        {
          code: "DEV_PLAN_CANONICAL_FACTS_INVALID",
          message:
            "canonical facts could not be derived from the validated raw-plan",
        },
      ],
      output: null,
      execution: "blocked",
    };
  }
}

export async function render(plan: string): Promise<string> {
  const result = await finalize(plan);
  if (result.status !== "pass" || result.output === null) {
    const finding = result.findings[0] ?? {
      code: "DEV_PLAN_FINALIZATION_REJECTED",
      message: "plan rejected",
    };
    throw new Error(`${finding.code}: ${finding.message}`);
  }
  return result.output;
}

export interface CliWriters {
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  signal?: AbortSignal;
}

export async function cli(
  argv = process.argv.slice(2),
  writers: CliWriters = {},
): Promise<number> {
  const writeStdout =
    writers.stdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr =
    writers.stderr ?? ((value: string) => process.stderr.write(value));
  try {
    const parsed = parseArguments(normalizePlanArgumentAliases(argv));
    assertPlanArguments(parsed, { values: ["input"], flags: ["help"] });
    if (parsed.options.has("help")) {
      writeStdout(REVIEW_USAGE);
      return 0;
    }
    const rawInput = parsed.options.get("input");
    const input = typeof rawInput === "string" ? rawInput : "-";
    const plan =
      input === "-"
        ? await readStdinUtf8(writers.signal)
        : await readCandidateInput(input);
    const result = await finalize(plan, writers.signal);
    if (result.status === "pass" && result.output !== null) {
      writeStdout(`<proposed_plan>\n${result.output}\n</proposed_plan>\n`);
      return 0;
    }
    writeStderr(
      `plan_validation:\n  status: reject\n  mode: explicit-dev-plan\n  findings:\n${result.findings.map((finding) => `    - code: ${finding.code}\n      message: ${finding.message}`).join("\n")}\n  output: none\n  execution: blocked\n`,
    );
    return 1;
  } catch (error) {
    if (error instanceof PlanArgumentError) {
      writeStderr(`${REVIEW_USAGE}\nerror: ${error.message}\n`);
      return 2;
    }
    const code =
      error instanceof InputEncodingError
        ? "DEV_PLAN_INPUT_ENCODING_INVALID"
        : "DEV_PLAN_FINALIZATION_INPUT_INVALID";
    writeStderr(
      `plan_validation:\n  status: reject\n  mode: explicit-dev-plan\n  findings:\n    - code: ${code}\n      message: ${error instanceof Error ? error.message : String(error)}\n  output: none\n  execution: blocked\n`,
    );
    return 1;
  }
}
