// Diagnostic only: preserve the exact fixed-check sandbox and its failure code.
import { resolve } from "node:path";
import { createCandidateSandbox } from "../../../skills/bin/modules/workspace/candidate_sandbox";

const candidate = resolve(process.argv[2]!);
const sandbox = createCandidateSandbox(candidate, process.env);
try {
  const result = await sandbox.run({
    command: process.execPath,
    args: ["-e", "console.log('candidate sandbox bootstrap')"],
    cwd: candidate,
  });
  console.log(
    JSON.stringify(
      {
        candidate_sha: Bun.spawnSync(["git", "rev-parse", "HEAD"])
          .stdout.toString()
          .trim(),
        platform: `${process.platform}-${process.arch}`,
        scenario: "fixed sandbox Bun bootstrap before any test import",
        returncode: result.exitCode,
        stdout: sandbox.redactOutput(result.stdout),
        stderr: sandbox.redactOutput(result.stderr),
      },
      null,
      2,
    ),
  );
  process.exitCode = result.exitCode;
} finally {
  sandbox.cleanup();
}
