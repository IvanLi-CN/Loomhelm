// Generated from codex-cli 0.166.0 app-server generate-ts (stable).
// Run: bun src/codex/generate-protocol.ts
// Upstream: https://github.com/openai/codex (Apache-2.0).
// Bundled dependency closure; only import declarations and generator headers removed.

// Source: AbsolutePathBuf.ts
/**
 * A path that is guaranteed to be absolute and normalized (though it is not
 * guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set
 * using [AbsolutePathBufGuard::new]. If no base path is set, the
 * deserialization will fail unless the path being deserialized is already
 * absolute.
 */
export type AbsolutePathBuf = string;

// Source: AgentPath.ts
export type AgentPath = string;

// Source: ApplyPatchApprovalParams.ts
export type ApplyPatchApprovalParams = { conversationId: ThreadId,
/**
 * Use to correlate this with [codex_protocol::protocol::PatchApplyBeginEvent]
 * and [codex_protocol::protocol::PatchApplyEndEvent].
 */
callId: string, fileChanges: { [key in string]?: FileChange },
/**
 * Optional explanatory reason (e.g. request for extra write access).
 */
reason: string | null,
/**
 * When set, the agent is asking the user to allow writes under this root
 * for the remainder of the session (unclear if this is honored today).
 */
grantRoot: string | null, };

// Source: ClientInfo.ts
export type ClientInfo = { name: string, title: string | null, version: string, };

// Source: CollaborationMode.ts
/**
 * Collaboration mode for a Codex session.
 */
export type CollaborationMode = { mode: ModeKind, settings: Settings, };

// Source: ExecCommandApprovalParams.ts
export type ExecCommandApprovalParams = { conversationId: ThreadId,
/**
 * Use to correlate this with [codex_protocol::protocol::ExecCommandBeginEvent]
 * and [codex_protocol::protocol::ExecCommandEndEvent].
 */
callId: string,
/**
 * Identifier for this specific approval callback.
 */
approvalId: string | null, command: Array<string>, cwd: string, reason: string | null, parsedCmd: Array<ParsedCommand>, };

// Source: FileChange.ts
export type FileChange = { "type": "add", content: string, } | { "type": "delete", content: string, } | { "type": "update", unified_diff: string, move_path: string | null, };

// Source: FunctionCallOutputBody.ts
export type FunctionCallOutputBody = string | Array<FunctionCallOutputContentItem>;

// Source: FunctionCallOutputContentItem.ts
/**
 * Responses API compatible content items that can be returned by a tool call.
 * This is a subset of ContentItem with the types we support as function call outputs.
 */
export type FunctionCallOutputContentItem = { "type": "input_text", text: string, } | { "type": "input_image", detail?: ImageDetail, } & ({ image_url: string, } | { file_id: string, }) | { "type": "input_audio", audio_url: string, } | { "type": "encrypted_content", encrypted_content: string, };

// Source: ImageDetail.ts
export type ImageDetail = "auto" | "low" | "high" | "original";

// Source: ImageGenerationFailure.ts
export type ImageGenerationFailure = { "type": "usageLimitExceeded", limitId: string, resetsAt: number | null, };

// Source: ImageGenerationInputImage.ts
/**
 * A local image file successfully read for this exact image-generation request.
 */
export type ImageGenerationInputImage = { path: AbsolutePathBuf,
/**
 * Lowercase SHA-256 of the file bytes read before image normalization.
 */
sha256: string, };

// Source: ImageGenerationItem.ts
export type ImageGenerationItem = { id: string, status: string, revisedPrompt: string | null, transparentBackground?: boolean, failure: ImageGenerationFailure | null, savedPath?: AbsolutePathBuf,
/**
 * Observed local inputs for a completed generation, absent on older items.
 */
inputImages?: Array<ImageGenerationInputImage>,
/**
 * Image generation identifier for the generated image, when provided by the image backend.
 */
generationId: string | null, } & ({ fileId: string, } | { result: string, });

// Source: InitializeCapabilities.ts
/**
 * Client-declared capabilities negotiated during initialize.
 */
export type InitializeCapabilities = {
/**
 * Use explicit gateway OAuth login instead of automatic browser authorization.
 * Applies to this app-server's gateway runtime; later connections cannot undo it.
 */
explicitGatewayOauth?: boolean,
/**
 * Opt into receiving experimental API methods and fields.
 */
experimentalApi: boolean,
/**
 * Opt into `attestation/generate` requests for upstream `x-oai-attestation`.
 */
requestAttestation: boolean,
/**
 * Legacy opt-in for the `openai/form` MCP extension.
 *
 * New clients should declare `openai/form` in [`Self::extensions`].
 */
mcpServerOpenaiFormElicitation?: boolean,
/**
 * Exact notification method names that should be suppressed for this
 * connection (for example `thread/started`).
 */
optOutNotificationMethods?: Array<string> | null,
/**
 * MCP extension settings declared by the app-server client.
 */
extensions?: { [key in string]?: JsonValue } | null, };

// Source: InitializeParams.ts
export type InitializeParams = { clientInfo: ClientInfo, capabilities: InitializeCapabilities | null, };

// Source: InitializeResponse.ts
export type InitializeResponse = { userAgent: string,
/**
 * Absolute path to the server's $CODEX_HOME directory.
 */
codexHome: AbsolutePathBuf,
/**
 * Platform family for the running app-server target, for example
 * `"unix"` or `"windows"`.
 */
platformFamily: string,
/**
 * Operating system for the running app-server target, for example
 * `"macos"`, `"linux"`, or `"windows"`.
 */
platformOs: string, };

// Source: InputModality.ts
/**
 * Canonical user-input modality tags advertised by a model.
 */
export type InputModality = "text" | "image" | "audio";

// Source: LegacyAppPathString.ts
/**
 * A UTF-8 path for preserving raw path compatibility at the app-server API
 * boundary while Codex migrates to [`PathUri`].
 *
 * Supports storing arbitrary strings read from the API and converting to and
 * from [`PathUri`] using an explicitly selected native path convention.
 *
 * When converting from [`PathUri`], "native" refers to the supplied
 * [`PathConvention`], which may be foreign to the operating system running
 * this process. The inner string is private so path-producing code must use a
 * path conversion method instead of bypassing the intended conversion
 * boundary. Non-UTF-8 paths are converted to UTF-8 lossily because this API
 * value is serialized as a JSON string.
 *
 * Deserialization and [`Self::from_string`] accept any UTF-8 string without
 * interpreting or validating it. Use [`Self::from_string`] when a caller
 * already owns legacy app-server path text and needs to preserve its wire
 * spelling; use [`Self::from_path`], [`Self::from_abs_path`], or
 * [`Self::from_path_uri`] when converting an actual path value. Relative
 * path text remains valid until an operation such as [`Self::to_path_uri`]
 * requires an absolute path.
 */
export type LegacyAppPathString = string;

// Source: MessagePhase.ts
/**
 * Classifies assistant text as commentary, a partial answer, or a terminal answer.
 *
 * Providers do not emit this consistently, so callers must treat `None` as
 * "phase unknown" and keep compatibility behavior for legacy models.
 */
export type MessagePhase = "commentary" | "partial_answer" | "final_answer";

// Source: ModeKind.ts
/**
 * Initial collaboration mode to use when the TUI starts.
 */
export type ModeKind = "plan" | "default";

