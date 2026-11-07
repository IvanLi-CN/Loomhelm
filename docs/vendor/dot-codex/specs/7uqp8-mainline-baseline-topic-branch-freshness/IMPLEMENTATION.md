# Mainline baseline and topic branch freshness contract 实现状态

> 当前有效规范仍以 `./SPEC.md` 为准；这里记录实现覆盖、交付进度与 rollout 相关事实。

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: 规格已建立，等待 skill / checker / replay / solution 全量收敛

## Coverage / rollout summary

- 已创建独立 topic spec，明确这次规则不再硬塞进 `docs/specs/dev-plan-default-fast-track-auto-lock/SPEC.md` 或 `docs/specs/git-skill-convergence/SPEC.md`。
- `AGENTS.md` 已补齐 owner-facing current truth：
  - 显式 `$dev-plan` 必须输出具体 `开发基线`
  - shared workflow 的“无 topic branch 自动建 / 已有 topic branch Step 1 预同步 / Step 4 再复核”合同
- `skills/dev-plan/SKILL.md` 已新增 `开发基线` 必填约束、默认解析规则与 skeleton 示例。
- `skills/project-engineering-workflow/SKILL.md` 已把 Step 1 改成“建立正确且新鲜的 topic-branch 执行上下文”，并补了 Step 1 预同步与 Step 4 二次复核的口径。
- `skills/git-branch/SKILL.md`、`skills/git-sync/SKILL.md`、`skills/fast-flow/SKILL.md` 已完成最小依赖文案对齐。
- `bin/plan_contract_check.sh` 已新增：
  - 缺失 `开发基线` 的拦截
  - 抽象主干词作为最终值的拦截
  - 主人显式 baseline 与计划最终值不一致的拦截
- checker 的 planning-session reset 逻辑已收紧：
  - 已锁定计划中的 standalone flow restatement 不再清空主人显式 baseline
  - 普通 scope clarification 里的产品词组（如 `new plan file upload API`）不再误判成新的独立计划请求
- checker 的 owner baseline 抽取已补足自然语言显式基线：
  - ``基于 \``...\` 开发``/``from ...` 这类 directional wording 会被识别为主人显式 baseline
  - `请把导入页面也规划进去，其他不变` 这类 scope clarification 不再误清当前 planning session
- checker 的 baseline / session 误报边界已继续收紧：
  - `BASE_REF=...` 形式现在也会被识别为主人显式 baseline
  - bare `base=...` / `base:...` 形式现在也会被识别为主人显式 baseline
  - ``branch protection``、``use \``main.ts\` as the parser reference` 这类普通产品/文件短语不再被误抽成 baseline
  - `plan.md` / `planning UI` 这类 scope clarification 不再因为包含 `plan` 词根而误触发新 planning session reset
  - `开发基线用 upstream/release-2026q3` 这类中文简写现在也会被识别为主人显式 baseline，不再漏掉 mismatch
  - owner baseline 比较会接受 `origin/main` 与 `refs/remotes/origin/main` 这类等价 remote ref 表达
  - `开发基线从 A 改为 B` / `开发基线改为 B` 这类 replace clause 现在会以新的显式 baseline 为准，不再错误沿用被替换掉的旧值
  - `请重新规划这个任务` 这类 verb-form re-plan 请求现在会正确打开新的 planning window，不再把上一轮显式 baseline 泄漏到下一轮计划
  - `重新规划这个任务，收口改为 merge-ready` 这类同时带 re-plan 与 continuation 词的请求，现在会优先按新的 planning window 处理，而不是被 continuation 词提前截走
  - `请帮我规划这个任务：...` 这类 plain-language 新计划请求现在会正确打开新的 planning window，不再被上一轮 flow/baseline 污染
  - `请用 $dev-plan 给我一份 merge queue API 的计划` 这类任务名含 `merge` 词根的新请求，不再被误当成 continuation
  - `开发基线使用 qa`、`base=rc` 这类 1-2 字符的 plain short ref baseline，现在也会被识别成主人显式 baseline，不再漏掉 mismatch
  - plain baseline 末尾如果是 Git 允许的 `,` / `;` 这类合法字符，现在会原样保留；只有真正的 continuation 子句（如 `, 并继续`）才会被裁掉
  - `基于 new plan file upload API 规划这个任务` 这类 directional 产品词组，不再被误抽成 owner baseline；plain directional baseline 只有在值显式带 `branch/ref/commit` 限定词，或本身长得像真实 ref/commit 时才会进入比较
  - ``基于 \``docs/specs/.../SPEC.md\` 规划这个任务``这类 backtick 包裹的 spec/doc 输入，不再被 plain directional baseline 分支误抽成 owner baseline；需要显式``开发基线...``/``BASE_REF=...``/``基于 ... 开发` 这类更强 Git 语义才会锁定 baseline
  - `请按 normal 把计划页面上传 API 也规划进去，flow 和开发基线都不变` 这类 scope clarification，不再因为产品词里的 `计划` 两字误触发新的 planning window reset
  - 合法 git ref 即使包含 `default` / `mainline` / `todo` 等词根，也不会再被 placeholder / abstract-baseline 规则误伤
  - `目标仓库主干基线` / `远程主干基线` 这类组合抽象词组，现在会继续被视为抽象默认策略词，而不是被误当成合法 ref
  - `origin/HEAD` / `upstream/HEAD` 这类常见 bare remote symbolic HEAD alias，以及 `refs/remotes/origin/HEAD` 这类 fully-qualified remote HEAD alias，现在都会被稳定拒绝，不再依赖 checker 当前仓库里恰好存在同名 remote
  - 合法 branch ref 即使最后一个 path component 恰好是 `HEAD`（如 `feature/HEAD`），也不会再被 remote symbolic HEAD alias 规则误伤
  - `bin/plan_contract_check.sh` 已去掉会依赖临时写盘的 here-string 输入路径，使 fresh review proof 在 read-only sandbox 下也能直接执行 checker，而不会因为 shell 临时文件失败而误报 `NO_PROPOSED_PLAN`
- review proof 暴露的后续边界问题也已补齐：
  - `topic/foo`、`feature/todo-cleanup` 这类 ref 内部包含 `to` 词根的合法 branch baseline，不会再被 replace-clause regex 截断成尾巴
  - 在 `request_user_input(flow_type)` 之后，`请按 normal 继续出计划` 这类自然语言 flow 回答不再清空先前显式 baseline
  - 显式 `$dev-plan` 新请求现在会先于 continuation heuristics 判定；像 `请用 $dev-plan 继续给我一份新的可执行计划` 这类同句带 `继续` 的 fresh request，也会正确打开新的 planning window
  - `todo` / `default` / `pending` 这类与 placeholder 词根重合但本身是合法 git ref 的 baseline，现在会优先按 concrete ref 接受；真正的 `TBD` 类占位词仍然拒绝
  - `feature/README.md` 这类“看起来像文档路径”但语法上合法的 git ref baseline，现在也会按 concrete ref 保留；只有真正的文件系统路径（如 `./docs/specs/foo/SPEC.md`）仍会被拒绝
- replay fixtures / `CASES.txt` 已补齐默认主干 concrete ref、显式 branch、显式 commit、缺失基线、抽象基线、忽略主人 baseline、standalone flow restatement、directional 产品词误报与 scope clarification false-positive 的 focused coverage，并已通过全套回放。
- `docs/solutions/workflow-issues/git-skill-convergence.md` 已刷新 reusable guidance。

## Remaining Gaps

- None currently tracked after local validation.

## References

- `./SPEC.md`
- `./HISTORY.md`
