# 代码地图

实现采用模块化单体。接口细节以类型、注释和测试为准。

`packages/core/src/work-context.ts` 从共享库构建按范围过滤的工作快照；`agent-runtime/index.ts:before_agent_start` 每轮注入，覆盖 Web 和全局/项目/事项机器人。`tests/work-context.test.ts` 测过滤与容量，`tests/bot-global-context.test.ts` 测真实 pi SDK、HTTP、SQLite 与替身飞书收发的跨 Agent 态势读取和刷新。

功能覆盖与参考证据见 [功能清单](feature-inventory.md)。待办时间编辑入口为 `apps/web/js/features/todos-tab.js`：浏览器本地时区展示、显式清空、未改时间不提交。后端复用 `workbench.ts:updateTodo`、`supervision.ts:tick` 和现有持久事件管线；端到端回归为 `tests/todo-reminder-browser.spec.ts`。

| 位置 | 职责 |
| --- | --- |
| `bin/super-mario.js` | 服务端命令、帮助、信号关停；选择源码或编译产物 |
| `bin/super-mario-agent.js` | 执行机命令与机器标识 |
| `apps/server/src/index.ts` | HTTP API、静态 Web、浏览器事件、机器连接 |
| `apps/agent-node/src/index.ts` | 主动连接、心跳、注册方法 RPC、重连 |
| `apps/web/` | 原生浏览器模块（ES Module），无前端构建框架；结构见下表 |
| `packages/protocol/src/index.ts` | Web/代理的数据与消息类型 |
| `packages/plugin-sdk/src/index.ts` | 插件、工具、知识与执行者接口 |
| `packages/core/src/model-config.ts` | 私密主模型配置、校验、读取脱敏与重启恢复 |
| `packages/core/src/projects.ts`、`project-folders.ts` | 文件夹项目绑定、目录去重、远端校验/发现、保留旧数据与归档 |
| `plugins/project-discovery.ts`、`bin/super-mario-agent.js` | 本机历史目录与 Git 项目发现，现有目录校验，节点能力注册 |
| `apps/web/js/features/project-discovery-list.js`、`project-folders.js`、`project-conversation.js` | 自动候选目录、显式导入/绑定、按项目保留的持续工作对话 |
| `packages/core/src/knowledge-curator.ts` | 来源队列、资料读取、CLI 委派、知识导入和本地 Git 记录 |
| `plugins/knowledge-worker.ts` | 执行机上的常驻 Codex / Claude JSONL 连接与结果持久化 |
| `apps/web/js/main.js`、`shell.js` | 启动装配；外壳（导航、顶栏搜索、项目范围、连接状态） |
| `apps/web/js/lib/` | `api`（接口与令牌）、`store`（快照 + 实时推送，唯一数据来源）、`router`（地址即状态、旧地址重定向）、`alerts`（提醒点纯函数）、`scope`（项目范围）、`dom`（`h()` 与只重绘变化行的 `keyedList`）、`format` |
| `apps/web/js/ui/` | 通用组件：`kit`（按钮、卡片、选项卡、表单）、`overlay`（抽屉、确认框、轻提示）、`hint`（右上角作用说明）、`icons` |
| `apps/web/js/pages/` | 五个页面：`chat`、`agent`、`projects`、`memory`、`channels`；只组装，不含业务细节 |
| `apps/web/js/features/` | 页面内的功能块：等你处理、待办、执行（列表/详情/发起）、自动处理、自动跟进、记忆条目与整理、项目跟进设置、高级、快捷键、搜索、开屏 |
| `apps/web/js/copy/` | 作用说明文案表 `hints.js` 和用词表 `terms.js` |
| `apps/web/js/legacy/` | 保留的自成体系模块：`terminal.js`（终端观察抽屉）、`bot-mailboxes.js`、`agent-artifacts.js`、`background-page.js`；由新页面按需挂载 |
| `apps/web/css/` | `base`（设计令牌）、`layout`（外壳与窄屏）、`components`（组件）、`pages`（页面） |
| `packages/core/src/attention.ts`、`todo-sections.ts`、`policy-presets.ts` | 只读待处理聚合、服务端待办分区、规则预设与真实命中统计 |
| `packages/core/src/config.ts` | 命令参数与环境变量 |
| `packages/core/src/workbench.ts` | 装配、待办、异步派活与业务入口 |
| `packages/core/src/store.ts` | SQLite JSON 文档存储与同步事务 |
| `packages/core/src/events.ts` | 持久事件与进程内订阅 |
| `packages/core/src/plugin-invocations.ts` | 钩子、JSON 服务与有序包装的超时/清理边界 |
| `apps/server/src/agent-artifacts.ts`、`apps/agent-node/src/agent-artifacts.ts` | 远端代码暂存确认、导入前完整性检查和版本绑定调用 |
| `packages/plugin-sdk/src/json.ts`、`permissions.ts`、`agent-artifacts.ts` | 公开 JSON、权限名称和制品校验接口 |
| `scripts/check-plugin-boundaries.mjs` | 系统与第三方插件统一 AST 导入检查，CI 失败 gate |
| `packages/core/src/plugin-host.ts` | 贡献注册、启停、依赖与资源释放 |
| `packages/core/src/agent-runtime/` | 唯一导入 pi 的目录，模型与插件工具桥接 |
| `plugins/index.ts` | 默认插件和主 Agent 业务工具 |
| `apps/server/src/feishu.ts` | 飞书配置、私聊配对、异步回复关联与启停 |
| `packages/core/src/integration-config.ts` | 本地私密配置，公开状态排除密钥 |
| `packages/core/src/inbox.ts` | 消息去重、规则分拣、版本校验与确认转待办 |
| `packages/core/src/machines.ts` | 执行机 RPC、连接替换隔离与瞬态事件 |
| `packages/core/src/plans.ts` | 1–8 项任务计划、版本启动与逐项派发回执 |
| `packages/core/src/policies.ts` | 全局、项目、任务规则及来源判定 |
| `packages/core/src/interactions.ts` | 交互卡片建议、版本回答、期限和撤回 |
| `packages/core/src/supervisor-agent.ts` | 独立督办模型的合批、复核与去重 |
| `packages/core/src/agent-runtime/codex-provider.ts` | 可选原生 Codex CLI 模型提供者，仍由 pi 执行工具循环 |
| `plugins/inbox-triage.ts` | 只读模型分拣与明确的规则回退 |
| `packages/core/src/effects.ts` | 外部动作认领、内容去重和未知结果记录 |
| `packages/core/src/approvals.ts` | 内容版本审批和动作执行 |
| `packages/core/src/run-monitor.ts` | 原生结果轮询与回送，不从读屏推断完成 |
| `packages/core/src/supervision.ts` | 配置、提醒认领、督办信号和事实简报 |
| `packages/core/src/extension-loader.ts` | 自定义插件清单校验和真实加载 |
| `plugins/task-runner.ts` / `task-results.ts` | 外部 CLI 任务进程和原生结果记录 |
| `scripts/verify-codex.mjs` | 显式真实 Codex 端到端验收 |
| `plugins/feishu.ts` | 官方长连接、机器人发送、可选 user 消息采集 |
| `plugins/terminal-host.ts` | 外部终端宿主的命令与画面观察适配 |
| `plugins/executors.ts` | CLI 会话绑定、读写与观察者生命周期 |
| `plugins/knowledge-local.ts` | 三层 Markdown 知识及索引 |
| `tests/*.test.ts` | 单元与本地 HTTP/WS 集成验证 |
| `tests/browser.spec.ts` | 真实 Chromium 的产品流程验证 |