// Source: ParsedCommand.ts
export type ParsedCommand = { "type": "read", cmd: string, name: string,
/**
 * (Best effort) Path to the file being read by the command. When
 * possible, this is an absolute path, though when relative, it should
 * be resolved against the `cwd`` that will be used to run the command
 * to derive the absolute path.
 */
path: string, } | { "type": "list_files", cmd: string, path: string | null, } | { "type": "search", cmd: string, query: string | null, path: string | null, } | { "type": "unknown", cmd: string, };

// Source: Personality.ts
/**
 * Deprecated: `friendly` and `pragmatic` no longer select a style.
 */
export type Personality = "none" | "friendly" | "pragmatic";

// Source: ReasoningEffort.ts
/**
 * See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#get-started-with-reasoning
 */
export type ReasoningEffort = string;

// Source: ReasoningSummary.ts
/**
 * A summary of the reasoning performed by the model. This can be useful for
 * debugging and understanding the model's reasoning process.
 * See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries
 */
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

// Source: RequestId.ts
export type RequestId = string | number;

// Source: serde_json/JsonValue.ts
export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;

// Source: ServerRequest.ts
/**
 * Request initiated from the server and sent to the client.
 */
export type ServerRequest ={ "method": "item/commandExecution/requestApproval", id: RequestId, params: CommandExecutionRequestApprovalParams, } | { "method": "item/fileChange/requestApproval", id: RequestId, params: FileChangeRequestApprovalParams, } | { "method": "item/tool/requestUserInput", id: RequestId, params: ToolRequestUserInputParams, } | { "method": "mcpServer/elicitation/request", id: RequestId, params: McpServerElicitationRequestParams, } | { "method": "item/permissions/requestApproval", id: RequestId, params: PermissionsRequestApprovalParams, } | { "method": "item/tool/call", id: RequestId, params: DynamicToolCallParams, } | { "method": "account/chatgptAuthTokens/refresh", id: RequestId, params: ChatgptAuthTokensRefreshParams, } | { "method": "attestation/generate", id: RequestId, params: AttestationGenerateParams, } | { "method": "applyPatchApproval", id: RequestId, params: ApplyPatchApprovalParams, } | { "method": "execCommandApproval", id: RequestId, params: ExecCommandApprovalParams, };

// Source: Settings.ts
/**
 * Settings for a collaboration mode.
 */
export type Settings = { model: string, reasoning_effort: ReasoningEffort | null, developer_instructions: string | null, };

// Source: SleepItem.ts
/**
 * Display item emitted by the interruptible `clock.sleep` tool.
 */
export type SleepItem = { id: string, durationMs: number, };

// Source: SubAgentSource.ts
export type SubAgentSource = "review" | "compact" | { "thread_spawn": { parent_thread_id: ThreadId, depth: number, agent_path: AgentPath | null, agent_nickname: string | null, agent_role: string | null, } } | "memory_consolidation" | { "other": string };

// Source: ThreadId.ts
/**
 * Identifier for a Codex thread.
 *
 * Codex-generated thread IDs are UUIDv7, and some use cases rely on that.
 */
export type ThreadId = string;

// Source: v2/AdditionalFileSystemPermissions.ts
export type AdditionalFileSystemPermissions = {
/**
 * This will be removed in favor of `entries`.
 */
read: Array<LegacyAppPathString> | null,
/**
 * This will be removed in favor of `entries`.
 */
write: Array<LegacyAppPathString> | null, globScanMaxDepth?: number, entries?: Array<FileSystemSandboxEntry>, };

// Source: v2/AdditionalNetworkPermissions.ts
export type AdditionalNetworkPermissions = { enabled: boolean | null, };

// Source: v2/AgentMessageDelivery.ts
export type AgentMessageDelivery = "async";

// Source: v2/ApprovalsReviewer.ts
/**
 * Configures who approval requests are routed to for review. Examples
 * include sandbox escapes, blocked network access, MCP approval prompts, and
 * ARC escalations. Defaults to `user`. `auto_review` uses a carefully
 * prompted subagent to gather relevant context and apply a risk-based
 * decision framework before approving or denying the request.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

// Source: v2/AskForApproval.ts
export type AskForApproval = "untrusted" | "on-request" | { "granular": { sandbox_approval: boolean, rules: boolean, skill_approval: boolean, request_permissions: boolean, mcp_elicitations: boolean, } } | "never";

// Source: v2/AsyncUserInputQuestion.ts
export type AsyncUserInputQuestion = { title: string, options: Array<string> | null, };

// Source: v2/AttestationGenerateParams.ts
export type AttestationGenerateParams = Record<string, never>;

// Source: v2/ByteRange.ts
export type ByteRange = { start: number, end: number, };

// Source: v2/ChatgptAuthTokensRefreshParams.ts
export type ChatgptAuthTokensRefreshParams = { reason: ChatgptAuthTokensRefreshReason,
/**
 * Workspace/account identifier that Codex was previously using.
 *
 * Clients that manage multiple accounts/workspaces can use this as a hint
 * to refresh the token for the correct workspace.
 *
 * This may be `null` when the prior auth state did not include a workspace
 * identifier (`chatgpt_account_id`).
 */
previousAccountId?: string | null, };

// Source: v2/ChatgptAuthTokensRefreshReason.ts
export type ChatgptAuthTokensRefreshReason = "unauthorized";

// Source: v2/CodexErrorInfo.ts
/**
 * This translation layer make sure that we expose codex error code in camel case.
 *
 * When an upstream HTTP status is available (for example, from the Responses API or a provider),
 * it is forwarded in `httpStatusCode` on the relevant `codexErrorInfo` variant.
 */
export type CodexErrorInfo = "contextWindowExceeded" | "sessionBudgetExceeded" | "usageLimitExceeded" | "rateLimitExceeded" | "flexUnavailable" | "serverOverloaded" | "modelNotFound" | "policyCapacityUnavailable" | "cyberPolicy" | "misalignmentPolicyViolation" | "tooManyDenials" | { "httpConnectionFailed": { httpStatusCode: number | null, } } | { "responseStreamConnectionFailed": { httpStatusCode: number | null, } } | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError" | { "responseStreamDisconnected": { httpStatusCode: number | null, } } | { "responseTooManyFailedAttempts": { httpStatusCode: number | null, } } | { "activeTurnNotSteerable": { turnKind: NonSteerableTurnKind, } } | "other" | string | { [key: string]: unknown };

// Source: v2/CollabAgentState.ts
export type CollabAgentState = { status: CollabAgentStatus, message: string | null, };

// Source: v2/CollabAgentStatus.ts
export type CollabAgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound";

// Source: v2/CollabAgentTool.ts
export type CollabAgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" | "listAgents";

// Source: v2/CollabAgentToolCallStatus.ts
export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed" | "interrupted";

// Source: v2/CommandAction.ts
export type CommandAction = { "type": "read", command: string, name: string, path: LegacyAppPathString, } | { "type": "listFiles", command: string, path: string | null, } | { "type": "search", command: string, query: string | null, path: string | null, } | { "type": "unknown", command: string, };

// Source: v2/CommandExecutionApprovalDecision.ts
export type CommandExecutionApprovalDecision = "accept" | "acceptForSession" | { "acceptWithExecpolicyAmendment": { execpolicy_amendment: ExecPolicyAmendment, } } | { "applyNetworkPolicyAmendment": { network_policy_amendment: NetworkPolicyAmendment, } } | "decline" | "cancel";

