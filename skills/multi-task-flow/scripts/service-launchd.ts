import { Runtime } from "../../bin/modules/core/runtime";
import { join } from "node:path";
import { requireCondition, ContractError } from "./errors";
import { writeAtomic } from "./store";
import type { ServiceState } from "./service-state";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function launchdDomain(): string {
  const uid = process.getuid!();
  return launchctl(["print", `gui/${uid}`], true)
    ? `gui/${uid}`
    : `user/${uid}`;
}
export const launchdTarget = (state: ServiceState) =>
  `${launchdDomain()}/${state.paths.label}`;
export function launchctl(args: string[], allowFailure = false) {
  requireCondition(
    process.platform === "darwin",
    "UNSUPPORTED_PLATFORM",
    "User service management requires macOS",
  );
  const result = Runtime.spawnSync(["/bin/launchctl", ...args], {
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  if (!allowFailure && result.exitCode !== 0)
    throw new ContractError(
      "LAUNCHD_FAILED",
      "User-level launchd operation failed; inspect service doctor (no privilege escalation)",
    );
  return result.exitCode === 0;
}
export function writeLaunchdDefinition(state: ServiceState): string {
  const config = state.config();
  const executable = join(state.paths.releases, config.current_build, "viewer");
  const environment = state.paths.isolated
    ? `<key>MULTI_TASK_FLOW_PROFILE</key><string>test</string><key>MULTI_TASK_FLOW_ROOT</key><string>${escape(state.paths.root)}</string>`
    : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${escape(state.paths.label)}</string><key>ProgramArguments</key><array><string>${escape(executable)}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict>${environment}<key>PATH</key><string>/usr/bin:/bin</string></dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`;
  const path = join(state.paths.config, "viewer.plist");
  writeAtomic(path, plist);
  return path;
}
export function startUserService(state: ServiceState): void {
  const target = launchdTarget(state);
  if (!launchctl(["print", target], true))
    launchctl([
      "bootstrap",
      launchdDomain(),
      join(state.paths.config, "viewer.plist"),
    ]);
  launchctl(["kickstart", target]);
}
export function unloadUserService(state: ServiceState): void {
  const target = launchdTarget(state);
  if (launchctl(["print", target], true)) launchctl(["bootout", target]);
}
