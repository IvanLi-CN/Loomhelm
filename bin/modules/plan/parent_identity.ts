import { lstat } from "node:fs/promises";

export async function assertDirectoryIdentity(
  path: string,
  expected: { dev: number; ino: number },
  message = "candidate output parent changed",
): Promise<void> {
  const current = await lstat(path);
  if (
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    throw new Error(message);
}
