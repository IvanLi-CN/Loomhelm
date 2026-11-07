export function evaluateContractCase(item: Record<string, unknown>): {
  ok: boolean;
  reasons: string[];
} {
  if (item.type === "status_text") {
    const text = String(item.text ?? "");
    const required = Array.isArray(item.required)
      ? item.required.map(String)
      : [];
    const forbidden = Array.isArray(item.forbidden)
      ? item.forbidden.map(String)
      : [];
    return {
      ok:
        required.every((value) => text.includes(value)) &&
        forbidden.every((value) => !text.includes(value)),
      reasons: [],
    };
  }
  const phase = item.phase;
  const body = String(item.pr_body ?? "");
  if (phase === "phase-a") {
    const paths = Array.isArray(item.evidence_paths)
      ? item.evidence_paths.map(String)
      : [];
    if (!paths.length)
      return {
        ok:
          item.expected_state === "blocked" &&
          String(item.expected_reasons ?? "").includes(
            "missing_task_evidence_declaration",
          ),
        reasons: ["missing_task_evidence_declaration"],
      };
    const selected = [...new Set(paths)];
    return {
      ok:
        item.expected_state === "rewritten" &&
        JSON.stringify(selected) === JSON.stringify(item.expected_paths ?? []),
      reasons: [],
    };
  }
  const parsed = parseContractManaged(body);
  const expectedState = String(item.expected_state ?? "");
  const expectedReasons = Array.isArray(item.expected_reasons)
    ? item.expected_reasons.map(String)
    : [];
  if (expectedState === "blocked")
    return {
      ok:
        parsed.state === "blocked" &&
        expectedReasons.every((reason) => parsed.reasons.includes(reason)),
      reasons: parsed.reasons,
    };
  return {
    ok:
      parsed.state === "selected" &&
      JSON.stringify(parsed.images) ===
        JSON.stringify(item.expected_paths ?? []),
    reasons: parsed.reasons,
  };
}

function parseContractManaged(body: string): {
  state: "selected" | "blocked";
  images: string[];
  reasons: string[];
} {
  const heading = body.match(/(?:^|\n)## Visual Evidence\s*\n/);
  if (!heading || heading.index === undefined)
    return {
      state: "blocked",
      images: [],
      reasons: ["missing_visual_evidence_section"],
    };
  const contentStart = heading.index + heading[0].length;
  const remaining = body.slice(contentStart);
  const nextHeading = remaining.search(/\n##\s+/);
  const content = remaining.slice(0, nextHeading < 0 ? undefined : nextHeading);
  const images: string[] = [];
  const reasons: string[] = [];
  for (const line of content
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const image = line.match(/^!\[[^\]]*\]\((https?:\/\/[^)]+)\)$/);
    if (!image) {
      if (line === "None") continue;
      reasons.push("managed_section_contains_non_image_content");
      continue;
    }
    const url = new URL(image[1]!);
    const segments = url.pathname.split("/").filter(Boolean);
    const captureIndex = segments.lastIndexOf("captures");
    const path = decodeURIComponent(
      (captureIndex >= 0
        ? segments.slice(captureIndex)
        : segments.slice(-1)
      ).join("/"),
    );
    images.push(path);
  }
  return reasons.length
    ? { state: "blocked", images: [], reasons }
    : { state: "selected", images, reasons };
}