常驻后台入口：`packages/core/src/eventbox.ts`（持久订阅/投递/恢复）、`schedules.ts`（到期事件）、`outbox.ts`（发送意图与授权）、`background.ts`（宿主装配）；SDK 在 `packages/plugin-sdk/src/background.ts`，治理页面在 `apps/web/background-page.js`。集合前缀 `eventbox.*`、`outbox.*`，与 `event-mailboxes.ts` 的业务信箱分开。核心事件在 `workbench.ts`、`supervision.ts`、`approvals.ts`、`interactions.ts` 的原事务中生产。`tests/background*.ts` 覆盖单元、HTTP、SIGKILL 和浏览器验收。

常见改动：新增能力先看插件 SDK；改派活看 `workbench.ts`；改模型看 `agent-runtime/`；改页面看 `apps/web/`。尽量复用已有服务入口，不另建一套任务或状态系统。

并行开发：功能 worktree 放 `../super-mario-worktrees/<功能名>/`，共享契约和锁文件由集成人维护。具体规则见根目录 `AGENTS.md`。


多机器人相关入口：

| 文件 | 职责 |
| --- | --- |
| `apps/server/src/feishu-bots.ts`、`packages/core/src/feishu-bot-config.ts` | 独立连接、私密配置、配对、事件路由与改绑失效 |
| `packages/core/src/event-mailboxes.ts`、`bot-scopes.ts` | 业务收发信箱、范围归类、版本确认与中断状态 |
| `packages/core/src/scoped-agents.ts`、`agent-input.ts` | 独立会话及共享工具的调用来源 |
| `plugins/feishu-registration.ts`、`apps/server/src/feishu-registration.ts` | 扫码登录、自动配置/发布回读及注册记录 |