// Source: v2/CommandExecutionApprovalKind.ts
/**
 * Distinguishes a command approval from input sent to an existing terminal.
 */
export type CommandExecutionApprovalKind = "command" | "writeStdin";

// Source: v2/CommandExecutionRequestApprovalParams.ts
export type CommandExecutionRequestApprovalParams = {/**
 * Kind of action under review. Defaults to `command` for older servers.
 */
kind: CommandExecutionApprovalKind, threadId: string, turnId: string, itemId: string, /**
 * Unix timestamp (in milliseconds) when this approval request started.
 */
startedAtMs: number, /**
 * Unique identifier for this specific approval callback.
 *
 * For regular shell/unified_exec approvals, this is null.
 *
 * For zsh-exec-bridge subcommand approvals, multiple callbacks can belong to
 * one parent `itemId`, so `approvalId` is a distinct opaque callback id
 * (a UUID) used to disambiguate routing.
 * Stdin approvals also use a distinct callback id; inspect `kind` to distinguish them.
 */
approvalId?: string | null, /**
 * Environment in which the command will run.
 */
environmentId: string | null, /**
 * Optional explanatory reason (e.g. request for network access).
 */
reason?: string | null, /**
 * Optional context for a managed-network approval prompt.
 */
networkApprovalContext?: NetworkApprovalContext | null, /**
 * The command to be executed.
 */
command?: string | null, /**
 * The command's working directory.
 */
cwd?: LegacyAppPathString | null, /**
 * Best-effort parsed command actions for friendly display.
 */
commandActions?: Array<CommandAction> | null, /**
 * Optional proposed execpolicy amendment to allow similar commands without prompting.
 */
proposedExecpolicyAmendment?: ExecPolicyAmendment | null, /**
 * Optional proposed network policy amendments (allow/deny host) for future requests.
 */
proposedNetworkPolicyAmendments?: Array<NetworkPolicyAmendment> | null};

// Source: v2/CommandExecutionRequestApprovalResponse.ts
export type CommandExecutionRequestApprovalResponse = { decision: CommandExecutionApprovalDecision, };

// Source: v2/CommandExecutionSource.ts
export type CommandExecutionSource = "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";

// Source: v2/CommandExecutionStatus.ts
export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";

// Source: v2/CyberAccessProgram.ts
/**
 * Requested cyber treatment for an OpenAI model turn.
 * Authorization and model-tier restrictions remain server-owned.
 */
export type CyberAccessProgram = "standard" | "daybreakBlue" | "daybreakRed";

// Source: v2/DynamicToolCallOutputContentItem.ts
export type DynamicToolCallOutputContentItem = { "type": "inputText", text: string, } | { "type": "inputImage", imageUrl: string, } | { "type": "inputAudio", audioUrl: string, };

// Source: v2/DynamicToolCallParams.ts
export type DynamicToolCallParams = { threadId: string, turnId: string, callId: string, namespace: string | null, tool: string, arguments: JsonValue, };

// Source: v2/DynamicToolCallStatus.ts
export type DynamicToolCallStatus = "inProgress" | "completed" | "failed";

// Source: v2/ExecPolicyAmendment.ts
export type ExecPolicyAmendment = Array<string>;

// Source: v2/FileChangeApprovalDecision.ts
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

// Source: v2/FileChangeRequestApprovalParams.ts
export type FileChangeRequestApprovalParams = { threadId: string, turnId: string, itemId: string,
/**
 * Unix timestamp (in milliseconds) when this approval request started.
 */
startedAtMs: number,
/**
 * Optional explanatory reason (e.g. request for extra write access).
 */
reason?: string | null,
/**
 * [UNSTABLE] When set, the agent is asking the user to allow writes under this root
 * for the remainder of the session (unclear if this is honored today).
 */
grantRoot?: string | null, };

// Source: v2/FileChangeRequestApprovalResponse.ts
export type FileChangeRequestApprovalResponse = { decision: FileChangeApprovalDecision, };

// Source: v2/FileSystemAccessMode.ts
export type FileSystemAccessMode = "read" | "write" | "deny";

// Source: v2/FileSystemPath.ts
export type FileSystemPath = { "type": "path", path: LegacyAppPathString, } | { "type": "glob_pattern", pattern: string, } | { "type": "special", value: FileSystemSpecialPath, };

// Source: v2/FileSystemSandboxEntry.ts
export type FileSystemSandboxEntry = { path: FileSystemPath, access: FileSystemAccessMode, };

// Source: v2/FileSystemSpecialPath.ts
export type FileSystemSpecialPath = { "kind": "root" } | { "kind": "minimal" } | { "kind": "project_roots", subpath: LegacyAppPathString | null, } | { "kind": "tmpdir" } | { "kind": "slash_tmp" } | { "kind": "unknown", path: string, subpath: LegacyAppPathString | null, };

// Source: v2/FileUpdateChange.ts
export type FileUpdateChange = { path: string, kind: PatchChangeKind, diff: string, };

// Source: v2/GitInfo.ts
export type GitInfo = { sha: string | null, branch: string | null, originUrl: string | null, };

// Source: v2/HookPromptFragment.ts
export type HookPromptFragment = { text: string, hookRunId: string, };

// Source: v2/McpAppDisplayMode.ts
export type McpAppDisplayMode = "inline" | "fullscreen";

// Source: v2/McpAppUi.ts
/**
 * UI resource and display preference for model invocations, captured from the tool descriptor.
 */
export type McpAppUi = { resourceUri: string, preferredModelDisplayMode: McpAppDisplayMode, };

// Source: v2/McpElicitationArrayType.ts
export type McpElicitationArrayType = "array";

// Source: v2/McpElicitationBooleanSchema.ts
export type McpElicitationBooleanSchema = { type: McpElicitationBooleanType, title?: string, description?: string, default?: boolean, };

// Source: v2/McpElicitationBooleanType.ts
export type McpElicitationBooleanType = "boolean";

// Source: v2/McpElicitationConstOption.ts
export type McpElicitationConstOption = { const: string, title: string, };

// Source: v2/McpElicitationEnumSchema.ts
export type McpElicitationEnumSchema = McpElicitationSingleSelectEnumSchema | McpElicitationMultiSelectEnumSchema | McpElicitationLegacyTitledEnumSchema;

// Source: v2/McpElicitationLegacyTitledEnumSchema.ts
export type McpElicitationLegacyTitledEnumSchema = { type: McpElicitationStringType, title?: string, description?: string, enum: Array<string>, enumNames?: Array<string>, default?: string, };

// Source: v2/McpElicitationMultiSelectEnumSchema.ts
export type McpElicitationMultiSelectEnumSchema = McpElicitationUntitledMultiSelectEnumSchema | McpElicitationTitledMultiSelectEnumSchema;

// Source: v2/McpElicitationNumberSchema.ts
export type McpElicitationNumberSchema = { type: McpElicitationNumberType, title?: string, description?: string, minimum?: number, maximum?: number, default?: number, };

// Source: v2/McpElicitationNumberType.ts
export type McpElicitationNumberType = "number" | "integer";

// Source: v2/McpElicitationObjectType.ts
export type McpElicitationObjectType = "object";

// Source: v2/McpElicitationPrimitiveSchema.ts
export type McpElicitationPrimitiveSchema = McpElicitationEnumSchema | McpElicitationStringSchema | McpElicitationNumberSchema | McpElicitationBooleanSchema;

