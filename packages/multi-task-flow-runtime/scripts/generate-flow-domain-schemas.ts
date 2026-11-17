#!/usr/bin/env -S bun --no-install
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicEdge, atomicNode } from "../lib/atomic-orchestration";
import { migrationReport } from "../lib/orchestration-migration";
import {
  baselineReceipt,
  executionProfile,
  fact,
  group,
  ledgerSchema,
  notification,
  plan,
  resource,
  task,
} from "../lib/schema";

const output = join(import.meta.dir, "../lib/flow-domain-schemas.json");
mkdirSync(join(import.meta.dir, "../lib"), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://loomhelm.dev/schemas/multi-task-flow/domain-schemas.json",
      migration_report: z.toJSONSchema(migrationReport),
      plan: z.toJSONSchema(plan),
      group: z.toJSONSchema(group),
      task: z.toJSONSchema(task),
      execution_profile: z.toJSONSchema(executionProfile),
      baseline_receipt: z.toJSONSchema(baselineReceipt),
      notification: z.toJSONSchema(notification),
      fact: z.toJSONSchema(fact),
      resource: z.toJSONSchema(resource),
      ledger: z.toJSONSchema(ledgerSchema),
      atomic_node: z.toJSONSchema(atomicNode),
      atomic_edge: z.toJSONSchema(atomicEdge),
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ output }));