## 2026-11-17：代码侧栏、离场通知与时间窗摘要

- `plugins/workspace-code.ts`：执行机上的有界只读代码浏览；由 `project-discovery.ts` 注册能力。
- `apps/server/src/index.ts`：已保存项目绑定的代码 API、在场 API、简报配置 API；私密配对目标与通知渠道适配。
- `apps/web/js/features/code-sidebar.js`：主对话与项目对话共用；`presence.js`：每个文档独立租约。
- `packages/core/src/web-presence.ts`：多标签聚合；`away-notifications.ts`：通知意图、路由积压及发件箱衔接；`briefing.ts`：时间窗事实、项目聚合及调度设置。
- `tests/workbench-experience.test.ts`：隔离目录、SQLite、HTTP/WS、替身发送与恢复；`tests/workbench-experience-browser.spec.ts`：真实 Chromium 入口、窄屏、多标签、摘要与截图。

机器人协作：`packages/core/src/bot-agent-routing.ts` 固定会话身份与执行者；`bot-group-policy.ts` 管理群权限、范围和因果链；`apps/server/src/feishu-bots.ts` 复用信箱/来源路由完成协作及只读回报；`plugins/feishu.ts` 只做平台适配；`apps/web/js/legacy/bot-mailboxes.js` 提供绑定、群与协作入口。共享字段在 `packages/protocol/src/bots.ts`，工作事实投影在 `work-context.ts`。

原生会话：`plugins/cli-session-discovery.ts` 只读元数据和精确恢复验证，`session-resume.ts` 在执行插件内构造原生命令；`executors.ts`、`task-runner.ts` 和 `task-results.ts` 复用会话托管/原生结果。`packages/core/src/agent-sessions.ts` 处理范围、审批与请求幂等，`run-monitor.ts` 校验插件声明的证据；共享字段在 `packages/protocol/src/agent-sessions.ts`，Web入口在 `features/cli-sessions.js`。

收件消息来源：`protocol/src/inbox-origin.ts` 定义展示来源；`core/src/inbox-origin.ts` 规范化，`inbox.ts` 保存版本、归类和待办关联，`event-mailboxes.ts` 保留机器人来源而不改变授权；`pages/mailbox.js` 负责来源/阶段/项目组合筛选。`plugins/command-inbox/` 是固定 argv 采集适配器，复用 `core.inbox.ingest` 服务和既有插件权限。

交付闭环：`todo-reporting.ts` 核对答复来源与周期，`run-review.ts` 保存验收和返工轮次，`task-closure.js` 为待办与执行详情共用入口。`project-follow-up.ts` 复用持久调度和出站账本，项目策略由 `workbench.updateProject` 协调 `policies.ts`，不在调度器中授予权限。


连续工作事实：`work-decisions.ts`保存决定及修订证据，`work-decision-access.ts`核对历史用户/渠道来源，`work-decision-service.ts`组合当前输入权限、Web显式编辑与每轮上下文。共享类型在protocol；工具仍注册于`builtin-tools`，不新增插件平台。记忆页组件`features/work-decisions.js`消费同一HTTP账本。端到端证据见`tests/work-decisions-integration-browser.spec.ts`。

执行观察：协议`execution-progress.ts`只包含阶段、工具名、摘要和时间。适配器`task-results.ts`提炼原生事件，`run-monitor.ts`先校验来源与固定线程，再保存进展/结果；`work-context.ts`和`runObservations`复用真实阻塞事项。Web入口为`features/runs.js`。

个人连续采集：`plugins/feishu.ts:collectBatch`负责固定窗口三路分页与稳定消息标识，`feishu-personal.ts`适配用户CLI，服务端个人采集管理器在ingest成功后私有落盘游标。`features/personal-messages.js`只显示公开完整性说明；不把游标或配置名发到浏览器。


