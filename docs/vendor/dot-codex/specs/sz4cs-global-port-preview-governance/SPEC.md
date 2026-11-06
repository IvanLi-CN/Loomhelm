# Global port preview governance

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## Related ADRs

None

## Context and Scope

This topic governs owned local-preview ports, the browser route used to validate owned preview URLs, and DevTools isolation for its explicit exception path. It does not alter external browser runtimes, bundled plugins, or user-owned listeners.

## Requirements

### REQ-PORT-LEASE

- A persistent local service MUST resolve and own an active `$global-port-manager` lease before startup and before its URL is shared.
- A port belonging to another scope or an unknown listener MUST NOT be taken over without explicit owner approval.
- Heartbeat MAY bind a PID on a lease whose PID is still empty when the recorded port matches; once a PID is present, ownership-sensitive callers MUST provide a matching expected owner guard, and a mismatch MUST leave the current lease unchanged.
- A service wrapper MUST reject duplicate startup when the current scope/service lease already has an owner PID or the port is already listening; it MUST not use a separate inspect/register sequence to overwrite that owner.

### REQ-EGO-BROWSER-DEFAULT

- Browser validation for an owned local preview MUST use `$ego-browser` by default, with one TaskSpace for the user goal.
- Chrome control and DevTools MUST remain explicit exceptions; an `$ego-browser` failure MUST NOT authorize a Chrome fallback.

### REQ-DEVTOOLS-ISOLATION

- The explicit DevTools path MUST reuse shared context by default and MUST enforce one declared `isolatedContext` per `task_scope_id` when isolation is necessary.
- A synthetic debugging-browser bootstrap MUST NOT be used without same-thread, task-scoped owner authorization.

## Verification

### VER-PORT-AND-BROWSER-ROUTING covers: REQ-PORT-LEASE, REQ-EGO-BROWSER-DEFAULT, REQ-DEVTOOLS-ISOLATION

- Port-registry tests cover lease allocation, first PID binding and replacement-owner conflict behavior; browser policy replay checks cover the default route and prohibited Chrome fallback.
- The acceptance cases below cover an owned preview URL, default ego-browser validation, and the DevTools isolation boundary.

## 背景 / 问题陈述

- 当前 `~/.codex` 只有 `$create-worktree`、`$remove-worktree` 等少数流程显式接入 `$global-port-manager`，并没有把“启动本地长驻服务前先做端口归属检查”写成全局门禁。
- session `019ce6bf-17ce-7782-83a4-5ff0f5e3cea9` 已给出完整反例：agent 直接运行仓库里的前端启动脚本，默认端口 `55173` 被其他 worktree 占用后，又手动切到 `55174` 继续启动；整个过程没有执行任何 `port_registry.py` 命令。
- 同一 session 里，agent 在本地页面验收时也绕过了正式浏览器入口，先尝试 `chrome-devtools`，超时后又回退到 `osascript` 打开 Chrome。
- 这会导致两个高风险后果：
  - 给用户交付了没有租约归属证明的 `localhost` 地址；
  - 默认端口冲突时，agent 容易滑向“杀掉旧进程 / 接管旧端口”的临场判断。

## 目标 / 非目标

### Goals

- 把“所有长驻本地服务都必须先做端口归属检查，再启动，再给出 URL”写成 `~/.codex` 的全局默认约束。
- 把 `chrome-devtools` 的 `isolatedContext` 使用收口到“默认共享、必要时显式申请、同一任务只复用一个隔离上下文、违规直接阻断”。
- 明确端口冲突默认处理为“报告归属并换新租约端口”，而不是“接管旧端口”。
- 让 repo 自带固定端口脚本只能作为端口输入来源，不能作为抢占该端口的默认授权。
- 让 `$global-port-manager` 的自动端口分配默认使用 `10000..65535` 范围内的按 scope 稳定随机候选，避免所有新 scope 从同一固定低位顺序起步。

### Non-goals

- 不新增新的服务托管层，也不改动其他与本次治理无关的服务管理能力。
- 不增加运行时 hook，也不依赖 `config.toml` 提供命令拦截。
- 不新增自动 kill 进程、自动回收他人端口或自动改写仓库启动脚本默认值的逻辑。
- 不修改 `chrome-devtools-mcp` upstream、Codex runtime 或任何 bundled plugin cache。
- 不把这条 `isolatedContext` 规则提升成所有 `chrome-devtools` consumer 的全局硬规则；本次只治理 `AGENTS.md` 中定义的显式 `chrome-devtools` 例外路径。

