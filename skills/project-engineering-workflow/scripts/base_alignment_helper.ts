import { main } from "./base_alignment";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun skills/project-engineering-workflow/scripts/base_alignment_helper.ts [inspect|apply-auto|safe-align] [options]",
    );
  } else process.exitCode = await main(argv);
}
