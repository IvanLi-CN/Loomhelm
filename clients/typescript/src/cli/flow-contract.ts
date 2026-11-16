type JsonSchema = Record<string, unknown>;

const id = { type: "string", minLength: 1 } as const;
const stringValue = { type: "string" } as const;
const booleanValue = { type: "boolean" } as const;
const numberValue = { type: "number" } as const;
const objectValue = { type: "object", additionalProperties: true } as const;
const arrayValue = { type: "array", items: objectValue } as const;
const domainRef = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const notificationReceipt = {
	type: "object",
	additionalProperties: false,
	required: ["provider", "evidence_ref"],
	properties: {
		provider: id,
		evidence_ref: id,
		message_id: { type: ["string", "null"], minLength: 1 },
		recipient_thread_id: id,
		prompt_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
	},
} as const;
const publicationReceipt = {
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
		provider: id,
		repository: id,
		resource_type: { enum: ["branch", "pr"] },
		resource_id: id,
		branch: id,
		target_branch: { type: ["string", "null"], minLength: 1 },
		base_sha: { type: ["string", "null"], minLength: 1 },
		head_sha: { type: ["string", "null"], minLength: 1 },
		pr: { oneOf: [objectValue, { type: "null" }] },
		state: { enum: ["exists", "open", "merged", "absent", "unknown"] },
		evidence_ref: id,
	},
} as const;
const providerReceipt = {
	oneOf: [notificationReceipt, publicationReceipt],
} as const;
const revisionInput = {
	type: "object",
	additionalProperties: false,
	properties: { reason: { type: ["string", "null"] } },
} as const;

const actor = {
	type: "object",
	additionalProperties: false,
	required: ["role", "thread_id"],
	properties: { role: { enum: ["main", "group", "task"] }, thread_id: id },
} as const;

const errorResponse = {
	type: "object",
	additionalProperties: false,
	required: ["ok", "code", "revision", "message", "details"],
	properties: {
		ok: { const: false },
		code: stringValue,
		revision: { type: ["integer", "null"] },
		message: stringValue,
		details: objectValue,
	},
} as const;

const field = (name: string): JsonSchema => {
	if (
		name === "verified" ||
		name === "drained" ||
		name === "approval_required" ||
		name === "equivalent_integration"
	)
		return booleanValue;
	if (name === "provider_receipt") return providerReceipt;
	if (name === "error") return stringValue;
	if (name === "revision") return revisionInput;
	if (
		name.endsWith("_ids") ||
		name === "integration_commits" ||
		name === "evidence_refs"
	)
		return { type: "array", items: id };
	if (
		[
			"plan",
			"groups",
			"tasks",
			"group",
			"pr",
			"task_pr",
			"parent_pr",
			"fact",
			"resource",
			"evidence",
			"provider_evidence",
			"provider_receipt",
			"provider_observation",
			"native_evidence",
			"creation_parameters",
			"execution_profile",
			"runtime",
			"baseline",
			"target",
			"lineage_evidence",
			"authorized_actions",
			"authorized_action_ids",
			"inherited_outputs",
			"uninherited_outputs",
		].includes(name)
	) {
		if (name === "plan") return domainRef("plan");
		if (name === "group") return domainRef("group");
		if (name === "tasks") return { type: "array", items: domainRef("task") };
		if (name === "groups") return { type: "array", items: domainRef("group") };
		if (name === "execution_profile") return domainRef("execution_profile");
		return name === "authorized_actions" ||
			name === "authorized_action_ids" ||
			name === "inherited_outputs" ||
			name === "uninherited_outputs"
			? arrayValue
			: objectValue;
	}
	if (
		name.endsWith("_at") ||
		name.endsWith("_sha") ||
		name.endsWith("_id") ||
		name.endsWith("_thread_id") ||
		name.endsWith("_branch") ||
		name.endsWith("_ref") ||
		name.endsWith("_status") ||
		name.endsWith("_state") ||
		name.endsWith("_type") ||
		name === "state" ||
		name === "stage" ||
		name === "mode" ||
		name === "kind" ||
		name === "outcome" ||
		name === "reason" ||
		name === "detail" ||
		name === "title" ||
		name === "prompt" ||
		name === "source" ||
		name === "target_type" ||
		name === "role" ||
		name === "section" ||
		name === "command" ||
		name === "status"
	)
		return stringValue;
	if (name === "expected_revision") return numberValue;
	return objectValue;
};