// Source: v2/McpElicitationSchema.ts
/**
 * Typed form schema for MCP `elicitation/create` requests.
 *
 * This matches the `requestedSchema` shape from the MCP 2025-11-25
 * `ElicitRequestFormParams` schema.
 */
export type McpElicitationSchema = { $schema?: string, type: McpElicitationObjectType, properties: { [key in string]?: McpElicitationPrimitiveSchema }, required?: Array<string>, };

// Source: v2/McpElicitationSingleSelectEnumSchema.ts
export type McpElicitationSingleSelectEnumSchema = McpElicitationUntitledSingleSelectEnumSchema | McpElicitationTitledSingleSelectEnumSchema;

// Source: v2/McpElicitationStringFormat.ts
export type McpElicitationStringFormat = "email" | "uri" | "date" | "date-time";

// Source: v2/McpElicitationStringSchema.ts
export type McpElicitationStringSchema = { type: McpElicitationStringType, title?: string, description?: string, minLength?: number, maxLength?: number, format?: McpElicitationStringFormat, default?: string, };

// Source: v2/McpElicitationStringType.ts
export type McpElicitationStringType = "string";

// Source: v2/McpElicitationTitledEnumItems.ts
export type McpElicitationTitledEnumItems = { anyOf: Array<McpElicitationConstOption>, };

// Source: v2/McpElicitationTitledMultiSelectEnumSchema.ts
export type McpElicitationTitledMultiSelectEnumSchema = { type: McpElicitationArrayType, title?: string, description?: string, minItems?: bigint, maxItems?: bigint, items: McpElicitationTitledEnumItems, default?: Array<string>, };

// Source: v2/McpElicitationTitledSingleSelectEnumSchema.ts
export type McpElicitationTitledSingleSelectEnumSchema = { type: McpElicitationStringType, title?: string, description?: string, oneOf: Array<McpElicitationConstOption>, default?: string, };

// Source: v2/McpElicitationUntitledEnumItems.ts
export type McpElicitationUntitledEnumItems = { type: McpElicitationStringType, enum: Array<string>, };

// Source: v2/McpElicitationUntitledMultiSelectEnumSchema.ts
export type McpElicitationUntitledMultiSelectEnumSchema = { type: McpElicitationArrayType, title?: string, description?: string, minItems?: bigint, maxItems?: bigint, items: McpElicitationUntitledEnumItems, default?: Array<string>, };

// Source: v2/McpElicitationUntitledSingleSelectEnumSchema.ts
export type McpElicitationUntitledSingleSelectEnumSchema = { type: McpElicitationStringType, title?: string, description?: string, enum: Array<string>, default?: string, };

// Source: v2/McpServerElicitationRequestParams.ts
export type McpServerElicitationRequestParams = { threadId: string,
/**
 * Active Codex turn when this elicitation was observed, if app-server could correlate one.
 *
 * This is nullable because MCP models elicitation as a standalone server-to-client request
 * identified by the MCP server request id. It may be triggered during a turn, but turn
 * context is app-server correlation rather than part of the protocol identity of the
 * elicitation itself.
 */
turnId: string | null, serverName: string, } & ({ "mode": "form", _meta: JsonValue | null, message: string, requestedSchema: McpElicitationSchema, } | { "mode": "openai/form", _meta: JsonValue | null, message: string, requestedSchema: JsonValue, } | { "mode": "openaiForm", _meta: JsonValue | null, message: string, requestedSchema: JsonValue, } | { "mode": "url", _meta: JsonValue | null, message: string, url: string, elicitationId: string, });

// Source: v2/McpToolCallAppContext.ts
export type McpToolCallAppContext = { connectorId: string, linkId: string | null, resourceUri: string | null, appName: string | null, actionName: string | null, };

// Source: v2/McpToolCallError.ts
export type McpToolCallError = { message: string, };

// Source: v2/McpToolCallResult.ts
export type McpToolCallResult = { content: Array<JsonValue>, structuredContent: JsonValue | null, _meta: JsonValue | null, };

// Source: v2/McpToolCallStatus.ts
export type McpToolCallStatus = "inProgress" | "completed" | "failed";

// Source: v2/MemoryCitation.ts
export type MemoryCitation = { entries: Array<MemoryCitationEntry>, threadIds: Array<string>, };

// Source: v2/MemoryCitationEntry.ts
export type MemoryCitationEntry = { path: string, lineStart: number, lineEnd: number, note: string, };

// Source: v2/MisalignmentErrorDetails.ts
export type MisalignmentErrorDetails = {
/**
 * Open-ended classification; clients must accept categories added by Responses.
 */
errorType: string | null,
/**
 * A substantive localized explanation is required before offering continuation.
 */
detailedExplanation: string | null,
/**
 * Instruction to submit as the next turn's user input if continuation is confirmed.
 */
steer: MisalignmentSteer | null,
/**
 * Opaque server-issued block target. Presence alone does not enable target-based continuation.
 */
reviewTarget?: string | null, };

// Source: v2/MisalignmentSteer.ts
export type MisalignmentSteer = { message: string, };

// Source: v2/Model.ts
export type Model = { id: string, model: string, upgrade: string | null, upgradeInfo: ModelUpgradeInfo | null, availabilityNux: ModelAvailabilityNux | null, displayName: string, description: string, modelSpecialty: string | null, hidden: boolean, supportedReasoningEfforts: Array<ReasoningEffortOption>, defaultReasoningEffort: ReasoningEffort, inputModalities: Array<InputModality>,
/**
 * @deprecated Always false; models no longer support personality selection.
 */
supportsPersonality: boolean,
/**
 * Multi-agent runtime declared by this model, when available.
 */
multiAgentVersion: MultiAgentVersion | null,
/**
 * Deprecated: use `serviceTiers` instead.
 */
additionalSpeedTiers: Array<string>, serviceTiers: Array<ModelServiceTier>,
/**
 * Catalog default service tier id for this model, when one is configured.
 */
defaultServiceTier: string | null,
/**
 * Null when the catalog does not provide access-program metadata.
 */
availableAccessPrograms: ModelAccessPrograms | null, isDefault: boolean, };

// Source: v2/ModelAccessPrograms.ts
/**
 * Caller-specific explicit access programs advertised by model discovery.
 */
export type ModelAccessPrograms = {
/**
 * Accepted explicit selections.
 */
cyber: Array<CyberAccessProgram>, };

// Source: v2/ModelAvailabilityNux.ts
export type ModelAvailabilityNux = { message: string, };

// Source: v2/ModelListParams.ts
export type ModelListParams = {
/**
 * Opaque pagination cursor returned by a previous call.
 */
cursor?: string | null,
/**
 * Optional page size; defaults to a reasonable server-side value.
 */
limit?: number | null,
/**
 * When true, include models that are hidden from the default picker list.
 */
includeHidden?: boolean | null, };

// Source: v2/ModelListResponse.ts
export type ModelListResponse = { data: Array<Model>,
/**
 * Opaque cursor to pass to the next call to continue after the last item.
 * If None, there are no more items to return.
 */
nextCursor: string | null, };

// Source: v2/ModelServiceTier.ts
export type ModelServiceTier = { id: string, name: string, description: string, };

// Source: v2/ModelUpgradeInfo.ts
export type ModelUpgradeInfo = { model: string, upgradeCopy: string | null, modelLink: string | null, migrationMarkdown: string | null,
/**
 * Informational Unix timestamp for this upgrade's scheduled retirement, if known.
 */
retirementAt: number | null, };

