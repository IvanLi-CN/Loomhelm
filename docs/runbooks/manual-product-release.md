# 统一产品版本发布

## 首次启用前

发布只使用现有认证：Actions 内使用 GitHub 提供的短期 `GITHUB_TOKEN`；主机上的 owner 操作使用已登录的 `gh`。不要求新增 App、私钥 Secret、独立签名身份或 Rulesets。main 现有的 PR、签名、管理员约束、strict required checks 由只读审计核验；任何无法读取的事实均报告为未知，不能当成未配置。

`scripts/product-release audit` 只读核验 main 保护，不创建 reservation、分支、提交或 Release，也不读取 Secret 内容。owner 使用现有 gh 登录时，审计核验完整保护配置；CI 内置令牌仅核验可读取的 protected 与 required contexts，完整配置明确标为 owner-audit-required，不伪装已验证。发布入口另外逐项核验实际 source 的签名、已合并 main PR 及精确 SHA 的成功检查。该审计不证明发布写权限或真实发布已成功。

GitHub 原生 `createCommitOnBranch` 为发布记录和版本投影生成平台签名；`expectedHeadOid` 将提交创建与 ref 前移绑定为一个原子操作。签名不可用、提交身份不符或 CAS 冲突时停止，不能降级为无签名写入。仓库访问控制仍有效，操作不设置 bypass、不强推、不修改平台规则。已有版本标签指向其他 SHA 时停止，不覆盖或重建。

## 新发布

从 main 运行 Manual Release，只填写一个 release_target：patch、minor、major 或完整 final/prerelease 版本。不支持 build metadata。首次没有合法 completed final baseline 时必须填写完整版本；历史 connector-v* tag 不自动转换为产品 baseline。

工作流占用唯一身份并生成签名版本准备分支；保留仓库当前禁止 Actions 创建 PR 的设置。owner 或已获授权的 agent 用现有 gh 身份打开普通版本准备 PR，链接由 Actions summary 提供。按正常质量门禁审核与合并，随后从 main 运行 Release，传入已有 reservation ID。入口自动读取准确合并 SHA，检查源码在准备期间没有混入业务改动。没有显式 target 时不得默认 patch。

Server/Worker 的 Linux amd64、Go 和 TS 两种客户端各自的 macOS arm64 / Linux amd64、Web 均为必需产物。TS 包携带 TypeScript 源码、完整 toolkit、依赖与 Bun FFI 资源，无需源码仓库；仅支持固定 Bun 1.4.4，保留主干 ADR 0021 的源码运行合同，不再支持 Node。Bun 根 lock 不保存根包版本，冻结安装验证依赖一致性；package.json 与包内源码 stamp 负责产品版本投影。包内 --version 报告构建版本和 SHA，正式程序拒绝运行配置覆盖身份。

服务端包在 candidate/ 子目录保留原 schema 2 bundle，images/ 子目录保存离线 OCI images，images/images.json 绑定 archive SHA256 和 OCI manifest digest。安装工具必须验证后导入原 OCI 内容；不得通过生产机器重建获取镜像。预览 candidate schema 2 的既有晋级验证保持有效，产品级发布 manifest 额外绑定完整组件集合及版本。

## 完成与恢复

以 ledger 身份、最终 merge SHA、发布 manifest、全部下载 digest 和 completion 共同判定完成。Release 页面或 tag 单独存在不算完成。公开成功但 completion 未写入时重新运行同一身份，验证后补记，不分配后继版本。

| 故障 | 处理 |
| - | - |
| 准备分支已推送但 ledger 未推进 | 对账确定性分支、签名、parent 和版本投影 tree，复用原准备身份 |
| 上传响应丢失 | 查询原 draft 资产并下载验证，同内容复用；不同内容或额外未登记资产阻断 |
| 上传部分完成 | 复用原 frozen inventory，补齐剩余原件；优先原构建 run，已持久资产可直接复用 |
| 原构建 artifact 过期 | 从 draft 复核已持久资产；缺失冻结原件阻断，不重建 |
| Release 已公开但 completion 丢失 | 查询原 tag、SHA 与资产集合，通过后补记 |
| tag 或资产被另一身份占用 | 停止，不改写、不自动选择 successor |
| 通知失败 | 独立记录失败，重跑通知流程；不修改发布或部署结果 |
| 显式终止 | 开始公开前可取消并保留墓碑；公开意图已写入后只能恢复完成，不再允许终止 |

正式发布资产、manifest 与校验和长期保留；未完成发布的冻结原件保留至恢复完成或显式终止。Actions retention 仅是传输窗口。

## 失败通知与兼容性

独立 Release Failure Notification 工作流从可信默认分支执行，只将失败 run 的身份附件作为数据读取。按 release identity 更新 GitHub Issue；reservation 前失败使用 workflow run 身份，不能编造产品版本。通知渠道为 owner 明确确认的 GitHub Issue，由仓库维护者管理；不引入外部 notifier secret。正文仅包含 identity、阶段、run、SHA/attempt 和恢复信息，不包含凭据及本地路径。

