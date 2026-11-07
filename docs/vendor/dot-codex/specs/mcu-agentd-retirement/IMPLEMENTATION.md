# mcu-agentd 集成清退实现状态

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: dot-codex、agent-toolkit 与 style-playbook 的受维护源头均已完成清退；runtime home 安装残留仍按边界单独记录。

## Implementation Coverage

| 需求 | dot-codex 覆盖 | 外部切片 |
| - | - | - |
| `REQ-MCURETIRE-001` | 已删除私有硬件操作 Skill、索引条目和 Git 跟踪白名单 | agent-toolkit 公共 Skill 及成员清单已由独立 PR 清退并合并 |
| `REQ-MCURETIRE-002` | dot-codex 不再提供旧工具路由或操作要求；旧服务规格已移除对该 Skill 的现行要求 | style-playbook 现行推荐及发现数据已由独立 PR 清退并合并 |
| `REQ-MCURETIRE-003` | 未新增替代工具，也未规定或调查消费项目工具 | 不适用 |
| `REQ-MCURETIRE-004` | 已删除旧项目的专属 trusted 登记；runtime home 仅做只读观察 | 安装源状态由对应对话分别报告 |
| `REQ-MCURETIRE-005` | 保留本主题和必要历史文档；两份旧服务规格保留其余治理内容并移除失效引用 | 外部主题快照由对应对话分别处理 |
| `REQ-MCURETIRE-006` | 已执行源仓库静态检查、现行引用分类和 runtime home 只读观察 | 外部仓库验收不属于本切片 |

## Source Inventory

### dot-codex

- `skills/mcu-agentd-hardware-ops/` 已从源仓库删除，连同 `agents/openai.yaml` 一并移除。
- `skills/README.md` 不再列出该私有 Skill；`.gitignore` 不再为其提供跟踪白名单。
- `config.toml` 不再登记 `/Users/ivan/Projects/Ivan/mcu-agentd` 的专属 trusted 项目。
- `docs/specs/retire-legacy-service-manager/{SPEC.md,IMPLEMENTATION.md}` 与 `docs/specs/6s9b8-retire-legacy-service-manager/{SPEC.md,IMPLEMENTATION.md}` 保留 zellij、Storybook、端口治理和历史 rollout 内容，不再要求已删除的硬件 Skill 存在。

### agent-toolkit

- 公共 Skill 源仓库、成员清单和项目基础文档已由独立清退 PR 完成并合并；本仓库不推断其安装端是否已同步。

### style-playbook

- 现行主题、参考实现、项目快照和发现数据已由独立清退 PR 完成并合并；本仓库不推断其安装端是否已同步。

## Consumer Discovery

- `/Users/ivan/.codex/skills/mcu-agentd-hardware-ops` 是运行 home 中的既有安装残留；本切片未修改、同步或删除 runtime home。
- 公共 Skill 的安装链接和 style-playbook 安装内容仍需与各自源头结果分别观察和报告；它们不是源仓库合并结果的替代证明。
- 源头清退与本机生效是不同结果。本仓库只读观察结果必须单独记录，不能表述为已完成部署。

## Verification

- 主题规范使用 `python3 bin/spec_contract_check.py --path docs/specs/mcu-agentd-retirement/SPEC.md` 验证；受影响的两个旧服务规格也分别通过同一契约检查。
- `skills/spec-sync/scripts/spec_drift_check.sh` 使用三个显式 `--spec-path` 和 `ADR_REFS=none` 验证规格同步。
- dot-codex 固定 candidate checks、`git diff --check`、TOML 解析、能力索引检查和旧名称变体搜索用于验证本仓库源头。
- 搜索结果按现行入口、必要历史事实和退役验收记录分类；不以排除整个文档目录来隐藏命中，也不运行旧 daemon、操作真实设备或调查消费项目工具链。

## Remaining Gaps

- runtime home 中的旧私有 Skill 仍可能存在；本主题不包含部署或同步操作。

## Related Changes

- None

## References

- [主题规范](./SPEC.md)
- [主题历史](./HISTORY.md)
