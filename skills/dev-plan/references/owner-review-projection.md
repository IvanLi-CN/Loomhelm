# Owner review projection

For an explicit `$dev-plan` request, first emit and validate the canonical raw-plan. Only after the checker passes, derive the transient owner-facing Markdown view from the same parsed canonical facts. The projection is written to stdout or the current response, is not persisted, is never reparsed as an execution contract, and cannot replace the raw-plan input. Native Codex Plan Mode without an explicit `$dev-plan` invocation remains unchanged.

The canonical `Task Orchestration` section is the only source for batch, wave, task, dependency, owned-surface, acceptance, and skill facts. Existing fast-track fixtures that use the older direct single-task shape remain on the explicit compatibility projection until they are migrated. New v2 tasks also declare `title`, `purpose`, and `outputs` in the task field list so the projection can explain the work without maintaining a second task registry. Compatibility direct plans project every direct task line accepted by the TypeScript checker, including the usual single `main-agent` shape, without inventing a second task registry. Historical JSONL may omit these display fields and remains limited to the explicit read-only compatibility route.

The owner-facing projection uses these sections in order: `决策卡`, `目标`, `不包含的工作`, `波次与依赖`, `执行规则`, `任务卡`, `约束`, `验收清单`, and `Review、运行时门禁与收口`. Its `波次与依赖` section contains a Mermaid graph derived only from canonical waves, tasks, same-wave parallelism, and explicit dependencies. The `任务卡` section displays every canonical task and every non-empty canonical batch lifecycle field. Displayed fields include target, parent branch, child PR, topology, event protocol, release policy, condition, acceptance, and observation window.

Direct task cards preserve the canonical `[model, effort]` profile and every accepted inline `$skill` annotation when present.

The `验收清单` section uses two phase headings: `PR 合并前验收` and `PR 合并后验收`. Under each heading, render one readable card per canonical acceptance item rather than a wide table. Each card shows its ID, proof target, pass conditions, and evidence; when scope is present, show it as a labeled field. Cards under the post-merge heading also show the applicable trigger, such as `Merge Receipt 已存在` or `部署身份已核验`. Keep each assertion and evidence item on its own semantic line so long text wraps naturally and is not forced into equal-width columns. The projection must not emit a long-text acceptance table or maintain a second machine-readable manifest. Review Readiness, PR convergence, and Step 5C consume only the pre-merge cards.

Task cards and acceptance items are views of canonical facts, not new machine-readable batch/task syntax. The historical coordinator contract section remains forbidden in new raw-plans and is accepted only by historical JSONL compatibility.

The `决策卡` retains the canonical flow lock as `流程类型`, so `$flow-continue` can resume the locked route without treating the projection as a new execution contract. Flow Decision fields are read only from unfenced list items with optional indentation, and fenced examples never affect routing.

Optional task profiles use the same supported model/effort matrix as the runtime profile checker.
