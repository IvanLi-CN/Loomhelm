#!/usr/bin/env -S bun --no-install
import { resolve } from "node:path";
import { sourceResources } from "../lib/source-resources.ts";

const inventory = sourceResources(resolve(import.meta.dirname, "../../.."));
const javascript = inventory.files.filter((file) => /\.(?:js|mjs|cjs)$/.test(file.path));
if (javascript.length)
  throw new Error(
    "Owned source must be TypeScript: " + javascript.map((file) => file.path).join(", "),
  );
console.log(
  JSON.stringify({
    ok: true,
    skills: inventory.skills.length,
    sourceFiles: inventory.files.length,
    source: "repository-files",
  }),
);
