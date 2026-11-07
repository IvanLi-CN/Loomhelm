import { lstatSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { gitText } from "./git";

const TOP_LEVEL_RE = /^##\s+(.+?)\s*$/;
const REQ_RE = /\bREQ-[A-Z0-9][A-Z0-9_-]*\b/g;
const VER_RE = /\bVER-[A-Z0-9][A-Z0-9_-]*\b/g;
const NORMATIVE_RE =
  /\b(MUST|SHALL|SHOULD|MAY NOT|MUST NOT)\b|必须|不得|仅可|只能|应当|不可/i;
const UNRESOLVED_RE =
  /\b(TBD|TBA|TBC|TODO|TO BE DETERMINED|TO BE CONFIRMED|OPEN QUESTION)\b|待确认|待定|未决/i;
const FORBIDDEN_HEADINGS = new Set([
  "acceptance checklist",
  "quality gates",
  "related prs",
  "related pr",
  "pull requests",
  "pr checklist",
  "related changes",
  "test commands",
  "verification commands",
  "risks",
  "open questions",
  "assumptions",
  "task orchestration",
  "execution steps",
  "current status",
  "milestones",
  "implementation status",
  "delivery status",
  "execution",
]);

export interface SpecIssue {
  path: string;
  code: string;
  message: string;
  line?: number;
}

function emit(
  path: string,
  code: string,
  message: string,
  line?: number,
): SpecIssue {
  return { path, code, message, ...(line === undefined ? {} : { line }) };
}

function repoRelative(path: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(path)).replaceAll("\\", "/");
  return rel === "" || (!rel.startsWith("../") && rel !== "..") ? rel : null;
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function collectIds(text: string, pattern: RegExp): string[] {
  return [...new Set(text.match(pattern) ?? [])].sort();
}

function headingBodies(
  lines: string[],
): Map<string, { line: number; body: string[] }> {
  const headings = new Map<string, { line: number; body: string[] }>();
  let current: { name: string; line: number; body: string[] } | undefined;
  for (const [index, line] of lines.entries()) {
    const match = TOP_LEVEL_RE.exec(line);
    if (match?.[1] !== undefined) {
      if (current)
        headings.set(current.name, { line: current.line, body: current.body });
      current = { name: match[1].trim(), line: index + 1, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current)
    headings.set(current.name, { line: current.line, body: current.body });
  return headings;
}

export function repositoryRoot(cwd = process.cwd()): string {
  return gitText(cwd, ["rev-parse", "--show-toplevel"])?.trim() ?? cwd;
}

export function checkSpec(path: string, root: string): SpecIssue[] {
  const absolute = resolve(path);
  const rel = repoRelative(absolute, root);
  if (rel === null) {
    return [
      emit(
        absolute,
        "SPEC_PATH_INVALID",
        "Spec path must remain inside the repository root",
      ),
    ];
  }
  if (!/^docs\/specs\/[a-z0-9]+(?:-[a-z0-9]+)*\/SPEC\.md$/.test(rel)) {
    return [
      emit(
        rel,
        "SPEC_PATH_INVALID",
        "strict checking only applies to canonical docs/specs/<slug>/SPEC.md",
      ),
    ];
  }
  if (!regularFile(absolute)) {
    return [emit(rel, "SPEC_NOT_REGULAR_FILE", "Spec must be a regular file")];
  }

  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  const headings = headingBodies(lines);
  const errors: SpecIssue[] = [];
  for (const required of [
    "Context and Scope",
    "Requirements",
    "Verification",
    "Related ADRs",
  ]) {
    if (!headings.has(required))
      errors.push(
        emit(
          rel,
          "SPEC_SECTION_MISSING",
          `missing required section: ## ${required}`,
        ),
      );
  }
  for (const [heading, value] of headings) {
    const normalized = heading.toLowerCase().trim();
    if (
      [...FORBIDDEN_HEADINGS].some(
        (forbidden) =>
          normalized === forbidden || normalized.startsWith(`${forbidden} `),
      )
    ) {
      errors.push(
        emit(
          rel,
          "SPEC_FORBIDDEN_SECTION",
          `task-state or execution section is not allowed in SPEC.md: ## ${heading}`,
          value.line,
        ),
      );
    }
  }
  for (const [index, line] of lines.entries()) {
    if (/^\s*-\s*\[[ xX]\]/.test(line))
      errors.push(
        emit(
          rel,
          "SPEC_CHECKBOX_FORBIDDEN",
          "SPEC.md cannot contain checkbox progress",
          index + 1,
        ),
      );
  }

  const requirements = headings.get("Requirements")?.body.join("\n") ?? "";
  const verification = headings.get("Verification")?.body.join("\n") ?? "";
  const reqIds = collectIds(requirements, REQ_RE);
  const verIds = collectIds(verification, VER_RE);
  if (reqIds.length === 0)
    errors.push(
      emit(
        rel,
        "SPEC_REQUIREMENTS_MISSING",
        "Requirements must declare stable REQ-* identifiers",
      ),
    );
  if (verIds.length === 0)
    errors.push(
      emit(
        rel,
        "SPEC_VERIFICATION_MISSING",
        "Verification must declare stable VER-* identifiers",
      ),
    );
  if (requirements && !NORMATIVE_RE.test(requirements))
    errors.push(
      emit(
        rel,
        "SPEC_NORMATIVE_BOUNDARY_MISSING",
        "Requirements must contain normative MUST/SHALL or Chinese normative language",
      ),
    );
  for (const id of reqIds) {
    const pattern = new RegExp(
      `(?:covers?|覆盖)\\s*[:=]\\s*[^\\n]*\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );
    if (!pattern.test(verification))
      errors.push(
        emit(
          rel,
          "SPEC_TRACEABILITY_MISSING",
          `no VER-* verification explicitly covers ${id}`,
        ),
      );
  }
  for (const id of verIds) {
    if (!new RegExp(`\\b${id}\\b`).test(verification))
      errors.push(
        emit(
          rel,
          "SPEC_VERIFICATION_INVALID",
          `verification id ${id} is not readable`,
        ),
      );
  }

  const related =
    headings.get("Related ADRs")?.body.filter((line) => line.trim()) ?? [];
  if (headings.has("Related ADRs")) {
    if (related.length === 0)
      errors.push(
        emit(
          rel,
          "SPEC_RELATED_ADRS_INVALID",
          "Related ADRs must be exactly None or contain ADR links",
        ),
      );
    else if (related.length !== 1 || related[0] !== "None") {
      const paths: string[] = [];
      for (const line of related) {
        const match =
          /^-\s+\[[^\]]+\]\(\.\.\/\.\.\/(adr\/[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)\)$/.exec(
            line,
          );
        if (!match?.[1]) {
          errors.push(
            emit(
              rel,
              "SPEC_RELATED_ADRS_INVALID",
              `invalid Related ADRs entry: ${line}`,
            ),
          );
          continue;
        }
        const adr = `docs/${match[1]}`;
        paths.push(adr);
        try {
          if (!statSync(resolve(root, adr)).isFile())
            errors.push(
              emit(
                rel,
                "SPEC_RELATED_ADRS_INVALID",
                `missing ADR target: ${adr}`,
              ),
            );
        } catch {
          errors.push(
            emit(
              rel,
              "SPEC_RELATED_ADRS_INVALID",
              `missing ADR target: ${adr}`,
            ),
          );
        }
      }
      if (paths.join("\n") !== [...new Set(paths)].sort().join("\n"))
        errors.push(
          emit(
            rel,
            "SPEC_RELATED_ADRS_INVALID",
            "Related ADRs must be path-sorted and duplicate-free",
          ),
        );
    }
  }
  for (const [index, line] of lines.entries()) {
    if (
      UNRESOLVED_RE.test(line) &&
      !line.trimStart().startsWith(">") &&
      !line.trimStart().startsWith("<!--")
    )
      errors.push(
        emit(
          rel,
          "SPEC_UNRESOLVED_DECISION",
          "unresolved decision markers do not belong in canonical SPEC.md",
          index + 1,
        ),
      );
  }
  return errors;
}

export function checkSpecs(
  paths: string[],
  root = repositoryRoot(),
): SpecIssue[] {
  return paths.flatMap((path) => checkSpec(resolve(root, path), root));
}
