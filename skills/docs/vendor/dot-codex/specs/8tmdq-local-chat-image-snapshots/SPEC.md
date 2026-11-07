# 本地聊天图片快照存储

> 当前有效规范以本文为准；实现覆盖与当前状态见 `./IMPLEMENTATION.md`，关键演进原因见 `./HISTORY.md`。

## 背景 / 问题陈述

- Codex Desktop 对本地聊天图片按绝对文件系统路径渲染；一旦 agent 直接把可变工作文件路径写进 Markdown，后续同路径覆盖就会污染历史消息里的图片内容。
- 当前自定义 prompt / skill 栈没有定义“聊天图片必须先快照”的统一出口，导致 `preview.png`、repo 里的规范图片、临时截图文件都可能被直接拿去聊天回图。
- 如果继续允许 agent 直接引用这些可变路径，主人翻旧对话时看到的图片将不再是发送当时的状态，既影响验收，也会放大桌面端同路径缓存问题。

## 目标 / 非目标

### Goals

- 为 owner-facing 本地聊天图片引入统一的不可变快照 helper，默认落到 `$CODEX_HOME/user-inline-assets/`。
- 明确全局提示词、AGENTS 与相关 skills 的规则：聊天图片路径与 repo/spec/project 的规范图片路径分离。
- 确保 `user-inline-assets/` 被 git 忽略，不污染仓库状态。
- 保持首版实现简单可用：只新增快照，不做自动清理。

### Non-goals

- 不修改官方 Codex App 的缓存或渲染逻辑。
- 不迁移或修复旧聊天记录中的历史图片引用。
- 不实现自动 GC、按天数清理或按容量清理。
- 不改变 spec / plan / PR 里规范图片的既有落盘语义。

## 范围（Scope）

### In scope

- `bin/snapshot_local_image.py`
- `.gitignore`
- `instruction.md`
- `AGENTS.md`
- `skills/ui-visual-evidence/SKILL.md`
- `skills/storybook-screenshots/SKILL.md`
- `skills/firmware-display-preview/SKILL.md`
- `docs/specs/README.md`

### Out of scope

- `prompts/**` 的 flow / PR 文案结构
- 官方桌面应用代码
- 自动清理逻辑与后台守护进程

## 需求（Requirements）

### MUST

- owner-facing 本地聊天图片在 Markdown 回图前必须先复制成唯一快照，聊天里只能引用快照绝对路径。
- 快照根目录固定为 `$CODEX_HOME/user-inline-assets/`，并按 `repo_slug__repo_hash8/YYYY/MM/DD/` 分片。
- 快照文件名必须唯一、ASCII-safe，并保留源图扩展名的小写形式。
- helper 必须是字节复制语义；禁止 symlink、hardlink、覆盖已有快照或内容去重。
- repo/spec/project 的规范图片仍保留原路径语义，但不得再直接拿这些路径做聊天 Markdown 图片引用。
- `user-inline-assets/` 必须被 git 忽略。

### SHOULD

- helper 应该只依赖标准 `python3` 运行环境。
- repo 作用域应优先来自 `git rev-parse --show-toplevel`，不在 git repo 时再退回 `--cwd`。
- 相关 skills 的文案应给出同一条 helper 用法，避免不同 skill 各写一套口径。

## 功能与行为规格（Functional/Behavior Spec）

### Core flows

- 当 agent 需要在聊天里回传本地图片时：
  - 先准备好最终源图（例如规范 `assets/` 文件、裁剪后的 Storybook 图、固件 `preview.png`）；
  - 再运行 `python3 "${CODEX_HOME:-$HOME/.codex}/bin/snapshot_local_image.py" --source <image-path> --cwd <working-dir>`；
  - 使用返回 JSON 里的 `snapshot_path` 生成 Markdown 图片；
  - 原始工作文件继续留在原路径供项目/规范复用，但聊天只引用快照。
- helper 的默认路径规则：
  - 根目录：`$CODEX_HOME/user-inline-assets/`
  - repo scope：`<repo_slug>__<repo_hash8>/`
  - 日期目录：`YYYY/MM/DD/`
  - 文件名：`<utc_ts>-<safe_source_stem>-<rand8>.<ext>`

### Edge cases / errors

