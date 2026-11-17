# 开发预览

本页记录 Loomhelm 各模块的源码预览入口。Agent 的主动交付时机、宿主后台托管、端口与浏览器交付流程统一见[项目开发预览 Skill](../.agents/skills/development-preview/SKILL.md)。预览页面展示目标行为，构建与测试结果承担各自的验证责任。

## 入口选择

| 开发对象或验证目的 | 入口与场景 |
| - | - |
| multi-task-flow 页面 | 在当前工作树的 `packages/multi-task-flow-runtime/` 运行下节源码预览；使用示例编排展示交互 |
| Loomhelm 产品整页 | 仓库根目录 `VITE_DEMO=true bun run dev`，选择覆盖目标页面的 login-free `ui_demo` 路由；真实认证集成另行验证 |
| Loomhelm 可复用组件与状态 | 仓库根目录 `bun run storybook`，打开相应 story；整页变化还需覆盖对应页面 |
| 候选部署、蓝绿切换与恢复 | 按[开发说明](development.md)及[候选构建](candidates.md)使用 `scripts/preview` 与会话 Agent VM |

Web 与 Storybook 启动时将实际监听端口设为当前任务租约获配端口；Storybook 脚本中的默认 6006 不代表端口使用权。核对实际监听结果，避免框架自动换端口导致租约失配。

查看正式编排属于已安装 `multi-task-flow` 的使用流程。开发中的页面使用当前工作树构建的隔离服务；浏览器中已打开的正式 viewer 不会因源码修改自动更新。`scripts/preview` 是部署控制入口，不承担普通页面开发预览。

## multi-task-flow 源码服务

先按模块 `package.json` 和锁文件准备依赖；命令均在当前工作树的 `packages/multi-task-flow-runtime/` 执行。默认使用能覆盖本次改动的示例，主人已指定示例时遵循其选择。

| 示例 | 命令 | 用途 |
| - | - | - |
| 编排展示与交互验收 | `bun --no-install run preview:source` | 多交付单元、依赖、等待与阻塞、动态切割 |
| 单交付单元 | `bun --no-install run preview:single-delivery-unit` | 文档检索服务示例、复杂依赖汇聚与默认任务网格 |
| Agent 空闲与归档 | `bun --no-install run preview:idle-archive` | Agent 空闲和对话归档的专门场景 |
| Gateway 故障恢复页 | `bun --no-install run preview:gateway-recovery` | 无需登录和账本的独立 HTML 故障页，覆盖可重试、限流倒计时和模拟恢复 |

入口复用正式 shared viewer 实现，从本工作树构建 Web 源码，在新的临时目录使用 development profile 与示例账本，自动申请并维护独立端口租约。它不安装或升级正式服务，也不导入真实运行账本。默认编排示例包含仓库 PR 查询入口；示例账本隔离不代表页面完全离线，验证时保留查询失败的真实状态。

服务输出包含 `root`、`pid`、`port`、`scope`、`run_id`、`source_commit` 和单次登录 `url`。用这些字段核对临时服务与租约身份；宿主后台会话由 Agent 另行取得和验证。`source_commit` 仅表示 HEAD，未提交修改也会参与构建，需一并记录。

直接在内置浏览器消费服务输出的登录入口，打开示例编排并进入本次修改的交互状态。登录票据有效期为 60 秒，既有浏览器会话继续有效；票据过期可在该临时 profile 下运行模块的 `scripts/service.ts login`，显式设置 `MULTI_TASK_FLOW_PROFILE=development` 与输出中的 `MULTI_TASK_FLOW_ROOT`，按实际 `run_id` 获取新入口，避免误用正式服务。

`web/` 源码变化会自动构建并在成功后刷新页面；构建失败保留上次成功资源，此时页面不是最新修改的证明。后端源码、示例数据和其他未监听输入变化后重启命令。需要结束时向精确拥有的预览进程发送 Ctrl+C 或 SIGTERM，由入口完成服务和租约释放；主人查看期间保持服务与浏览器标签页。

静态导出适合独立静态产物检查；开发期间需要示例编排与交互验收时使用上述 HTTP 源码服务。

## Gateway 纯 Web Demo

