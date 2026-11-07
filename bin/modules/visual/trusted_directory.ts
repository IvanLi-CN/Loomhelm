import {
  closeSync,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";

export type DirectoryHandle = {
  descriptor: number;
  canonicalPath: string;
};

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function openTrustedDirectory(
  path: string,
  flags: number,
  openDirectory: (path: string) => DirectoryHandle,
): DirectoryHandle {
  let descriptor = -1;
  try {
    descriptor = openSync(path, flags);
    const canonicalPath = realpathSync(path);
    const opened = fstatSync(descriptor);
    const resolved = statSync(canonicalPath);
    if (!sameIdentity(opened, resolved))
      throw new Error("no-follow directory root changed");
    const trusted = openDirectory(canonicalPath);
    const verified = fstatSync(trusted.descriptor);
    if (!sameIdentity(verified, opened)) {
      closeSync(trusted.descriptor);
      throw new Error("no-follow directory root changed");
    }
    return trusted;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}
