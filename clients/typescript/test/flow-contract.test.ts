import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enrichFlowContract, FLOW_CONTRACT } from "../src/cli/flow-contract.ts";

test("flow schema exposes the versioned command contract", () => {
	const cli = resolve(import.meta.dir, "../src/cli.ts");
	const result = spawnSync(
		process.execPath,
		["--no-install", cli, "flow", "schema", "--format", "json"],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const domain = JSON.parse(
		readFileSync(
			resolve(
				import.meta.dir,
				"../resources/skills/multi-task-flow/lib/flow-domain-schemas.json",
			),
			"utf8",
		),
	) as Record<string, unknown>;
	assert.deepEqual(JSON.parse(result.stdout), enrichFlowContract(domain));
	for (const [name, contract] of Object.entries(FLOW_CONTRACT.commands)) {
		assert.equal(
			name.includes("*"),
			false,
			`${name} must be an exact command entry`,
		);
		assert.equal(
			typeof contract.request,
			"object",
			`${name} request schema missing`,
		);
		assert.equal(
			typeof contract.response,
			"object",
			`${name} response schema missing`,
		);
	}
});

test("the packaged Skill contract mirrors the canonical repository contract", () => {
	const root = resolve(import.meta.dir, "../..", "..");
	const canonical = readFileSync(
		resolve(
			root,
			"docs/specs/multi-task-flow-unified-atomic-orchestration/CLI-CONTRACT.md",
		),
		"utf8",
	);
	const packaged = readFileSync(
		resolve(root, "skills/multi-task-flow/references/cli-contract.md"),
		"utf8",
	);
	assert.equal(packaged, canonical);
});
