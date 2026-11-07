import { describe, expect, test } from "bun:test";
import { parseAcceptance } from "../../modules/plan/acceptance";

function plan(entries: string): string {
  return `# Plan\n\n## Acceptance & Validation\n${entries}\n\n## Assumptions/Defaults\n- scope: 已确定\n`;
}

describe("plan acceptance manifest", () => {
  test("normalizes strict entries and defaults the validation gate", () => {
    const manifest = parseAcceptance(
      plan(
        "- A1 [contract/direct] exact model binding | evidence=`test:model` | assertions=`rejected,atomic`",
      ),
    );
    expect(manifest.items).toEqual([
      {
        id: "A1",
        category: "contract",
        mode: "direct",
        gate: "validation",
        scope: "plan",
        phase: "pre_merge",
        target: "exact model binding",
        evidence: ["test:model"],
        assertions: ["atomic", "rejected"],
      },
    ]);
    expect(manifest).toEqual({
      plan_digest:
        "aab7afcf2a18e5c8edddc6e3d1ce95836c6b0d409ff068bb3af29d27b2009a86",
      items: [
        {
          id: "A1",
          category: "contract",
          mode: "direct",
          gate: "validation",
          scope: "plan",
          phase: "pre_merge",
          target: "exact model binding",
          evidence: ["test:model"],
          assertions: ["atomic", "rejected"],
        },
      ],
    });
  });

  test("rejects duplicate, incomplete, and unknown entries", () => {
    expect(() =>
      parseAcceptance(
        plan(
          "- A1 [contract/direct] target | evidence=`test:a` | assertions=`one`\n- A1 [contract/direct] target | evidence=`test:b` | assertions=`two`",
        ),
      ),
    ).toThrow("duplicate acceptance ID");
    expect(() =>
      parseAcceptance(
        plan(
          "- A1 [unknown/direct] target | evidence=`test:a` | assertions=`one`",
        ),
      ),
    ).toThrow("invalid acceptance category");
    expect(() =>
      parseAcceptance(
        plan("- A1 [contract/direct] target | evidence=`` | assertions=`one`"),
      ),
    ).toThrow("strict ID/class/mode");
  });

  test("requires explicit direct and multi-task-flow phase bindings", () => {
    const entry =
      "- A1 [contract/direct] local proof | evidence=`test:local` | assertions=`covered`";
    expect(() => parseAcceptance(plan(entry), { requirePhase: true })).toThrow(
      "DIRECT_V1_ACCEPTANCE_PHASE_REQUIRED",
    );
    expect(() =>
      parseAcceptance(
        plan(
          entry.replace(
            "evidence=",
            "scope=`task:one` | phase=`pre_merge` | evidence=",
          ),
        ),
        { requirePhase: true },
      ),
    ).toThrow("DIRECT_V1_ACCEPTANCE_SCOPE_INVALID");
    expect(() =>
      parseAcceptance(plan(entry), { requireScopedAcceptance: true }),
    ).toThrow("multi-task-flow acceptance requires explicit scope and phase");
  });

  test("requires direct evidence for high-risk acceptance", () => {
    expect(() =>
      parseAcceptance(
        plan(
          "- A1 [migration/composed] target | evidence=`test:a,test:b` | assertions=`one`",
        ),
      ),
    ).toThrow("high-risk acceptance requires direct evidence");
  });

  test("checks concrete empirical assertions", () => {
    expect(
      parseAcceptance(
        plan(
          "- A1 [contract/direct] empirical proof | evidence=`lab:run` | assertions=`scenario=unchanged-source,expected=stable-acceptance`",
        ),
        { requireEmpirical: true },
      ).items[0]?.id,
    ).toBe("A1");
    expect(() =>
      parseAcceptance(
        plan(
          "- A1 [contract/direct] empirical proof | evidence=`lab:run` | assertions=`scenario=placeholder,expected=stable`",
        ),
        { requireEmpirical: true },
      ),
    ).toThrow("empirical scenario must be concrete");
  });

  test("uses Python whitespace boundaries for empirical placeholders", () => {
    expect(() =>
      parseAcceptance(
        plan(
          "- A1 [contract/direct] empirical proof | evidence=`lab:run` | assertions=`scenario=check\u001ftodo\u001fitem,expected=stable`",
        ),
        { requireEmpirical: true },
      ),
    ).toThrow("empirical scenario must be concrete");
    expect(() =>
      parseAcceptance(
        plan(
          "- A1 [contract/direct] empirical proof | evidence=`lab:run` | assertions=`scenario=check\ufefftodo\ufeffitem,expected=stable`",
        ),
        { requireEmpirical: true },
      ),
    ).not.toThrow();
  });

  test("ignores fenced acceptance examples", () => {
    const text = `# Plan\n\n\`\`\`md\n## Acceptance & Validation\n- A0 [contract/direct] example | evidence=\`test:example\` | assertions=\`ignored\`\n\`\`\`\n\n## Acceptance & Validation\n- A1 [contract/direct] actual | evidence=\`test:actual\` | assertions=\`selected\`\n`;
    expect(parseAcceptance(text).items.map((item) => item.id)).toEqual(["A1"]);
  });

  test("keeps digest and item order stable across Python splitlines breaks", () => {
    const text = plan(
      "- A_2 [contract/direct] second | evidence=`test:second` | assertions=`stable`\n- A-1 [contract/direct] first | evidence=`test:first` | assertions=`stable`",
    );
    const normalized = parseAcceptance(text);
    const carriageSeparated = parseAcceptance(text.replaceAll("\n", "\r"));
    expect(normalized.items.map((item) => item.id)).toEqual(["A-1", "A_2"]);
    expect(carriageSeparated.items).toEqual(normalized.items);
    expect(normalized.plan_digest).toBe(
      "4f823fdffcecb8c3de4b645a8e84097d68b12905295ebb3eff89842db576ecbc",
    );
    expect(carriageSeparated.plan_digest).toBe(normalized.plan_digest);
  });

  test("trims all Python-compatible trailing Unicode whitespace", () => {
    const text = plan(
      "- A1 [contract/direct] stable digest | evidence=`test:digest` | assertions=`unchanged`",
    );
    const padded = text.replace("# Plan\n", "# Plan\u00a0\u001f\n\u3000");
    expect(parseAcceptance(text).plan_digest).toBe(
      "f8f4bef29e6cbb1379ef6528d365bb70bbd70b101a94f3cc46a8577dcf7ffee7",
    );
    expect(parseAcceptance(padded).plan_digest).toBe(
      parseAcceptance(text).plan_digest,
    );
    const bom = text.replace("# Plan\n", "# Plan\ufeff\n");
    expect(parseAcceptance(bom).plan_digest).not.toBe(
      parseAcceptance(text).plan_digest,
    );
  });

  test("uses Python whitespace rules for acceptance fields", () => {
    const base = plan(
      "- A1 [contract/direct] stable target | evidence=`test:stable` | assertions=`scenario=stable,expected=accepted`",
    );
    const padded = base
      .replace("stable target", "stable target\u001f")
      .replace("test:stable", "\u001ftest:stable\u001f")
      .replace(
        "scenario=stable,expected=accepted",
        "scenario=stable\u001f,expected=accepted\u001f",
      );
    expect(parseAcceptance(padded, { requireEmpirical: true }).items).toEqual(
      parseAcceptance(base, { requireEmpirical: true }).items,
    );
  });

  test("sorts Unicode strings by code point like Python", () => {
    const manifest = parseAcceptance(
      plan(
        "- A1 [contract/direct] stable sort | evidence=`test:\ud83d\ude00,test:\ue000` | assertions=`stable`",
      ),
    );
    expect(manifest.items[0]?.evidence).toEqual([
      "test:\ue000",
      "test:\ud83d\ude00",
    ]);
  });
});