执行者配置与恢复：`plugins/agent-diagnostics.ts`只在显式RPC时读取规范化本地凭证状态；`bin/super-mario-agent.js`把同一launcher/profile交给实际执行和历史发现。`agent-node`/`machines.ts`保存代理实例，`terminal-recovery.ts`报告宿主已知边界；`executors.ts`区分本次创建与历史恢复绑定。电脑详情、诊断和控制台复用现有Web模块。

等待回复：`waiting-replies.ts`保存轮次和直接回复依据；`reply-tracking.ts`只允许选择连接器已观察的消息和身份。个人采集回调及插件收件批次进入同一核心服务；`reminderVersion`与现有staleIf使旧通知失效。待办原字段和事件仍是事实来源，自动停催不完成待办。UI在`features/waiting-reply.js`，实际浏览器/HTTP/SQLite闭环在同名integration测试。

周期工作：`scheduled-work.ts`协调已有审批与调度，`scheduled-work-service.ts`约束真实用户来源并提供公开投影；Web入口为`features/scheduled-work.js`。到期动作沿用事件账本和普通派发审批，不新增任务事实源。

受保护知识来源：`plugins/knowledge-source-reader.ts`只读调用显式CLI连接；核心`knowledge-source-settings.ts`保存独立开关，`knowledge-source-approval.ts`绑定单次来源确认。`workbench.ts`以调用上下文固定原链接、身份及插件贡献代次。`knowledge-curator.ts`处理来源队列与分层范围绑定，`knowledge-worker.ts`管理执行机常驻会话池；Web设置和队列在`features/knowledge-reader.js`、`features/curator.js`。

自动收件分类：`agent-runtime/inbox-classifier.ts`为每次分类创建隔离、无工具会话；`inbox.ts`保留本地规则回退。`pages/mailbox.js`只对展示窗口建立卡片，全量筛选数据不裁剪。

逐条收件处理：`inbox-handling.ts`保存建议版本、模型请求和现有审批的绑定，状态投影复用实际Run与交互；`inbox-handling-source.ts`从两个既有收件集合解析当前归属和可信消息依据。`agent-runtime/inbox-handling.ts`只维护隔离讨论、零工具与同范围知识，`features/inbox-handling.js`提供讨论/编辑/确认。`work-context.ts`汇总状态，`inbox_handling_read`按当前模型范围过滤历史；它不能代批。

个人回复：`plugins/feishu-personal-reply.ts`执行单次、显式profile的CLI回复。服务端只从已观察消息解析原目标，经过已有审批、Outbox和effects；机器人回复复用控制器的原范围/线程及来源版本校验。`plugin-host.ts`持久记录启停代次，防止off→on后复用旧确认。

知识附件：`knowledge-attachment-parser.ts`在独立worker中调用固定版本PDF/DOCX库，`knowledge-attachment-worker.ts`处理文字提取、页数/输出限制与本地资源。受保护来源reader仍负责可信域名、下载大小、私有临时文件和取消清理。合成fixture在`tests/fixtures/knowledge-attachments/`，不含真实文档。

本轮 CLI 与知识边界：`model-config.ts` 保存主模型 `cliCommand/cliConfigDir`；`agent-runtime/codex-model-config.ts` 做短 `config/read` 预检，`codex-provider.ts` 负责原生工作/数据工具限制与调用拒绝。`knowledge-curator.ts` 完整保存 raw，来源输入超过 200000 字符明确失败；其与 `plugins/knowledge-worker.ts` 核实远端 scope/provider/workerId，并保护暂停、切换及关闭清理。共享原生工具策略在 `packages/protocol/src/codex-model-policy.ts`，经公开 protocol 入口复用。

周期模型参数：`plugins/index.ts` 的 `scheduled_work_propose` 声明严格嵌套Schema，仅适配参数；`scheduled-work-service.ts` 仍核对当前用户，`scheduled-work.ts` 仍协调创建审批和到期调度。实际注册工具与core透传回归在 `tests/scheduled-work-tool-schema.test.ts`。

审批动作与单任务策略参数：`plugins/tool-parameters.ts` 只描述模型可见JSON Schema，由 `plugins/index.ts` 注册。`approvals.ts`、`plans.ts` 与 `policies.ts` 仍是原事实和校验来源；`tests/action-policy-tool-schema.test.ts` 通过实际SDK及原工具验证不提前执行。
