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
	const commands = FLOW_CONTRACT.commands as Record<string, any>;
	assert.ok(commands["execution-profile-update"]);
	assert.ok(commands["task-external-merge-reconcile"]);
	assert.deepEqual(
		commands["plan-propose"].request.properties.payload.properties.revision,
		{
			type: "object",
			additionalProperties: false,
			properties: { reason: { type: ["string", "null"] } },
		},
	);
	assert.deepEqual(
		commands["publish-pr-resolve"].request.properties.payload.properties
			.provider_receipt,
		{
			oneOf: [
				{
					type: "object",
					additionalProperties: false,
					required: ["provider", "evidence_ref"],
					properties: {
						provider: { type: "string", minLength: 1 },
						evidence_ref: { type: "string", minLength: 1 },
						message_id: { type: ["string", "null"], minLength: 1 },
						recipient_thread_id: { type: "string", minLength: 1 },
						prompt_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
					},
				},
				{
					type: "object",
					additionalProperties: false,
					required: [
						"provider",
						"repository",
						"resource_type",
						"resource_id",
						"branch",
						"target_branch",
						"base_sha",
						"head_sha",
						"pr",
						"state",
						"evidence_ref",
					],
					properties: {
						provider: { type: "string", minLength: 1 },
						repository: { type: "string", minLength: 1 },
						resource_type: { enum: ["branch", "pr"] },
						resource_id: { type: "string", minLength: 1 },
						branch: { type: "string", minLength: 1 },
						target_branch: { type: ["string", "null"], minLength: 1 },
						base_sha: { type: ["string", "null"], minLength: 1 },
						head_sha: { type: ["string", "null"], minLength: 1 },
						pr: {
							oneOf: [
								{ type: "object", additionalProperties: true },
								{ type: "null" },
							],
						},
						state: { enum: ["exists", "open", "merged", "absent", "unknown"] },
						evidence_ref: { type: "string", minLength: 1 },
					},
				},
			],
		},
	);
	assert.deepEqual(
		commands["notification-reconcile"].response.success.oneOf[1].properties
			.result.required,
		["notifications", "pending", "unacknowledged"],
	);
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
