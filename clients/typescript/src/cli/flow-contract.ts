type JsonSchema = Record<string, unknown>;

const id = {
	type: "string",
	minLength: 1,
	maxLength: 128,
	pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$",
} as const;
const requestId = { ...id, maxLength: 96, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$" } as const;
const textValue = { type: "string", minLength: 1 } as const;
const stringValue = { type: "string" } as const;
const booleanValue = { type: "boolean" } as const;
const numberValue = { type: "number" } as const;
const objectValue = { type: "object", additionalProperties: true } as const;
const stringArrayValue = { type: "array", items: stringValue } as const;
const idArrayValue = { type: "array", items: id } as const;
const nonEmptyIdArrayValue = { type: "array", items: id, minItems: 1 } as const;
const nullableId = { oneOf: [id, { type: "null" }] } as const;
const shaValue = {
	type: "string",
	pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
} as const;
const sha40Value = { type: "string", pattern: "^[a-f0-9]{40}$" } as const;
const digestValue = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const commitArrayValue = {
	type: "array",
	items: sha40Value,
	minItems: 1,
} as const;
const domainRef = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const externalRefValue = {
	type: "object",
	additionalProperties: false,
	required: ["provider", "repository", "id", "url"],
	properties: {
		provider: textValue,
		repository: textValue,
		id: textValue,
		url: { type: ["string", "null"], format: "uri" },
	},
} as const;
const notificationReceipt = {
	type: "object",
	additionalProperties: false,
	required: ["provider", "evidence_ref"],
	properties: {
		provider: textValue,
		evidence_ref: textValue,
		message_id: { type: ["string", "null"], minLength: 1 },
		recipient_thread_id: textValue,
		prompt_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
	},
	if: { properties: { provider: { const: "codex-app-tools" } } },
	then: { required: ["recipient_thread_id", "prompt_digest"] },
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
		provider: textValue,
		repository: textValue,
		resource_type: { enum: ["branch", "pr"] },
		resource_id: textValue,
		branch: textValue,
		target_branch: { type: ["string", "null"], minLength: 1 },
		base_sha: { oneOf: [shaValue, { type: "null" }] },
		head_sha: { oneOf: [shaValue, { type: "null" }] },
		pr: { oneOf: [externalRefValue, { type: "null" }] },
		state: { enum: ["exists", "open", "merged", "absent", "unknown"] },
		evidence_ref: textValue,
	},
} as const;
const groupBaseObservation = {
	type: "object",
	additionalProperties: false,
	required: ["branch", "sha", "source", "evidence_ref"],
	properties: {
		branch: textValue,
		sha: shaValue,
		source: textValue,
		evidence_ref: textValue,
		ancestor_sha: { oneOf: [shaValue, { type: "null" }] },
	},
} as const;
const groupBaseReconciliation = {
	type: "object",
	additionalProperties: false,
	required: ["operation", "branch", "previous_sha", "sha", "parent_pr", "source", "evidence_ref"],
	properties: {
		operation: { const: "update-branch" },
		branch: textValue,
		previous_sha: shaValue,
		sha: shaValue,
		parent_pr: externalRefValue,
		source: textValue,
		evidence_ref: textValue,
	},
} as const;
const mergeObservation = {
	type: "object",
	additionalProperties: false,
	required: ["pr", "head_sha", "base_sha", "merge_sha", "state"],
	properties: {
		pr: externalRefValue,
		head_sha: shaValue,
		base_sha: shaValue,
		merge_sha: shaValue,
		state: { const: "merged" },
	},
} as const;
const utcDateTime = {
	type: "string",
	format: "date-time",
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
} as const;
const closeoutObservation = {
	type: "object",
	additionalProperties: false,
	required: ["pr", "provider_state", "merge_sha", "source", "observed_at", "evidence_ref"],
	properties: {
		pr: externalRefValue,
		provider_state: { enum: ["merged", "closed", "open", "unknown"] },
		merge_sha: { oneOf: [shaValue, { type: "null" }] },
		source: textValue,
		observed_at: utcDateTime,
		evidence_ref: textValue,
	},
} as const;
const notificationDeliveryResult = {
	type: "object",
	additionalProperties: true,
	required: [
		"result",
		"replayed",
		"delivery_attempt_id",
		"should_send",
		"next_action",
		"tool_request",
		"receipt_command",
		"receipt_identity",
	],
	properties: {
		result: objectValue,
		replayed: booleanValue,
		delivery_attempt_id: id,
		should_send: booleanValue,
		next_action: { enum: ["send_message_to_thread", "notification-reconcile"] },
		tool_request: { oneOf: [objectValue, { type: "null" }] },
		receipt_command: { const: "notification-reconcile" },
		receipt_identity: objectValue,
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
	if (name === "expected_previous_baseline")
		return { oneOf: [objectValue, { type: "null" }] };
	if (name === "expected_lineage_sha") return { oneOf: [shaValue, { type: "null" }] };
	if (name === "target_digest") return digestValue;
	if (name === "runtime") return { enum: ["active", "idle", "unknown"] };
	if (name === "evidence" || name === "handling_evidence" || name === "change_class")
		return stringValue;
	if (name === "sha" || name.endsWith("_sha")) return shaValue;
	if (
		name.endsWith("_ids") ||
		name === "integration_commits" ||
		name === "evidence_refs"
	)
		return name === "integration_commits"
			? commitArrayValue
			: name === "evidence_refs"
				? stringArrayValue
				: name === "resource_ids"
					? nonEmptyIdArrayValue
					: idArrayValue;
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
			? stringArrayValue
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
	overrides: Record<string, JsonSchema> = {},
): JsonSchema => ({
	type: "object",
	additionalProperties: false,
	required: names.filter((name) => !optional.includes(name)),
	properties: Object.fromEntries(names.map((name) => [name, overrides[name] ?? field(name)])),
});
const mutationRequest = (payload: JsonSchema): JsonSchema => ({
	type: "object",
	additionalProperties: false,
	required: ["run_id", "actor", "request_id", "expected_revision", "payload"],
	properties: {
		run_id: id,
		actor,
		request_id: requestId,
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
const resultField = (name: string): JsonSchema =>
	name.endsWith("_id") ||
	name.endsWith("_thread_id")
		? nullableId
			: name === "notification_request"
				? { oneOf: [objectValue, { type: "null" }] }
			: name === "previous_sha" || name === "sha"
				? { oneOf: [shaValue, { type: "null" }] }
			: field(name);
const resultSchema = (
	names: readonly string[],
	optional: readonly string[] = [],
	overrides: Record<string, JsonSchema> = {},
): JsonSchema => ({
	type: "object",
	additionalProperties: true,
	required: names.filter((name) => !optional.includes(name)),
	properties: Object.fromEntries(
		names.map((name) => [name, overrides[name] ?? resultField(name)]),
	),
});
const command = (
	payloadNames: readonly string[],
	resultNames: readonly string[],
	options: {
		access?: string;
		optionalPayload?: readonly string[];
		optionalResult?: readonly string[];
		payloadOverrides?: Record<string, JsonSchema>;
		payloadAnyOfRequired?: readonly (readonly string[])[];
		payloadIfThen?: readonly { when: JsonSchema; required: readonly string[] }[];
		resultOverrides?: Record<string, JsonSchema>;
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
				payload: objectSchema(payloadNames, options.optionalPayload, options.payloadOverrides),
				},
			}
		: mutationRequest(
				Object.assign(
					objectSchema(payloadNames, options.optionalPayload, options.payloadOverrides),
					options.payloadAnyOfRequired
						? {
							anyOf: options.payloadAnyOfRequired.map((names) => ({ required: names })),
						}
						: {},
					options.payloadIfThen
						? {
							allOf: options.payloadIfThen.map((condition) => ({
								if: condition.when,
								["then"]: { required: condition.required },
							})),
						}
						: {},
				),
			),
	response: {
		success: successResponse(
			resultSchema(resultNames, options.optionalResult, options.resultOverrides),
		),
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
	{
		optionalPayload: ["thread_id", "native_evidence"],
		optionalResult: ["notification_request"],
	},
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
	{ optionalPayload: ["execution_profile"] },
);
add(
	"execution-profile-update",
	["target_type", "target_id", "execution_profile"],
	["target_type", "target_id", "execution_profile"],
	{
		payloadOverrides: {
			execution_profile: { oneOf: [domainRef("execution_profile"), { type: "null" }] },
		},
		resultOverrides: {
			execution_profile: { oneOf: [domainRef("execution_profile"), { type: "null" }] },
		},
	},
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
		payloadOverrides: {
			baseline: domainRef("baseline_receipt"),
			expected_previous_baseline: {
				oneOf: [domainRef("baseline_receipt"), { type: "null" }],
			},
		},
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
		"baseline_sync",
		"evidence_ref",
	],
	["target_type", "target_id", "stage"],
	{
		optionalPayload: ["baseline", "baseline_sync"],
		payloadIfThen: [{ when: { required: ["baseline_sync"] }, required: ["baseline"] }],
		payloadOverrides: {
			branch: stringValue,
			baseline: domainRef("baseline_receipt"),
			baseline_sync: {
				type: "object",
				additionalProperties: false,
				required: ["mode", "dispatch_operation_id", "expected_previous_baseline", "expected_lineage_sha", "lineage_event_id"],
				properties: {
					mode: { enum: ["initial", "refresh"] },
					dispatch_operation_id: id,
					expected_previous_baseline: { oneOf: [domainRef("baseline_receipt"), { type: "null" }] },
					expected_lineage_sha: { oneOf: [shaValue, { type: "null" }] },
					lineage_event_id: textValue,
				},
			},
		},
	},
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
		optionalPayload: ["provider_receipt", "provider_observation", "verified_no_effect"],
		payloadAnyOfRequired: [["provider_receipt"], ["provider_observation"]],
		payloadOverrides: {
			provider_receipt: publicationReceipt,
			provider_observation: publicationReceipt,
		},
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
	{},
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
		optionalPayload: ["provider_receipt", "provider_observation", "verified_no_effect"],
		payloadAnyOfRequired: [["provider_receipt"], ["provider_observation"]],
		payloadOverrides: {
			provider_receipt: publicationReceipt,
			provider_observation: publicationReceipt,
		},
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
	{
		payloadOverrides: {
			task_head_sha: sha40Value,
			parent_merge_sha: sha40Value,
		},
	},
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
	{ payloadOverrides: { provider_observation: groupBaseObservation } },
);
add(
	"group-base-reconcile",
	["group_id", "provider_observation"],
	["group_id", "previous_sha", "current_sha"],
	{ payloadOverrides: { provider_observation: groupBaseReconciliation } },
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
	{
		payloadOverrides: {
			pr: externalRefValue,
			provider_observation: publicationReceipt,
			quality_evidence: domainRef("fact"),
		},
	},
);
add("task-pr", ["task_id", "pr"], ["task_id", "pr"]);
add("task-base", ["task_id", "base_sha", "evidence"], ["task_id", "base_sha"], {
	optionalPayload: ["evidence"],
});
add("task-quality-record", ["task_id", "base_sha", "evidence"], ["fact_id"], {
	payloadOverrides: { evidence: domainRef("fact") },
});
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
	{},
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
			"task_id",
			"original_parent_pr",
			"original_parent_merge_sha",
			"follow_pr_id",
			"owner_approval_id",
		],
		payloadOverrides: { original_parent_merge_sha: shaValue },
		payloadIfThen: [
			{
				when: { properties: { mode: { const: "parent" } } },
				required: ["owner_approval_id"],
			},
			{
				when: { properties: { mode: { const: "parent-followup" } } },
				required: [
					"owner_approval_id",
					"original_parent_pr",
					"original_parent_merge_sha",
				],
			},
		],
	},
);
add(
	"merge-observe",
	["target_type", "target_id", "provider_observation", "supersedes"],
	["observation_id", "status", "operation_id"],
	{
		optionalPayload: ["supersedes"],
		payloadOverrides: {
			provider_observation: {
				...publicationReceipt,
				required: [...publicationReceipt.required, "merge_sha"],
				properties: {
					...publicationReceipt.properties,
					resource_type: { const: "pr" },
					state: { const: "merged" },
					target_branch: textValue,
					pr: externalRefValue,
					base_sha: shaValue,
					head_sha: shaValue,
					merge_sha: shaValue,
				},
			},
		},
		resultOverrides: {
			observation_id: id,
			status: { enum: ["reconcile_required", "already_recorded", "conflict", "unclaimed"] },
			operation_id: nullableId,
		},
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
	{
		optionalPayload: ["provider_evidence", "provider_observation"],
		payloadOverrides: {
			provider_evidence: domainRef("fact"),
			provider_observation: mergeObservation,
		},
	},
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
add("fact-record", ["fact"], ["fact_id"], {
	payloadOverrides: { fact: domainRef("fact") },
});
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
		payloadOverrides: { provider_evidence: domainRef("fact") },
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
		optionalPayload: ["error"],
		payloadOverrides: { provider_receipt: notificationReceipt },
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
	{ payloadOverrides: { provider_receipt: notificationReceipt } },
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
add("resource-update", ["resource"], ["resource_id", "status"], {
	payloadOverrides: { resource: domainRef("resource") },
});
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
	{ payloadOverrides: { provider_observation: closeoutObservation } },
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
			optionalResult: ["thread_id", "notification_request"],
		},
	),
	"creation-reconcile": command(
		["operation_id"],
		["operation_id", "outcome", "thread_id", "notification_delivery", "reason"],
		{
			access: "reconcile",
			optionalResult: ["thread_id", "notification_delivery", "reason"],
		},
	),
	"initialization-recover": command(
		["operation_id"],
		["operation_id", "outcome", "thread_id", "notification_delivery", "reason"],
		{ access: "external-write", optionalResult: ["thread_id", "notification_delivery", "reason"] },
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
						{ provider_receipt: notificationReceipt },
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
const invocationStatus = {
  oneOf: [{ type: "null" }, {
    type: "object", required: ["invocation_id", "state", "quiescent", "missing_evidence"],
    properties: {
      invocation_id: { type: "string", format: "uuid" }, state: { enum: ["running", "stopped"] },
      quiescent: booleanValue, missing_evidence: stringArrayValue,
      marker_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, evidence_refs: stringArrayValue,
    },
  }],
};
for (const name of ["show", "view"]) {
  const success = successResponse(objectValue);
  entries[name] = { ...entries[name], response: { success: {
    ...success, required: ["ok", "code", "revision", "result", "invocation"],
    properties: { ...(success.properties as JsonSchema), invocation: invocationStatus },
  }, error: errorResponse } };
}
const inspectionSuccess = {
  type: "object", required: ["ok", "code", "revision", "source", "executor", "invocation"],
  properties: { ok: { const: true }, code: { const: "OK" }, revision: { type: "integer" },
    source: objectValue, executor: objectValue, invocation: invocationStatus },
};
entries["invocation-inspect"] = {
  access: "read", availability: "cli-only",
  request: { type: "object", additionalProperties: false, required: ["run_id", "actor"], properties: { run_id: id, actor } },
  response: { success: inspectionSuccess, error: errorResponse },
};
entries["invocation-reconcile"] = {
  access: "write", availability: "cli-only",
  request: mutationRequest(objectSchema(["invocation_id", "marker_digest", "evidence_refs"], [], {
    invocation_id: { type: "string", format: "uuid" },
    marker_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    evidence_refs: { type: "array", maxItems: 256, items: { type: "string", pattern: "^[a-f0-9]{64}$" } },
  })),
  response: { success: { type: "object", required: ["ok", "code", "revision", "invocation_id"],
    properties: { ok: { const: true }, code: { const: "APPLIED" }, revision: { type: "integer" }, invocation_id: { type: "string", format: "uuid" } } }, error: errorResponse },
};


add("initialization-recovery-claim", ["operation_id", "attempt"], ["operation_id", "attempt_id"], { payloadOverrides: { attempt: objectValue } });
add("initialization-recovery-observe", ["operation_id", "attempt_id", "turn_id"], ["operation_id", "turn_id"]);

for (const name of ["dispatch-bind-request", "dispatch-resolve", "initialization-recovery-claim", "initialization-recovery-observe"]) {
	entries[name] = { ...entries[name], access: "internal", availability: "cli-only" };
}
for (const name of ["notification-prepare", "notification-send"]) {
	entries[name] = {
		...entries[name],
		response: { success: successResponse(notificationDeliveryResult), error: errorResponse },
	};
}

export const FLOW_CONTRACT = Object.freeze({
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://loomhelm.dev/schemas/multi-task-flow/flow-contract.schema.json",
	schema_version: 2,
	contract_version: 6,
	content_type: "application/json",
	invocation:
		"bunx --bun @loomhelm/multi-task-flow@<exact-version> flow <command> --output json --input -",
	commands: entries,
	error_codes: [
    "CALLER_IDENTITY_UNAVAILABLE",
    "RUN_VERSION_MISMATCH",
    "RUN_BOUNDARY_CHANGED",
    "RUN_QUIESCENCE_UNPROVEN",
    "RUN_MIGRATION_UNSAFE",
    "UPGRADE_AUDIT_INVALID",
    "MIGRATION_AUDIT_REQUIRED",
    "ARCHIVE_IDENTITY_UNAVAILABLE",
    "INVOCATION_EVIDENCE_REQUIRED",
    "INVOCATION_STATE_CONFLICT",
    "INVOCATION_CLOSED",
    "INVOCATION_RESOURCE_CONFLICT",
    "UPGRADE_INCOMPLETE",
		"ACTION_NOT_APPROVED",
		"ACTION_NOT_PLANNED",
		"ACTIVE_GROUP_IDLE",
		"ACTOR_MISMATCH",
		"APPLIED",
		"ARCHIVE_IN_FLIGHT",
		"ATOMS_PENDING",
		"ATTEMPT_EXISTS",
		"ATTEMPT_MISMATCH",
		"BASELINE_CONFLICT",
		"BASELINE_MISMATCH",
		"BASELINE_NOT_VERIFIED",
		"BASELINE_REQUIRED",
		"BASE_CHANGED",
		"BASE_NOT_READY",
		"BASE_UNCHANGED",
		"BLOCK_REASON_REQUIRED",
		"BODY_TOO_LARGE",
		"BRANCH_MISMATCH",
		"BRANCH_NOT_PUBLISHED",
		"CAPACITY",
		"CI_PENDING",
		"CLI_ONLY_DISPATCH",
		"CONTROL_OWNERSHIP_UNKNOWN",
		"CONVERSATION_ARCHIVED",
		"CREATED",
		"CREATION_EVIDENCE_CONFLICT",
		"CREATION_PENDING",
		"CUT_ALREADY_APPLIED",
		"CUT_ALREADY_CLAIMED",
		"CUT_NOT_READY",
		"CUT_ORDER",
		"CUT_PENDING",
		"CUT_SCOPE_MISMATCH",
		"CYCLE",
		"DELIVERY_GATE_PENDING",
		"DEPENDENCIES_PENDING",
		"DISPATCH_NOT_READY",
		"EVIDENCE_MISMATCH",
		"EVIDENCE_REQUIRED",
		"EXECUTION_PENDING",
		"FOLLOW_PR_EXISTS",
		"FOLLOW_PR_PENDING",
		"FORBIDDEN",
		"GROUPS_PENDING",
		"GROUP_CHANGED",
		"GROUP_CLOSED",
		"GROUP_CLOSE_REQUIRED",
		"GROUP_CUT",
		"GROUP_EXECUTION_SEPARATE",
		"GROUP_EXISTS",
		"GROUP_MISMATCH",
		"GROUP_NOT_ACTIVE",
		"GROUP_NOT_MERGED",
		"GROUP_NOT_READY",
		"HANDOFF_PENDING",
		"IDENTITY_IMMUTABLE",
		"ID_CONFLICT",
		"INCOMPATIBLE_LEDGER",
		"INVALID_ARGUMENTS",
		"INVALID_COMMAND",
		"INVALID_FACT",
		"INVALID_INPUT",
		"INVALID_MIGRATION",
		"INVALID_NEW_GROUP",
		"INVALID_NEW_TASK",
		"INVALID_NEXT_GROUP",
		"INVALID_NOTIFICATION",
		"INVALID_PLAN",
		"INVALID_PLAN_HANDOFF",
		"INVALID_PROFILE",
		"INVALID_RESULT",
		"INVALID_TRANSITION",
		"INVALID_WAIT_TARGET",
		"IO_ERROR",
		"LEDGER_UNREADABLE",
		"LEGACY_PLAN_ACTION",
		"LIFECYCLE_BLOCKED",
		"LINEAGE_MISMATCH",
		"MAIN_TASK_REQUIRED",
		"MERGE_PENDING",
		"MIGRATION_CONFLICT",
		"MILESTONE_EXISTS",
		"NATIVE_RECEIPT_REQUIRED",
		"NATIVE_REQUEST_CONFLICT",
		"NOTIFICATION_ALREADY_SENT",
		"NOTIFICATION_IN_FLIGHT",
		"NOTIFICATION_NOT_SENT",
		"NOTIFICATION_NOT_UNKNOWN",
		"NOTIFICATION_TERMINAL",
		"NOT_DISPATCHABLE",
		"NOT_FOUND",
		"OK",
		"OPERATIONS_PENDING",
		"OPERATION_EXISTS",
		"OPERATION_PENDING",
		"OPERATION_TERMINAL",
		"ORPHAN_GROUP",
		"OWNER_UNCERTAIN",
		"PLAN_EXISTS",
		"PLAN_MISMATCH",
		"PLAN_NOT_APPROVED",
		"PLAN_NOT_DISPATCHABLE",
		"PLAN_NOT_FOUND",
		"PLAN_NOT_SCHEDULABLE",
		"PLAN_REVISION_EMPTY",
		"PLAN_REVISION_HOLD",
		"PLAN_REVISION_PENDING",
		"PREVIOUS_GROUP_NOT_MERGED",
		"PROFILE_CONFLICT",
		"PROFILE_FROZEN",
		"PROFILE_MIGRATION_REQUIRED",
		"PROTECTED_ACTION_NOT_APPROVED",
		"PR_MISMATCH",
		"PR_NOT_MERGED",
		"PR_NOT_PUBLISHED",
		"PR_NOT_READY",
		"PUBLICATION_PENDING",
		"QUALITY_REQUIRED",
		"RECIPIENT_UNBOUND",
		"RECONCILIATION_EXISTS",
		"RECONCILIATION_REQUIRED",
		"REPLAYED",
		"REPOSITORY_MISMATCH",
		"RESOURCE_MISMATCH",
		"RESOURCE_TERMINAL",
		"REVISION_CONFLICT",
		"REVISION_EVIDENCE_REQUIRED",
		"REVISION_PENDING",
		"REVISION_REASON_REQUIRED",
		"RUN_ALREADY_COMPLETE",
		"RUN_EXISTS",
		"RUN_MISMATCH",
		"SHARED_DELIVERY_UNIT_DISPATCH",
		"SHARED_DELIVERY_UNIT_PR",
		"TARGET_MISMATCH",
		"TARGET_NOT_ACTIVE",
		"TASKS_PENDING",
		"TASK_BASE_REQUIRED",
		"TASK_CHANGED",
		"TASK_MIGRATION_REQUIRED",
		"TASK_MISMATCH",
		"TASK_NOT_ACTIVE",
		"TASK_PR_BINDING_INCOMPLETE",
		"THREAD_CONFLICT",
		"TRANSPORT_REQUIRED",
		"UNKNOWN",
		"UNKNOWN_COMMAND",
		"UNKNOWN_REQUIRES_RECONCILIATION",
		"UNKNOWN_TASK",
		"VIEWER_BINDING_INVALID",
		"VIEWER_RENEWAL_FAILED",
		"WAIT_REASON_REQUIRED",
		"WORKSPACE_NOT_READY",
	],
	sources: {
		runtime_validation: "packages/multi-task-flow-runtime/lib/engine.ts",
		domain_schema: "packages/multi-task-flow-runtime/lib/schema.ts",
		human_contract:
			"docs/specs/multi-task-flow-unified-atomic-orchestration/CLI_CONTRACT.md",
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