// Source: v2/MultiAgentVersion.ts
/**
 * Multi-agent runtime supported by a model.
 */
export type MultiAgentVersion = "disabled" | "v1" | "v2";

// Source: v2/NetworkAccess.ts
export type NetworkAccess = "restricted" | "enabled";

// Source: v2/NetworkApprovalContext.ts
export type NetworkApprovalContext = { host: string, protocol: NetworkApprovalProtocol, };

// Source: v2/NetworkApprovalProtocol.ts
export type NetworkApprovalProtocol = "http" | "https" | "socks5Tcp" | "socks5Udp";

// Source: v2/NetworkPolicyAmendment.ts
export type NetworkPolicyAmendment = { host: string, action: NetworkPolicyRuleAction, };

// Source: v2/NetworkPolicyRuleAction.ts
export type NetworkPolicyRuleAction = "allow" | "deny";

// Source: v2/NonSteerableTurnKind.ts
export type NonSteerableTurnKind = "review" | "compact";

// Source: v2/PatchApplyStatus.ts
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined";

// Source: v2/PatchChangeKind.ts
export type PatchChangeKind = { "type": "add" } | { "type": "delete" } | { "type": "update", move_path: string | null, };

// Source: v2/PermissionsRequestApprovalParams.ts
export type PermissionsRequestApprovalParams = { threadId: string, turnId: string, itemId: string, environmentId: string | null,
/**
 * Unix timestamp (in milliseconds) when this approval request started.
 */
startedAtMs: number, cwd: LegacyAppPathString, reason: string | null, permissions: RequestPermissionProfile, };

// Source: v2/ReasoningEffortOption.ts
export type ReasoningEffortOption = { reasoningEffort: ReasoningEffort, description: string, };

// Source: v2/RequestPermissionProfile.ts
export type RequestPermissionProfile = { network: AdditionalNetworkPermissions | null, fileSystem: AdditionalFileSystemPermissions | null, };

// Source: v2/SandboxMode.ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// Source: v2/SandboxPolicy.ts
export type SandboxPolicy = { "type": "dangerFullAccess" } | { "type": "readOnly", networkAccess: boolean, } | { "type": "externalSandbox", networkAccess: NetworkAccess, } | { "type": "workspaceWrite", writableRoots: Array<AbsolutePathBuf>, networkAccess: boolean, excludeTmpdirEnvVar: boolean, excludeSlashTmp: boolean, };

// Source: v2/SessionSource.ts
export type SessionSource = "cli" | "vscode" | "exec" | "appServer" | { "custom": string } | { "subAgent": SubAgentSource } | "unknown";

// Source: v2/SortDirection.ts
export type SortDirection = "asc" | "desc";

// Source: v2/SubAgentActivityKind.ts
export type SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed";

// Source: v2/TextElement.ts
export type TextElement = {
/**
 * Byte range in the parent `text` buffer that this element occupies.
 */
byteRange: ByteRange,
/**
 * Optional human-readable placeholder for the element, displayed in the UI.
 */
placeholder: string | null, };

// Source: v2/Thread.ts
export type Thread = {/**
 * Identifier for this thread. Codex-generated thread IDs are UUIDv7.
 */
id: string, /**
 * Session id shared by threads that belong to the same session tree.
 */
sessionId: string, /**
 * Source thread id when this thread was created by forking another thread.
 */
forkedFromId: string | null, /**
 * The ID of the parent thread. This will only be set if this thread is a subagent.
 */
parentThreadId: string | null, /**
 * Usually the first user message in the thread, if available.
 */
preview: string, /**
 * Whether the thread is ephemeral and should not be materialized on disk.
 */
ephemeral: boolean, /**
 * The independently persisted section selected for this thread, if any.
 */
section: ThreadSection | null, /**
 * Unix timestamp in seconds when the thread entered its current section.
 */
sectionEnteredAt: number | null, /**
 * Canonical project assignment owned by app-server, if any.
 */
projectId: string | null, /**
 * Persisted thread history contract selected when this thread was created.
 */
historyMode: ThreadHistoryMode, /**
 * Model provider used for this thread (for example, 'openai').
 */
modelProvider: string, /**
 * Current configured model when loaded, otherwise the latest persisted model.
 * Null when unavailable. This is not per-turn execution telemetry.
 */
model: string | null, /**
 * Current configured reasoning effort when loaded, otherwise the latest persisted effort.
 * Null when unset or unavailable. This is not per-turn execution telemetry.
 */
reasoningEffort: ReasoningEffort | null, /**
 * Unix timestamp (in seconds) when the thread was created.
 */
createdAt: number, /**
 * Unix timestamp (in seconds) when the thread was last updated.
 */
updatedAt: number, /**
 * Unix timestamp (in seconds) used for thread recency ordering.
 */
recencyAt: number | null, /**
 * Current runtime status for the thread.
 */
status: ThreadStatus, /**
 * [UNSTABLE] Path to the thread on disk.
 */
path: string | null, /**
 * Working directory captured for the thread.
 */
cwd: AbsolutePathBuf, /**
 * Version of the CLI that created the thread.
 */
cliVersion: string, /**
 * Originator recorded when the thread was created, independent of its current client or executor.
 * Null when the recorded originator is unavailable.
 */
originator: string | null, /**
 * Origin of the thread (CLI, VSCode, codex exec, codex app-server, etc.).
 */
source: SessionSource, /**
 * Optional analytics source classification for this thread.
 */
threadSource: ThreadSource | null, /**
 * Optional random unique nickname assigned to an AgentControl-spawned sub-agent.
 */
agentNickname: string | null, /**
 * Optional role (agent_role) assigned to an AgentControl-spawned sub-agent.
 */
agentRole: string | null, /**
 * Optional Git metadata captured when the thread was created.
 */
gitInfo: GitInfo | null, /**
 * Optional user-facing thread title.
 */
name: string | null, /**
 * Only populated on `thread/resume`, `thread/fork`, and `thread/read`
 * (when `includeTurns` is true) responses.
 * For all other responses and notifications returning a Thread,
 * the turns field will be an empty list.
 */
turns: Array<Turn>};

// Source: v2/ThreadActiveFlag.ts
export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

// Source: v2/ThreadForkParams.ts
/**
 * There are two ways to fork a thread:
 * 1. By thread_id: load the thread from disk by thread_id and fork it into a new thread.
 * 2. By path: load the thread from disk by path and fork it into a new thread.
 *
 * If using a non-empty path, the thread_id param will be ignored.
 * Empty string path values are treated as absent.
 *
 * Prefer using thread_id whenever possible.
 */
export type ThreadForkParams = {threadId: string, /**
 * Optional last turn id to fork through, inclusive.
 *
 * When specified, turns after `last_turn_id` are omitted from the fork.
 * The referenced turn cannot be in progress.
 */
lastTurnId?: string | null, /**
 * Configuration overrides for the forked thread, if any.
 */
model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null, /**
 * Override where approval requests are routed for review on this thread
 * and subsequent turns.
 */
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, baseInstructions?: string | null, developerInstructions?: string | null, ephemeral?: boolean, /**
 * Optional client-supplied analytics source classification for this forked thread.
 */
threadSource?: ThreadSource | null, /**
 * When true, return only thread metadata and live fork state without
 * populating `thread.turns`. This is useful when the client plans to call
 * `thread/turns/list` immediately after forking. Full-history hydration
 * is deprecated for paginated threads; use this with `thread/turns/list`
 * and `thread/items/list` instead.
 */
excludeTurns?: boolean};

