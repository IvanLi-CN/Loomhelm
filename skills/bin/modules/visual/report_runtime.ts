import {
  accessSync,
  copyFileSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  identity,
  removeStagingPath,
  runSandboxedCommand,
  sandboxAvailable,
  type RunResult,
  REG_CLI_COMMAND,
  REG_CLI_VERSION,
} from "./isolation";
import { isRealDirectory, isRegularFile, pathWithin } from "./paths";

export type RunRegCli = (
  directory: string,
  command?: readonly string[],
) => RunResult | undefined;
export type CloneFile = (source: string, destination: string) => void;

const packageRoot = resolve(import.meta.dir, "../../reg-cli-report");

function commandPath(command: string, pathValue?: string): string {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    const candidate = join(directory || ".", command);
    try {
      const canonical = realpathSync(candidate);
      if (!lstatSync(canonical).isFile()) continue;
      accessSync(canonical, constants.X_OK);
      return canonical;
    } catch {}
  }
  throw new Error(`${command} is unavailable`);
}

export const runRegCli: RunRegCli = (directory, command = REG_CLI_COMMAND) => {
  if (command.join(" ") !== REG_CLI_COMMAND.join(" "))
    throw new Error(
      "reg-cli command is fixed; custom commands are not supported",
    );
  if (!isRealDirectory(directory))
    throw new Error("reg-cli staging directory is not a regular directory");
  if (!sandboxAvailable())
    throw new Error(
      "reg-cli reports require macOS sandbox-exec; refusing to run unsandboxed",
    );
  const runtime = mkdtempSync(join(directory, ".reg-cli-runtime-"));
  const runtimeIdentity = identity(runtime);
  let completed = false;
  try {
    const runtimeHome = join(runtime, "home");
    const runtimeTmp = join(runtime, "tmp");
    const npmCache = join(runtime, "npm-cache");
    const packageDirectory = join(runtime, "package");
    for (const path of [runtimeHome, runtimeTmp, npmCache, packageDirectory])
      mkdirSync(path);
    const npmrc = join(runtime, "global.npmrc");
    writeFileSync(npmrc, "", "utf8");
    for (const filename of ["package.json", "package-lock.json"])
      copyFileSync(
        join(packageRoot, filename),
        join(packageDirectory, filename),
      );
    const env: Record<string, string> = {};
    for (const key of [
      "PATH",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ])
      if (process.env[key]) env[key] = process.env[key] as string;
    Object.assign(env, {
      HOME: runtimeHome,
      TMPDIR: runtimeTmp,
      TMP: runtimeTmp,
      TEMP: runtimeTmp,
      npm_config_cache: npmCache,
      npm_config_logs_dir: join(npmCache, "_logs"),
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: npmrc,
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      CI: "1",
    });
    const node = commandPath("node", env.PATH);
    const npm = commandPath("npm", env.PATH);
    const npmBin = dirname(npm);
    const npmPackage = dirname(npmBin);
    const npmNodeModules = dirname(npmPackage);
    const nodeLib = dirname(npmNodeModules);
    const nodeRoot = dirname(nodeLib);
    if (
      basename(npm) !== "npm-cli.js" ||
      [npmBin, npmPackage, npmNodeModules, nodeLib]
        .map((path) => basename(path))
        .join("/") !== "skills/bin/npm/node_modules/lib"
    )
      throw new Error(
        "npm installation layout is unsupported; refusing to run unsandboxed",
      );
    if (dirname(dirname(node)) !== nodeRoot)
      throw new Error("node and npm must belong to the same installation");
    const npmRoot = npmPackage;
    runSandboxedCommand(
      directory,
      [
        node,
        npm,
        "ci",
        "--prefix",
        packageDirectory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-update-notifier",
        "--registry=https://registry.npmjs.org/",
      ],
      {
        runtimeDir: runtime,
        env,
        allowNetwork: true,
        label: "pinned-reg-cli-installation",
        additionalReadPaths: [runtime, node, npmRoot],
        includeStagingRead: false,
        includeSnapshotReads: false,
        workingDirectory: packageDirectory,
      },
    );
    let installedPackageDirectory = join(
      packageDirectory,
      "node_modules",
      "reg-cli",
    );
    const runtimeRoot = realpathSync(runtime);
    if (!isRealDirectory(installedPackageDirectory))
      throw new Error("npm did not install the pinned reg-cli package");
    installedPackageDirectory = realpathSync(installedPackageDirectory);
    if (!pathWithin(runtimeRoot, installedPackageDirectory))
      throw new Error("pinned reg-cli package escaped the runtime directory");
    const manifestPath = join(installedPackageDirectory, "package.json");
    if (!isRegularFile(manifestPath))
      throw new Error("pinned reg-cli package metadata is missing");
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      manifest = parsed as Record<string, unknown>;
    } catch {
      throw new Error("pinned reg-cli package metadata is invalid");
    }
    if (manifest.version !== REG_CLI_VERSION)
      throw new Error("npm installed an unexpected reg-cli version");
    const bin = manifest.bin;
    const entry =
      bin && typeof bin === "object" && !Array.isArray(bin)
        ? (bin as Record<string, unknown>)["reg-cli"]
        : undefined;
    if (
      typeof entry !== "string" ||
      isAbsolute(entry) ||
      /^[A-Za-z]:[\\/]/.test(entry) ||
      entry.split(/[\\/]/).includes("..")
    )
      throw new Error("pinned reg-cli package has no expected executable");
    let executable: string;
    try {
      executable = realpathSync(resolve(installedPackageDirectory, entry));
    } catch {
      throw new Error("pinned reg-cli executable is missing");
    }
    if (
      !pathWithin(installedPackageDirectory, executable) ||
      !isRegularFile(executable)
    )
      throw new Error("pinned reg-cli executable is missing");
    runSandboxedCommand(
      directory,
      [
        node,
        executable,
        "actual",
        "expected",
        "diff",
        "-R",
        "report.html",
        "-J",
        "reg.json",
        "-I",
      ],
      {
        runtimeDir: runtime,
        env,
        allowNetwork: false,
        label: "reg-cli",
        additionalReadPaths: [node],
        includeSnapshotReads: true,
        workingDirectory: directory,
      },
    );
    completed = true;
    return { runtimeName: runtime.split("/").at(-1) ?? "", runtimeIdentity };
  } finally {
    if (!completed) removeStagingPath(runtime, runtimeIdentity);
  }
};
