# 本地工程工作流

`workflow/index.ts` 提供 Skills 发现、兼容性检查与本地工程阶段 API。`workflow/cli.ts` 是独立机器可读入口，编译后可通过 Node.js 或 Bun 调用；现有客户端公共入口不因本模块改变。实现以 `docs/design/client.md` 中的 Skills 和工作流职责为边界，参考已安装 `project-engineering-workflow` 的本地阶段语义。

## Skills

调用 `loadSkills({ project, user })`，参数直接指向 Skills 目录，例如仓库的 `.agents/skills` 和用户的 `~/.agents/skills`；调用方也可显式传入 `.codex/skills` 等现有目录。模块不推断宿主配置、不写全局技能、不执行 Skill 中的代码。每个目录的直接子目录对应一个 Skill，并支持符号链接安装。缺失根目录视为空目录；权限或其他目录读取错误向上传递。

每个 Skill 必须有 `SKILL.md`，frontmatter 包含与目录一致的 `name` 和非空 `description`。名称使用小写字母、数字和短横线；这两个字段支持普通单行、双引号 JSON 字符串或单引号 YAML 字符串，其他正文和字段保持原样。多行 YAML 标量等未支持的语法会给出诊断，不会猜测解释。

同名项目 Skill 优先于用户 Skill。项目副本无效或不适用时仍占用该名称，不会静默回退到用户副本。其他正常 Skills 可以继续加载；调用方必须处理 `diagnostics`，或通过 `requireSkill` 确认需要的 Skill 可用。

可在 Skill 旁添加可选的 `loomhelm.json`，供客户端检查兼容性；它是客户端独立的机器合同，不要求改写已安装 Skill。示例：

```json
{
  "schemaVersion": 1,
  "version": "1.2.3",
  "scopes": ["project", "user"]
}
```

清单只允许 `schemaVersion`、`version`、`scopes`；`scopes` 必须声明允许从哪个来源加载，不能用于授予文件或命令执行权限。没有清单或没有 `version` 时版本为 `null`，仍可按名称加载；一旦要求版本范围，未知版本会拒绝。未声明版本的全局 `project-engineering-workflow` 可只读加载，但不能被当作满足某个版本约束。版本不从目录名、frontmatter 或 Git 历史猜测。

`requireSkill(catalog, name, { range, scopes })` 检查选中的 Skill。版本支持严格的三段非负整数，以及 `*`、精确版本、`^`、`~` 和空格连接的 `>=`、`<=`、`>`、`<`、`=` 比较式；不支持预发布版本、通配分段和 `||`。`^0.2.3` 的上界为 `0.3.0`，`^0.0.3` 仅接受 `0.0.3`。所有约束都会先完成语法检查。`digest` 是正文与清单原文组成的 SHA-256 指纹，仅作内容身份，不证明可信来源。

```ts
const catalog = await loadSkills({ project: projectSkills, user: userSkills });
const skill = requireSkill(catalog, 'engineering', {
  range: '>=1.0.0 <2.0.0',
  scopes: ['project', 'user'],
});
```

## 本地阶段

`LocalWorkflow.open(repository, baseRef, flowType)` 完成执行上下文检查：必须有可解析的明确 base、非 `main`/`master` 的命名分支、干净工作区，以及从 base 派生的 HEAD。模块仅检查本地 Git，不 fetch、不变更 remote，也不修改已有改动。

| 调用 | 完成的本地阶段 | 下一阶段 |
| - | - | - |
| `open` | 执行上下文 | `durable-contracts` |
| `settleContracts` | 记录 Spec 和 ADR 的适用性结论及文件指纹 | `delivery-slices` |
| `recordImplementation` | 记录调用方已完成的实现说明 | `validation` |
| `validate` | 执行显式配置的验证命令并保存结果 | `can-open-pr` 或 `validation` |
| `readiness` | 重新读取 Git 和合同文件，检查结果是否仍适用 | 返回当前门禁 |

`settleContracts` 必须分别包含 Spec 和 ADR 的结论：`link` 要求存在的仓库相对文件路径，`not-needed` 要求空路径列表，两者均要求理由。真实路径不能经符号链接逃出仓库。设计决策及批准由调用方负责；模块不创建或替代 Spec/ADR，也不把说明文字当作人工批准。合同变化后必须重新结算合同、记录实现并验证。