## 范围（Scope）

### In scope

- 更新 `AGENTS.md` 的全局长驻服务与本地预览规则。
- 更新 `skills/global-port-manager/SKILL.md` 的集成契约与冲突处理规则。
- 更新 `skills/global-port-manager/scripts/port_registry.py` 的自动端口分配默认下限与候选顺序。
- 更新 `AGENTS.md` 中与本地预览相关的浏览器禁忌，以及 `isolatedContext` 使用契约。
- 新增/更新相关 `docs/solutions/**`，把隔离上下文复用治理沉淀成可复用经验。
- 更新 `docs/specs/README.md` 并登记本规格。

### Out of scope

- 修改任何仓库业务代码或本地运行脚本。
- 改变 `leases.tsv` schema 或迁移既有 active leases。
- 限制 `register --port` 的显式端口注册范围；显式注册仍保持 caller-provided port 语义。
- 修改 GitHub、浏览器或 Codex runtime 本身的行为。
- 为 `AGENTS.md` 显式例外路径之外的调用入口自动拦截、自动改写或自动回收 `isolatedContext`。

## 需求（Requirements）

### MUST

- 任何会长期监听本地端口的服务，在启动前都必须先按 `$global-port-manager` 推导 `scope_id` 与 `service`。
- 若命令或仓库脚本已有显式/默认端口，agent 必须先对该端口执行 `inspect`，先识别归属，再决定 `register` 还是 `allocate`。
- 若目标端口属于其他 `scope_id`、其他 worktree 或未知 LISTENing 进程，agent 必须默认改用新的租约端口，并把该端口显式注入启动命令。
- 未经主人明确授权，agent 不得以 `kill`、`pkill`、`接管旧端口`、`复用他人监听端口` 作为默认冲突解决策略。
- 任何要交付给主人或用于浏览器验收的 `localhost` / `127.0.0.1` / `::1` URL，都必须先证明它属于当前 scope 的 active lease，或属于当前仓库在本次运行中已启动并验证过的稳定预览端口。
- `$ego-browser` 是默认浏览器入口；每个用户目标只使用一个 TaskSpace。`chrome:control-chrome` 和 `chrome-devtools` 只允许作为 `AGENTS.md` 明确记载的非默认例外路径。
- 浏览器工具在 `$ego-browser` 或显式例外不可用时只能报告 blocker 或按 `$gui-escalation-gate` 评估 Computer Use，不得回退到 `osascript`、`open`、`xdg-open` 或类似系统 URL opener。
- 对上述任务，agent 不得通过启动新的 Chrome/Chromium/`9222` 调试实例来伪造 DevTools Surface；这类 `Synthetic DevTools Bootstrap` 只有在主人已于同一 thread 中明确授权这一次浏览器任务这样做时才可例外。
- `chrome-devtools` 例外路径默认必须复用共享浏览器上下文；当共享状态已足以完成验证时，不得请求 `isolatedContext`。
- 若 `chrome-devtools` 例外路径需要请求 `isolatedContext`，调用方必须在调用前显式固定 `task_scope_id`，并提供结构化 `isolation_reason`，至少说明：
  - `hazard`：共享上下文会造成的风险类别，例如 `result_distortion`、`auth_side_effect`、`storage_side_effect`；
  - `shared_context_failure`：共享上下文为何会让本次验证结论失真，或引入不可接受的登录态 / storage 副作用。
- 同一 `task_scope_id` 下最多只允许创建一个 `isolatedContext`；后续所有隔离页面创建与导航都必须复用这个既有上下文。
- 若同一 `task_scope_id` 下尝试创建第二个不同的 `isolatedContext`，或无法证明当前调用是在复用既有隔离上下文，调用方必须直接阻断并返回可审计错误，明确要求“复用已有 isolatedContext”或“显式切换新的 task_scope_id”。
- 对上述 `isolatedContext` 违规场景，禁止静默 auto-rewrite 成已有上下文名。
- `allocate` 与 `suggest` 默认必须只自动推荐 / 分配 `>=10000` 的端口。
- `allocate` 与 `suggest` 对新 `scope_id + service` 必须基于 `scope_id` 派生稳定随机 block 候选顺序；同一 registry 状态下同一 scope 结果可复现，不同 scope 不应集中抢同一个固定起点。
- 已存在的同一 `scope_id + service` lease 必须继续复用；同一 scope 内不同 service 应继续优先共享已有 block，并保留 service offset 偏好。

