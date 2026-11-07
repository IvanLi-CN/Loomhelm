import { lstatSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const topLevel = /^##\s+(.+?)\s*$/;
const reqId = /\bREQ-[A-Z0-9][A-Z0-9_-]*\b/g;
const verId = /\bVER-[A-Z0-9][A-Z0-9_-]*\b/g;
const normative =
  /\b(MUST|SHALL|SHOULD|MAY NOT|MUST NOT)\b|必须|不得|仅可|只能|应当|不可/i;
const unresolved =
  /\b(TBD|TBA|TBC|TODO|TO BE DETERMINED|TO BE CONFIRMED|OPEN QUESTION)\b|待确认|待定|未决/i;
const forbidden = new Set([
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

function issue(
  path: string,
  code: string,
  message: string,
  line?: number,
): SpecIssue {
  return line === undefined
    ? { path, code, message }
    : { path, code, message, line };
}

function headings(
  lines: string[],
): Map<string, { line: number; body: string[] }> {
  const output = new Map<string, { line: number; body: string[] }>();
  let current: { name: string; line: number; body: string[] } | undefined;
  for (const [index, text] of lines.entries()) {
    const match = topLevel.exec(text);
    if (match?.[1] !== undefined) {
      if (current)
        output.set(current.name, { line: current.line, body: current.body });
      current = { name: match[1].trim(), line: index + 1, body: [] };
    } else if (current) current.body.push(text);
  }
  if (current)
    output.set(current.name, { line: current.line, body: current.body });
  return output;
}

export function checkSpec(path: string, root: string): SpecIssue[] {
  const absolute = resolve(path);
  const rootAbsolute = resolve(root);
  const rel = relative(rootAbsolute, absolute).replaceAll("\\", "/");
  if (rel === "" || rel === ".." || rel.startsWith("../"))
    return [
      issue(
        path,
        "SPEC_PATH_INVALID",
        "Spec path must remain inside the repository root",
      ),
    ];
  if (!/^docs\/specs\/[a-z0-9]+(?:-[a-z0-9]+)*\/SPEC\.md$/.test(rel))
    return [
      issue(
        rel,
        "SPEC_PATH_INVALID",
        "strict checking only applies to canonical docs/specs/<slug>/SPEC.md",
      ),
    ];
  try {
    if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile())
      return [
        issue(rel, "SPEC_NOT_REGULAR_FILE", "Spec must be a regular file"),
      ];
  } catch {
    return [issue(rel, "SPEC_NOT_REGULAR_FILE", "Spec must be a regular file")];
  }

  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  const sections = headings(lines);
  const errors: SpecIssue[] = [];
  for (const required of [
    "Context and Scope",
    "Requirements",
    "Verification",
    "Related ADRs",
  ])
    if (!sections.has(required))
      errors.push(
        issue(
          rel,
          "SPEC_SECTION_MISSING",
          `missing required section: ## ${required}`,
        ),
      );
  for (const [name, value] of sections) {
    const normalized = name.toLowerCase().trim();
    if (
      [...forbidden].some(
        (item) => normalized === item || normalized.startsWith(`${item} `),
      )
    )
      errors.push(
        issue(
          rel,
          "SPEC_FORBIDDEN_SECTION",
          `task-state or execution section is not allowed in SPEC.md: ## ${name}`,
          value.line,
        ),
      );
  }
  lines.forEach((line, index) => {
    if (/^\s*-\s*\[[ xX]\]/.test(line))
      errors.push(
        issue(
          rel,
          "SPEC_CHECKBOX_FORBIDDEN",
          "SPEC.md cannot contain checkbox progress",
          index + 1,
        ),
      );
  });
  const requirements = sections.get("Requirements")?.body.join("\n") ?? "";
  const verification = sections.get("Verification")?.body.join("\n") ?? "";
  const requirementsIds = [...new Set(requirements.match(reqId) ?? [])].sort();
  const verificationIds = [...new Set(verification.match(verId) ?? [])].sort();
  if (!requirementsIds.length)
    errors.push(
      issue(
        rel,
        "SPEC_REQUIREMENTS_MISSING",
        "Requirements must declare stable REQ-* identifiers",
      ),
    );
  if (!verificationIds.length)
    errors.push(
      issue(
        rel,
        "SPEC_VERIFICATION_MISSING",
        "Verification must declare stable VER-* identifiers",
      ),
    );
  if (requirements && !normative.test(requirements))
    errors.push(
      issue(
        rel,
        "SPEC_NORMATIVE_BOUNDARY_MISSING",
        "Requirements must contain normative MUST/SHALL or Chinese normative language",
      ),
    );
  for (const id of requirementsIds)
    if (
      !new RegExp(`(?:covers?|覆盖)\\s*[:=]\\s*[^\\n]*\\b${id}\\b`, "i").test(
        verification,
      )
    )
      errors.push(
        issue(
          rel,
          "SPEC_TRACEABILITY_MISSING",
          `no VER-* verification explicitly covers ${id}`,
        ),
      );
  for (const id of verificationIds)
    if (!new RegExp(`\\b${id}\\b`).test(verification))
      errors.push(
        issue(
          rel,
          "SPEC_VERIFICATION_INVALID",
          `verification id ${id} is not readable`,
        ),
      );
  if (sections.has("Related ADRs")) {
    const related = sections
      .get("Related ADRs")!
      .body.filter((line) => line.trim());
    if (!related.length)
      errors.push(
        issue(
          rel,
          "SPEC_RELATED_ADRS_INVALID",
          "Related ADRs must be exactly None or contain ADR links",
        ),
      );
    else if (!(related.length === 1 && related[0] === "None")) {
      const targets: string[] = [];
      for (const line of related) {
        const match =
          /^-\s+\[[^\]]+\]\(\.\.\/\.\.\/(adr\/[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)\)$/.exec(
            line,
          );
        if (!match?.[1]) {
          errors.push(
            issue(
              rel,
              "SPEC_RELATED_ADRS_INVALID",
              `invalid Related ADRs entry: ${line}`,
            ),
          );
          continue;
        }
        const target = `docs/${match[1]}`;
        targets.push(target);
        try {
          if (!statSync(resolve(rootAbsolute, target)).isFile())
            errors.push(
              issue(
                rel,
                "SPEC_RELATED_ADRS_INVALID",
                `missing ADR target: ${target}`,
              ),
            );
        } catch {
          errors.push(
            issue(
              rel,
              "SPEC_RELATED_ADRS_INVALID",
              `missing ADR target: ${target}`,
            ),
          );
        }
      }
      if (targets.join("\n") !== [...new Set(targets)].sort().join("\n"))
        errors.push(
          issue(
            rel,
            "SPEC_RELATED_ADRS_INVALID",
            "Related ADRs must be path-sorted and duplicate-free",
          ),
        );
    }
  }
  lines.forEach((line, index) => {
    if (
      unresolved.test(line) &&
      !line.trimStart().startsWith(">") &&
      !line.trimStart().startsWith("<!--")
    )
      errors.push(
        issue(
          rel,
          "SPEC_UNRESOLVED_DECISION",
          "unresolved decision markers do not belong in canonical SPEC.md",
          index + 1,
        ),
      );
  });
  return errors;
}

export function formatSpecIssue(item: SpecIssue): string {
  return `path=${item.path} code=${item.code} msg=${item.message}${item.line === undefined ? "" : ` line=${item.line}`}`;
}
