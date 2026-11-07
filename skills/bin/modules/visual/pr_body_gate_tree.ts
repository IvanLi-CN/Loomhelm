import { execFileSync } from "node:child_process";
import { backendFor, type HostingBackend } from "../hosting/backend";
import { treeFacts } from "../hosting/compatibility_resources";
import type { RepositoryBinding } from "../hosting/types";

function localTreeHas(root: string, sha: string, path: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["-C", root, "ls-tree", "-r", "-z", sha, "--", path],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.split("\0").some((entry) => {
      const [metadata, foundPath] = entry.split("\t");
      return foundPath === path && metadata?.split(" ")[0] === "100644";
    });
  } catch {
    return false;
  }
}

export async function treeHas(
  root: string,
  binding: RepositoryBinding,
  sha: string,
  path: string,
  backend: HostingBackend = backendFor(binding, { cwd: root }),
): Promise<boolean> {
  if (localTreeHas(root, sha, path)) return true;
  try {
    const result = await treeFacts(binding, backend, sha, path);
    return result.exists === true;
  } catch {
    return false;
  }
}