const objectSchema = (
	names: readonly string[],
	optional: readonly string[] = [],
): JsonSchema => ({
	type: "object",
	additionalProperties: false,
	required: names.filter((name) => !optional.includes(name)),
	properties: Object.fromEntries(names.map((name) => [name, field(name)])),
});
const mutationRequest = (payload: JsonSchema): JsonSchema => ({
	type: "object",
	additionalProperties: false,
	required: ["run_id", "actor", "request_id", "expected_revision", "payload"],
	properties: {
		run_id: id,
		actor,
		request_id: id,
		expected_revision: { type: "integer", minimum: 0 },
		payload,
	},
});
const successResponse = (result: JsonSchema): JsonSchema => ({
	type: "object",
	additionalProperties: true,
	required: ["ok", "code", "revision", "result"],
	properties: {
		ok: { const: true },
		code: { enum: ["APPLIED", "REPLAYED", "CREATED", "OK", "UNKNOWN"] },
		revision: { type: "integer", minimum: 0 },
		result,
	},
});
const resultSchema = (names: readonly string[]): JsonSchema => ({
	...objectSchema(names),
	additionalProperties: true,
});
const command = (
	payloadNames: readonly string[],
	resultNames: readonly string[],
	options: {
		access?: string;
		optionalPayload?: readonly string[];
		read?: boolean;
	} = {},
): JsonSchema => ({
	access: options.access ?? (options.read ? "read" : "write"),
	request: options.read
		? {
				type: "object",
				additionalProperties: false,
				required: ["run_id", "actor"],
				properties: {
					run_id: id,
					actor,
					payload: objectSchema(payloadNames, options.optionalPayload),
				},
			}
		: mutationRequest(objectSchema(payloadNames, options.optionalPayload)),
	response: {
		success: successResponse(resultSchema(resultNames)),
		error: errorResponse,
	},
});

const entries: Record<string, JsonSchema> = {};
const add = (
	name: string,
	payloadNames: readonly string[],
	resultNames: readonly string[],
	options: Parameters<typeof command>[2] = {},
) => {
	entries[name] = command(payloadNames, resultNames, options);
};

