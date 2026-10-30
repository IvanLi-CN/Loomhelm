# V01 Loomhelm 一期联合验收

本手册定义 V01 联合验收的可重复证据流程，目标是把一次候选的源码 SHA、候选 digest、命令尝试、脱敏日志和明确的未通过边界放进同一份账本；它不是把尚未具备真实环境的验收项标成通过。

验收必须从 `feat/phase1` 的干净候选提交开始，并在会话专属 Agent VM 中运行数据库、Docker/Compose、候选构建和重型测试；本机不启用 Docker，也不接管其他工作树的监听端口。

## 验收范围

账本覆盖 PRD 中的 `AC-LH-001` 到 `AC-LH-013`，每项状态只能是 `passed`、`reused`、`failed`、`blocked` 或 `not_run`。

`passed/current` 只表示本账本记录的命令或证据与当前源码 SHA 和当前候选 digest 同时绑定；`reused` 只能表示外部已有记录被引用，不能替代当前候选的独立通过证明。

`AC-LH-005` 必须使用同一个 Desktop 活跃会话的真实 thread 和 turn；历史记录、fork、copy、另一个 app-server 进程或仅有 Web 会话都不满足该项。

`AC-LH-010` 的 PWA 安装必须由真实浏览器安装流程证明；已有 service worker、manifest、离线 reducer 或构建产物不能代替实际安装与更新证据。

`AC-LH-011` 的 control-only rehearsal 只能证明控制合同和证据格式；完整运行时蓝绿切换仍需在 VM 中拥有四个当前租约端口、候选镜像、Server/Worker readiness、drain、generation fencing 和恢复记录。

## 准备

确认当前工作树的父分支和提交身份：

```sh
git status --short
git branch --show-current
git rev-parse HEAD
git show -s --format='%H %s' HEAD
```

先按 `$agent-vm` 完成 `doctor`、`status` 和带稳定 `AGENT_VM_SESSION_ID` 的 `acquire`，再从当前工作树同步源码：

```sh
export AGENT_VM_SESSION_ID=loomhelm-v01
bun "/Users/ivan/.agents/skills/agent-vm/scripts/agent_vm.ts" doctor
bun "/Users/ivan/.agents/skills/agent-vm/scripts/agent_vm.ts" status
bun "/Users/ivan/.agents/skills/agent-vm/scripts/agent_vm.ts" acquire
bun "/Users/ivan/.agents/skills/agent-vm/scripts/agent_vm.ts" sync --name loomhelm-v01
```

在 VM 内检查 `go version`、`bun --version`、`docker version` 和 `docker compose version`，只按仓库锁定版本准备缺失依赖；不要用浮动版本替换 `tools/versions.env` 的合同。

## 建立候选账本

在 VM 的同步工作树中使用当前完整提交 SHA 构建一次候选，输出目录必须是新的绝对路径；构建完成后不得重建候选来“修复” promotion 或蓝绿结果。

```sh
cd /workspace/worktrees/loomhelm-v01/src
source_sha=$(git rev-parse HEAD)
candidate_dir=/workspace/evidence/loomhelm-v01/candidate
scripts/build-candidate --source-sha "$source_sha" --output "$candidate_dir"
mkdir -p /workspace/evidence/loomhelm-v01/acceptance
scripts/accept-v01 init \
  --evidence-dir /workspace/evidence/loomhelm-v01/acceptance \
  --source-sha "$source_sha" \
  --parent-branch feat/phase1 \
  --candidate-manifest "$candidate_dir/candidate-manifest.json"
```

`init` 会拒绝脏工作树、非当前 HEAD、候选清单源码 SHA 不一致或同一账本的身份漂移；清单中的 `candidate.digest`、清单 SHA-256 和源码 tree SHA 会写入 `ledger.json`。

## 运行当前证据

为数据库测试启动 VM 内的隔离 PostgreSQL，并将 `LOOMHELM_DATABASE_URL` 与 `LOOMHELM_POSTGRES_PORT` 配成同一个端口；测试使用随机 schema，不得指向个人或共享数据库。

API、浏览器认证、项目任务 CRUD、权限和 Server 重启持久化使用真实应用集成测试：

```sh
scripts/accept-v01 run \
  --evidence-dir /workspace/evidence/loomhelm-v01/acceptance \
  --check-id AC-LH-001 \
  --name server-browser-auth-crud \
  --timeout 600 -- \
  go test -count=1 ./internal/app -run '^TestServerBrowserAuthenticationAndCRUD$'
```

官方 MCP SDK、artifact authorization、原始文件字节和私有 artifact 隐藏使用真实下载集成测试；该测试不等价于完整产品闭环：

```sh
scripts/accept-v01 run \
  --evidence-dir /workspace/evidence/loomhelm-v01/acceptance \
  --check-id AC-LH-008 \
  --name authorized-artifact-download \
  --timeout 600 -- \
  go test -count=1 ./internal/app -run '^TestServerAuthorizedArtifactDownloadStreamsOriginalBytesAndHidesPrivateArtifacts$'
```

