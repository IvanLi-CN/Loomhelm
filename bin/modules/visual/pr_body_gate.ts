import { execFileSync } from "node:child_process";
import { bindingFromRemote } from "../hosting/remote";
import { HostingError, type RepositoryBinding } from "../hosting/types";
import {
  defaultAlt,
  imageUrl,
  parseManaged,
  renderSection,
  replaceManaged,
  repoPath,
  type Image,
} from "./pr_body_gate_markdown";
import {
  readPullRequest,
  renderAndCheck,
  samePullRequestIdentity,
  type PullRequest,
} from "./pr_body_gate_provider";
import {
  PullRequestUpdateError,
  updatePullRequestBody,
} from "./pr_body_gate_update";
import { type GateResult } from "./pr_body_gate_result";
import { treeHas } from "./pr_body_gate_tree";

function bindingFromFullName(
  base: RepositoryBinding,
  fullName: string,
): RepositoryBinding {
  return bindingFromRemote(`https://${base.host}/${fullName}.git`, base.remote);
}

function gitRemote(root: string, remote: string): RepositoryBinding {
  let url: string;
  try {
    url = execFileSync(
      "git",
      ["-C", root, "config", "--get", `remote.${remote}.url`],
      {
        encoding: "utf8",
      },
    ).trim();
  } catch {
    throw new HostingError(
      "invalid_remote",
      "selected Git remote is unavailable",
      "pr-body-gate",
    );
  }
  return bindingFromRemote(url, remote);
}

