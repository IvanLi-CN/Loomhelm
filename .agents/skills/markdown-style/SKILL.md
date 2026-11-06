---
name: markdown-style
description: "Apply one-line Markdown paragraphs with pinned native dprint, safe staged Lefthook fixes, and matching CI checks."
schema_version: 1
kind: policy-skill
slug: markdown-style
primary_topic: markdown-style
policy_dependencies: []
visibility: public
public_url_hosts:
  - github.com
  - dprint.dev
  - lefthook.dev
---

# Markdown style

当项目需要统一 Markdown 正文排版、提交前修复或 CI 样式检查时使用本 Policy。自然段保持一行，结构由空行、列表、表格、代码块和显式硬换行表达；作者意图中的独立段落应使用空行分隔。

## Workflow

1. 检查目标项目的 Markdown 范围、现有 formatter、Git hook 管理器、CI 和用户改动。首批范围为 Git 跟踪的 `.md`，formatter 使用官方 dprint Markdown 插件，不新增正文最大行宽。
2. 预览项目 Policy 安装和工具接入变更。将 `assets/templates/markdown.py` 与 `lefthook.sh` 放到目标项目的 `tools/`，采用 `dprint.json` 配置；将 Lefthook 示例中的 Markdown job 合并到现有配置，不覆盖既有 hook、其他 job 或本地设置。在 `.gitignore` 中加入 `/.tmp/markdown-tools/`。
3. 用 `python3 tools/markdown.py setup` 准备固定的原生工具与 Wasm；清单和 SHA256 来自 `assets/toolchain.json`。只有显式选择 `setup --install-hooks` 才安装 hook。遇到已有 `core.hooksPath` 或非本 Policy 管理的 pre-commit hook 时，保留它并完成可审查的手工集成。
4. 在提交阶段使用 Lefthook 的 `stage_fixed: true` 与原生部分暂存备份/隐藏/恢复机制。通过 `staged` 只修复已暂存 Markdown。工具或插件缺失时提示初始化，提交阶段不下载；无 Markdown 的提交跳过 formatter。
5. CI 先执行普通 `setup`，再执行 `check`。使用项目已有 job 和 required check 名称，不自动重写分支保护。用真实 Git 暂存场景验证未暂存修改、无关文件和既有 stash 保留；失败或恢复冲突时停止提交并处理原生恢复材料。
6. 用 `fix` 建立独立的机械格式化提交。核对 frontmatter、代码内容、文档解析和公开导出，修正生成模板，使重新生成后仍能通过 `check`。记录冷/热运行耗时，性能证据来自实际执行而不是工具名称。

## Formatting contract

`textWrap: never` 保持自然段单行；中文软换行还需要 `wrapUnspacedScripts: true`，否则仅设置 never 仍可能保留换行。英文换行合并为空格，连续中文合并时不插入空格，混合正文遵循官方插件的词边界规则。

表格使用紧凑的 `table.cellPadding: space`；代码块跳过内嵌 formatter 并保留缩进与空行，HTML 同样跳过。显式硬换行统一成可见的反斜杠，保留原有换行语义。工具采用 LF；frontmatter 不接入 YAML formatter。不通过 `lineWidth` 推导正文需要按列宽拆行。

`check` 只读检查跟踪的 Markdown，失败展示差异；`fix` 修复同一集合。首次创建的未暂存文档需要先纳入 Git 跟踪；故意不合规的测试输入使用字符串或非 Markdown fixture。配置与包装脚本维护在项目中，工具实现与清单由安装的 Policy 提供，不依赖提供方仓库的其他 Python 模块。

Git 路径按 NUL 分隔读取，并对 dprint CLI 的 glob 字符转义和锚定。离线 Lefthook 包装启用字面 Git pathspec，避免重新暂存方括号等文件名时选中未跟踪的匹配文件；接入其他 job 时应检查其是否依赖 Git glob。原生 dprint 将反斜杠视为路径分隔符，含反斜杠的文件名会在写入前明确拒绝，需要先重命名。

提交前的包装先校验 Lefthook 摘要，并检查既有恢复材料。若 `git stash list` 中存在以 `lefthook auto backup` 开头的原生备份消息，或 `git rev-parse --git-path info` 定位的目录存在 `lefthook-unstaged.patch` / `lefthook-unstaged-all.patch`，立即停止，保留索引、工作区、stash 和 patch。先另行保存并核对这些材料，确认恢复完毕后再显式清理对应项；包装不自动 apply、drop 或覆盖它们。该检查避免固定版本原生 runner 清理旧同名备份或覆盖旧 patch。

包装在恢复材料检查前取得 Git info 目录中的 `markdown-style.lock` 文件锁，并持有至原生 runner 完成。该目录与 stash 在 linked worktree 间共享；并发 hook 会在修改任何恢复材料前停止，提示等待另一提交完成后重试。操作系统在进程退出时释放锁，保留的锁文件不表示仍有提交运行，不需要手工删除；锁文件不能是符号链接。其他 hook 管理器手工接入时，必须通过本包装运行 Lefthook，才能维持同一互斥边界。

原生 Lefthook 保存全量恢复 patch 时使用分离的 `git diff --output <路径> --` 参数；共享 patch 位于 linked worktree 外时，Git 的早期无索引检测会误将它识别为比较路径。初始化同时准备本包的 Git 兼容入口，hook 按源文件摘要核对后仅在子进程 PATH 中使用；它将 `diff` 的该参数改为等价的 `--output=<路径>`，其余参数直接交给原生 Git。入口不解析 Markdown，不实现 stash 或恢复，不影响用户 shell 的 Git，缺失或改变时要求重新初始化。

暂存选择覆盖新增、复制、修改、重命名及 `T` 类型变更。Lefthook job 使用包含这些状态的 `files` 命令与 `{files}` 元数据，以便原生 `stage_fixed` 能跟踪类型变更；formatter 的实际选集仍由 NUL 分隔的 Git 输出决定。符号链接转为普通 Markdown 会修复后重新暂存，转为符号链接则明确停止并保留索引和链接目标。

## Adoption preview

在目标项目预览 `.agents/skills/markdown-style/` 与 `skills-lock.json` 的写入，并取得明确批准后，使用 `npx skills add IvanLi-CN/style-playbook-skills --skill markdown-style --yes`。CLI 负责选择标准项目安装面。本 Policy 不自行安装其他 Policy，也不把已有模板复制到未经批准的项目。

当前提供方仓库的薄包装直接使用 `skills/policies/markdown-style/` 源包；这属于实现复用，不构成目标项目 Policy 安装对齐证明。其他项目使用标准安装面，包装脚本支持该路径。

## Package resources

- `assets/scripts/markdown.py`：仅依赖 Python 标准库的初始化、文件选择及原生 formatter 调用。
- `assets/scripts/git-compat.py`：供原生 Lefthook 使用的 Git 参数兼容入口，保持 linked worktree 的恢复 patch 写入有效。
- `assets/toolchain.json`：macOS/Linux arm64/x86_64 的固定官方 Release URL、版本和 SHA256。
- `assets/templates/`：项目包装、离线 Lefthook 入口、Markdown 配置、Lefthook job 与 CI step 示例。
- [dprint CLI](https://dprint.dev/cli/) 和 [Lefthook stage_fixed](https://lefthook.dev/configuration/stage_fixed/)：原生工具行为参考。