同一条当前候选测试日志可以作为 `AC-LH-009` 的绑定证据引用，但必须写明它覆盖的是该测试实际断言的内容，不得把一次 artifact 下载测试扩展解释成全部未知事件和 sub-agent 内容：

```sh
scripts/accept-v01 reuse \
  --evidence-dir /workspace/evidence/loomhelm-v01/acceptance \
  --check-id AC-LH-009 \
  --status passed \
  --evidence /workspace/evidence/loomhelm-v01/acceptance/attempts/attempt-0002.stdout.log \
  --evidence-source-sha "$source_sha" \
  --evidence-candidate-digest "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["candidate"]["digest"])' "$candidate_dir/candidate-manifest.json")" \
  --reason 'Reuses the current artifact test log only for assertions directly covered by that test.'
```

控制合同 rehearsal 可以记录 `AC-LH-011` 的当前候选 control-only 证据，但报告必须保留 runtime skipped 的边界：

```sh
scripts/accept-v01 run \
  --evidence-dir /workspace/evidence/loomhelm-v01/acceptance \
  --check-id AC-LH-011 \
  --name blue-green-control-contract \
  --timeout 600 -- \
  scripts/rehearse-blue-green --control-only \
  --evidence-dir /workspace/evidence/loomhelm-v01/blue-green-control
```

如果运行完整蓝绿 rehearsal，先按 `$global-port-manager` 为当前工作树登记四个端口，并使用 `scripts/preview` 的现有 manifest、readiness、drain、Worker generation 和 recovery 流程；任何不满足的前置条件都用 `mark --status blocked` 记录，而不是改写 control-only 结果。

## 复用与阻塞

复用 E01 的历史 Connector/Codex 最小真实回路时，传入历史记录中的真实 `evidence-source-sha` 和 `evidence-candidate-digest`，状态使用 `reused`；路径只读，账本不会复制、修改或删除外部证据：

```sh
scripts/accept-v01 reuse \
  --evidence-dir /workspace/evidence/loomhelm-v01/acceptance \
  --check-id AC-LH-004 \
  --status reused \
  --evidence /absolute/path/to/e01-real-platform-c01-record.json \
  --evidence-source-sha <historical-source-sha> \
  --evidence-candidate-digest <historical-candidate-digest> \
  --reason 'Historical E01 real Connector record; not a current V01 candidate pass.'
```

无法在当前候选和授权环境中完成的项必须显式阻塞，尤其是 Desktop 活跃会话、实际 PWA 安装、完整三进程重启、完整 runtime blue-green 和全产品 Web/API/MCP 闭环：

```sh
scripts/accept-v01 mark --evidence-dir /workspace/evidence/loomhelm-v01/acceptance --check-id AC-LH-005 --status blocked --reason 'Active Desktop thread/turn evidence is unavailable.'
scripts/accept-v01 mark --evidence-dir /workspace/evidence/loomhelm-v01/acceptance --check-id AC-LH-010 --status blocked --reason 'Real browser PWA installation evidence is unavailable.'
scripts/accept-v01 mark --evidence-dir /workspace/evidence/loomhelm-v01/acceptance --check-id AC-LH-012 --status blocked --reason 'Full Web/API/MCP closure is not proven by the selected checks.'
```

`blocked` 是验收结论的一部分，不是失败重试的别名；只有补齐相同候选身份和真实环境证据后，才能追加新的尝试或 decision。

## 输出与关闭

同时生成 JSON 和 Markdown 报告，并检查日志中的命令、DSN、Bearer、token、secret 和 password 已脱敏：

```sh
scripts/accept-v01 report --evidence-dir /workspace/evidence/loomhelm-v01/acceptance --format json --output /workspace/evidence/loomhelm-v01/acceptance/V01.json
scripts/accept-v01 report --evidence-dir /workspace/evidence/loomhelm-v01/acceptance --format markdown --output /workspace/evidence/loomhelm-v01/acceptance/V01.md
```

将报告目录作为 owner-facing 证据保存，并在父线程消息中报告当前 `source_sha`、候选 digest、账本路径、各项状态、明确的 blocked/not_run 项和下一步；不要把外部 VM 证据目录提交进仓库。

本任务只新增验收脚本、文档和手动 workflow，不改变 Web/Storybook 渲染输入，因此 UI 视觉证据为“不适用”；不得用现有设计截图替代实际 PWA 安装或 Desktop 活跃会话证据。

验收完成后先执行 `bun "/Users/ivan/.agents/skills/agent-vm/scripts/agent_vm.ts" status`，确认没有仍需使用的命令或服务，再执行 `release` 并再次 `status`；只有确认租约、映射和 VM 清理完成，才能在交接中声称环境已关闭。

相关合同见 [一期项目规范](specs/phase1-core/SPEC.md)、[候选构建](candidates.md)、[蓝绿基线](blue-green-baseline.md) 和 [开发说明](development.md)。