function numberOption(argv: string[], name: string): number {
  const index = argv.findIndex((value) => value === `--${name}`);
  const raw =
    index >= 0
      ? argv[index + 1]
      : argv
          .find((value) => value.startsWith(`--${name}=`))
          ?.slice(name.length + 3);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new HostingError(
      "invalid_arguments",
      `--${name} must be a positive integer`,
      "pr-body-gate",
    );
  return value;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.findIndex((value) => value === `--${name}`);
  if (index >= 0) return argv[index + 1];
  return argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function hasOption(argv: string[], name: string): boolean {
  return (
    argv.includes(`--${name}`) ||
    argv.some((value) => value.startsWith(`--${name}=`))
  );
}

function baseResult(
  phase: "phase-a" | "phase-b",
  pr: PullRequest,
  base: RepositoryBinding,
  publish: RepositoryBinding,
  sha: string,
  reference: string,
  reasons: string[],
  state: GateResult["state"] = "blocked",
  selected: Image[] = [],
  output: string[] = [],
  bodyChanged = false,
): GateResult {
  return {
    state,
    phase,
    pr_number: pr.number,
    target_sha: sha,
    target_ref: reference,
    target_ref_kind: phase === "phase-a" ? "branch" : "commit",
    selected_images: selected.map((image) => image.path),
    output_images: output,
    reasons: [...new Set(reasons)].sort(),
    base_repo: base.fullName,
    publish_repo: publish.fullName,
    body_changed: bodyChanged,
  };
}

export async function runPrBodyGate(
  argv: string[],
  root: string,
): Promise<GateResult> {
  const phase = optionValue(argv, "phase");
  if (phase !== "phase-a" && phase !== "phase-b")
    throw new HostingError(
      "invalid_arguments",
      "--phase must be phase-a or phase-b",
      "pr-body-gate",
    );
  const phaseName = phase as "phase-a" | "phase-b";
  const number = numberOption(argv, "pr-number");
  const remote = optionValue(argv, "remote") ?? "origin";
  const base = gitRemote(root, remote);
  const requestedRepo = optionValue(argv, "repo");
  if (
    requestedRepo &&
    requestedRepo.toLowerCase() !== base.fullName.toLowerCase()
  )
    throw new HostingError(
      "cross_repository",
      "PR repository does not match the selected base remote",
      phaseName,
    );
  const pr = await readPullRequest(root, base, number);
  if (phaseName === "phase-a" && pr.state !== "OPEN")
    return baseResult(phaseName, pr, base, base, pr.head_sha, pr.head_ref, [
      "phase-a_requires_open_pr",
    ]);
  if (phaseName === "phase-b" && pr.state !== "MERGED")
    return baseResult(phaseName, pr, base, base, pr.merge_sha, pr.merge_sha, [
      "phase-b_requires_merged_pr",
    ]);
  const publish =
    phaseName === "phase-a" && pr.head_repository
      ? bindingFromFullName(base, pr.head_repository)
      : base;
  const targetSha = phaseName === "phase-a" ? pr.head_sha : pr.merge_sha;
  const targetRef = phaseName === "phase-a" ? pr.head_ref : pr.merge_sha;
  if (!/^[0-9a-f]{40}$/i.test(targetSha))
    return baseResult(phaseName, pr, base, publish, targetSha, targetRef, [
      `${phaseName}_requires_target_sha`,
    ]);

  const head = pr.head_repository
    ? bindingFromFullName(base, pr.head_repository)
    : undefined;
  if (phaseName === "phase-a" && !head)
    return baseResult(phaseName, pr, base, base, targetSha, targetRef, [
      "phase-a_requires_head_repository",
    ]);
  if (phaseName === "phase-b" && !head)
    return baseResult(phaseName, pr, base, base, targetSha, targetRef, [
      "phase-b_requires_head_repository",
    ]);

  let selected: Image[] = [];
  if (phaseName === "phase-a") {
    const evidence: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const value = argv[index]!;
      if (value === "--evidence" && argv[index + 1]) {
        evidence.push(argv[++index]!);
      } else if (value.startsWith("--evidence=")) {
        evidence.push(value.slice("--evidence=".length));
      }
    }
    const noEvidence = hasOption(argv, "no-evidence");
    if (evidence.length && noEvidence)
      return baseResult(phaseName, pr, base, publish, targetSha, targetRef, [
        "evidence_and_no_evidence_are_mutually_exclusive",
      ]);
    if (!evidence.length && !noEvidence)
      return baseResult(phaseName, pr, base, publish, targetSha, targetRef, [
        "missing_task_evidence_declaration",
      ]);
    if (evidence.length) {
      const reasons: string[] = [];
      const seen = new Set<string>();
      for (const raw of evidence) {
        const path = repoPath(raw, root);
        if (!path) {
          reasons.push(`evidence_path_invalid:${raw}`);
          continue;
        }
        if (seen.has(path)) continue;
        seen.add(path);
        if (!(await treeHas(root, publish, targetSha, path)))
          reasons.push(`evidence_not_in_pr_head:${path}`);
        else selected.push({ path, alt: defaultAlt(path) });
      }
      if (reasons.length)
        return baseResult(
          phaseName,
          pr,
          base,
          publish,
          targetSha,
          targetRef,
          reasons,
          "blocked",
          selected,
        );
    }
  } else {
    const parsed = parseManaged(pr.body, head!, pr.head_ref);
    if (parsed.state === "blocked")
      return baseResult(
        phaseName,
        pr,
        base,
        publish,
        targetSha,
        targetRef,
        parsed.reasons,
      );
    selected = parsed.images;
    if (parsed.state === "selected") {
      const missing: Image[] = [];
      for (const image of selected)
        if (!(await treeHas(root, publish, targetSha, image.path)))
          missing.push(image);
      if (missing.length)
        return baseResult(
          phaseName,
          pr,
          base,
          publish,
          targetSha,
          targetRef,
          missing.map(
            (image) =>
              `managed_section_image_not_in_merge_commit:${image.path}`,
          ),
          "blocked",
          selected,
        );
    }
  }

  const rewritten = replaceManaged(
    pr.body,
    renderSection(selected, publish, targetRef),
  );
  const output = selected.map((image) =>
    imageUrl(publish, targetRef, image.path),
  );
  const expectedState = selected.length ? "selected" : "explicit_no_image";
  const parsedRewrite = parseManaged(rewritten, publish, targetRef);
  if (parsedRewrite.state !== expectedState)
    return {
      ...baseResult(
        phaseName,
        pr,
        base,
        publish,
        targetSha,
        targetRef,
        ["managed_section_state_mismatch"],
        "update_failed",
        selected,
        output,
        rewritten !== pr.body,
      ),
      rewritten_body: rewritten,
    };
  if (rewritten !== pr.body) {
    try {
      await updatePullRequestBody(root, base, pr, rewritten);
    } catch (error) {
      return {
        ...baseResult(
          phaseName,
          pr,
          base,
          publish,
          targetSha,
          targetRef,
          [
            error instanceof PullRequestUpdateError
              ? error.reason
              : `pr_body_update_failed:${error instanceof Error ? error.message : String(error)}`,
          ],
          "update_failed",
          selected,
          output,
          true,
        ),
        rewritten_body: rewritten,
      };
    }
  }
  try {
    const refreshed = await readPullRequest(root, base, number);
    if (!samePullRequestIdentity(pr, refreshed) || refreshed.body !== rewritten)
      return {
        ...baseResult(
          phaseName,
          refreshed,
          base,
          publish,
          targetSha,
          targetRef,
          ["pr_identity_changed_after_update"],
          "update_failed",
          selected,
          output,
          rewritten !== pr.body,
        ),
        rewritten_body: rewritten,
      };
    const reasons = await renderAndCheck(root, base, refreshed.body, output);
    return {
      ...baseResult(
        phaseName,
        refreshed,
        base,
        publish,
        targetSha,
        targetRef,
        reasons,
        reasons.length
          ? "update_failed"
          : selected.length
            ? "rewritten"
            : "explicit_no_image",
        selected,
        output,
        rewritten !== pr.body,
      ),
      rewritten_body: rewritten,
    };
  } catch (error) {
    return {
      ...baseResult(
        phaseName,
        pr,
        base,
        publish,
        targetSha,
        targetRef,
        [
          `verification_failed:${error instanceof Error ? error.message : String(error)}`,
        ],
        "update_failed",
        selected,
        output,
        rewritten !== pr.body,
      ),
      rewritten_body: rewritten,
    };
  }
}
