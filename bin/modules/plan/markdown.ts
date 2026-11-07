export function linesOf(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
}

function fenceMarker(line: string): string | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  return match?.[1] ?? null;
}

function closesFence(line: string, marker: string): boolean {
  const escaped = marker[0] === "`" ? "`" : "~";
  const pattern = new RegExp(
    `^[ \\t]{0,3}${escaped}{${marker.length},}[ \\t]*$`,
  );
  return pattern.test(line);
}

export function sectionHeadingCount(text: string, name: string): number {
  const heading = new RegExp(`^[ \\t]*##[ \\t]+${escapeRegExp(name)}[ \\t]*$`);
  let inFence = false;
  let marker = "";
  let count = 0;
  for (const line of linesOf(text)) {
    const nextMarker = fenceMarker(line);
    if (nextMarker !== null) {
      if (!inFence) {
        inFence = true;
        marker = nextMarker;
      } else if (nextMarker[0] === marker[0] && closesFence(line, marker)) {
        inFence = false;
      }
      continue;
    }
    if (!inFence && heading.test(line)) count += 1;
  }
  return count;
}

export function section(text: string, name: string): string {
  const heading = new RegExp(`^[ \\t]*##[ \\t]+${escapeRegExp(name)}[ \\t]*$`);
  const nextHeading = /^[ \t]*##[ \t]+.+$/;
  let inFence = false;
  let marker = "";
  let found = false;
  const body: string[] = [];
  for (const line of linesOf(text)) {
    const nextMarker = fenceMarker(line);
    if (nextMarker !== null) {
      if (!inFence) {
        inFence = true;
        marker = nextMarker;
      } else if (nextMarker[0] === marker[0] && closesFence(line, marker)) {
        inFence = false;
      }
      if (found) body.push(line);
      continue;
    }
    if (!found) {
      if (!inFence && heading.test(line)) found = true;
      continue;
    }
    if (
      !inFence &&
      (nextHeading.test(line) || line.trim() === "</proposed_plan>")
    ) {
      break;
    }
    body.push(line);
  }
  return body.join("\n");
}

export function unfencedMarkerLines(text: string, marker: string): number[] {
  const markerPattern = new RegExp(`^[ \\t]*${escapeRegExp(marker)}[ \\t]*$`);
  let inFence = false;
  let fence = "";
  const matches: number[] = [];
  for (const [index, line] of linesOf(text).entries()) {
    const nextMarker = fenceMarker(line);
    if (nextMarker !== null) {
      if (!inFence) {
        inFence = true;
        fence = nextMarker;
      } else if (nextMarker[0] === fence[0] && closesFence(line, fence)) {
        inFence = false;
      }
      continue;
    }
    if (!inFence && markerPattern.test(line)) matches.push(index + 1);
  }
  return matches;
}

export function validateFencedBlocks(text: string): void {
  let inFence = false;
  let marker = "";
  for (const line of linesOf(text)) {
    const nextMarker = fenceMarker(line);
    if (nextMarker === null) continue;
    if (!inFence) {
      inFence = true;
      marker = nextMarker;
    } else if (nextMarker[0] === marker[0] && closesFence(line, marker)) {
      inFence = false;
    }
  }
  if (inFence)
    throw new Error(
      "malformed fenced code block: missing matching closing fence",
    );
}

export function stripFencedBlocks(text: string): string {
  let inFence = false;
  let marker = "";
  const output: string[] = [];
  for (const line of linesOf(text)) {
    const nextMarker = fenceMarker(line);
    if (nextMarker !== null) {
      if (!inFence) {
        inFence = true;
        marker = nextMarker;
      } else if (nextMarker[0] === marker[0] && closesFence(line, marker)) {
        inFence = false;
      }
      continue;
    }
    if (!inFence) output.push(line);
  }
  return output.join("\n");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
