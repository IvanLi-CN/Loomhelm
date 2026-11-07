import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

interface ProcessChild {
  pid: number;
  token: string;
}

export function readProcessDescendants(rootPid: number): Map<number, string> {
  const children = new Map<number, ProcessChild[]>();
  try {
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = readFileSync(`/proc/${name}/stat`, "utf8");
          const end = stat.lastIndexOf(")");
          const fields = stat
            .slice(end + 2)
            .trim()
            .split(/\s+/);
          const pid = Number(name);
          const parent = Number(fields[1]);
          const token = fields[19];
          if (Number.isInteger(parent) && token)
            children.set(parent, [
              ...(children.get(parent) ?? []),
              { pid, token },
            ]);
        } catch {}
      }
    } else {
      const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        const pid = Number(fields[0]);
        const parent = Number(fields[1]);
        if (Number.isInteger(pid) && Number.isInteger(parent))
          children.set(parent, [
            ...(children.get(parent) ?? []),
            { pid, token: fields.slice(2).join(" ") },
          ]);
      }
    }
  } catch {
    return new Map();
  }
  const result = new Map<number, string>();
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length) {
    const child = pending.shift()!;
    if (result.has(child.pid)) continue;
    result.set(child.pid, child.token);
    pending.push(...(children.get(child.pid) ?? []));
  }
  return result;
}

export function readProcessTree(
  rootPid: number,
  supervisionToken?: string,
): Map<number, string> {
  const result = readProcessDescendants(rootPid);
  if (
    supervisionToken === undefined ||
    !["linux", "darwin"].includes(process.platform)
  )
    return result;
  const marker = `CODEX_PROCESS_SUPERVISION_TOKEN=${supervisionToken}`;
  if (process.platform === "linux") {
    try {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const environment = readFileSync(`/proc/${name}/environ`, "utf8");
          if (!environment.split("\0").includes(marker)) continue;
          const stat = readFileSync(`/proc/${name}/stat`, "utf8");
          const end = stat.lastIndexOf(")");
          const token = stat
            .slice(end + 2)
            .trim()
            .split(/\s+/)[19];
          if (token) result.set(Number(name), token);
        } catch {}
      }
    } catch {}
    return result;
  }
  try {
    const output = execFileSync("/bin/ps", ["eww", "-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      const pid = Number(fields.shift());
      if (!Number.isInteger(pid) || !line.includes(marker)) continue;
      try {
        const token = execFileSync(
          "/bin/ps",
          ["-p", String(pid), "-o", "lstart="],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        if (token) result.set(pid, token);
      } catch {}
    }
  } catch {}
  return result;
}
