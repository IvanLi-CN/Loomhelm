# Dispatch outcome handling

Read this when a creation attempt returns anything other than one resolved native `threadId`.

## Pending setup

A result containing only `clientThreadId` means setup is still pending. Treat it as a creation acknowledgement only, never as an observation/read, navigation, or relay target; assignment-scoped cutover still applies, but it does not block parent-scoped work that is resource-disjoint from the child assignment. The platform owns the pending-to-real-`threadId` binding: do not retry creation, dispatch the same assignment again, infer a thread identity, or create local recovery state. Wait for the platform to expose the real `threadId` before any child-task operation, and do not poll automatically. The envelope's pending `dispatch_operation_id` remains the single claim for native creation; append each claim to the task's unique `dispatch_operation_history`, and only a confirmed `source=native-create` failure receipt may release it for a new operation. The receipt must retain the exact active `dispatch_operation_id`, use `source=native-create`, report `status=failed|rejected`, and include a non-empty error. Only that confirmed native failure may authorize one retry with the same locked profile. A persisted marker and digest preserve failure history but do not authorize a new retry after JSON reload; retry recovery requires an adapter-owned receipt or a matching `dispatch_failure` observation in the same replay stream.

## Unknown or failed creation

If `create_thread` fails without that matching receipt, returns neither identifier, exposes contradictory identifiers, or leaves only an ambiguous outcome, treat creation as unknown. Stop and ask the owner or platform to reconcile the exact request; do not retry, duplicate, infer a target, relay, or continue overlapping work while the outcome is unresolved.

## Failure receipts

A trusted adapter-owned native `PreToolUse` denial or runtime `create_thread` failure may be imported as the matching dispatch receipt, preserving the exact operation identity, native request identity, canonical `create_thread` tool identity, failure status, and error. The public generic receipt importer MUST NOT create a `dispatch-failure` receipt accepted by claim release; only the trusted native dispatch adapter may create that imported receipt. The trusted runtime adapter MUST validate the raw provider result and end with an opaque adapter failure before claim release; a public release helper MUST NOT adapt a raw caller mapping. A runtime failure qualifies only when the adapter observed all of those native fields; it MUST NOT fill a missing operation identity, tool identity, or status from local defaults. A raw or caller-authored hook/runtime mapping is not a receipt. This is evidence of the failed native attempt, not a flow capability check; retry remains explicit and reuses the locked pair.

## Request-identity binding

After native `PreToolUse` or a runtime failure exposes the request identity, bind that exact identity and the canonical `create_thread` tool name to the pending dispatch claim before importing or releasing a failure receipt. A runtime failure must also carry the exact active `dispatch_operation_id`, `status=failed|rejected`, and a non-empty error; missing or mismatched identity is an unknown creation outcome and cannot authorize retry. A resolved native `threadId` must use the flow's atomic success binding operation with the exact bound native request identity, which retains `dispatch_operation_history` and clears the claim and its request binding together. Missing, mismatched, or ambiguous request identity is an unknown creation outcome and must not authorize retry.