// Source: v2/ThreadForkResponse.ts
export type ThreadForkResponse = {thread: Thread, model: string, modelProvider: string, serviceTier: string | null, /**
 * Saved list of disabled plugin IDs. Does not yet filter plugin capabilities.
 */
disabledPluginIds: Array<string>, cwd: AbsolutePathBuf, /**
 * Environment-native paths to instruction source files currently loaded for this thread.
 */
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval, /**
 * Reviewer currently used for approval requests on this thread.
 */
approvalsReviewer: ApprovalsReviewer, /**
 * Legacy sandbox policy retained for compatibility. Experimental clients
 * should prefer `activePermissionProfile` for profile provenance.
 */
sandbox: SandboxPolicy, reasoningEffort: ReasoningEffort | null};

// Source: v2/ThreadHistoryMode.ts
export type ThreadHistoryMode = "legacy" | "paginated";

// Source: v2/ThreadItem.ts
/**
 * A thread item and its recorded lifecycle times. The payload stays flat on the wire.
 */
export type ThreadItem = {
/**
 * Unix timestamp in milliseconds when the item started, if recorded.
 */
startedAtMs?: number | null,
/**
 * Unix timestamp in milliseconds when the item completed, if recorded.
 */
completedAtMs?: number | null, } & ({ "type": "userMessage", id: string, clientId: string | null, content: Array<UserInput>, } | { "type": "hookPrompt", id: string, fragments: Array<HookPromptFragment>, } | { "type": "agentMessage", id: string, text: string, phase: MessagePhase | null, memoryCitation: MemoryCitation | null, delivery: AgentMessageDelivery | null, questions: Array<AsyncUserInputQuestion> | null, } | { "type": "functionCallOutput", id: string, name: string, namespace: string | null, output: FunctionCallOutputBody, } | { "type": "plan", id: string, text: string, } | { "type": "reasoning", id: string, summary: Array<string>, content: Array<string>, } | { "type": "commandExecution", id: string,
/**
 * Trusted first-party plugin id when this command resolves to one plugin script.
 */
pluginId: string | null,
/**
 * Safe plugin-relative path when this command resolves to one plugin script.
 */
scriptPath: string | null,
/**
 * The command to be executed.
 */
command: string,
/**
 * The command's working directory.
 */
cwd: LegacyAppPathString,
/**
 * Identifier for the underlying PTY process (when available).
 */
processId: string | null, source: CommandExecutionSource, status: CommandExecutionStatus,
/**
 * A best-effort parsing of the command to understand the action(s) it will perform.
 * This returns a list of CommandAction objects because a single shell command may
 * be composed of many commands piped together.
 */
commandActions: Array<CommandAction>,
/**
 * The command's output, aggregated from stdout and stderr.
 */
aggregatedOutput: string | null,
/**
 * The command's exit code.
 */
exitCode: number | null,
/**
 * The duration of the command execution in milliseconds.
 */
durationMs: number | null, } | { "type": "fileChange", id: string, changes: Array<FileUpdateChange>, status: PatchApplyStatus, } | { "type": "mcpToolCall", id: string, server: string, tool: string, status: McpToolCallStatus, arguments: JsonValue, appContext: McpToolCallAppContext | null,
/**
 * Legacy compatibility field; prefer `mcpAppUi.resourceUri` when available.
 */
mcpAppResourceUri?: string,
/**
 * Presentation captured from the invoked descriptor; absent in older history.
 */
mcpAppUi: McpAppUi | null, pluginId: string | null, readOnlyHint: boolean | null, result: McpToolCallResult | null, error: McpToolCallError | null,
/**
 * The duration of the MCP tool call in milliseconds.
 */
durationMs: number | null, } | { "type": "dynamicToolCall", id: string, namespace: string | null, tool: string, arguments: JsonValue, status: DynamicToolCallStatus, contentItems: Array<DynamicToolCallOutputContentItem> | null, success: boolean | null,
/**
 * The duration of the dynamic tool call in milliseconds.
 */
durationMs: number | null, } | { "type": "collabAgentToolCall",
/**
 * Unique identifier for this collab tool call.
 */
id: string,
/**
 * Name of the collab tool that was invoked.
 */
tool: CollabAgentTool,
/**
 * Current status of the collab tool call.
 */
status: CollabAgentToolCallStatus,
/**
 * Thread ID of the agent issuing the collab request.
 */
senderThreadId: string,
/**
 * Thread ID of the receiving agent, when applicable. In case of spawn operation,
 * this corresponds to the newly spawned agent.
 */
receiverThreadIds: Array<string>,
/**
 * Prompt text sent as part of the collab tool call, when available.
 */
prompt: string | null,
/**
 * Model requested for the spawned agent, when applicable.
 */
model: string | null,
/**
 * Reasoning effort requested for the spawned agent, when applicable.
 */
reasoningEffort: ReasoningEffort | null,
/**
 * Last known status of the target agents, when available.
 */
agentsStates: { [key in string]?: CollabAgentState }, } | { "type": "subAgentActivity",
/**
 * Resolved model at sub-agent creation; absent from older records and other activities.
 */
model: string | null,
/**
 * Resolved reasoning effort at sub-agent creation, when known.
 */
reasoningEffort: ReasoningEffort | null, id: string, kind: SubAgentActivityKind, agentThreadId: string, agentPath: string, } | { "type": "webSearch" } & WebSearchItem | { "type": "imageView", id: string, path: LegacyAppPathString, } | { "type": "sleep" } & SleepItem | { "type": "imageGeneration" } & ImageGenerationItem | { "type": "enteredReviewMode", id: string, review: string, } | { "type": "exitedReviewMode", id: string, review: string, } | { "type": "contextCompaction", id: string, });

// Source: v2/ThreadListParams.ts
export type ThreadListParams = {/**
 * Opaque pagination cursor returned by a previous call.
 */
cursor?: string | null, /**
 * Optional page size; defaults to a reasonable server-side value.
 */
limit?: number | null, /**
 * Thread IDs to exclude before applying the result limit. Up to 100
 * entries; invalid IDs or a larger list are rejected, never truncated.
 * Send the same exclusions on each page. Omitted, null, or empty means no exclusions.
 */
excludedThreadIds?: Array<string> | null, /**
 * Optional sort key; defaults to created_at.
 */
sortKey?: ThreadSortKey | null, /**
 * Optional sort direction; defaults to descending (newest first).
 */
sortDirection?: SortDirection | null, /**
 * Optional provider filter; when set, only sessions recorded under these
 * providers are returned. When present but empty, includes all providers.
 */
modelProviders?: Array<string> | null, /**
 * Optional source filter; when set, only sessions from these source kinds
 * are returned. When omitted or empty, defaults to interactive sources.
 */
sourceKinds?: Array<ThreadSourceKind> | null, /**
 * Optional originator allowlist, matching any supplied value exactly.
 * Supported by hosted backends only; the local app-server rejects a nonempty list.
 * Omitted or empty lists leave originators unrestricted.
 */
originators?: Array<string> | null, /**
 * Optional archived filter; when set to true, only archived threads are returned.
 * If false or null, only non-archived threads are returned.
 */
archived?: boolean | null, /**
 * Omit to include every section, set to `null` for unsectioned threads,
 * or provide a section ID to return only threads in that section.
 */
sectionId?: string | null, /**
 * Optional cwd filter or filters; when set, only threads whose session cwd
 * exactly matches one of these paths are returned.
 */
cwd?: string | Array<string> | null, /**
 * If true, return from the state DB without scanning JSONL rollouts to
 * repair thread metadata. Omitted or false preserves scan-and-repair
 * behavior.
 */
useStateDbOnly?: boolean, /**
 * Optional substring filter for the extracted thread title.
 */
searchTerm?: string | null};