每条验证包含唯一 `id`、可执行文件 `command` 和字符串数组 `args`，默认是必需验证。命令在仓库根目录通过现有 `runProcess` 执行，禁用隐式 shell 展开。验证默认超时 30 秒、输出上限 1 MiB，可显式调整至最多 1800 秒和 64 MiB。命令本身拥有当前用户权限，调用方须只提交已授权的命令；本模块不是命令沙箱。

至少需要一条必需验证。所有必需验证通过、整套验证执行结束且候选未变化，才能进入 `can-open-pr`。可选验证失败会保留失败事实，不阻塞必需验证；任何验证造成 Git 状态或合同变化都会阻止就绪。非零退出、超时、输出超限、启动失败与取消都不会被记作通过。取消之后未开始的条目不生成执行收据；完整套件缺失条目时不能就绪。

收据包含随机执行身份、命令、仓库、base、HEAD、实际开始与结束时间、退出码、信号、状态、输出与输出摘要。现有进程适配器在超时、取消、输出超限等异常时只返回异常，因此这些收据不声称保留部分 stdout/stderr。状态快照使用深拷贝；单实例拒绝并行变更，每次验证调用都重新运行命令。调用方负责持久保存返回结果、跨实例锁与重启恢复，本模块不伪造持久化或幂等执行保证。

`can-open-pr` 只表示该模块覆盖的本地阶段已通过，不是远端发布授权、完整 Review Readiness、merge-ready 或 Flow Complete。调用方仍负责项目适用的 Spec 同步、视觉证据、经验验收、审查层级与正式 review/CI 等门禁。`flowType` 保留 `normal`、`fast-track`、`local-merge` 路由身份，但不从中继承 push、PR、merge 或 release 权限。候选 HEAD 变化、工作区变脏或合同指纹变化后，`readiness()` 返回未完成门禁，旧收据保留为历史事实。

## 验证入口

先在 `client` 下执行 `npm ci` 和 `npm run build`。命令输出 JSON，失败退出码为 1；参数或配置错误输出 JSON 到 stderr，实际验证失败的结果输出到 stdout。

```sh
node dist/workflow/cli.js skills /path/to/repo/.agents/skills /path/to/user/.agents/skills
node dist/workflow/cli.js verify /path/to/workflow.json
bun dist/workflow/cli.js verify /path/to/workflow.json
```

`verify` 清单示例：

```json
{
  "schemaVersion": 1,
  "repository": "./repo",
  "base": "HEAD",
  "flowType": "normal",
  "skills": {
    "project": ".agents/skills",
    "user": "/path/to/user/.agents/skills",
    "requirements": [{ "name": "engineering", "range": "^1.0.0", "scopes": ["project", "user"] }]
  },
  "contracts": [
    { "kind": "spec", "disposition": "link", "reason": "Existing acceptance contract", "paths": ["docs/specs/feature/SPEC.md"] },
    { "kind": "adr", "disposition": "not-needed", "reason": "No architectural boundary change", "paths": [] }
  ],
  "implementation": "Implementation committed and ready for local validation",
  "validations": [
    { "id": "tests", "command": "node", "args": ["--test", "test/feature.test.mjs"], "timeoutMs": 30000 }
  ]
}
```

`repository` 相对于清单所在目录解析，Skills 路径相对于仓库解析；`skills` 可省略。验证命令固定以仓库根目录为工作目录。建议将清单与输出放在仓库外或既有忽略的证据目录，避免验证自身产生未跟踪文件使候选变脏。输出的 `selectedSkills` 保留实际加载的内容、来源、版本与指纹；Skill 检查在执行命令前进行，不声称锁定全局 Skill 文件或检测验证期间的外部变更。

行为验证使用 `npm test` 和 `npm run test:bun`。`test/workflow.test.mjs` 使用临时真实 Git 仓库和真实 Node/Bun 子进程，覆盖 Skills 覆盖与兼容性、阶段顺序、命令结果、取消、合同逃逸、合同漂移、候选污染、HEAD 变化，以及无服务端的 CLI 验证链路。