add(
	"binding-resolve",
	["owner_decision", "previous_owner_observation"],
	["owner_thread_id"],
);
add("link-verification", ["verified", "evidence"], ["verified"]);
add(
	"plan-propose",
	["plan", "groups", "tasks", "revision"],
	["plan_id", "change_class", "approval_required", "paused_task_ids"],
	{ optionalPayload: ["revision"] },
);
add(
	"plan-approve",
	["plan_id", "approval_id", "authorized_action_ids", "authorized_actions"],
	["plan_id"],
);
add(
	"protected-approve",
	["kind", "target_id", "approval_id", "target_digest"],
	["target_id", "kind", "approval_id"],
	{ optionalPayload: ["target_digest"] },
);
add("plan-abandon", ["plan_id"], ["plan_id", "restored_plan_id"], {
	optionalPayload: ["restored_plan_id"],
});
add(
	"task-migrate",
	[
		"old_task_id",
		"new_task_id",
		"reason",
		"inherited_outputs",
		"uninherited_outputs",
	],
	["old_task_id", "new_task_id"],
);
add("dispatch-claim", ["task_id"], ["operation_id"]);
add("dispatch-group-claim", ["group_id"], ["operation_id"]);
add(
	"dispatch-resolve",
	["operation_id", "outcome", "native_evidence", "thread_id"],
	["operation_id", "outcome", "thread_id", "notification_request"],
	{ optionalPayload: ["thread_id", "native_evidence"] },
);
add("execution-profile-migrate", ["execution_profile"], ["execution_profile"]);
add(
	"execution-profile-default-update",
	["execution_profile"],
	["execution_profile"],
);
add(
	"execution-profile-recommend",
	["target_type", "target_id", "execution_profile"],
	["target_type", "target_id", "execution_profile"],
);
add(
	"execution-profile-update",
	["target_type", "target_id", "execution_profile"],
	["target_type", "target_id", "execution_profile"],
);
add(
	"dispatch-progress",
	["operation_id", "native_request_id", "thread_id"],
	["operation_id", "thread_id"],
);
add(
	"dispatch-bind-request",
	["operation_id", "native_request_id", "creation_parameters"],
	["operation_id", "native_request_id"],
);
add(
	"development-baseline-sync",
	[
		"target_type",
		"target_id",
		"mode",
		"dispatch_operation_id",
		"baseline",
		"expected_previous_baseline",
		"expected_lineage_sha",
		"lineage_event_id",
		"branch",
		"resource_ids",
		"evidence_ref",
	],
	["target_type", "target_id", "mode", "previous_sha", "sha", "fact_id"],
	{
		optionalPayload: [
			"dispatch_operation_id",
			"expected_previous_baseline",
			"expected_lineage_sha",
			"lineage_event_id",
			"branch",
			"resource_ids",
		],
	},
);
add(
	"lifecycle-record",
	[
		"target_type",
		"target_id",
		"stage",
		"branch",
		"resource_ids",
		"baseline",
		"evidence_ref",
	],
	["target_type", "target_id", "stage"],
	{ optionalPayload: ["baseline"] },
);
add(
	"milestone-record",
	["target_type", "target_id", "milestone_id", "title", "evidence_ref"],
	["milestone_id"],
	{ optionalPayload: ["evidence_ref"] },
);
add(
	"publish-branch-claim",
	["target_type", "target_id", "branch", "action_id", "expected_head_sha"],
	["operation_id"],
);
add(
	"publish-branch-resolve",
	[
		"operation_id",
		"outcome",
		"provider_receipt",
		"provider_observation",
		"fact_id",
		"verified_no_effect",
	],
	["operation_id", "outcome"],
	{
		optionalPayload: [
			"provider_receipt",
			"provider_observation",
			"fact_id",
			"verified_no_effect",
		],
	},
);
add(
	"publish-pr-claim",
	[
		"target_type",
		"target_id",
		"branch",
		"expected_head_sha",
		"expected_base_sha",
		"pr",
		"action_id",
		"target_branch",
	],
	["operation_id"],
	{ optionalPayload: ["pr", "target_branch"] },
);
add(
	"publish-pr-resolve",
	[
		"operation_id",
		"outcome",
		"provider_receipt",
		"provider_observation",
		"fact_id",
		"verified_no_effect",
	],
	["operation_id", "outcome"],
	{
		optionalPayload: [
			"provider_receipt",
			"provider_observation",
			"fact_id",
			"verified_no_effect",
		],
	},
);
add(
	"task-runtime-observe",
	["task_id", "thread_id", "runtime", "observed_at", "turn_id"],
	["state"],
	{ optionalPayload: ["turn_id"] },
);
add(
	"task-update",
	["task_id", "state", "evidence", "detail", "occurred_at"],
	[
		"task_id",
		"state",
		"notification_id",
		"notification_status",
		"notification_request",
	],
	{ optionalPayload: ["evidence", "detail", "occurred_at"] },
);
add(
	"task-equivalent-integrate",
	[
		"task_id",
		"task_pr",
		"parent_pr",
		"task_head_sha",
		"parent_merge_sha",
		"integration_commits",
		"evidence_ref",
	],
	["task_id", "state", "equivalent_integration"],
);
add(
	"atom-update",
	["task_id", "atom_id", "state"],
	["task_id", "atom_id", "state"],
);
add(
	"group-atom-update",
	["group_id", "atom_id", "state", "detail", "occurred_at"],
	["group_id", "atom_id", "state"],
	{ optionalPayload: ["detail", "occurred_at"] },
);
add(
	"group-execution-update",
	["group_id", "state", "waiting_for_task_ids", "reason", "occurred_at"],
	["group_id", "coordination_execution"],
	{ optionalPayload: ["waiting_for_task_ids", "reason", "occurred_at"] },
);
add("group-update", ["group"], ["group_id", "state"]);
add(
	"group-base",
	["group_id", "provider_observation"],
	["group_id", "current_sha"],
);
add(
	"group-base-reconcile",
	["group_id", "provider_observation"],
	["group_id", "previous_sha", "current_sha"],
);
add(
	"task-external-merge-reconcile",
	[
		"task_id",
		"recovery_approval_id",
		"pr",
		"provider_observation",
		"merge_sha",
		"quality_evidence",
	],
	[
		"task_id",
		"state",
		"pr",
		"quality_fact_id",
		"publication_fact_id",
		"merge_fact_id",
		"current_group_sha",
	],
);
add("task-pr", ["task_id", "pr"], ["task_id", "pr"]);
add("task-base", ["task_id", "base_sha", "evidence"], ["task_id", "base_sha"], {
	optionalPayload: ["evidence"],
});
add("task-quality-record", ["task_id", "base_sha", "evidence"], ["fact_id"]);
add(
	"follow-pr-update",
	[
		"follow_pr_id",
		"origin_task_id",
		"origin_group_id",
		"target_branch",
		"pr",
		"affected_task_ids",
	],
	["follow_pr_id", "target_branch"],
	{
		optionalPayload: ["origin_task_id", "origin_group_id", "affected_task_ids"],
	},
);
add(
	"merge-claim",
	[
		"group_id",
		"mode",
		"pr",
		"expected_head_sha",
		"expected_base_sha",
		"task_id",
		"original_parent_pr",
		"original_parent_merge_sha",
		"follow_pr_id",
		"target_branch",
		"owner_approval_id",
	],
	["operation_id"],
	{
		optionalPayload: [
			"group_id",
			"task_id",
			"original_parent_pr",
			"original_parent_merge_sha",
			"follow_pr_id",
			"target_branch",
			"owner_approval_id",
		],
	},
);
add(
	"merge-resolve",
	["operation_id", "outcome", "provider_evidence", "provider_observation"],
	[
		"operation_id",
		"outcome",
		"notification_id",
		"notification_status",
		"notification_request",
	],
	{ optionalPayload: ["provider_evidence", "provider_observation"] },
);
add("cut-claim", ["group_id", "rule_id"], ["operation_id", "drained"]);
add(
	"cut-apply",
	[
		"operation_id",
		"cut_sha",
		"provider_evidence",
		"next_group",
		"included_task_ids",
	],
	["operation_id", "next_group_id", "reassigned_task_ids"],
	{},
);
add("fact-record", ["fact"], ["fact_id"]);
add(
	"action-claim",
	[
		"kind",
		"task_id",
		"owner_approval_id",
		"action_id",
		"expected_sha",
		"target",
	],
	["operation_id"],
	{},
);
add(
	"action-resolve",
	[
		"operation_id",
		"outcome",
		"provider_evidence",
		"lineage_evidence",
		"provider_observation",
	],
	["operation_id", "outcome"],
	{
		optionalPayload: [
			"provider_evidence",
			"lineage_evidence",
			"provider_observation",
		],
	},
);
add(
	"notification-deliver",
	[
		"notification_id",
		"provider_receipt",
		"outcome",
		"delivery_attempt_id",
		"error",
	],
	[
		"notification_id",
		"delivery_attempt_id",
		"ledger_status",
		"delivery_status",
		"ack_status",
	],
	{
		optionalPayload: [
			"provider_receipt",
			"outcome",
			"delivery_attempt_id",
			"error",
		],
	},
);
add(
	"notification-reconcile",
	[
		"notification_id",
		"delivery_attempt_id",
		"reconciliation_id",
		"outcome",
		"provider_receipt",
		"error",
	],
	[
		"notification_id",
		"reconciliation_id",
		"ledger_status",
		"delivery_status",
		"ack_status",
	],
	{
		optionalPayload: [
			"notification_id",
			"delivery_attempt_id",
			"reconciliation_id",
			"outcome",
			"provider_receipt",
			"error",
		],
	},
);
add(
	"notification-sent",
	["provider_receipt", "notification_id"],
	["notification_id", "ledger_status", "delivery_status", "ack_status"],
);
add(
	"notification-ack",
	["notification_id", "handling_evidence"],
	[
		"notification_id",
		"status",
		"ledger_status",
		"delivery_status",
		"ack_status",
	],
);
add("resource-update", ["resource"], ["resource_id", "status"]);
add("run-complete", ["evidence"], ["state"]);
add(
	"group-close",
	["group_id"],
	[
		"group_id",
		"state",
		"notification_id",
		"notification_status",
		"notification_request",
	],
);
add(
	"group-closeout-reconcile",
	[
		"group_id",
		"plan_id",
		"outcome",
		"provider_observation",
		"closeout_event_id",
		"reconciliation_id",
		"reason",
		"evidence_refs",
	],
	["group_id", "state", "outcome", "reconciliation_id"],
	{ optionalPayload: ["provider_observation", "reason", "evidence_refs"] },
);
add(
	"group-reopen",
	["group_id", "plan_id", "recovery_id", "reason", "evidence_refs"],
	["group_id", "state", "recovery_id"],
);