### SHOULD

- 两处文本（`AGENTS.md`、`$global-port-manager`）对执行顺序使用一致措辞：`inspect/allocate/register -> start -> verify -> share URL`。
- `docs/specs/global-port-preview-governance/SPEC.md` 与 `AGENTS.md` 应对 `isolatedContext` 使用一致描述：`shared by default -> declare necessity -> reuse one per task -> block instead of auto-rewrite`。
- 负面案例应明确写入规格，避免后续入口新增时再次出现“绕过租约直接开新端口”的回归。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 当 agent 需要启动本地长驻服务时：
  - 先解析 `scope_id`；
  - 若仓库脚本自带默认端口，先对该端口执行 `inspect`；
  - 若端口空闲且确实要保留该固定端口，则 `register`；
  - 若端口已被其他 scope 占用，改走 `allocate`，并把新端口通过 `PORT`、CLI flag 或等价方式注入启动命令；
  - 启动后再验证服务确实监听在该归属端口上。
- 当 `$global-port-manager` 自动选择新 lease 端口时：
  - 默认从 `10000` 作为 `--start-base` 下限；
  - 将 `start_base..65535` 内按 `step` 可达的 block base 作为候选；
  - 用 `sha256(scope_id, base)` 对候选 block 做稳定随机排序；
  - 先尝试当前 scope 已有 block，再尝试新候选 block；
  - 跳过已登记的 block / port 和当前正在 LISTEN 的 port。
- 当本地预览验证需要浏览器时：
  - 先确认 URL 的端口来自当前租约，或来自当前仓库在本次运行中已启动并验证过的稳定预览端口；
  - 若来源不明、端口属于其他 workspace/scope、或只是未知 LISTENing 进程，直接报告 mismatch，不得“试试看打开”；
  - Agent 默认直接使用 `$ego-browser`，并为用户目标复用一个 TaskSpace；
  - 只有主人显式点名 `chrome:control-chrome`，或任务必须复用既有 Chrome 会话时，才允许进入 Chrome 例外路径；`chrome-devtools` 仅限主人点名或某条仓库 current-truth skill 明确要求的窄用途；
  - `$ego-browser` 工具不可用或失败不构成 Chrome Control Surface 例外的证据。
  - 启动新的 Chrome/Chromium/`9222` 调试实例来“补出一个可连的 DevTools”属于 `Synthetic DevTools Bootstrap`，默认禁止。
- 当 agent 通过 `chrome-devtools` 例外路径打开页面时：
  - 默认使用共享浏览器上下文；
  - 只有当共享上下文会污染验证结果、引入登录态 / storage 副作用，或使证据失真时，才允许申请 `isolatedContext`；
  - 首次申请隔离前必须固定 `task_scope_id` 并记录结构化 `isolation_reason`；
  - 同一 `task_scope_id` 下首次隔离调用可以创建一个 `isolatedContext`；
  - 同一 `task_scope_id` 下后续隔离页面创建必须复用该上下文，不得再生成第二个名字不同的 `isolatedContext`；
  - 若调用方确实需要第二个隔离容器，必须显式切换新的 `task_scope_id`，而不是在原任务里继续增生上下文。

### Edge cases / errors

- 若 `scope_id` 不能可靠推导，必须阻断并问主人 1 个关键问题，不能瞎编。
- 若稳定预览端口由当前仓库的后端脚本固定声明并且该服务已由当前仓库成功启动，允许把该端口当作可交付 URL 来源，但仍要在本次运行里完成来源验证。
- 若仓库脚本硬编码默认端口且缺少可覆盖参数，agent 仍必须先报告该限制，再说明无法满足租约注入，而不是直接运行。
- 若调用方需要隔离上下文但未提供 `task_scope_id` 或结构化 `isolation_reason`，必须阻断，不得以“先开一个再说”兜底。
- 若同一 `task_scope_id` 下已经存在隔离上下文，但当前调用无法证明自己在复用它，必须返回 blocker，而不是猜测、改写或重新创建。

## 验收标准（Acceptance Criteria）

- Given 某个仓库脚本默认使用 `55173` When agent 要启动该服务 Then 它必须先执行端口归属检查，而不是直接运行脚本。

- Given 默认端口已被其他 worktree 占用 When agent 处理冲突 Then 它只能报告归属并切换到新的租约端口，不能默认建议 kill 或接管。

