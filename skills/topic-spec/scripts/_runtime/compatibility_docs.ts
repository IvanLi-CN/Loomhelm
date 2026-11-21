import { verifyDocLocks } from "./modules/docs/hardware_locks";
import { ingestExtract } from "./modules/docs/hardware_ingest";
import { findNextPlan } from "./modules/docs/next_plan";
import { generateLegacySpecIds } from "./modules/docs/legacy_spec_id";
import { parseSpecDriftArgs, runSpecDrift } from "./modules/docs/spec_drift";
import {
  planSpecsHygiene,
  planSpecsMigration,
} from "./modules/docs/spec_migration";
import { json, option, rootFor } from "./compatibility_shared";

export function docs(name: string, argv: string[]): number {
  if (name === "verify_doc_locks") {
    const result = verifyDocLocks(rootFor(argv), {
      strictPdf: argv.includes("--strict-pdf"),
      checkPerms: !argv.includes("--no-check-perms"),
    });
    result.lines.forEach((line) => console.log(line));
    return result.exitCode;
  }
  if (name === "find_next_plan") {
    json(findNextPlan(option(argv, "repo", process.cwd())!));
    return 0;
  }
  if (name === "gen_legacy_spec_id") return legacyId(argv);
  if (name === "specs_migrate_guard") return migrateGuard(argv);
  if (name === "spec_drift_check") return drift(argv);
  if (name === "ingest_mineru_extract") return ingest(argv);
  return 2;
}

function legacyId(argv: string[]): number {
  const args: Parameters<typeof generateLegacySpecIds>[0] = {
    repoRoot: option(argv, "repo", process.cwd())!,
    legacyCompat: argv.includes("--legacy-compat"),
    count: Number(option(argv, "count", "1")),
    length: Number(option(argv, "length", "5")),
  };
  const alphabet = option(argv, "alphabet");
  if (alphabet !== undefined) args.alphabet = alphabet;
  const result = generateLegacySpecIds(args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

function migrateGuard(argv: string[]): number {
  const repo = option(argv, "repo", process.cwd())!;
  const source = option(argv, "source")!;
  const branch = option(argv, "branch");
  const legacyId = option(argv, "legacy-id");
  const topic = option(argv, "topic");
  const options = {
    ...(branch === undefined ? {} : { branch }),
    ...(legacyId === undefined ? {} : { legacyId }),
    ...(topic === undefined ? {} : { topic }),
  };
  const result =
    option(argv, "mode") === "specs-hygiene"
      ? planSpecsHygiene(repo, source, {
          ...options,
          renameConfirmed: argv.includes("--rename-confirmed"),
        })
      : planSpecsMigration(repo, source, options);
  json(result);
  return result.blocked_reason ? 1 : 0;
}

function drift(argv: string[]): number {
  const parsed = parseSpecDriftArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.help) {
    console.log(
      "Usage: spec_drift_check.ts [--base-ref <ref>] [--spec-path <path>]...",
    );
    return 0;
  }
  const result = runSpecDrift(parsed.options);
  json(result);
  return result.exitCode;
}

function ingest(argv: string[]): number {
  try {
    const args: Parameters<typeof ingestExtract>[0] = {
      extractPath: option(argv, "extract-path")!,
      destDir: option(argv, "dest-dir")!,
      slug: option(argv, "slug")!,
      overwrite: argv.includes("--overwrite"),
      addHeader: argv.includes("--add-header"),
      keepMineruJson: argv.includes("--keep-mineru-json"),
      writeLock: !argv.includes("--no-write-lock"),
      lockGenerated: !argv.includes("--writable-generated"),
      createReadme: !argv.includes("--no-readme"),
    };
    for (const [key, flag] of [
      ["docSubdir", "doc-subdir"],
      ["sourceUrl", "source-url"],
      ["docType", "doc-type"],
      ["vendor", "vendor"],
      ["part", "part"],
    ] as const) {
      const value = option(argv, flag);
      if (value !== undefined) args[key] = value;
    }
    ingestExtract(args).lines.forEach((line) => console.log(line));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
