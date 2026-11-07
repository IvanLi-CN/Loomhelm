# ADR 0019：浏览器恢复与分层查询缓存

## 背景

浏览器恢复焦点时，现有 Provider 会使绑定客户端失效、递增会话 generation，并重新进入 loading assembly。项目和任务查询以 generation 分区，因此一次同主体的正常恢复也会使页面卸载并重新请求数据。项目成员、任务关系的提前全量读取和重复 source 订阅进一步放大网络与界面变化。TanStack Query 已存在，但其缓存生命周期被鉴权 assembly 的生命周期反复打断。

ADR 0013 的不可变主体绑定与 ADR 0008 的完整 reconciliation 屏障仍然有效。优化不能通过保留失效主体、跳过授权或把局部可见数据当成完整刷新来减少抖动。

## 决定

普通 focus/visibility 恢复使用后台会话校验。同一主体校验成功时保留当前绑定客户端、session generation、authenticated assembly 与 QueryClient 中的现有资源身份，不经过全屏 loading。并发恢复事件合并为一次有界校验，校验结果使用 generation 和请求身份隔离；晚到的校验不能撤销后续登出或覆盖新主体。

显式登出、跨窗口失效通知、受保护请求返回 401 或校验确认主体变化时，继续执行使旧绑定失效、取消并清除旧主体查询、重新 bootstrap 的完整流程。受保护请求继续携带并校验 X-Loomhelm-Expected-Principal，后台校验不授予新的权限，也不自动重放 mutation。网络错误保留最近一次成功界面并提供可恢复错误状态；401 与资源级 403 不得作为普通网络错误保留被撤销的受保护资源。

查询保留 loomhelm、principal、真实鉴权 generation 的共同前缀，资源键再表达项目、过滤、分页和关系身份。同主体恢复不改变前缀。全局与项目任务读取、当前使用的成员信息、详情关系与图关系按实际视图需要加载；缓存未过期时复用，后台刷新时保留同一安全主体的数据。不同项目、主体或分页范围不得使用误导性的跨范围占位数据。重复 UI 消费者共享同一个 source；传入 source 的组件不得再隐式创建第二份生产 source。

查询任务沿用现有 GET 资源与分页语义，不等待后端优化产生新协议。关系读取的后端优化必须先证明读取或鉴权放大，再在不改变端点、返回形状、项目权限及凭据 scope 的条件下消除重复工作。未经测量不添加索引或迁移。

普通浏览的按需读取与 mutation reconciliation 的完整读取分开。显式恢复屏障仍读取受影响范围内全部项目、成员、任务及任务关系，只有完整成功且 idle 的结果才能解除屏障；懒加载、缓存命中、局部刷新或后台会话校验本身不能解除屏障。

## 模块边界

Provider 与 API client 负责后台会话校验、真实失效与旧响应隔离，保留现有 ProductionApiAssembly 的 authenticated 状态语义；可恢复提示使用既有 message 或兼容的可选状态。查询 source 负责资源键、读取范围、失效与完整 reconciliation；不自行解释 cookie 变化或递增鉴权 generation。ProductShell 和任务视图只消费稳定 source 与状态，不注册第二套焦点刷新策略。后端优化保持公共 REST 兼容，因此这三个实现边界在本契约固定后可并行。

## 影响与验证

同主体恢复不再以页面重建作为刷新机制，页面导航、筛选、选择与滚动状态必须保留。代价是需要显式区分初始加载、后台刷新、真实鉴权失效和可恢复网络失败，并对旧请求和跨窗口事件做竞态验证。短时间保留的数据仍受原主体绑定和服务端当前授权约束。

验证必须覆盖 focus/visibility 合并、长时间后台恢复、同主体缓存复用、主体变化、登出与晚响应竞态、401/403、网络失败、按需请求次数，以及完整 reconciliation 屏障。UI 使用确定性 Storybook/ui_demo 场景和挂载身份断言；真实程序截图另行取得授权。

## 兼容性

公共 REST、MCP 和数据库持久格式不变，不引入 tRPC 或批量 graph API。客户端内部状态与缓存键的调整不得破坏 ADR 0013 的绑定保证。最终实现覆盖与实际验证结果记录在 phase1-core 的 IMPLEMENTATION.md，本文不宣称尚未执行的验证通过。

## 关联

- [主体绑定](0013-immutable-browser-principal-binding.md)
- [完整恢复边界](0008-u02-recovery-completeness.md)
- [核心契约](../specs/phase1-core/SPEC.md)
