import { lstatSync } from "node:fs";
import {
  readRegularNoFollow as readSecureRegularNoFollow,
  writeAtomicNoFollow,
} from "../../modules/visual/secure_io";

export function readRegularBytesNoFollow(
  path: string,
  stopAt?: string,
): Uint8Array | undefined {
  try {
    return readSecureRegularNoFollow(path, stopAt);
  } catch {
    return;
  }
}

export function readRegularTextNoFollow(path: string, stopAt?: string): string {
  const bytes = readRegularBytesNoFollow(path, stopAt);
  if (!bytes) throw new Error("baseline file is missing or not regular");
  return Buffer.from(bytes).toString("utf8");
}

export function writeRegularTextNoFollow(
  path: string,
  text: string,
  stopAt?: string,
): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("baseline file is not regular");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeAtomicNoFollow(path, text, stopAt);
}
