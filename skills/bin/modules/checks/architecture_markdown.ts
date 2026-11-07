import { readFileSync } from "node:fs";

export interface ArchitectureActiveLine {
  line: string;
  quoted: boolean;
}

function fenceMarker(line: string): [string, number, string] | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const marker = match[1]!;
  if (marker.startsWith("`") && match[2]!.includes("`")) return undefined;
  return [marker[0]!, marker.length, match[2]!];
}

function quoteContent(line: string): [boolean, string] {
  const match = /^ {0,3}>[ \t]?(.*)$/.exec(line);
  return match ? [true, match[1]!] : [false, line];
}

function indentationColumns(line: string): number {
  let columns = 0;
  for (const character of line) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns = (Math.floor(columns / 4) + 1) * 4;
    else break;
  }
  return columns;
}

function indentedCode(line: string): boolean {
  return indentationColumns(line) >= 4;
}

function thematicBreak(line: string): boolean {
  const stripped = line.trimStart();
  return /^(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}$/.test(stripped);
}

function htmlBlockStart(line: string): boolean {
  const stripped = line.trimStart();
  if (
    /^(?:<!--|<\?|<!\[CDATA\[|<![A-Z]|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|ol|p|pre|script|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?\>))/i.test(
      stripped,
    )
  )
    return true;
  return /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\s*\/?>\s*$/.test(stripped);
}

function htmlBlockKind(line: string): string | undefined {
  const stripped = line.trimStart();
  if (stripped.startsWith("<!--"))
    return stripped.slice(4).includes("-->") ? undefined : "comment";
  if (/^<\?/.test(stripped))
    return stripped.slice(2).includes("?>") ? undefined : "processing";
  if (stripped.startsWith("<![CDATA["))
    return stripped.slice(9).includes("]]>") ? undefined : "cdata";
  const tag = /^<(script|style)\b[^>]*>/i.exec(stripped);
  if (tag) {
    const kind = tag[1]!.toLowerCase();
    return new RegExp(`</${kind}\\s*>`, "i").test(stripped.slice(tag[0].length))
      ? undefined
      : kind;
  }
  return undefined;
}

function htmlBlockClosed(line: string, kind: string): boolean {
  const stripped = line.trimStart();
  if (kind === "comment") return stripped.includes("-->");
  if (kind === "processing") return stripped.includes("?>");
  if (kind === "cdata") return stripped.includes("]]>");
  return new RegExp(`</${kind}\\s*>`, "i").test(stripped);
}

function paragraphContent(line: string): boolean {
  if (!line.trim() || indentedCode(line) || fenceMarker(line)) return false;
  if (thematicBreak(line)) return false;
  const stripped = line.trimStart();
  if (/^#{1,6}(?:\s|$)/.test(stripped)) return false;
  if (/^(?:[-+*]|\d{1,9}[.)])(?:\s|$)/.test(stripped)) return false;
  if (stripped.startsWith(">")) return false;
  return !htmlBlockStart(line);
}

function lazyQuoteContinuation(line: string): boolean {
  if (!line.trim()) return false;
  if (indentedCode(line)) return true;
  if (thematicBreak(line) || htmlBlockStart(line)) return false;
  const stripped = line.trimStart();
  return !/^(?:#{1,6}\s|(?:[-+*]|\d+[.)])(?:\s|$)|>|`{3,}|~{3,})/.test(
    stripped,
  );
}

/**
 * Return active Markdown lines and mark quote/HTML/code lines as non-operative.
 * The scanner intentionally mirrors the legacy checker because quoted and
 * fenced prose must not satisfy live contracts, while serial-gate scans still
 * need to see quoted and unclosed-fence legacy wording.
 */
export function currentActiveLines(
  path: string,
  includeUnclosedFence = false,
): ArchitectureActiveLine[] {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const active: ArchitectureActiveLine[] = [];
  let fenceChar: string | undefined;
  let fenceLength = 0;
  let fenceInBlockquote = false;
  let fencedLines: string[] = [];
  let blockquoteActive = false;
  let blockquoteParagraphActive = false;
  let htmlBlock: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const [explicitQuote, parsedLine] = quoteContent(line);
    if (htmlBlock) {
      active.push({ line, quoted: true });
      if (htmlBlockClosed(parsedLine, htmlBlock)) htmlBlock = undefined;
      continue;
    }

    const lazyQuote: boolean =
      blockquoteActive &&
      blockquoteParagraphActive &&
      !explicitQuote &&
      lazyQuoteContinuation(line);
    let isQuoted = explicitQuote || lazyQuote;

    if (fenceChar) {
      if (fenceInBlockquote && !explicitQuote) {
        fenceChar = undefined;
        fenceLength = 0;
        fenceInBlockquote = false;
        fencedLines = [];
        blockquoteActive = false;
        blockquoteParagraphActive = false;
        isQuoted = false;
      } else {
        const marker = fenceMarker(fenceInBlockquote ? parsedLine : line);
        if (
          marker &&
          marker[0] === fenceChar &&
          marker[1] >= fenceLength &&
          !marker[2].trim()
        ) {
          if (fenceInBlockquote && explicitQuote) {
            blockquoteActive = false;
            blockquoteParagraphActive = false;
          }
          fenceChar = undefined;
          fenceLength = 0;
          fenceInBlockquote = false;
          fencedLines = [];
          continue;
        }
        fencedLines.push(line);
        continue;
      }
    }

    if (indentedCode(parsedLine)) {
      if (explicitQuote) {
        blockquoteActive = true;
        blockquoteParagraphActive = false;
      } else if (!lazyQuote) {
        blockquoteActive = false;
        blockquoteParagraphActive = false;
      }
      continue;
    }

    const marker = fenceMarker(parsedLine);
    if (marker) {
      fenceChar = marker[0];
      fenceLength = marker[1];
      fenceInBlockquote = explicitQuote || lazyQuote;
      blockquoteActive = explicitQuote || lazyQuote;
      blockquoteParagraphActive = false;
      fencedLines = [];
      continue;
    }

    if (htmlBlockStart(parsedLine)) {
      htmlBlock = htmlBlockKind(parsedLine);
      active.push({ line, quoted: Boolean(htmlBlock) || isQuoted });
      blockquoteActive = false;
      blockquoteParagraphActive = false;
      continue;
    }

    if (
      !isQuoted &&
      /^\s{0,3}##\s+Historical rollout snapshot\b/i.test(parsedLine)
    )
      break;

    active.push({ line, quoted: isQuoted });
    if (explicitQuote && thematicBreak(parsedLine)) {
      blockquoteActive = false;
      blockquoteParagraphActive = false;
    } else if (explicitQuote && !parsedLine.trim()) {
      blockquoteActive = false;
      blockquoteParagraphActive = false;
    } else if (explicitQuote) {
      blockquoteActive = true;
      blockquoteParagraphActive = paragraphContent(parsedLine);
    } else if (lazyQuote) {
      blockquoteActive = true;
    } else if (blockquoteActive && !line.trim()) {
      blockquoteActive = false;
      blockquoteParagraphActive = false;
    } else if (blockquoteActive) {
      blockquoteActive = false;
      blockquoteParagraphActive = false;
    }
  }
  if (fenceChar && includeUnclosedFence)
    active.push(...fencedLines.map((line) => ({ line, quoted: true })));
  return active;
}

export function currentOperationalContractText(path: string): string {
  return currentActiveLines(path)
    .filter(({ quoted }) => !quoted)
    .map(({ line }) => line)
    .join("\n")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function currentSerialGateScanText(path: string): string {
  return currentActiveLines(path, true)
    .map(({ line }) => line)
    .join("\n")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
