import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArguments } from "./modules/core/cli";
import { canonicalJson, FlowError } from "./modules/flow/common";
import { gitCommit, requireCleanCurrentHead } from "./modules/flow/git";
import { FlowLedger, gitLedgerRoot } from "./modules/flow/ledger";
import { parseLaneSpec } from "./modules/flow/review";

function value(
  options: Map<string, string | true>,
  name: string,
  required = true,
): string | undefined {
  const result = options.get(name);
  if (typeof result !== "string" || !result.trim()) {
    if (required) throw new FlowError(`missing required option --${name}`);
    return undefined;
  }
  return result;
}

function values(argv: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== `--${name}`) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) result.push(next);
  }
  return result;
}

function jsonOption(
  options: Map<string, string | true>,
  name: string,
): unknown {
  const raw = value(options, name, false);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new FlowError(`${name} JSON is not valid`, { cause: error });
  }
}

function fileJson(repo: string, path: string | undefined): unknown {
  if (!path) throw new FlowError("required JSON file is missing");
  const resolved = resolve(repo, path);
  if (!existsSync(resolved)) throw new FlowError("JSON file does not exist");
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new FlowError("JSON file is not valid", { cause: error });
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${canonicalJson(value)}\n`);
}

async function main(argv: string[]): Promise<number> {
  if (argv.some((value) => value === "--help" || value === "-h")) {
    process.stdout.write("Usage: bun skills/bin/flow_receipt.ts <action> [options]\n");
    return 0;
  }
  const parsed = parseArguments(argv);
  const repo = resolve(value(parsed.options, "repo", false) ?? process.cwd());
  const ledger = new FlowLedger(gitLedgerRoot(repo), repo);
  const action = parsed.positional[0];
  if (!action) throw new FlowError("an action is required");
  if (action === "init") {
    const baseSha = gitCommit(repo, value(parsed.options, "base-sha")!);
    const [headSha] = requireCleanCurrentHead(
      repo,
      value(parsed.options, "head-sha")!,
    );
    writeJson(
      ledger.init(
        value(parsed.options, "run-id", false),
        value(parsed.options, "flow-type")!,
        baseSha,
        headSha,
        value(parsed.options, "pr-ref", false),
        value(parsed.options, "acceptance-manifest", false),
      ),
    );
    return 0;
  }
  if (action === "acceptance-register") {
    writeJson(
      ledger.registerAcceptanceManifest(
        value(parsed.options, "manifest-file")!,
      ),
    );
    return 0;
  }
  if (action === "bind-pr") {
    writeJson(ledger.bindPr(value(parsed.options, "pr-ref")!));
    return 0;
  }
  if (action === "review-assess") {
    writeJson(
      ledger.assessReviewNecessity(
        Number(value(parsed.options, "tier")!),
        value(parsed.options, "reason")!,
      ),
    );
    return 0;
  }
  if (action === "status") {
    writeJson(ledger.status());
    return 0;
  }
  if (action === "close") {
    writeJson(ledger.close(value(parsed.options, "state")!));
    return 0;
  }
  if (action === "classify") {
    writeJson(
      ledger.classifyGitDelta(
        value(parsed.options, "source-head")!,
        value(parsed.options, "head-sha", false) ?? "HEAD",
      ),
    );
    return 0;
  }
  if (action === "review-wave") {
    const subaction = parsed.positional[1];
    if (subaction === "open") {
      const laneSpecs = values(argv, "lane").map(parseLaneSpec);
      writeJson(
        ledger.openReviewWave({
          stage: value(parsed.options, "stage")!,
          baseRef: value(parsed.options, "base-ref")!,
          headSha: value(parsed.options, "head-sha", false),
          laneSpecs,
          scopeClass: value(parsed.options, "scope-class", false),
          previousHeadSha: value(parsed.options, "previous-head-sha", false),
          repairPermitId: value(parsed.options, "repair-permit-id", false),
          highRequirement: parsed.options.has("high-requirement"),
          arbitrationConflicts: values(argv, "arbitration-conflict"),
          arbitrationBlockerFingerprints: values(
            argv,
            "arbitration-blocker-fingerprint",
          ),
        }),
      );
      return 0;
    }
    if (subaction === "finalize") {
      writeJson(
        ledger.finalizeReviewWave(
          value(parsed.options, "wave-id")!,
          value(parsed.options, "synthesis-file", false)
            ? fileJson(repo, value(parsed.options, "synthesis-file", false))
            : undefined,
        ),
      );
      return 0;
    }
    if (subaction === "authorize-repair") {
      writeJson(ledger.authorizeRepair(value(parsed.options, "wave-id")!));
      return 0;
    }
    throw new FlowError("unsupported review-wave action");
  }
  if (action === "convergence-reopen") {
    writeJson(
      ledger.reopenConvergence({
        authorizationRef: value(parsed.options, "authorization-ref")!,
        authorizationTextSha256: value(
          parsed.options,
          "authorization-text-sha256",
        )!,
        reason: value(parsed.options, "reason")!,
        prRef: value(parsed.options, "pr-ref")!,
        userMessageId: value(parsed.options, "user-message-id")!,
        baseRef: value(parsed.options, "base-ref")!,
        headSha: value(parsed.options, "head-sha", false),
      }),
    );
    return 0;
  }
  if (action !== "record") throw new FlowError(`unsupported action: ${action}`);
  const kind = value(parsed.options, "kind")!;
  if (kind === "post-merge") {
    writeJson(
      ledger.recordPostMerge(
        value(parsed.options, "post-merge-evidence-file")!,
      ),
    );
    return 0;
  }
  if (kind === "acceptance") {
    const evidence = value(parsed.options, "acceptance-evidence-json", false)
      ? jsonOption(parsed.options, "acceptance-evidence-json")
      : fileJson(
          repo,
          value(parsed.options, "acceptance-evidence-file", false),
        );
    writeJson(
      ledger.recordPhaseAcceptance(
        evidence,
        value(parsed.options, "merge-sha")!,
        jsonOption(parsed.options, "deployment-identity-json"),
      ),
    );
    return 0;
  }
  if (kind === "review") {
    writeJson(
      ledger.recordSubagentReview({
        reviewProfile: value(parsed.options, "review-profile")!,
        baseRef: value(parsed.options, "base-ref")!,
        reviewModel: value(parsed.options, "review-model")!,
        reviewEffort: value(parsed.options, "review-effort")!,
        reviewResultJson:
          value(parsed.options, "review-result-json", false) ?? "",
        terminalState:
          (value(parsed.options, "review-terminal-state", false) as
            "completed" | "unavailable" | undefined) ?? "completed",
        unavailabilityClassification: value(
          parsed.options,
          "review-unavailability-classification",
          false,
        ),
        headSha: value(parsed.options, "head-sha", false),
        waveId: value(parsed.options, "wave-id", false),
        lane: value(parsed.options, "lane", false),
      }),
    );
    return 0;
  }
  if (kind === "convergence") {
    writeJson(ledger.recordConvergence(values(argv, "blocker")));
    return 0;
  }
  if (kind === "attestation") {
    writeJson(
      ledger.recordAttestation(
        value(parsed.options, "source-receipt-id")!,
        value(parsed.options, "head-sha")!,
        value(parsed.options, "base-ref")!,
      ),
    );
    return 0;
  }
  if (kind === "validation") {
    const command = value(parsed.options, "command")!;
    const evidence = value(parsed.options, "acceptance-evidence-json", false)
      ? jsonOption(parsed.options, "acceptance-evidence-json")
      : value(parsed.options, "acceptance-evidence-file", false)
        ? fileJson(
            repo,
            value(parsed.options, "acceptance-evidence-file", false),
          )
        : undefined;
    writeJson(
      await ledger.runValidation(
        command,
        value(parsed.options, "toolchain-fingerprint")!,
        value(parsed.options, "input-fingerprint")!,
        {
          headSha: value(parsed.options, "head-sha", false),
          logPath: value(parsed.options, "log-path", false),
          retryStateFingerprint: value(
            parsed.options,
            "retry-state-fingerprint",
            false,
          ),
          inputPaths: values(argv, "input-path"),
          acceptanceEvidence: evidence,
        },
      ),
    );
    return 0;
  }
  throw new FlowError(`unsupported record kind: ${kind}`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  writeJson({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = error instanceof FlowError ? 2 : 2;
}
