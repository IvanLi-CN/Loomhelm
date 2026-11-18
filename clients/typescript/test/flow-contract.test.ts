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
	for (const command of ["atom-update", "group-atom-update"]) {
		assert.deepEqual(
			commands[command].request.properties.payload.properties.state.enum,
			["planned", "running", "blocked", "completed"],
		);
	}
	assert.deepEqual(
		commands["plan-propose"].request.properties.payload.properties.revision,
		{
			type: "object",
			additionalProperties: false,
			properties: { reason: { type: ["string", "null"] } },
		},
	);
	const publicationReceipt = commands["publish-pr-resolve"].request.properties.payload
		.properties.provider_receipt;
	assert.equal(publicationReceipt.properties.repository.type, "string");
	assert.equal(publicationReceipt.properties.branch.type, "string");
	assert.equal(publicationReceipt.properties.evidence_ref.minLength, 1);
	const lifecycleRecord = commands["lifecycle-record"].request.properties.payload;
	assert.equal(lifecycleRecord.properties.branch.type, "string");
	const protectedApprove = commands["protected-approve"].request.properties.payload;
	assert.equal(protectedApprove.properties.target_digest.pattern, "^[a-f0-9]{64}$");
	const mergeClaim = commands["merge-claim"].request.properties.payload;
	assert.equal(
		mergeClaim.properties.original_parent_merge_sha.pattern,
		"^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
	);
	assert.deepEqual(
		mergeClaim.allOf.map((condition: any) => condition.then.required),
		[["owner_approval_id"], ["owner_approval_id", "original_parent_pr", "original_parent_merge_sha"]],
	);
	assert.deepEqual(
		commands["notification-reconcile"].response.success.oneOf[1].properties
			.result.required,
		["notifications", "pending", "unacknowledged"],
	);
	const notificationPrepareResult = commands["notification-prepare"].response.success
		.properties.result;
	assert.equal(notificationPrepareResult.properties.result.type, "object");
	assert.equal(notificationPrepareResult.properties.delivery_attempt_id.type, "string");
});

test("the packaged Skill contract mirrors the canonical repository contract", () => {
	const root = resolve(import.meta.dir, "../..", "..");
	const canonicalPath =
		"docs/specs/multi-task-flow-unified-atomic-orchestration/CLI_CONTRACT.md";
	assert.equal(FLOW_CONTRACT.sources.human_contract, canonicalPath);
	const canonical = readFileSync(
		resolve(root, canonicalPath),
		"utf8",
	);
	const packaged = readFileSync(
		resolve(root, "skills/multi-task-flow/references/cli-contract.md"),
		"utf8",
	);
	assert.equal(packaged, canonical);
});
