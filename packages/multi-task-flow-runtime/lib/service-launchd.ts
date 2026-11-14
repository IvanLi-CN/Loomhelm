import { Runtime } from "../../../skills/bin/modules/core/runtime";
import { join } from "node:path";
import { requireCondition, ContractError } from "../lib/errors";
import { writeAtomic } from "../lib/store";
import { readRegularNoFollow } from "../../../skills/bin/modules/visual/secure_io";
import type { ServiceState } from "../lib/service-state";

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
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${escape(state.paths.label)}</string><key>ProgramArguments</key><array><string>${escape(executable)}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict>${environment}<key>PATH</key><string>${escape(process.env.PATH ?? "")}</string></dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>ProcessType</key><string>Interactive</string><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`;
  const path = join(state.paths.config, "viewer.plist");
  writeAtomic(path, plist);
  return path;
}
export function startUserService(state: ServiceState): void {
  const definition = readRegularNoFollow(join(state.paths.config, "viewer.plist"), state.paths.root).toString("utf8");
  requireCondition(
    definition.includes(`<key>Label</key><string>${escape(state.paths.label)}</string>`),
    "SERVICE_UPGRADE_REQUIRED",
    "Service label changed; use the new bundle maintenance CLI for an explicit upgrade",
  );
  const target = launchdTarget(state);
  if (!launchctl(["print", target], true))
    launchctl([
      "bootstrap",
      launchdDomain(),
      join(state.paths.config, "viewer.plist"),
    ]);
  launchctl(["kickstart", target]);
}
export function unloadUserService(state: ServiceState, control = launchctl, domain = launchdDomain()): void {
  // Explicit maintenance retires both identities within this exact profile.
  const legacy = state.paths.label.replace("cc.ivanli.loomhelm.multi-task-flow.viewer", "cn.ivan.multi-task-flow.viewer");
  for (const label of new Set([state.paths.label, legacy])) {
    const target = `${domain}/${label}`;
    if (control(["print", target], true)) control(["bootout", target]);
  }
}
