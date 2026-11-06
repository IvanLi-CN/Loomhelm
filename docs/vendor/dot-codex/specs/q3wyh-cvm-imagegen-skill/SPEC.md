# CVM imagegen fallback skill

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- 系统 `/Users/ivan/.codex/skills/.system/imagegen/SKILL.md` 的 fallback CLI 路径默认围绕 `OPENAI_API_KEY` 与官方 OpenAI endpoint 组织，不适合直接用于当前仓库已有的 CVM OpenAI-compatible provider。
- 当前仓库已经有 `CVM_API_KEY` 与 `https://vibe-code.ivanli.cc/v1` 的 provider 事实，但缺少一个显式、本地、可维护的 image fallback skill 入口。
- 直接修改系统 `.system/imagegen` 会让后续更新难以维护，也违背“系统 skill 不作为本仓长期策略承载层”的规则。

## 目标 / 非目标

### Goals

- 新增一个独立的 `cvm-imagegen` skill，作为显式调用的 CLI fallback 能力。
- 固定该 skill 的 live client 配置为 `CVM_API_KEY` 与 `https://vibe-code.ivanli.cc/v1`。
- 复用官方 fallback CLI 的接口心智，保留 `generate`、`edit`、`generate-batch` 与核心参数名。
- 明确文档边界：普通生图仍优先用 built-in `image_gen`，只有显式需要自定义 BaseURL 的 CLI 路径才使用本 skill。

### Non-goals

- 不修改系统 `imagegen` skill 或其脚本。
- 不把 `cvm-imagegen` 做成 built-in `image_gen` 的自动替身。
- 不重新设计图片 prompt taxonomy、透明背景策略或 OpenAI Images API 参数契约。
- 不改动仓库全局 provider 配置或 remote/model routing。

## 范围（Scope）

### In scope

- `skills/cvm-imagegen/SKILL.md`
- `skills/cvm-imagegen/scripts/image_gen.py`
- `skills/cvm-imagegen/references/cli.md`
- `skills/cvm-imagegen/references/image-api.md`
- `skills/README.md` 的新 skill 发现入口

### Out of scope

- `/Users/ivan/.codex/skills/.system/imagegen/**`
- built-in `image_gen` tool 的行为
- plugin marketplace 暴露或安装流
- 额外的 prompt/reference 套件复制

## 需求（Requirements）

### MUST

- `cvm-imagegen` 必须是独立 skill，而不是对系统 `imagegen` 的原地覆盖。
- 该 skill 必须只承载显式 CLI fallback，不得声称会自动接管 built-in `image_gen` 路由。
- live API 调用必须使用 `CVM_API_KEY` 和 `https://vibe-code.ivanli.cc/v1`。
- CLI 必须支持 `generate`、`edit`、`generate-batch` 三个子命令。
- CLI 必须尽量复用官方 fallback 的参数形状、输出路径约定和 dry-run 语义。
- `--dry-run` 必须在缺少 `CVM_API_KEY` 时仍可工作。
- 非 dry-run 执行在缺少 `CVM_API_KEY` 时必须给出准确的 CVM 专属报错。
- 文档必须明确 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL` 不属于该 wrapper 的运行时契约。
- `skills/README.md` 必须出现 `cvm-imagegen` 的可发现条目。

### SHOULD

- 实现应采用薄包装，而不是复制整份系统 fallback 逻辑。
- 参考文档应聚焦 CLI 用法与 API 参数，不重复无关的 built-in 流程说明。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- `cvm-imagegen` 通过本仓 `skills/cvm-imagegen/scripts/image_gen.py` 作为唯一 CLI 入口。
- wrapper 在运行时加载系统 imagegen fallback 脚本，并只覆写：
  - API key 检查
  - 同步 OpenAI client 构造
  - 异步 OpenAI client 构造
- 其余参数解析、payload 构造、文件输出、batch 并发、prompt augmentation 与透明背景相关校验沿用系统 fallback 逻辑。
- `generate`、`edit`、`generate-batch` 的命令形状和核心 flags 保持兼容。

### Edge cases / errors

- 当 `CODEX_HOME` 未设置时，wrapper 默认回退到 `~/.codex` 查找系统 imagegen fallback 脚本。
- 当系统 fallback 脚本不存在或无法加载时，wrapper 必须直接报错并退出。
- 当 `CVM_API_KEY` 缺失且不是 dry-run 时，wrapper 必须阻止 live API 调用。
- 当 `CVM_API_KEY` 缺失但处于 dry-run 时，wrapper 只给 warning，不中断 dry-run。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `skills/cvm-imagegen` | skill | internal | New | `skills/cvm-imagegen/SKILL.md` | codex-global | owner / agents | 显式 CLI fallback 入口 |
| `skills/cvm-imagegen/scripts/image_gen.py` | CLI wrapper | internal | New | `skills/cvm-imagegen/references/cli.md` | codex-global | owner / agents | 复用系统 fallback 逻辑并固定 CVM client |
| `CVM_API_KEY` | environment variable | internal | New | `skills/cvm-imagegen/SKILL.md` | runtime env | wrapper CLI | live API 调用凭证 |

### 契约文档（按 Kind 拆分）

- `skills/cvm-imagegen/SKILL.md`
- `skills/cvm-imagegen/references/cli.md`
- `skills/cvm-imagegen/references/image-api.md`

## 验收标准（Acceptance Criteria）

- Given owner 明确调用 `$cvm-imagegen` When 查看 `SKILL.md` Then 可以明确看到它是独立 skill、仅用于显式 CLI fallback、且固定使用 `CVM_API_KEY` 与 `https://vibe-code.ivanli.cc/v1`

