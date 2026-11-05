# 部署目录结构

本文区分 Git 仓库中的部署定义与安装目录中的发布产物。仓库保存源码、校验逻辑和 Compose 模板；安装目录保存不可变候选、Web 静态树、运行配置和持久化数据。安装目录不是源码 checkout，也不应通过手工修改候选文件来完成切换。

## 仓库结构

与部署相关的目录和入口如下：

```text
.
├── cmd/
│   ├── deployment-controller/   # 安装级部署控制器
│   ├── server/                  # HTTP/API/MCP Server
│   ├── worker/                  # River Worker 与对账作业
│   └── connector/               # 执行机器上的 Connector
├── deploy/
│   ├── dev/                     # 本地开发数据库
│   ├── example/                 # 通用单槽引导和数据库示例
│   ├── preview/                 # 可执行的分支预览蓝绿控制器
│   └── production/              # 安装级蓝绿生产模板
├── docs/
│   ├── candidates.md            # 候选构建、校验和发布
│   ├── deployment.md            # 部署控制面、状态和切换流程
│   ├── deployment-layout.md     # 本文：仓库与安装目录契约
│   └── blue-green-baseline.md   # 蓝绿运行时演练
├── internal/deployment/         # 控制器应用服务和执行边界
└── scripts/
    ├── build-candidate
    ├── promote-candidate
    ├── build-deployment-envelope
    └── preview
```

`deploy/production/compose.yaml` 是安装级蓝绿模板，声明稳定 Caddy、独立部署控制器、`server-blue`/`server-green` 和 `worker-blue`/`worker-green` 两套槽位，以及共享的 Connector 和数据库边界。它是可校验的模板，不包含真实凭据、主机名或镜像摘要；实际安装应复制模板并通过受保护的环境文件提供值。

`deploy/preview/` 是仓库内可执行的分支预览实现，负责演练候选校验、非活动槽位启动、Caddy 切换、Worker generation fencing、旧槽排空和兼容回滚。`deploy/example/` 只提供通用单槽引导和共享数据库示例，不是蓝绿切换的 Compose 定义。

`docs/candidates.md` 规定候选 manifest、候选摘要、确定性压缩包和发布校验；`docs/deployment.md` 规定部署控制器的状态机、API、观测、切换和恢复；`deploy/production/README.md` 说明生产模板的安装边界；`docs/blue-green-baseline.md` 说明运行时演练。架构取舍记录在 `docs/adr/0014-deployment-control-plane-and-blue-green.md`。

## 安装目录

安装根目录由部署者选择，以下是蓝绿安装使用的通用布局：

```text
<installation-root>/
├── deploy/production/
│   ├── compose.yaml             # 当前安装使用的蓝绿 Compose 文件
│   └── Caddyfile.tmpl           # 控制器渲染的稳定入口模板
├── release/
│   └── <source-sha>/            # 一个源码 SHA 对应一个不可变候选目录
│       ├── candidate-manifest.json
│       ├── candidate-manifest.json.sha256
│       ├── candidate.tar.gz
│       ├── candidate.tar.gz.sha256
│       ├── bin/
│       │   ├── connector
│       │   ├── server
│       │   └── worker
│       ├── web/                  # 候选 Web 树
│       ├── deployment-envelope.json  # 需要部署控制器时生成
│       └── Dockerfile.*          # 发布流程需要时附带的构建定义
├── web/
│   └── candidates/<candidate-id>/ # 按候选 digest 保存的 Web 树
├── config/caddy/Caddyfile       # 当前生效的 Caddy 配置
├── deployment/                  # 控制器的安装级状态挂载点
├── artifacts/                   # 应用持久化文件，按安装配置提供
├── connector/                   # Connector journal，按安装配置提供
├── workspace/                   # Connector 执行工作区，按安装配置提供
└── <protected-env>              # 受保护的环境文件，不进入 Git
```

上面的 `release/<source-sha>/` 是安装级候选仓库，不是源码目录。目录名使用完整源码 SHA 便于追溯；真正的候选身份以其中 `candidate-manifest.json` 的 `candidate.digest` 为准，不能仅凭目录名判断候选内容。候选 digest 通常也是 `web/candidates/<candidate-id>/` 的目录名，因此源码 SHA、候选 digest 和 Web digest 是三个不同的身份字段。

`release/<source-sha>/` 至少应保持 manifest、两个 sidecar 校验文件、候选压缩包和候选运行产物的一致性。`bin/` 与 `web/` 用于将同一个候选交给安装流程；`deployment-envelope.json` 额外绑定候选 digest、Web digest、不可变 Server/Worker 镜像引用和状态兼容窗口。某些发布流程还会附带 `server`、`worker`、`migrate` 或单独的 `deployment-controller` 可执行文件，它们是交付便利物，不改变蓝绿槽位和候选身份契约。

`web/candidates/<candidate-id>/` 是 Caddy 和部署控制器读取的只读 Web 发布树。它与 `release/<source-sha>/web/` 表示同一候选的不同安装落点；发布流程必须校验 Web digest，不能在候选激活后就地覆盖文件。旧 Web 树在兼容窗口内保留，用于浏览器缓存资源回退和兼容回滚。

`config/caddy/Caddyfile` 是稳定入口当前使用的渲染结果。蓝绿切换不是移动 `release/` 目录或改镜像标签，而是由部署控制器启动非活动 Server/Worker 槽位、验证候选身份和健康状态、提升新的 Worker generation、切换 Caddy 路由，再排空旧槽位。因此 `release/` 负责保存候选，`deploy/production/compose.yaml` 负责声明双槽拓扑，Caddy 配置负责表示当前流量入口。

`deployment/` 是安装级控制器的挂载点；部署状态的权威事实由控制器的持久化设计决定，不能把其中临时文件当作候选发布目录。`artifacts/`、`connector/` 和 `workspace/` 属于运行时持久化边界，不得放进 `release/`，也不得在应用切换时随槽位删除。环境文件包含数据库、OIDC、Connector 和排空令牌等敏感值，只能由安装流程管理。

## `release/` 的检查方式

先查看目录名和文件清单，再以 manifest 校验候选身份；不要通过解压或执行二进制来判断版本：

```sh
find <installation-root>/release -mindepth 1 -maxdepth 2 -type f -print | sort
cd <installation-root>/release/<source-sha>
sha256sum -c candidate-manifest.json.sha256
sha256sum -c candidate.tar.gz.sha256
python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["candidate"])' \
  candidate-manifest.json
```

候选目录发布后应视为不可变对象：同一候选可重试安装和切换，但不能覆盖 manifest、压缩包、Web 文件或二进制。需要新版本时发布新的 `<source-sha>` 目录，并让控制器依据 manifest 和 deployment envelope 选择候选；清理旧目录必须遵守保留窗口、回滚兼容性和备份策略。

## 相关文档

| 文档 | 内容 |
| - | - |
| [`docs/candidates.md`](candidates.md) | 候选构建、确定性摘要、发布校验和 envelope |
| [`docs/deployment.md`](deployment.md) | 控制器状态机、API、观测、切换、排空和恢复 |
| [`deploy/production/README.md`](../deploy/production/README.md) | 安装级蓝绿 Compose 模板与配置边界 |
| [`deploy/preview/README.md`](../deploy/preview/README.md) | 分支预览的可执行蓝绿流程 |
| [`docs/blue-green-baseline.md`](blue-green-baseline.md) | Agent VM 蓝绿运行时演练 |
| [`docs/adr/0014-deployment-control-plane-and-blue-green.md`](adr/0014-deployment-control-plane-and-blue-green.md) | 部署控制面与蓝绿架构决策 |