- 若源图不存在、不是文件或没有扩展名，helper 必须失败并给出明确错误，而不是生成不确定的聊天路径。
- 若当前 `--cwd` 不在 git repo 内，helper 仍可工作，但 repo 作用域退回到 `--cwd`。
- 若随机 token 恰好撞名，helper 必须重新生成路径；若调用者显式注入固定 token 且目标已存在，则应报错而不是覆盖。

## 接口契约（Interfaces & Contracts）

### 接口清单（Inventory）

| 接口（Name） | 类型（Kind） | 范围（Scope） | 变更（Change） | 契约文档（Contract Doc） | 负责人（Owner） | 使用方（Consumers） | 备注（Notes） |
| - | - | - | - | - | - | - | - |
| `snapshot_local_image.py` | script | internal | New | in-spec | Codex config repo | owner-facing local image flows | 输出 JSON，提供不可变快照路径 |
| Local chat image snapshot rule | prompt/skill rule | internal | Modify | in-spec | `instruction.md` + `AGENTS.md` | default agent + skills | 统一“聊天路径 != 工作路径” |
| Visual evidence / screenshot return contract | skill | internal | Modify | in-spec | `ui-visual-evidence`, `storybook-screenshots`, `firmware-display-preview` | UI / preview evidence flows | 所有本地聊天图片改用 helper |

### 契约文档（按 Kind 拆分）

- None. 本规格只涉及内部脚本与提示词/skill 契约，以上表和相应文件正文即为真相源。

## 验收标准（Acceptance Criteria）

- Given 同一张本地源图被连续快照两次 When helper 运行两次 Then 两次返回的 `snapshot_path` 必须不同，且都位于 `$CODEX_HOME/user-inline-assets/` 下。

- Given 源图在第一次快照后被同路径覆盖 When 再次读取第一次生成的快照文件 Then 第一次快照的字节内容必须保持不变。

- Given repo 路径或源图文件名包含空格或非 ASCII 字符 When helper 生成快照路径 Then 生成出来的 repo scope、日期目录和文件名都必须是 ASCII-safe。

- Given `ui-visual-evidence`、`storybook-screenshots` 或 `firmware-display-preview` 要把本地图片回给主人 When 按更新后的契约执行 Then 聊天里必须使用 helper 返回的 `snapshot_path`，而不是原始工作文件路径。

- Given `user-inline-assets/probe.png` When 运行 `git check-ignore -v` Then 结果必须显示该路径由仓库 `.gitignore` 忽略。

## 非功能性验收 / 质量门槛（Quality Gates）

### Testing

- `python3 bin/test_snapshot_local_image.py`
- `python3 bin/snapshot_local_image.py --help`
- `git diff --check`
- `git check-ignore -v user-inline-assets/probe.png`

### UI / Storybook (if applicable)

- Stories to add/update: None
- Docs pages / state galleries to add/update: None
- `play` / interaction coverage to add/update: None
- Visual regression baseline changes (if any): None

### Quality checks

- `rg -n "snapshot_local_image|user-inline-assets|snapshot_path" instruction.md AGENTS.md skills docs/specs/local-chat-image-snapshots`

## Visual Evidence

## 方案概述（Approach, high-level）

- 用一个轻量、可直接从 prompt/skills 调用的 Python helper 统一生成不可变聊天图片快照，避免不同 skill 自己拼路径。
- 让 repo/spec/project 的规范图片继续按既有路径落盘，再由 helper 复制出聊天专用快照，彻底切断“历史消息依赖可变工作文件”的耦合。
- 首版故意不做自动清理，优先保证历史聊天图片不会因为误删或复用路径而失真。

## 风险 / 开放问题 / 假设（Risks, Open Questions, Assumptions）

- 风险：若某个源图没有扩展名，helper 会失败；这是刻意的保守边界，避免生成桌面端不易识别的聊天图片路径。
- 风险：首版不清理快照目录，长期会积累文件；这是有意识地换取历史消息稳定性。
- 假设：owner-facing 本地聊天图片主要来自带明确扩展名的 PNG/JPG/WebP/GIF 等常见文件。

## 参考（References）

- `config.toml`
- `instruction.md`
- `AGENTS.md`
- `skills/ui-visual-evidence/SKILL.md`
- `skills/storybook-screenshots/SKILL.md`
- `skills/firmware-display-preview/SKILL.md`