// Source: v2/ThreadListResponse.ts
export type ThreadListResponse = {data: Array<Thread>, /**
 * Opaque cursor to pass to the next call to continue after the last item.
 * if None, there are no more items to return.
 */
nextCursor: string | null, /**
 * Opaque cursor to pass as `cursor` when reversing `sortDirection`.
 * This is only populated when the page contains at least one thread.
 * Use it with the opposite `sortDirection`; for timestamp sorts it anchors
 * at the start of the page timestamp so same-second updates are not skipped.
 */
backwardsCursor: string | null};

// Source: v2/ThreadReadParams.ts
export type ThreadReadParams = { threadId: string,
/**
 * When true, include turns and their items from rollout history.
 * Full-history hydration is deprecated for paginated threads; prefer a
 * metadata-only read and page with `thread/turns/list` and
 * `thread/items/list`.
 */
includeTurns?: boolean, };

// Source: v2/ThreadReadResponse.ts
export type ThreadReadResponse = {thread: Thread};

// Source: v2/ThreadResumeParams.ts
/**
 * There are three ways to resume a thread:
 * 1. By thread_id: load the thread from disk by thread_id and resume it.
 * 2. By history: instantiate the thread from memory and resume it.
 * 3. By path: load the thread from disk by path and resume it.
 *
 * For non-running threads, the precedence is: history > non-empty path > thread_id.
 * If using history or a non-empty path for a non-running thread, the thread_id
 * param will be ignored.
 *
 * If thread_id identifies a running thread, app-server rejoins that thread and
 * treats a non-empty path as a consistency check against the active rollout path.
 * Empty string path values are treated as absent.
 *
 * Prefer using thread_id whenever possible.
 */
export type ThreadResumeParams = {threadId: string, /**
 * Configuration overrides for the resumed thread, if any.
 */
model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null, /**
 * Override where approval requests are routed for review on this thread
 * and subsequent turns.
 */
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, baseInstructions?: string | null, developerInstructions?: string | null, /**
 * @deprecated `friendly` and `pragmatic` no longer select a style.
 * Changing this does not rewrite the thread's existing instructions.
 */
personality?: Personality | null, /**
 * When true, return only thread metadata and live-resume state without
 * populating `thread.turns`. This is useful when the client plans to call
 * `thread/turns/list` immediately after resuming. Full-history hydration
 * is deprecated for paginated threads; use this with `thread/turns/list`
 * and `thread/items/list` instead.
 */
excludeTurns?: boolean};

// Source: v2/ThreadResumeResponse.ts
export type ThreadResumeResponse = {thread: Thread, model: string, modelProvider: string, serviceTier: string | null, /**
 * Saved list of disabled plugin IDs. Does not yet filter plugin capabilities.
 */
disabledPluginIds: Array<string>, cwd: AbsolutePathBuf, /**
 * Environment-native paths to instruction source files currently loaded for this thread.
 */
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval, /**
 * Reviewer currently used for approval requests on this thread.
 */
approvalsReviewer: ApprovalsReviewer, /**
 * Legacy sandbox policy retained for compatibility. Experimental clients
 * should prefer `activePermissionProfile` for profile provenance.
 */
sandbox: SandboxPolicy, reasoningEffort: ReasoningEffort | null, /**
 * Effective collaboration mode. Absent when resuming from an older server.
 */
collaborationMode: CollaborationMode | null, /**
 * Opaque cursor for hydrating paginated turns backwards.
 *
 * Pass this as `cursor` to `thread/turns/list` with
 * `sortDirection: "desc"`. The first page includes the turn identified by the cursor.
 */
turnsBackwardsCursor: string | null, /**
 * Opaque cursor for hydrating paginated items backwards.
 *
 * Pass this as `cursor` to `thread/items/list` with
 * `sortDirection: "desc"`. The first page includes the item identified by the cursor.
 */
itemsBackwardsCursor: string | null};

// Source: v2/ThreadSection.ts
/**
 * An independently persisted, user-visible thread section.
 */
export type ThreadSection = {
/**
 * Opaque UUIDv7 identity that remains stable when the section is renamed.
 */
id: string,
/**
 * The current user-visible section name.
 */
name: string,
/**
 * Optional appearance synchronized across clients.
 */
appearance: ThreadSectionAppearance | null, };

// Source: v2/ThreadSectionAppearance.ts
/**
 * Extensible visual presentation for a custom thread section.
 */
export type ThreadSectionAppearance = { icon: string | null, color: string | null, };

// Source: v2/ThreadSetNameParams.ts
export type ThreadSetNameParams = { threadId: string, name: string, };

// Source: v2/ThreadSortKey.ts
export type ThreadSortKey = "created_at" | "updated_at" | "recency_at" | "section_position";

// Source: v2/ThreadSource.ts
export type ThreadSource = string;

// Source: v2/ThreadSourceKind.ts
export type ThreadSourceKind = "cli" | "vscode" | "exec" | "appServer" | "subAgent" | "subAgentReview" | "subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "unknown";

// Source: v2/ThreadStartParams.ts
export type ThreadStartParams = {model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null, /**
 * Override where approval requests are routed for review on this thread
 * and subsequent turns.
 */
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, serviceName?: string | null, baseInstructions?: string | null, developerInstructions?: string | null, /**
 * @deprecated `friendly` and `pragmatic` no longer select a style.
 */
personality?: Personality | null, ephemeral?: boolean | null, sessionStartSource?: ThreadStartSource | null, /**
 * Optional client-supplied analytics source classification for this thread.
 */
threadSource?: ThreadSource | null};

// Source: v2/ThreadStartResponse.ts
export type ThreadStartResponse = {thread: Thread, model: string, modelProvider: string, serviceTier: string | null, /**
 * Saved list of disabled plugin IDs. Does not yet filter plugin capabilities.
 */
disabledPluginIds: Array<string>, cwd: AbsolutePathBuf, /**
 * Environment-native paths to instruction source files currently loaded for this thread.
 */
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval, /**
 * Reviewer currently used for approval requests on this thread.
 */
approvalsReviewer: ApprovalsReviewer, /**
 * Legacy sandbox policy retained for compatibility. Experimental clients
 * should prefer `activePermissionProfile` for profile provenance.
 */
sandbox: SandboxPolicy, reasoningEffort: ReasoningEffort | null};

// Source: v2/ThreadStartSource.ts
export type ThreadStartSource = "startup" | "clear";

// Source: v2/ThreadStatus.ts
export type ThreadStatus = { "type": "notLoaded" } | { "type": "idle" } | { "type": "systemError" } | { "type": "active", activeFlags: Array<ThreadActiveFlag>, };