在 `packages/multi-task-flow-runtime/` 运行 `bun --no-install run dev:demo`，使用终端输出的 HTTP `url`。根路径和 `/runs/demo-recovery/` 默认直接展示正式故障页，不再先显示链接目录。入口从当前工作树生成 UI 库样式，使用与 Gateway 相同的 HTML 渲染器、Lucide 图标、DaisyUI 按钮及 Viewer 主题令牌；HTTP 服务仅提供静态页面，模拟等待与恢复完全在浏览器内运行，不需要登录、账本、Daemon 或 Worker，也不提供业务 API。

```sh
bun --no-install run dev:demo --scenario recover --theme dark --run-id lims-poc02-04-r10 --wait-ms 3000
bun --no-install run build:demo
```

第一条命令自动申请端口、记录真实 PID 并维护租约；输出还包含源码工作树和 `runtime=browser-mock`。服务托管仍按项目开发预览 Skill 核验，只有主人明确同意时才可为单次预览采用不同托管方式。CSS、渲染器或模拟脚本修改后重新运行命令，不宣称热更新。停止精确拥有的进程时使用 Ctrl+C 或 SIGTERM，入口释放自己的租约。

页面顶部的「Demo 控制」提供场景、主题、编排 ID、等待毫秒与复制场景链接。URL 中 `demo=gateway-recovery` 标记演示身份，`d_state=ready|cooldown|recover` 选择可重试、倒计时或模拟恢复，`d_theme=system|light|dark` 选择主题，`d_run_id` 和 `d_wait_ms` 指定数据；等待时间限制为 0–60000 毫秒。可以直接编辑链接或使用表单，「应用并重置」明确重新开始此无业务状态的场景。调整控件本身不会触发导航。分享链接删除内部 `demo_started`，让接收者从头复现；刷新当前页保留等待起点。

`recover` 场景只在等待结束后手动点击「重试连接」才进入模拟成功页，并保留 URL 中的计划、标签页和定位。这证明页面交互，不代表真实 Worker 已恢复。正式故障页的「返回编排列表」在 Demo 中返回演示首页。

`build:demo` 生成仓库根目录 `dist/gateway-recovery-demo/` 下的五个独立 HTML 文件，可由普通静态 HTTP 服务托管；`index.html` 就是可重试的实际页面，子场景无需后端回退。重复构建只更新已知生成文件，保留目录中其他文件，拒绝输出目录或文件为符号链接。需要导出到新的目录时，使用 `bun --no-install run preview:gateway-recovery --export <新的输出目录>`。独立文件同样能交互，但源码开发验收优先使用 HTTP 入口。

### 方案依据与取舍

本模块需要可指定、可分享、无需真实服务的页面预览；约束是复用正式 UI，防止演示环境读写正式编排，并继续遵守端口及宿主托管合同。Style Playbook 的 `topics/web-demo/TOPIC.md`，以及 `projects/octo-rill.md`、`projects/mains-aegis.md` 提供了独立构建、正式界面复用、浏览器模拟输入和 URL 场景状态的参照；当前模块本身已有无外部资源的 Gateway 渲染器，因此无须另建 React 应用或复制一份故障页。Playbook 的路径是外部参考库身份，不是本仓库运行依赖。

默认方案是正式渲染器加隔离的浏览器引导脚本，开发服务与静态导出使用同一页面工厂。风险是模拟恢复可能被误解为运行状态，因此入口显式标记「仅模拟数据」，不提供 API；此页没有需保留的业务编辑，场景提交明确叫「应用并重置」，普通控件变更不重新加载页面。生产重试脚本保持独立，不携带 Demo 控制代码。

替代方案一是继续由开发服务器维护模拟等待状态：容易模拟真实 HTTP 503，但分享后的行为依赖服务器时钟和进程，离线静态构建无法复现；它适合网络协议集成验证，本模块已有 Gateway 集成测试承担这一职责。替代方案二是另外手写 Demo UI：便于自由展示，但容易与正式恢复页漂移，仅适合尚无正式实现的早期原型。当前选择不需要安装新 Policy；`web-demo` Policy 采用审计为 `not-applicable`，不表示新增了 Policy 对齐证明。

后续新增页面或场景时扩展既有 Demo 入口，保持 URL 可复现和真实运行时隔离；暂不扩展为通用全站模拟平台。纯前端整页证据来自此 `ui_demo`，实际认证、HTTP 错误码和 Worker 生命周期继续使用各自测试。