const specialCommands: Record<string, JsonSchema> = {
	init: {
		access: "write",
		request: {
			type: "object",
			additionalProperties: false,
			required: ["run_id", "actor", "payload"],
			properties: {
				run_id: id,
				actor,
				payload: objectSchema([
					"repository",
					"config",
					"initial_plan",
					"groups",
					"tasks",
				]),
			},
		},
		response: {
			success: successResponse(objectSchema(["run_id"])),
			error: errorResponse,
		},
	},
	migrate: command([], ["run_id"]),
	"conversation-create": command(
		["operation_id", "title", "prompt"],
		["operation_id", "outcome", "thread_id", "notification_request"],
		{
			access: "external-write",
			optionalPayload: ["thread_id", "notification_request"],
		},
	),
	"creation-reconcile": command(
		["operation_id"],
		["operation_id", "outcome", "thread_id", "notification_delivery"],
		{
			access: "reconcile",
			optionalPayload: ["thread_id", "notification_delivery"],
		},
	),
	"notification-prepare": command(
		["notification_id"],
		["notification_id", "delivery_attempt_id"],
		{ access: "external-write" },
	),
	"notification-send": command(
		["notification_id"],
		["notification_id", "delivery_attempt_id"],
		{ access: "external-write" },
	),
	"notification-reconcile": {
		access: "read-or-write",
		request: {
			oneOf: [
				mutationRequest(
					objectSchema(
						[
							"notification_id",
							"delivery_attempt_id",
							"reconciliation_id",
							"outcome",
							"provider_receipt",
							"error",
						],
						["delivery_attempt_id", "error"],
					),
				),
				{
					type: "object",
					additionalProperties: false,
					required: ["run_id", "actor"],
					properties: {
						run_id: id,
						actor,
						status: {
							enum: ["pending", "sent", "failed", "unknown", "acknowledged"],
						},
					},
				},
			],
		},
		response: {
			success: {
				oneOf: [
					successResponse(
						objectSchema([
							"notification_id",
							"reconciliation_id",
							"ledger_status",
							"delivery_status",
							"ack_status",
						]),
					),
					successResponse({
						type: "object",
						additionalProperties: false,
						required: ["notifications", "pending", "unacknowledged"],
						properties: {
							notifications: {
								type: "array",
								items: domainRef("notification"),
							},
							pending: { type: "integer", minimum: 0 },
							unacknowledged: { type: "integer", minimum: 0 },
						},
					}),
				],
			},
			error: errorResponse,
		},
	},
	show: {
		access: "read",
		request: {
			type: "object",
			additionalProperties: false,
			required: ["run_id", "actor"],
			properties: {
				run_id: id,
				actor,
				section: {
					enum: [
						"summary",
						"plan",
						"tasks",
						"operations",
						"notifications",
						"task-context",
						"full",
					],
				},
				task_id: id,
			},
		},
		response: { success: successResponse(objectValue), error: errorResponse },
	},
	view: {
		access: "read",
		request: {
			type: "object",
			additionalProperties: false,
			required: ["run_id", "actor"],
			properties: { run_id: id, actor, plan_id: id },
		},
		response: { success: successResponse(objectValue), error: errorResponse },
	},
};