首批联网保证同版本。Go 客户端、Web 与后续 TS 联网适配使用 /version 与 X-Loomhelm-Version；REST、MCP、事件和 gateway 服务端门禁拒绝缺失或不兼容版本。拒绝返回 426 / PRODUCT_VERSION_INCOMPATIBLE，不产生业务副作用。TS 本地模式不依赖联网版本。跨版本放行必须另有明确合同与矩阵验证，不凭 SemVer 的 major/minor 推断兼容。

## 验收边界

PR 的 Product Release Contract 覆盖版本规则、实际裸 Git CAS、状态机和故障注入；Product Package 的 Linux/macOS 任务观察冻结包及 Bun 1.4.4 源码运行和实际 FFI 行为。真实 GitHub publication、Issue 投递、权限和恢复演练必须在实际 Merge Receipt 与 owner 首发 target 授权后完成；本地模拟不能替代。

## Ledger 状态兼容

[状态迁移记录](release-ledger-state.json) 声明无 ref 到 schema 1 的初始化、受支持状态、暂停点与前向恢复边界。未知 schema 拒绝读取；旧版本只支持自己声明的 schema，不自动降级或清空 reservation。

## 部署准备与离线导入

`GITHUB_REPOSITORY=IvanLi-CN/Loomhelm scripts/deploy-product --identity <reservation> --directory <installation-staging-dir>` 只接受签名 ledger 中 completed 且公开的身份，下载并逐项验证完整冻结产物。已有文件 digest 冲突即停止。此步骤使用现有只读 GitHub 权限核验平台签名、发布记录与资产，不需要本地签名私钥。

在已授权部署主机追加 `--import-images` 会用 skopeo 导入原 OCI archive，核对导入后的 image ID，并生成兼容现有 schema 2 candidate 的 deployment envelope。离线运行使用不可变 `sha256:<config-digest>` 镜像 ID；原 OCI manifest digest 另行保留。正式程序直接使用编译版本，不再把 source SHA 当作运行版本覆盖。此工具只生成 stage/import 回执，不执行 slot promotion，也不能把本地导入回执当作生产部署成功。

PR 包场景使用明确标记的 `0.0.0-ci` 合成版本与零身份检验正式门禁；它不占用产品版本、不成为 baseline，并被公开入口拒绝。

浏览器 OIDC start/callback 与 device verify 是窄范围认证导航，由原有 OIDC state、device code 与 CSRF 校验处理，不能携带 fetch 自定义头，也不被判为兼容业务连接。所有 session、REST 业务、MCP、事件及 Go gateway 请求仍必须通过产品版本门禁；不能用认证导航例外绕过业务路径。

服务端包附带同版本、同 SHA 的 `bin/loomhelm-migrate`，OCI 内对应路径为 `/loomhelm-migrate`。初始数据库仍遵循既有 approval-history 的 prepare → backfill → validate → indexes → cutover 顺序；工具不改变数据库/journal schema，不在正式部署中自动越过暂停点。成品测试仅对一次性空数据库执行这些既有步骤后观察 Server/Worker readiness。

持久冻结前先追加 staged inventory（固定期望 digest 与原构建 run，接续已禁止重建）。逐项上传、下载核验后才追加 frozen；因此 frozen 的每个原件都已有长期 draft asset 副本，不依赖 Actions retention。staged 中尚未持久化的原件若丢失，仍必须阻断并报告损失，不能以重新构建补齐。

构建矩阵开始前，签名 ledger 用 CAS 固定唯一 Actions run/attempt；重新运行同一个 run 的另一 attempt 也只能下载原 run 的成品，不得重新构建。若中断发生在 inventory 固定前，恢复仅用这些原始 archive 生成 manifest 和校验和。缺少任何原包都必须阻断。发布 policy hash 同时覆盖 release-contract 与 quality-gates，准备期间变更门禁也会拒绝接续。

全部资产复核后，公开 API 调用前先以 CAS 写入不可撤销的公开意图。取消先赢得 CAS 时不会公开；公开意图先写入后禁止取消，即使公开请求结果未知也只能沿原版本、SHA 和 digest 对账完成。该边界不把意图记为已公开或已完成。

部署 stage 回执只允许首次创建或逐字相同的复用，拒绝 symlink 与不同结果覆盖。需要改变 stage/import 模式时使用新的输出目录，保留旧回执。普通 candidate/preview 始终使用 dev 构建身份；只有绑定 reservation 的正式包构建器显式注入产品版本，避免根 VERSION 已投影后影响预览。

## 身份记录初始化与审计

首次初始化以已验证 main 提交作为 Git 分支种子，以原子 create-ref 占用 `release-ledger`，然后用精确旧 head 追加 ledger.json。创建 ref 后中断可复用空种子，不重建另一个身份；竞争者必须重新读取。读取逐项验证发布提交的平台签名、author、单 parent、仅 ledger.json 的变更和 JSON 追加语义。存在产品 Release 或版本准备分支却缺失 ledger 时阻断，要求恢复记录，不能当作全新产品重新开始。

GitHub 原生提交接口的签名与 CAS 行为依据 [createCommitOnBranch](https://docs.github.com/en/enterprise-cloud@latest/graphql/reference/commits)。内置令牌创建 PR 后的检查审批行为依据 [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)；本项目保留现有 owner 创建 PR 路径，不为减少人工步骤新增凭据或更改仓库设置。
