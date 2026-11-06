import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output-last-message");
const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : undefined;

if (!outputPath) {
  console.error("mock codex requires --output-last-message");
  process.exitCode = 2;
} else {
  await writeFile(
    outputPath,
    `${JSON.stringify({
      route: "normal-flow",
      stop: "local-can-open-pr",
      confirmation: false,
      research: false,
      visual: false,
      forbidden: [],
    })}\n`,
    "utf8",
  );
}
