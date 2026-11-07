import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { requireCondition } from "./errors";

export function servicePaths(env: NodeJS.ProcessEnv = process.env) {
  const production = join(homedir(), ".local", "share", "multi-task-flow");
  const override = env.MULTI_TASK_FLOW_ROOT;
  const isolated =
    env.MULTI_TASK_FLOW_PROFILE === "test" ||
    env.MULTI_TASK_FLOW_PROFILE === "development";
  requireCondition(
    !override ||
      (isolated && isAbsolute(override) && resolve(override) !== production),
    "INVALID_ROOT",
    "A service root override requires an isolated test/development profile",
  );
  requireCondition(
    !isolated || override,
    "INVALID_ROOT",
    "An isolated profile requires an explicit service root",
  );
  const root = override ? resolve(override) : production;
  const suffix = isolated
    ? "." + createHash("sha256").update(root).digest("hex").slice(0, 12)
    : "";
  return {
    root,
    isolated,
    data: join(root, "data"),
    config: join(root, "config"),
    state: join(root, "state"),
    releases: join(root, "releases"),
    logs: join(root, "logs"),
    label: "cn.ivan.multi-task-flow.viewer" + suffix,
    scope: "multi-task-flow--user-" + String(process.getuid?.() ?? 0) + suffix,
  };
}

export type ServicePaths = ReturnType<typeof servicePaths>;

export function orchestrationRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.TASK_ORCHESTRATION_DATA_ROOT;
  requireCondition(
    !explicit || isAbsolute(explicit),
    "INVALID_ROOT",
    "Data root must be absolute",
  );
  return explicit ? resolve(explicit) : servicePaths(env).data;
}