// Source: v2/ThreadTurnsListParams.ts
export type ThreadTurnsListParams = { threadId: string,
/**
 * Opaque cursor to pass to the next call to continue after the last turn.
 */
cursor?: string | null,
/**
 * Optional turn page size.
 */
limit?: number | null,
/**
 * Optional turn pagination direction; defaults to descending.
 */
sortDirection?: SortDirection | null,
/**
 * How much item detail to include for each returned turn; defaults to summary.
 */
itemsView?: TurnItemsView | null, };

// Source: v2/ThreadTurnsListResponse.ts
export type ThreadTurnsListResponse = { data: Array<Turn>,
/**
 * Opaque cursor to pass to the next call to continue after the last turn.
 * if None, there are no more turns to return.
 */
nextCursor: string | null,
/**
 * Opaque cursor to pass as `cursor` when reversing `sortDirection`.
 * This is only populated when the page contains at least one turn.
 * Use it with the opposite `sortDirection` to include the anchor turn again
 * and catch updates to that turn.
 */
backwardsCursor: string | null, };

// Source: v2/ToolRequestUserInputOption.ts
/**
 * EXPERIMENTAL. Defines a single selectable option for request_user_input.
 */
export type ToolRequestUserInputOption = { label: string, description: string, };

// Source: v2/ToolRequestUserInputParams.ts
/**
 * EXPERIMENTAL. Params sent with a request_user_input event.
 */
export type ToolRequestUserInputParams = { threadId: string, turnId: string, itemId: string, questions: Array<ToolRequestUserInputQuestion>, isBlocking: boolean,
/**
 * @deprecated Use `isBlocking` to decide whether the request should block.
 */
autoResolutionMs: number | null, };

// Source: v2/ToolRequestUserInputQuestion.ts
/**
 * EXPERIMENTAL. Represents one request_user_input question and its required options.
 */
export type ToolRequestUserInputQuestion = { id: string, header: string, question: string, isOther: boolean, isSecret: boolean, options: Array<ToolRequestUserInputOption> | null, };

// Source: v2/Turn.ts
export type Turn = {
/**
 * Identifier for this turn. Codex-generated turn IDs are UUIDv7.
 */
id: string,
/**
 * ID of the first turn in the chain of work that led to this turn.
 * Pass this as `rootTurnId` when starting work on behalf of this turn.
 * May be null in older history or a `review/start` response.
 */
rootTurnId: string | null,
/**
 * Thread items currently included in this turn payload.
 */
items: Array<ThreadItem>,
/**
 * Describes how much of `items` has been loaded for this turn.
 */
itemsView: TurnItemsView, status: TurnStatus,
/**
 * Error associated with a failed or interrupted turn.
 */
error: TurnError | null,
/**
 * Unix timestamp (in seconds) when the turn started.
 */
startedAt: number | null,
/**
 * Unix timestamp (in seconds) when the turn completed.
 */
completedAt: number | null,
/**
 * Duration between turn start and completion in milliseconds, if known.
 */
durationMs: number | null, };

// Source: v2/TurnError.ts
export type TurnError = { message: string, codexErrorInfo: CodexErrorInfo | null, additionalDetails: string | null,
/**
 * Optional public explanation and continuation instruction for a misalignment block.
 */
misalignment: MisalignmentErrorDetails | null, };

// Source: v2/TurnInterruptParams.ts
export type TurnInterruptParams = { threadId: string, turnId: string, };

// Source: v2/TurnInterruptResponse.ts
export type TurnInterruptResponse = Record<string, never>;

// Source: v2/TurnItemsView.ts
export type TurnItemsView = "notLoaded" | "summary" | "full";

// Source: v2/TurnStartParams.ts
export type TurnStartParams = {threadId: string, /**
 * Replace this thread's disabled plugin IDs.
 * Omitted/null preserves the list; [] clears it.
 */
disabledPluginIds?: Array<string> | null, clientUserMessageId?: string | null, input: Array<UserInput>, /**
 * Optional source classification for the caller that starts this turn.
 * Ignored when this request steers an already-active turn.
 */
turnTrigger?: string | null, /**
 * ID of the turn that caused this new turn to start.
 *
 * Set this when starting work on behalf of another turn, such as delegated
 * work in a different thread. Leave unset for work started directly by the
 * user. Ignored when this request adds input to an active turn.
 */
parentTurnId?: string | null, /**
 * ID of the first turn in the chain of work that led to this new turn.
 *
 * When setting `parentTurnId`, set this to the parent turn's `rootTurnId`
 * when known. This keeps descendant work attributed to the original turn.
 * If omitted, the new turn becomes its own root. Ignored when this request
 * adds input to an active turn.
 */
rootTurnId?: string | null, toolOutput?: TurnToolOutput | null, /**
 * Override the working directory for this turn and subsequent turns.
 */
cwd?: string | null, /**
 * Override the approval policy for this turn and subsequent turns.
 */
approvalPolicy?: AskForApproval | null, /**
 * Override where approval requests are routed for review on this turn and
 * subsequent turns.
 */
approvalsReviewer?: ApprovalsReviewer | null, /**
 * Override the sandbox policy for this turn and subsequent turns.
 */
sandboxPolicy?: SandboxPolicy | null, /**
 * Override the model for this turn and subsequent turns.
 */
model?: string | null, /**
 * Override the service tier for this turn and subsequent turns.
 */
serviceTier?: string | null | null, /**
 * Override the service tier only when this request starts a new turn.
 * Use "default" for standard speed. Omitted or null inherits the thread's tier.
 * Does not change the thread's tier or a turn being steered.
 */
serviceTierForTurn?: string | null, /**
 * Override the reasoning effort for this turn and subsequent turns.
 */
effort?: ReasoningEffort | null, /**
 * Override the reasoning summary for this turn and subsequent turns.
 */
summary?: ReasoningSummary | null, /**
 * @deprecated `friendly` and `pragmatic` no longer select a style.
 * Changing this does not rewrite the thread's existing instructions.
 */
personality?: Personality | null, /**
 * Optional JSON Schema used to constrain the final assistant message for
 * this turn.
 */
outputSchema?: JsonValue | null};

// Source: v2/TurnStartResponse.ts
export type TurnStartResponse = { turn: Turn, };

// Source: v2/TurnStatus.ts
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

// Source: v2/TurnToolOutput.ts
export type TurnToolOutput = { name: string, namespace: string | null, output: FunctionCallOutputBody,
/**
 * Requests retention of this output in the thread's model history.
 */
retain?: boolean, };

// Source: v2/UserInput.ts
export type UserInput = { "type": "text", text: string,
/**
 * UI-defined spans within `text` used to render or persist special elements.
 */
text_elements: Array<TextElement>, } | { "type": "image", detail?: ImageDetail, } & ({ url: string, } | { fileId: string, }) | { "type": "localImage", detail?: ImageDetail, path: string, } | { "type": "audio", url: string, } | { "type": "localAudio", path: string, } | { "type": "skill", name: string, path: string, } | { "type": "mention", name: string, path: string, };

// Source: v2/WebSearchAction.ts
export type WebSearchAction = { "type": "search", query: string | null, queries: Array<string> | null, } | { "type": "openPage", url: string | null, } | { "type": "findInPage", url: string | null, pattern: string | null, } | { "type": "other" };

// Source: WebSearchItem.ts
export type WebSearchItem = { id: string, query: string, action: WebSearchAction | null,
/**
 * Structured search results returned out-of-band by standalone web search.
 *
 * These stay as opaque JSON at the extension/app-server boundary so new
 * result fields and result types can pass through without a Codex release.
 */
results: Array<JsonValue> | null, };
