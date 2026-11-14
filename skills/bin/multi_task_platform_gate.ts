import { Runtime } from "./modules/core/runtime";
export {};

const supportedPlatforms = new Set(["darwin", "linux"]);

if (!supportedPlatforms.has(process.platform)) {
  console.error(
    `PLATFORM_GATE: multi-task runtime tests require Darwin or Linux; refusing an unsupported platform: ${process.platform}`,
  );
  process.exit(1);
}

const child = Runtime.spawn(
  [
    process.execPath,
    "test",
    "--path-ignore-patterns",
    "packages/multi-task-flow-runtime/tests/ui/**",
    "packages/multi-task-flow-runtime/tests",
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.exit(await child.exited);