- Given 执行 `python3 skills/cvm-imagegen/scripts/image_gen.py generate --dry-run ...` When 环境中缺少 `CVM_API_KEY` Then 命令仍然可以完成 dry-run 并打印 payload

- Given 执行非 dry-run 的 live command When 环境中缺少 `CVM_API_KEY` Then 命令必须以 CVM-specific 报错失败，而不是要求 `OPENAI_API_KEY`

- Given 执行 wrapper CLI When 使用 `generate`、`edit`、`generate-batch` Then 三个子命令都能正确解析并沿用官方 fallback 的核心 flags

- Given 查看 `skills/README.md` When 搜索 `cvm-imagegen` Then 可以发现该 skill，且描述与“显式自定义 BaseURL image fallback”一致

## 验收清单（Acceptance checklist）

- [x] 独立 skill 路径已建立。
- [x] CLI wrapper 已固定 `CVM_API_KEY` 与 `https://vibe-code.ivanli.cc/v1`。
- [x] dry-run 与缺失 key 的运行时边界已明确。
- [x] skills 索引已补充新入口。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 /Users/ivan/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/cvm-imagegen`
- `python3 skills/cvm-imagegen/scripts/image_gen.py --help`
- `python3 skills/cvm-imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/cvm-imagegen-test.png --dry-run`
- `python3 skills/cvm-imagegen/scripts/image_gen.py edit --image /tmp/cvm-imagegen-test.png --prompt "Test" --out /tmp/cvm-imagegen-edit.png --dry-run`
- `python3 skills/cvm-imagegen/scripts/image_gen.py generate-batch --input /tmp/cvm-imagegen-prompts.jsonl --out-dir /tmp/cvm-imagegen-batch --dry-run`
- `env -u CVM_API_KEY python3 skills/cvm-imagegen/scripts/image_gen.py generate --prompt "Test" --out /tmp/cvm-imagegen-live.png`

### Quality checks

- `git diff --check`
- `rg -n "CVM_API_KEY|vibe-code.ivanli.cc/v1|generate-batch|OPENAI_API_KEY" skills/cvm-imagegen`

## Visual Evidence

None

## Related PRs

- None

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：系统 imagegen fallback 若未来重命名内部 helper，wrapper 需要同步调整 monkeypatch 点位。
- 风险：该 skill 依赖系统 fallback 脚本仍存在于 `CODEX_HOME/skills/.system/imagegen/scripts/image_gen.py`。
- 假设：`https://vibe-code.ivanli.cc/v1` 对外保持 OpenAI Images API 兼容。

## 参考（References）

- `/Users/ivan/.codex/skills/.system/imagegen/SKILL.md`
- `/Users/ivan/.codex/skills/.system/imagegen/scripts/image_gen.py`
- `skills/README.md`
