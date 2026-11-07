# 统一产品版本发布

## 首次启用前

本轮代码交付不执行真实发版。owner 必须准备专用 GitHub App 和可验证提交签名；不能以管理员临时直推 main 替代准备 PR。配置完成前，入口拒绝执行。

| 配置 | 所有者 | 用途 |
| - | - | - |
| `RELEASE_APP_ID` variable | 仓库维护者 | 安装在本仓库的 App 身份 |
| `RELEASE_APP_PRIVATE_KEY` secret | 仓库维护者 | 短期 installation token，contents / pull_requests / issues 最小读写权限 |
| `RELEASE_GPG_PRIVATE_KEY` secret | 签名维护者 | ephemeral runner 导入的发布签名私钥；必须支持非交互签名 |
| `RELEASE_GPG_KEY_ID` variable | 签名维护者 | GitHub 能验证的 GPG 签名身份 |
| `RELEASE_SIGNING_EMAIL` variable | 签名维护者 | 与 GitHub 已验证签名身份相符的提交邮箱 |

main 必须要求 PR、签名提交与仓库 quality-gates 声明的检查。release-ledger 必须禁止删除和非快进、要求签名，只有授权发布者可追加；初次 reservation 可原子创建空缺 ref。正式 v* tags 必须禁止更新与删除。权限不足、配置不完整或规则无法核验时 fail closed，不修改平台配置作为自动补救。

## 新发布

从 main 运行 Manual Release，只填写一个 release_target：patch、minor、major 或完整 final/prerelease 版本。不支持 build metadata。首次没有合法 completed final baseline 时必须填写完整版本；历史 connector-v* tag 不自动转换为产品 baseline。

工作流占用唯一身份并创建版本准备 PR；按正常质量门禁审核与合并，随后从 main 运行 Release，传入已有 reservation ID。入口自动读取准确合并 SHA，检查源码在准备期间没有混入业务改动。没有显式 target 时不得默认 patch。

Server/Worker 的 Linux amd64、Go 和 TS 两种客户端各自的 macOS arm64 / Linux amd64、Web 均为必需产物。TS 包携带完整 toolkit/native 资源，无需源码仓库；需要 Node 22 或 24。包内 --version 报告构建版本和 SHA，正式程序拒绝运行配置覆盖身份。

服务端包包含候选文件与离线 OCI images，images/images.json 绑定 archive SHA256 和 OCI manifest digest。安装工具必须验证后导入原 OCI 内容；不得通过生产机器重建获取镜像。预览 candidate schema 2 的既有晋级验证保持有效，产品级发布 manifest 额外绑定完整组件集合及版本。

## 完成与恢复

以 ledger 身份、最终 merge SHA、发布 manifest、全部下载 digest 和 completion 共同判定完成。Release 页面或 tag 单独存在不算完成。公开成功但 completion 未写入时重新运行同一身份，验证后补记，不分配后继版本。

| 故障 | 处理 |
| - | - |
| 准备分支已推送但 ledger 未推进 | 对账确定性分支、签名、parent 和版本投影 tree，复用原准备身份 |
| 上传响应丢失 | 查询原 draft 资产并下载验证，同内容复用；不同内容阻断 |
| 上传部分完成 | 复用原 frozen inventory，补齐剩余原件；优先原构建 run，已持久资产可直接复用 |
| 原构建 artifact 过期 | 从 draft 复核已持久资产；缺失冻结原件阻断，不重建 |
| Release 已公开但 completion 丢失 | 查询原 tag、SHA 与资产集合，通过后补记 |
| tag 或资产被另一身份占用 | 停止，不改写、不自动选择 successor |
| 通知失败 | 独立记录失败，重跑通知流程；不修改发布或部署结果 |
| 显式终止 | 有权限维护者使用同一 policy 终止并记录原因，保留墓碑和历史版本占用 |

正式发布资产、manifest 与校验和长期保留；未完成发布的冻结原件保留至恢复完成或显式终止。Actions retention 仅是传输窗口。

## 失败通知与兼容性

独立 Release Failure Notification 工作流从可信默认分支执行，只将失败 run 的身份附件作为数据读取。按 release identity 更新 GitHub Issue；reservation 前失败使用 workflow run 身份，不能编造产品版本。通知渠道为 owner 明确确认的 GitHub Issue，由仓库维护者管理；不引入外部 notifier secret。正文仅包含 identity、阶段、run、SHA/attempt 和恢复信息，不包含凭据及本地路径。

首批联网保证同版本。Go 客户端、Web 与后续 TS 联网适配使用 /version 与 X-Loomhelm-Version；REST、MCP、事件和 gateway 服务端门禁拒绝缺失或不兼容版本。拒绝返回 426 / PRODUCT_VERSION_INCOMPATIBLE，不产生业务副作用。TS 本地模式不依赖联网版本。跨版本放行必须另有明确合同与矩阵验证，不凭 SemVer 的 major/minor 推断兼容。

## 验收边界

PR 的 Product Release Contract 覆盖版本规则、实际裸 Git CAS、状态机和故障注入；Product Package 的 Linux/macOS 任务观察冻结包及 Node 22/24 运行。真实 GitHub publication、Issue 投递、权限和恢复演练必须在实际 Merge Receipt 与 owner 首发 target 授权后完成；本地模拟不能替代。