Object.assign(entries, specialCommands);

export const FLOW_CONTRACT = Object.freeze({
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://loomhelm.dev/schemas/multi-task-flow/flow-contract.schema.json",
	schema_version: 2,
	contract_version: 3,
	content_type: "application/json",
	invocation:
		"bunx --bun @loomhelm/multi-task-flow@<exact-version> flow <command> --input -",
	commands: entries,
	error_codes: [
		"ACTOR_MISMATCH",
		"ARCHIVE_IN_FLIGHT",
		"BODY_TOO_LARGE",
		"CYCLE",
		"FORBIDDEN",
		"INVALID_ARGUMENTS",
		"INVALID_COMMAND",
		"INVALID_INPUT",
		"INVALID_PLAN",
		"INVALID_PROFILE",
		"INVALID_RESULT",
		"LEDGER_UNREADABLE",
		"MIGRATION_CONFLICT",
		"NATIVE_REQUEST_CONFLICT",
		"NOT_FOUND",
		"ORPHAN_GROUP",
		"PLAN_NOT_FOUND",
		"PROFILE_CONFLICT",
		"RUN_EXISTS",
		"UNKNOWN_COMMAND",
		"VIEWER_BINDING_INVALID",
		"REVISION_CONFLICT",
		"UNKNOWN",
	],
	sources: {
		runtime_validation: "packages/multi-task-flow-runtime/lib/engine.ts",
		domain_schema: "packages/multi-task-flow-runtime/lib/schema.ts",
		human_contract:
			"docs/specs/multi-task-flow-unified-atomic-orchestration/CLI-CONTRACT.md",
	},
} as const);

export function enrichFlowContract(
	domainSchemas: Record<string, unknown>,
): Record<string, unknown> {
	const {
		$schema: domainSchemaDialect,
		$id: domainSchemaId,
		...definitions
	} = domainSchemas;
	return {
		...FLOW_CONTRACT,
		$defs: definitions,
		domain_schema: { dialect: domainSchemaDialect, id: domainSchemaId },
	};
}

export function flowHelp(command?: string): string {
	if (!command)
		return "flow COMMAND --input - [--socket PATH] | flow COMMAND --help | flow schema --format json";
	const metadata =
		FLOW_CONTRACT.commands[command as keyof typeof FLOW_CONTRACT.commands];
	return metadata
		? `${command}: ${JSON.stringify(metadata)}`
		: `Unknown flow command: ${command}; use flow schema --format json`;
}
