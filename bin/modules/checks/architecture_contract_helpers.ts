import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  currentOperationalContractText,
  currentSerialGateScanText,
} from "./architecture_markdown";

export const pathFor = (root: string, relativePath: string): string =>
  join(root, relativePath);

export const existsFile = (path: string): boolean =>
  existsSync(path) && statSync(path).isFile();

export const operational = (root: string, relativePath: string): string =>
  currentOperationalContractText(pathFor(root, relativePath));

export const serial = (root: string, relativePath: string): string =>
  currentSerialGateScanText(pathFor(root, relativePath));

export const has = (source: string, phrase: string): boolean =>
  source.includes(phrase.toLowerCase());

export function missingPhrases(
  findings: string[],
  prefix: string,
  source: string,
  phrases: readonly string[],
): void {
  for (const phrase of phrases)
    if (!has(source, phrase)) findings.push(`${prefix} phrase=${phrase}`);
}