- Given 一个新 scope 未指定 `--start-base` When 执行 `allocate` 或 `suggest` Then 自动选择的端口必须 `>=10000`，且不应总是从 `10000` 顺序起步。

- Given 相同 registry 状态与相同 `scope_id` When 重复执行 `suggest` Then 推荐端口与 `port_base` 必须稳定一致。

- Given 同一 scope 已有 `web` lease When 再为 `api` 分配端口 Then `api` 应优先落在同一 `port_base + 1`，除非该端口已被占用或正在 LISTEN。

- Given 主人要求“在浏览器打开本地 web demo 给我看” When agent 选择浏览器面 Then 它必须默认先走 `$ego-browser`，并为用户目标使用一个 TaskSpace。

- Given 共享浏览器上下文已经足以完成当前验证 When agent 通过 `chrome-devtools` 例外路径打开页面 Then 它不得请求 `isolatedContext`。

- Given 当前任务确实需要隔离浏览器状态 When agent 通过 `chrome-devtools` 例外路径首次创建隔离页面 Then 它必须先提供 `task_scope_id` 与结构化 `isolation_reason`，再创建唯一的 `isolatedContext`。

- Given 当前任务需要隔离浏览器状态但缺少 `isolation_reason` When agent 尝试请求 `isolatedContext` Then 调用方必须阻断并返回可审计错误。

- Given 同一 `task_scope_id` 下已经存在一个隔离上下文 When agent 再次请求另一个不同名称的 `isolatedContext` Then 调用方必须阻断，并要求复用已有上下文或显式切换新的 `task_scope_id`。

- Given agent 显式切换到新的 `task_scope_id` When 新任务首次请求隔离上下文 Then 允许创建新的 `isolatedContext`。

- Given session `019ce6bf-17ce-7782-83a4-5ff0f5e3cea9` 的行为回放 When 按本规格检查 Then “直接起 `55173` / 改跑 `55174` / 用 `osascript` 打开本地页”都应被判定为不合规。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- Unit tests: `bun test skills/global-port-manager/scripts/test_port_registry.ts`
- Integration tests: 通过静态文本一致性检查验证三处规则是否给出一致结论
- E2E tests (if applicable): N/A

### Quality checks

- `git diff --check`
- 交叉检查 `AGENTS.md`、`skills/global-port-manager/SKILL.md` 是否都包含：
  - 先查归属/租约
  - 再启动
  - 再交付 URL
  - 禁止默认抢他人端口
  - 禁止系统 opener fallback
- 交叉检查 `docs/specs/global-port-preview-governance/SPEC.md` 与 `AGENTS.md` 是否都包含：
  - 默认共享浏览器上下文
  - `isolatedContext` 需要 `task_scope_id`
  - `isolatedContext` 需要结构化 `isolation_reason`
  - 同一任务最多一个隔离上下文且必须复用
  - 违规时阻断并报告，而不是 auto-rewrite

## 方案概述（Approach, high-level）

- 保留租约 schema、GC 与显式 register 语义，只调整自动 `allocate` / `suggest` 的默认下限和候选排序。
- 用 `$global-port-manager` 提供统一的归属判断语言，避免每个 agent 临场发明“换端口”或“接管端口”的策略。
- 用 `AGENTS.md` 收口 `chrome-devtools` 例外路径的 `isolatedContext` 使用边界：允许必要隔离，但把“默认共享、任务级单实例复用、违规硬阻断”写成可审计契约；不做静默 auto-rewrite，避免掩盖上游错误任务建模。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：治理仍依赖 agent 遵守 `$global-port-manager` 门禁；若后续新增入口但不读取这些规则，仍可能绕开。
- 风险：`AGENTS.md` 显式例外路径之外的直接 `chrome-devtools` consumer 仍不受本条 `isolatedContext` 契约约束；若未来同类问题继续从其他入口出现，需要单独扩面，而不是误以为 `docs/specs/global-port-preview-governance/SPEC.md` 已全局拦截。
- 需要决策的问题：None
- 假设：当前 `config.toml` 没有提供可用的命令级前置 hook，因此本次只能通过全局提示与 skill 契约修正行为。

## 参考（References）

- `sessions/2026/03/13/rollout-2026-03-13T18-30-09-019ce6bf-17ce-7782-83a4-5ff0f5e3cea9.jsonl`
- `skills/global-port-manager/scripts/port_registry.ts`
