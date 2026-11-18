# 技术架构方案：核心能力、接口与默认插件

更新日期：2026-11-16（常驻运行 4.13/5.9 已实现并完成本地验证；真实外部联调边界另列）。

状态：方案已定稿（2026-11-15 用户确认按本方案执行），首版功能已实现，已完成本地回归与真实 Codex 外包执行链路验证，详见 [项目验收报告](acceptance-report.md)。当前可用范围以 README 和代码为准；本文包含尚未实现的目标能力。最新开发约定优先：保持模块化单体、SQLite、本地可验证，不一次实现预留机制。基座采用 pi，项目与包统一以 `super-mario` 命名。本文定义“底座”：核心提供哪些能力、暴露哪些接口、插件怎么写，以及系统自带哪些默认插件。底座建成后，新功能默认以插件方式开发。分期和工作包见 [项目计划书](project-plan.md)；本文与计划书冲突时，以本文为准，计划书随后同步。

## 0. 结论

- **一套插件体系**：工作台只有一种插件，称为“扩展”。pi 的扩展机制不直接开放给插件作者，由核心内部一个“桥接扩展”使用。这样插件作者只学一套接口，pi 升级的影响也收在核心内部。
- **核心只做 12 件事**：插件宿主、主 Agent 运行时（封装 pi）、领域存储与事件、副作用账本、交互卡片、工作编排、渠道管线、网关（HTTP/WS 与认证）、督办与通知、收件箱与待办、机器连接与执行机代理、可配置的自动处理策略。其他能力全部是插件。
- **两个可部署程序**：服务端（核心 + 插件）和执行机代理。执行机代理装在每台执行机上，主动用 WebSocket 连接服务端，在本机贴近 CLI 工作（hooks、transcript、终端运行时、Codex 协议）。服务端不再经 SSH 操作执行机。
- **核心定义接口，插件提供实现**：执行机、外部 Agent、飞书、知识存储、收件箱分拣、简报等都通过扩展点接入。核心不出现任何具体平台或 CLI 的名字。
- **接口按“可跨进程”设计**：首版插件在服务端进程内运行，但插件接口只传可序列化数据和已登记的回调。以后改为子进程插件时，插件代码不用改。
- **首期加载全部系统插件**：系统插件 8 个，首次启动全部启用，可在 Web 中单独停用。
- **自动处理全部可配置**：谁来回答卡片、哪些可以自动处理、多久上交、何时打扰用户，都是配置项（第 4.12 节），代码里只有默认值，没有写死的规则。
- **系统插件清单**：飞书、Claude Code、Codex、终端运行时宿主、本地知识库、收件箱分拣、每日简报、内置主 Agent 工具集。Web 终端协议（全量加增量、重连、背压）属于核心网关，不再单列插件。

## 1. 设计原则

1. **核心小而稳**：核心只放所有插件都依赖、且需要统一语义的能力。判断标准：两个以上插件需要它，并且语义不统一会出错（例如状态、副作用、权限）。
2. **插件只做适配**：平台差异留在插件里。例如渠道插件只负责与 IM 收发，“消息进入对话、跟踪这一轮、把回答送回去、转发提问”的公共流程由核心完成。
3. **接收、送达、执行、完成分开**：每个副作用都有可查的状态；结果不确定时记为“未知”，不当作成功，也不自动重试有副作用的操作。
4. **少打扰用户**：Agent 的提问、权限请求先经过策略和主 Agent 代答，仍需用户处理的才推给用户。核心记录每次打扰，用于统计。
5. **主对话随时可用**：主 Agent 不被长任务阻塞。长任务一律异步执行，结果作为后续消息回到对话。
6. **先本地反馈**：服务端收到消息后立即回“处理中”，不等模型或进程启动。
7. **可替换**：每个扩展点至少能换一个实现。默认插件与第三方插件使用同一套接口，没有特殊通道。

## 2. 总体分层

```
┌──────────────────────────── Web（apps/web）────────────────────────────┐
│ 对话 · 执行详情 · 终端控制台 · 待办 · 知识 · 机器 · 插件管理 · 卡片 │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ REST + WS（网关）
┌──────────────────────────────┴──────── 服务端核心（packages/core）──────┐
│ 网关/认证 │ 渠道管线 │ 交互卡片 │ 工作编排 │ 督办与通知 │ 收件箱与待办 │
│ 副作用账本 │ 领域存储+事件 │ 机器连接（执行机代理的服务端一侧）         │
│                主 Agent 运行时（封装 pi SDK + 桥接扩展）                │
│                    插件宿主（清单·生命周期·依赖·配置·权限）              │
└───────┬───────────┬───────────┬────────────┬───────────────────────────┘
        │扩展点（服务端一侧）    │            │
   ┌────┴───┐ ┌─────┴────┐ ┌────┴─────┐ ┌────┴─────┐
   │ 飞书   │ │Claude Code│ │  Codex   │ │知识/分拣/│  默认插件（plugins/）
   │渠道+连接│ │(服务端半) │ │(服务端半)│ │简报 …    │
   └────────┘ └──────────┘ └──────────┘ └──────────┘
                               ▲ WebSocket（代理主动连入，断线自动重连）
┌──────────────────────────────┴──── 执行机代理（apps/agent-node）────────┐
│ 会话发现与统一投影 │ 发送安全（去重·串行·读屏·确认） │ hook 本机 socket │
│ 插件的执行机一侧：Claude Code（hooks+transcript）· Codex（app-server）  │
│                   · 终端运行时宿主（创建会话·读屏·按键·画面流）          │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ 本机 IPC
                     终端运行时 daemon（PTY）+ Claude Code / Codex 进程
```

## 3. pi 在系统中的位置

### 3.1 用什么

| pi 能力 | 工作台怎么用 |
| --- | --- |
| `createAgentSession`（`@earendil-works/pi-coding-agent`） | 创建主对话会话。显式传入 `cwd`、`agentDir`、`modelRuntime`、`customTools`、`resourceLoader`、`sessionManager`、`settingsManager` |
| `customTools` | 注入插件贡献的工具和核心内置工具 |
| `DefaultResourceLoader` 的 `extensionFactories` | 只注册一个内联的“工作台桥接扩展” |
| `noContextFiles` / `noSkills` / `noExtensions` 等开关 | 关闭 pi 默认的目录发现和包加载；资源全部由核心按插件贡献显式提供 |
| `additionalSkillPaths`、`appendSystemPrompt` 覆盖 | 注入插件贡献的技能目录、全局工作原则 |
| 扩展事件（`before_agent_start`、`context`、`tool_call`、`message_end`、`agent_settled`、`session_shutdown` 等） | 由桥接扩展转成工作台事件，或调用工作台的上下文、策略、交互服务 |
| `CustomAgentMessages` + `convertToLlm` | 定义工作台自有消息类型，例如“任务结果回报”“待办提醒”，在对话中可见、可持久化 |
| `steer` / `followUp` | 用户在主 Agent 运行中发来的新消息，以及异步任务的结果，都排入 follow-up；用户明确要求打断时用 steer |
| `SessionManager`（JSONL 会话文件） | 保存主对话历史；重启后按文件恢复对话上下文 |
| `registerProvider`（经桥接扩展） | 模型供应商插件的落点 |

### 3.2 不用什么

| 不用 | 原因 |
| --- | --- |
| RPC 模式 | 子进程 stdin JSONL，EOF 即退出，不带重连和事件重放；SDK 同进程更直接 |
| pi 的项目资源自动发现与包安装 | SDK 默认信任项目资源，重载时可能安装包；工作台需要显式控制加载内容 |
| 直接把 pi 扩展开放给插件作者 | pi 扩展是进程内代码，生命周期与工作台插件不同；两套插件会让作者和维护都翻倍 |
| pi 作为外部执行者 | 首版执行者是 Claude Code、Codex；以后要用 pi 做执行者，按普通执行者插件接入 |

### 3.3 必须注意的 pi 行为

- `steer` 不抢占正在执行的工具。一批工具全部执行完才注入。因此**任何可能超过几秒的工作都不能写成同步工具**，必须走“工作编排”异步执行（第 4.6 节）。
- 取消是协作式的。工具必须响应 `AbortSignal`；不响应的工具会让会话无法及时停下。插件规范要求所有工具处理 signal。
- `agent_end` 不是最终结束信号，会话层可能重试或压缩；以 `agent_settled` 作为“这一轮已静止”的信号，它也不代表业务完成。
- 会话 JSONL 只恢复历史，不恢复运行中的 Promise 和内存队列。排队中的消息由核心持久化，重启后重新投递。
- 同一个 `Agent` 不能并发运行两次 prompt。核心为每个对话维护一个串行输入队列。

### 3.4 版本策略

- 固定 pi 精确版本，不用范围依赖。升级 pi 是一次独立的变更，需要跑桥接扩展的契约测试。
- 只在 `packages/core/src/agent-runtime/` 里 import pi。其他包和全部插件不直接依赖 pi。

## 4. 核心能力

每项写明职责、暴露给插件的接口、放在核心的理由。接口名是草图，M0 评审时可调整。

### 4.1 插件宿主

- **职责**：发现、校验、加载、启停插件；解析依赖；管理配置与密钥；登记并自动清理插件注册的一切资源；报告插件状态与错误。
- **为什么在核心**：所有插件的入口。
- **详见第 5 节。**

### 4.2 主 Agent 运行时

2026-11-17 补齐跨入口工作态势：每轮模型执行前从共享 SQLite 构建只读工作快照，Web 主对话与全局机器人均可看到各项目进度、未完成待办、执行状态/结果、待确认决定和电脑在线状态。全局知识只是指导原则，不能代替此快照。快照按当前机器人绑定范围过滤；项目/事项不因用户询问“全局”而扩大权限，未标记身份不提供业务事实。每组条数和文本长度有上限，附总数、遗漏数、记录标识和查询工具，模型按需查详情。不合并各机器人原始聊天，不把执行结束当成待办验收，不改变发送授权；每轮重建，不依赖本机器人是否收到其他执行结果通知。真实飞书收发仍需单独验收。

- **职责**：
  - 管理主对话（首版只有一个主对话；结构上支持多个，供以后的“项目负责人对话”使用）。
  - 用 pi 创建和恢复会话；每个对话一个串行输入队列（持久化）。
  - 汇总插件贡献的工具、技能、上下文提供者，组装进 pi。
  - 桥接 pi 事件到工作台事件总线，并实时推送到 Web。
  - 记录每次启动/恢复对话的结果，统计可用率。
- **暴露给插件的接口**：

```ts
interface AgentRuntime {
  post(conversationId, input: { text; source: SourceRef; urgent?: boolean }): Promise<{ accepted: true; inputId }>;
  inject(conversationId, msg: WorkbenchMessage): Promise<void>;   // 例如任务结果回报，作为 follow-up
  onEvent(handler: (e: AgentEvent) => void): Disposable;
}
// 扩展点：tools、skills、context_providers、model_providers（第 6 节）
```

- **为什么在核心**：主 Agent 是唯一的对话对象，工具和上下文的组装顺序、输入排队必须统一。

### 4.3 领域存储与事件

- **职责**：
  - 项目是持久工作区，绑定电脑和真实目录；一次执行只是项目里的执行尝试。目录由电脑代理只读发现，显式导入后保存绑定，不在服务端扫描远端文件系统。旧项目可补绑目录，历史数据不迁走。
  - 保存核心实体：项目、对话、知识条目索引、收件箱条目、待办、执行者、机器、执行尝试、交互卡片、副作用记录。
  - 进程内事件总线；关键事件落库，用于重启后补投递和 Web 重连补齐。
  - 给每个插件一个独立的存储命名空间（表名前缀 + 迁移脚本）。
- **接口**：

```ts
interface Store { tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> }
interface PluginStore { migrate(steps: Migration[]): Promise<void>; kv: KV; sql: ScopedSql }  // 只能访问本插件命名空间
interface EventBus { publish(e: DomainEvent): void; on(type, handler): Disposable }
```

- **为什么在核心**：实体是插件之间的共同语言；状态词表必须唯一（第 9 节）。
- **现状与差距（2026-11-16 核对代码）**：`events.ts` 只是“落库的进程内通知”，没有按订阅者的进度，重启后不补投递，WS 也没有游标，上面“补投递、重连补齐”尚未实现。需要可恢复的后台事件时使用 4.13 的事件收件箱，不改本总线的语义。

### 4.4 副作用账本

- **职责**：所有对外部世界有影响的操作（发消息、启动执行、向终端输入、执行命令、创建外部任务）都经过账本：
  1. 登记操作：类型、目标、内容摘要、幂等键、所需批准。
  2. 检查策略与批准：没有批准的不执行。
  3. 执行并记录结果：`pending → sent → confirmed / failed / unknown`。
  4. 相同幂等键重复请求时，返回已有结果，不重复执行。
  5. 服务重启后，`sent` 但未确认的操作标为 `unknown`。当前不提供通用 `reconcile` 回调；在发件箱由用户核实送达情况，只有明确未送达才使用新的尝试 key。已失败的旧 key 也不会被复用。
- **接口**：

```ts
interface Effects {
  perform<R>(op: { key; kind; target; summary; content?; run: () => Promise<R> }): Promise<R>;
  list(): EffectRecord[];
}

```

- **为什么在核心**：这是二期“一键同意后 AI 代执行”的地基。批准绑定到具体操作和内容版本，只有核心能统一保证。首版就建，首版的“发送机器人回复”“启动执行”都走它。

### 4.5 交互卡片

- **职责**：统一管理“需要人回应的事”：Agent 提问、工具权限、计划审批、终端对话框、表单、通知。
  1. 来源登记：来自哪个对话、执行尝试、待办。
  2. 路由梯级：按“自动处理策略”（第 4.12 节）逐级处理。默认梯级为：常设规则 → 督办对话（第 4.9 节）→ 主 Agent 代答 → 推送给用户（Web、飞书卡片）。梯级的顺序、每级停留时间、哪类卡片允许哪一级处理，全部由配置决定；督办对话也可以主动上报（`escalate`）。
  3. **审批的默认规则**：默认配置下，权限卡（`permission`）和计划审批（`plan`）只能由常设规则或用户本人处理，并有 15 分钟期限，到点推送给用户。用户可以在配置中放宽（例如允许督办对话批准某个项目目录内的只读命令）；放宽审批的规则在界面上标为高风险，每次自动批准都记录命中的规则。
  4. 生命周期：`open → answered / expired / withdrawn`；同一卡片只接受第一个有效回答，其余设备收到“已被处理”。发起方停止等待时（例如 CLI 已退出），卡片自动撤回。
  5. 回答回传：把回答交给发起方插件（执行者插件把它变成 CLI 的输入或权限决定）。
  6. 统计：记录卡片首次推送给用户的时间 `userNotifiedAt`（打扰次数只按它计）；被督办拦下、被规则自动处理、来自临时测试目录的卡片单列，不计入打扰。
- **接口**：

```ts
interface Interactions {
  open(card: { kind: "question" | "permission" | "plan" | "screen" | "form" | "notice"; origin: OriginRef; title; body; options?; expiresAt?; policyHints? }): Promise<CardHandle>;
  // CardHandle.answered: Promise<Answer>；发起方可 withdraw()
  decide(card): Promise<PolicyDecision>;            // 按第 4.12 节的策略算出由哪一级处理、用哪条规则
}
// 扩展点：interaction_policies（插件提供的额外判定器，例如“CI 已通过”的核实）、channels 中的卡片呈现能力
```

- **为什么在核心**：远程接管的“回答、审批”和二期的“一键同意”都依赖它；打扰统计必须集中。

### 4.6 工作编排

- **职责**：管理“谁在哪台机器上执行什么”。
  - 执行者目录：执行者 = 执行者类型（由执行者插件提供）+ 机器 + 工作目录 + 凭证引用 + 能力描述。
  - 任务计划：主 Agent 调用 `task_plan`，一次把用户目标拆成 1–8 个任务。会修改文件或外部状态的任务（可写任务）必须带验收标准 `doneWhen` 和预计时长 `expectMinutes`，缺任一项时核心直接拒绝。任务的来源、发起人、仓库等字段由核心填写，不采用模型传入的值。
  - 开始条件：只读任务、用户在对话中亲口要求的任务、命中常设信任规则的任务自动开始；其余任务生成计划卡，等用户点“开始”。
  - 派活：任务开始时由工作编排调用 `dispatch`，立即返回执行尝试 ID；执行在后台进行，不阻塞对话。一个执行会话同时只挂一个活跃任务（数据库唯一约束）。
  - 执行尝试状态机（第 9 节），状态由执行者插件上报，并记录信号来源。
  - 远程接管动作：回答、批准、输入、中断、恢复、打开控制台，统一入口，经执行机代理转给执行者插件的执行机一半。
  - 执行结束后：把结果作为工作台消息注入发起的对话；关联待办则更新待办的执行记录（不自动标记待办完成）。
- **接口**：

```ts
interface Work {
  dispatch(req: { executorId?; requirement?: string; prompt; cwd?; todoId?; conversationId; idempotencyKey }): Promise<{ runId }>;
  control(runId, action: { type: "input"; text } | { type: "interrupt" } | { type: "resume" } | { type: "cancel" }): Promise<EffectResult>;
  get(runId): Promise<Run>;
  listExecutors(filter?): Promise<Array<Executor & { online: boolean }>>;  // 在线状态实时核验
}
// 扩展点：executors、terminal_hosts（第 6 节）
```

- **为什么在核心**：主 Agent、待办、Web、飞书都要派活和查状态；“执行结束 ≠ 业务完成”的语义要统一。

### 4.7 渠道管线

- **职责**：外部 IM 与主 Agent 之间的公共流程：
  - 入站：渠道插件交来消息 → 核对绑定的用户 → 立即回“处理中” → 投递给主 Agent 对话（带来源）。
  - 出站：跟踪这一轮对话，把最终回答送回原会话；中间进度按渠道能力合并或省略。
  - 卡片：把交互卡片按渠道能力呈现（飞书卡片按钮），回调转为卡片回答；回调重放不重复处理。
- **接口**：渠道插件实现 `ChannelAdapter`（第 6 节），核心实现其余部分。
- **为什么在核心**：参考产品验证过的做法——“核心跑公共管线，扩展只对接 IM”。新增微信、Slack 时只写适配器。

### 4.8 网关

- **职责**：HTTP/WS 服务、单用户登录、Web 实时事件推送（带游标，重连补齐）、插件路由挂载（`/api/v1/x/<pluginId>/…`）、终端 WS 通道的鉴权与转发。
- **为什么在核心**：统一认证和事件游标。

### 4.9 督办与通知

工作编排、交互卡片和主 Agent 运行时共同组成“少打扰”机制。这部分规则必须集中在核心，否则打扰次数统计不准。

- **督办对话**：核心自动维护一个后台督办对话（由 pi 创建的另一个会话，用户在 Web 可查看，默认折叠）。它默认接收任务卡片和巡检信号，不需要用户配置。它能回答哪些卡片由自动处理策略决定，默认不回答审批类卡片。
- **巡检循环**：下列时间都是默认值，可在 `supervision` 配置中修改。默认每 30 秒检查一次活跃任务，推导信号：
  - `review`：执行结束，待验收；
  - `idle`：执行者空闲但任务未结束；
  - `needs_you`：卡片等待超过 3 分钟；
  - `stalled`：运行超过 max(20 分钟, 预计时长 × 1.5)；
  - `orphaned`：执行会话丢失或执行者插件不可用。
  同类信号合并 15 秒后一起发出；发给督办对话的两条消息至少间隔 10 分钟，等待决定的信号至少间隔 2 分钟。
- **验收**：执行结束后，执行者插件交回结果和收尾块（做了什么、交付物、未完成项）。督办对话对照 `doneWhen` 判断，结论以验收卡交给用户。首版不做独立评审 Agent。
- **唯一通知出口**：所有“告诉用户”的动作只经过核心的 `notifyUser`，在这里写 `userNotifiedAt` 并按渠道推送。插件不能绕过它直接推送。向外部渠道的推送以 4.13 的发件箱记录意图、去重、窗口和状态，`notifyUser` 是它的上层；发送授权规则不因入箱而放宽。
- **默认安静**：任务默认不推送；督办轮次正常结束不推送，在界面折叠成一行。只有三类内容到达用户：主 Agent 显式调用“通知用户”、需要用户回答的卡片、验收结论卡。用户最近 2 分钟内刚说过话时，系统消息先排队，等用户这一轮结束再插入。
- **两级紧急度**：立即推送；或进入下一次简报。哪些内容立即推送、用户在场让路的时长，都在 `notify` 配置中设置。
- **可用率记录**：主 Agent 运行时只在一个出口（向对话投递输入）记录每次启动或恢复：`ok / failed / unknown`，失败原因分为：对话不存在、超时、机器离线、已取消、执行端错误码、内部错误。`unknown` 不算成功。
- **主对话连续性**：主对话 ID 保存在设置中，始终出现在对话列表；进程回收后用 pi 会话文件恢复。换新主对话时，旧主对话的开放任务和督办关系一起迁移。

```ts
interface Supervision {
  signals(): AsyncIterable<{ kind: "review" | "idle" | "needs_you" | "stalled" | "orphaned"; runId; todoId?; since }>;
  escalate(cardId, reason): Promise<void>;          // 督办对话上报给用户
}
interface Notify {
  notifyUser(n: { text; urgency: "now" | "brief"; origin: OriginRef; cardId? }): Promise<{ delivered: string[]; missed?: "no_device" | "filtered" | "held" }>;
}
interface NorthStar {
  read(day: string): Promise<{ interruptions: Counted; availability: { attempts; ok; failed; unknown; rate } ; partial: boolean }>;
}
```

### 4.10 收件箱与待办

连接器和分拣策略是插件，收件箱与待办的规则在核心。原因：去重、合并、版本化确认、自动归档的依据，这些语义必须统一，否则不同来源会各做一套。

- **收件箱事件按话题聚合**：连接器交来的每一项带稳定的话题键 `thread`（例如 `feishu:chat:<id>[:thread:<id>]`）和最新消息位置 `last`。同一个 `thread` 同时只有一个开放事件；`last` 变化表示“有新动静”，才触发重新分拣。
- **三级分拣**：`action`（需要处理）、`fyi`（知道即可）、`noise`（噪音）。判据是“用户不看这一条，会不会有人干等或耽误事”。分拣输出摘要、理由、是否紧急。模型失败时用连接器给的规则回退；没有回退的来源，这一轮不入库，下次再试。
- **静音与策略由代码执行**：优先级为发送人 > 聊天 > 来源。命中静音的直接归档，并记录依据。
- **处理链**：每个事件保存一条处理链（收到、分拣、建议、确认、归档、重开等），只记程序实际看到的步骤，并标明发生在哪（来源、用户、主 Agent、执行者）。
- **建议带版本号**：每个事件同一时间只有一条建议。确认时必须回传版本号，版本不符返回冲突，重复点击无效。首版只开放两种建议：`todo`（转成待办）和 `conclusion`（给出结论后归档）。`reply`（代回复）和 `agent`（派活）放二期，届时经副作用账本执行。
- **自动归档**：连接器报告“用户已在别处回复或已读”时自动归档，记录依据 `settledOf`。用户重开后，同一依据不再触发归档。误关比漏关代价大，判断不确定时不归档。
- **待办只存事实，状态派生**：数据库只存截止、提醒、完成时间、完成方式、等待对象等事实。页面分区（需要你、逾期、今天、等待中、之后、某天、刚完成、已完成）由服务端按决策表计算一次，Web 和简报共用。不采纳 Agent 对自己工作的自述作为完成依据。
- **等对方**：放在待办上（`waitingOn`），与收件箱事件的回看共用一个调度器：默认 24 小时后回看，连续 3 次没有进展就交还用户。来源有新消息时，待办从“等待中”回到“待处理”。
- **提醒**：到点先认领（条件更新 `remindedAt`）再推送，保证只推一次；修改提醒时间时清空认领。

本轮补齐（2026-11-16）：项目→待办→编辑提供截止日期和提醒时间，允许留空取消。日期与时间按浏览器本地时区显示和输入，提交继续使用现有 ISO 时间字段；不新增实体、调度器或发送权限。未修改时间字段时不提交该字段，保留原始秒数、时区表示与 `remindedAt` 认领，避免只改标题导致再次提醒。修改或清空提醒复用原 PATCH 和持久事件管线。界面说明全局提醒开关及渠道授权条件，不承诺手机推送或实际外发成功。参考能力与差距见 [功能清单](feature-inventory.md)。

```ts
interface InboxService {
  ingest(source: string, things: InboxThing[]): Promise<void>;     // 核心按 thread 去重、聚合、触发分拣
  confirm(itemId, version: number, edits?): Promise<{ todoId? }>;   // 版本不符抛冲突
  reject(itemId, version: number, instruction?: string): Promise<void>;
  reopen(itemId): Promise<void>;
}
interface TodoService {
  create(t: TodoInput): Promise<Todo>;
  update(id, patch): Promise<Todo>;
  complete(id, by: "user" | "inbox_settled", reason?): Promise<void>;
  sections(now?): Promise<Record<TodoSection, Todo[]>>;               // 服务端统一计算
}
```

### 4.11 机器连接与执行机代理（远程接管的底座）

远程接管指：Agent 在执行机上运行，用户从 Web 或飞书实时看、回答、审批、输入、中断，回到电脑前接着用同一个会话。它的前提是 **Agent 始终跑在执行机终端运行时的一个终端里**：Web 只是“另一个终端”，不把会话改成后台无界面模式。

**分工**

| 位置 | 持有什么 | 不持有什么 |
| --- | --- | --- |
| 服务端核心 | 机器登记与信任、会话投影的最新副本、卡片生命周期、发送去重表、事件游标 | 不直接碰终端和 CLI 进程 |
| 执行机代理 | 本机会话发现、hook socket、transcript 读取、发送队列、终端运行时调用 | 不持久保存业务状态 |
| 执行机插件半边 | 每种 CLI 的具体做法（见 6.1） | — |

**连接**

- 执行机代理用机器凭据主动连接服务端 WebSocket，带心跳和连接代号（generation）；断线后自动重连，新连接替换旧连接。一条出站连接就能穿过 NAT，不需要 SSH、端口映射或打洞。
- 新机器首次连接时进入“待确认”，用户在 Web 确认归属后才可接收任务。机器角色至少两档：完全控制、只读。
- 代理与服务端断线期间：会话照常运行；hook 卡片在本机等待，服务端为可恢复的卡片保留 3 分钟宽限；事件在代理内排队，重连后补发。

**统一会话投影**

- 代理按固定顺序发现本机会话：终端运行时里的面板、插件识别出的 CLI 会话、离线历史。合并成统一的会话行：机器、会话 ID、CLI 原生会话 ID、终端位置、状态、`capabilities`（可回答、可审批、可发送、可中断、可恢复、可看终端）。
- 每一行能做什么以 `capabilities` 为准。Web 按它显示按钮，服务端执行前再校验一次。
- **只接管自己启动的会话**：由工作台启动的会话通过启动时注入的 hook 绑定会话 ID，可写；其他会话只读展示。会话绑定不确定时拒绝写入，不猜。
- **单写者**：已停止的会话只读，需显式点“恢复”；恢复前检查是否已有进程打开同一会话，有则拒绝（`open_elsewhere`）。服务重启后不自动继续被打断的工作，避免重复执行工具调用。

**正文与实时输出**

- 正文来自 CLI 自己的记录（Claude Code 的 transcript、Codex 的 rollout 或协议事件），代理每 250 毫秒读取新增内容，解析为带序号的条目。
- Web 订阅时带 `sinceSeq`；推送带 `fromSeq/toSeq`，缺口用 HTTP 分页补齐。订阅队列满时断开，由客户端按序号重订阅，不静默丢条目。

**发送输入（最危险的动作）**

四层共同保证“同一条消息只执行一次，结果不确定时不自动重发”：

1. Web：每条消息带 `clientMsgId`，本地先显示“发送中”。
2. 服务端：`clientMsgId` 持久去重。已送达直接返回成功；正在发送或结果未知时返回 `unknown`，**不再发**。
3. 执行机代理：内存再去重 10 分钟；同一会话的发送排队，一次只发一条。终端路由先读屏：有对话框返回 `dialog_open`，输入框里有用户在电脑上没发出的草稿返回 `input_draft`，都不发送。
4. 确认：发送后在 transcript 中找到这条消息才算送达；15 秒内找不到，记为 `unknown`。transcript 中匹配的用户行带上 `clientMsgId` 推给 Web，Web 据此收起“发送中”。

结果三态：已送达 / 未送达（可换新 ID 重发）/ 不确定（只提示，不重发）。

**卡片与终端的关系**

- 卡片 ID 由会话、事件、工具调用 ID 计算得出，重启后能接上同一张卡。
- 电脑终端和 Web 同时可答，**先答者生效**，另一侧撤卡。用户也可以点“交还电脑”，卡片撤销，CLI 回到原生终端对话框。卡片 30 分钟未答也回到终端。
- hook 覆盖不到的终端对话框（信任目录、模型选择等）由代理读屏生成 `screen` 卡，附画面版本号 `rev`。回答时代理重新读屏比对 `rev`，不一致返回 `prompt_changed`，什么键都不按，并生成新卡。首版只解析单选数字菜单、信任目录、权限菜单；解析不了的显示“打开终端”。

**终端控制台**

- 结构化接管（卡片、发送、正文）是主路径，终端控制台是兜底：解析失败的对话框、shell 操作、直接观察。
- 首版只做单面板画面流：每条连接独立 epoch/seq，先全量后增量；同一时间只有一个控制者，其余只读；释放控制时归还原尺寸，不抢走电脑上用户的终端。
- 完整工作区视图（与电脑共享布局）放到以后。

```ts
// 服务端核心暴露给插件和 Web 的机器接口
interface Machines {
  list(): Promise<Array<Machine & { online: boolean; trust: "pending" | "trusted"; role: "full" | "read" }>>;
  sessions(machineId?): Promise<SessionRow[]>;          // 统一投影
  call<T>(machineId, method: string, params): Promise<T>;  // 调用执行机侧插件方法，按 capabilities 校验
  send(ref: SessionRef, text, clientMsgId): Promise<{ delivered: "yes" | "no" | "unknown"; reason? }>;
}
interface SessionRow {
  machineId; sessionId; nativeSessionId?; executorType; title; cwd;
  state: "starting" | "working" | "waiting_input" | "waiting_approval" | "idle" | "stopped" | "unknown";
  stateSource: string;                                   // 状态来自 hook、协议还是读屏
  capabilities: Array<"answer" | "approve" | "send" | "interrupt" | "resume" | "terminal">;
  writable: boolean;                                     // 只有自己启动并已绑定的会话可写
}
```


### 4.12 可配置的自动处理策略

**原则：规则是数据，不是代码。** 卡片由谁处理、能否自动处理、多久上交、督办节奏、何时打扰用户，全部存在设置里。核心只提供默认值和执行引擎；插件可以增加判定器，但不能绕过策略。

**配置层级**：全局设置 → 项目设置 → 单个任务（`task_plan` 中可带覆盖项）。下层覆盖上层；每条决定都记录来自哪一层、哪条规则。

**规则模型**：规则按顺序匹配，第一条命中生效；都不命中时使用梯级默认值。

```yaml
# 设置 → 自动处理（Web 有表单编辑；也可导入导出）
interactions:
  ladder: [rules, supervisor, main_agent, user]   # 可删减、可调序；user 必须在最后
  escalateAfterMinutes: 5                          # 每一级未处理多久后上交
  rules:
    - id: approvals-to-user                        # 默认规则：审批交给用户
      match: { kind: [permission, plan] }
      handler: user
      deadlineMinutes: 15
    - id: trust-workspace-dirs
      match: { kind: screen, screenKind: trust_dir, cwdUnder: ["~/code-work"] }
      handler: rules
      answer: trust
    - id: questions-to-supervisor
      match: { kind: question }
      handler: supervisor
      mode: auto                                   # auto 直接回答 | suggest 给出建议答案后仍交用户 | off 跳过这一级
supervision:
  tickSeconds: 30
  needsYouMinutes: 3
  stalledMinutes: { min: 20, factorOfEstimate: 1.5 }
  batchSeconds: 15
  minGapMinutes: { digest: 10, decision: 2 }
notify:
  quietByDefault: true
  immediate: [notify_user_now, card_to_user, review_verdict]
  yieldToUserSeconds: 120
```

**匹配条件**：卡片种类、终端对话框种类、执行者类型、机器、项目、工作目录前缀、工具名、命令模式、待办来源、时间段。

**处理方式**：`rules`（按规则直接给出答案）、`supervisor`（督办对话）、`main_agent`（主 Agent）、`user`（推送给用户）。Agent 处理时可选 `auto` 或 `suggest`。

**安全默认与可追溯**：

- 默认配置偏保守：审批交给用户；Agent 只回答普通提问。
- 放宽审批的规则标为高风险，保存时提示一次。
- 每次自动处理都在卡片上显示“由规则 X 处理”，并可一键撤销该规则。
- 被规则或 Agent 处理的卡片单独计数，不计入打扰次数，但在简报中列出数量。
- CLI 自身的会话级“总是允许”（例如 Claude Code 的会话规则）照常可用，记录为来源 `cli_session`。

```ts
interface PolicyDecision {
  handler: "rules" | "supervisor" | "main_agent" | "user";
  mode?: "auto" | "suggest";
  answer?: Answer;                 // handler 为 rules 时
  ruleId?: string; layer: "global" | "project" | "task" | "default";
  deadlineAt?: string;
}
interface PolicyEvaluator {        // 扩展点 interaction_policies：插件补充判定条件
  id; evaluate(card, facts): Promise<"match" | "no_match" | "unknown">;   // unknown 视为不命中
}
```


### 4.13 常驻运行：持久事件、调度与发件箱

状态：2026-11-16 已实现。运行模块为 `eventbox.ts`、`schedules.ts`、`outbox.ts` 和装配层 `background.ts`；以下保留设计依据，实际接口以 SDK 与测试为准。用户已认可：单机版本、事件机制、事件收件箱、发件箱、定时调度，并向外部插件公开。下文其余具体选择（表结构、状态名、默认值、阶段顺序）是设计建议，不是用户逐项确认；真正需要用户拍板的事见本节末尾。外部背景只作参考：常驻 Agent 不是一直运行，而是“事件进入持久收件箱 → 一次短 run → 保存状态 → 休眠”；等待时不占模型；调度器只往收件箱投递到期事件；先用普通代码检查变化，必要时才调用模型。

**为什么需要它**：现在的“事件”只有进程内通知。进程在“数据库已提交”和“观察者已处理”之间退出，这条通知就丢了，且没有任何记录说明谁处理到哪。督办提醒、结果回送、飞书通知都靠这种通知，所以每处都各自补了一套“先认领再发”的小机制。事件收件箱把这套机制收成一处。

#### 四个容易混淆的概念（不合并）

| 概念 | 是什么 | 现状 / 位置 |
| --- | --- | --- |
| 消息收件箱 | 业务用户的外部消息，经分拣后由用户确认转待办 | 已有，`packages/core/src/inbox.ts`，集合 `inbox` |
| 通知总线 | 进程内“有变化了”广播，驱动 Web 刷新和内部观察者；不保证送达 | 已有，`packages/core/src/events.ts`，集合 `core.events` |
| 事件收件箱 | 后台持久事件及每个订阅者各自的投递进度，供插件和核心处理器消费 | 新增，集合前缀 `eventbox.` |
| 发件箱 | 对外发送的意图、去重、时间窗口与状态；真正发送仍经副作用账本 | 新增，集合前缀 `outbox.` |

规则：消息收件箱的条目不是事件，反之亦然。二者可以通过事件关联（例如新增 `inbox.item.created` 事件），但不共用表、状态和 Web 页面。通知总线保持原语义，只在事件收件箱或发件箱状态变化后发 `eventbox.changed`、`outbox.changed` 让 Web 刷新。

#### 现有能力、缺口与复用

| 能力 | 现有实现（位置） | 缺口 | 复用方式 |
| --- | --- | --- | --- |
| 事件落库 | `events.ts:9-24` 在 `store.transaction` 内写 `core.events` 并自增 id；观察者异常被吞掉 | 无来源 ID 去重；无类型版本、关联任务、因果；无按订阅者的进度；已补 30 天默认保留和数字游标；旧实现的 `since()` 为全表读取后过滤（`events.ts:31-33`）；除测试和 SDK 外无人调用，重启后不补投递，WS 也不带游标（`apps/server/src/index.ts:231-238`） | 保留原样作通知总线。新事件另存 `eventbox.*`，不改 `core.events` 语义 |
| 存储与事务 | `store.ts`：SQLite 单表 JSON 文档，同步保存点事务，拒绝异步回调（`store.ts:34-51`） | 无按状态/到期时间索引，`list` 扫整个集合；无 claim 原语 | 单进程内同步事务就是原子的：认领 = 事务内读状态再写状态。首版沿用 JSON 文档，不加表；超过阈值再换专用表（决策见下） |
| 去重与版本 | 消息收件箱用 `sha256([source,thread])` 作 ID，`last` 变化才更新（`inbox.ts:60-64`）；交互卡、审批、计划均带 `version` 且回答时校验 | 督办信号用 `run.updatedAt` 当版本（`supervision.ts:64`），时间戳会造成伪更新 | 事件 ID = hash(来源,来源事件ID)，由主键保证去重；过期判断复用各对象的 `version` |
| 先认领再发布 | `supervision.ts:95-96,118`：事务内写 `remindedAt` 和信号，提交后才 `publish`；`supervisor-agent.ts:47-53` 内存订阅，`processed` 集合去重，并从开放信号重新补齐 | 提交与发布之间退出，提醒已被认领却永远没人收到；内存 `pending` 重启即丢（靠开放信号补回，但仅限督办） | 检测逻辑保留（普通代码先检查变化）；把“提交后 publish”改成“同一事务内追加事件”，保留开放信号补齐作为对账 |
| 外部动作账本 | `effects.ts`：先落 `sent` 再做 I/O；重启把 `sent` 改 `unknown`（`effects.ts:19-21`）；同 key 不同内容拒绝；`unknown` 不重发 | 同 key 在 `failed` 后也不允许再试（`effects.ts:38-44`）；设计文档里的 `reconcile` 核对方法未实现 | 发件箱每次尝试用新 key `outbox:<id>:<尝试号>`，仅在确定未发（`delivery:'no'`）后递增；`unknown` 停下等人核实 |
| 等待确认 | `approvals.ts:107-124`：审批保存 `kind+params+version`，批准时事务内认领，结果不确定记 `unknown`；`interactions.ts:95-110` 认领后才投递回答，卡片有期限 | 回答只走进程内回调，不产生可恢复的事件；插件不能发起；`Approval.kind` 是封闭枚举（`approvals.ts:41`） | 审批 = 具体动作快照，卡片 = 问题。两者在决定时追加 `approval.decided` / `interaction.answered` 事件，恢复处理器先复核再继续 |
| 会话串行 | `agent-runtime/index.ts:268-269` 主 Agent 输入走一条串行队列；`workbench.ts:265-300` `dispatch` 有幂等键 `dispatch-keys` | 没有“按 key 串行”的通用处理；委派 Run 是异步的，没有“Run 结束后接着做”的持久衔接 | 事件带 `serialKey`，同订阅者同 key 同时只跑一个；委派只调用已有 `dispatch`（用事件 ID 作幂等键），Run 结束再发 `run.finished` 事件接续 |
| 重启恢复 | `workbench.ts:191-195` 把 `running/queued` 的 Run 标 `unknown`；`plans.ts:90-96`、`approvals.ts:72` 同理；`run-monitor.ts` 轮询原生结果 | 恢复策略分散，但方向一致：不重放外部动作 | 沿用“重启后不确定就标 unknown”，事件投递按处理器声明区别对待（见“恢复”） |
| 调度 | `supervision.ts` 一个 `setInterval` 计时（`schedule()`），`workbench.ts:122` 交互卡过期计时 | 没有通用调度；文档 8.4 写“核心调度器触发 daily-brief”，但代码里 `routines` 贡献没有任何消费者（`plugins/index.ts:173-176` 只登记） | 督办巡检保留为“检测器”；新调度器统一承担到点触发，并补上 `routines` 的缺口 |
| 插件宿主 | `plugin-host.ts:212-214` 事件发布/订阅按权限控制，`own()` 登记的清理在停用时执行（`plugin-host.ts:224-228`）；权限正则在 `plugin-sdk/src/permissions.ts` | 无持久订阅、调度、发件箱入口；权限串里没有对应项 | 新能力用同一 `contribute`/`ctx.*` 与权限串机制，停用时同一套释放 |
| 飞书发送 | `apps/server/src/feishu.ts:34` `send` 经 `effects.perform`；回复靠内存 `replies` Map 和进程内订阅（`feishu.ts:19,46`）；审批 `feishu-reply` 可发任意会话（`workbench.ts:176-177`） | 只回复用户发起的对话，没有“主动通知配对用户”的出口（`feishu.ts` 对无 `replyTo` 的通知直接丢弃）；重启后未发回复不补 | 发件箱的飞书渠道调用同一个 `send` 和 `channel.send` 钩子；目标 `owner` 取自配对记录 |

#### 最小协议

**事件**（集合 `eventbox.events`，只追加）：

| 字段 | 含义 |
| --- | --- |
| `id` | `hash(source, sourceId)`；同一来源事件重复投递得到同一 ID |
| `seq` | 单调递增序号，供游标和排序；不是去重依据 |
| `source` | 发布者，由宿主按调用方固定填写，调用方不能指定：核心代码为 `core`，插件为自己的插件 ID。类型前缀按 `source` 决定：`core` 的事件使用核心保留前缀（`run.`、`supervision.`、`supervisor.`、`approval.`、`interaction.`、`schedule.`、`todo.`、`outbox.`）；插件事件的类型必须以 `<pluginId>.` 开头。插件 API 发布保留前缀的事件一律拒绝，因此无法伪造核心事件 |
| `sourceId` | 来源自己给的稳定事实标识，例如 `run:<id>:result`。必须描述“发生了什么事实”，不得含当前时间 |
| `type` / `typeVersion` | 如 `run.finished` v1。破坏性变更升版本，旧版本在迁移期并存 |
| `data` | 纯 JSON，≤64KB。大内容放引用，不放正文 |
| `subject` / `serialKey` | 关联的任务、会话或执行，如 `{kind:'run',id}`；`serialKey` 默认取 `subject` |
| `causedBy` / `rootId` / `hops` | 因果链：上一个事件 ID、链根、深度；宿主计算深度；超过 8 拒绝追加，当前投递转 `failed`，保留原因，防止自激循环 |
| `staleIf` | 可选。`{ref:'schedule:<id>', version:n}`：投递或发送时该对象版本不等于 n 或已不存在，则判过期跳过 |
| `createdAt` | 事件时间，仅供显示 |

去重规则：相同 `(source, sourceId)` 且内容相同 → 返回已有事件（`duplicate:true`）；内容不同 → 拒绝并报错 `source_id_conflict`，不覆盖。要表达“同一对象又变了”，来源必须换一个包含新版本的 `sourceId`（如 `todo:<id>:v3`），而不是用时间戳。

**订阅与投递**：订阅分两部分。
- **持久订阅记录**（集合 `eventbox.subs`，ID `<拥有者>/<名称>`）：保存类型与版本、`subjectKind`、`effects`、`serial`、重试策略、状态 `active | inactive`、`registeredAt`、`inactiveSince`。它是订阅的身份，激活、停用、重启都不丢。
- **内存处理器**：只是激活时挂上的回调（`ctx` 登记，停用时由宿主摘掉）。回调不持久，也不决定谁有订阅。

激活时按 ID 升级持久记录（新建或更新定义，状态置 `active`）并挂回调；停用时只把记录置 `inactive`、摘掉回调，**不删记录**。追加事件时，在同一事务内为每条匹配的持久订阅记录（`active` 和 `inactive` 都算）创建一行投递（集合 `eventbox.deliveries`，ID `<订阅>:<事件>`）。`inactive` 订阅的投递保持 `pending`，调度器不派发；重新激活后按创建顺序派发。这样停用期间的事件不会被静默丢弃，某个订阅者失败或停用也不阻塞别的订阅者。订阅的类型列表变化时，新增类型只接收变化之后的事件。新订阅默认只接收登记之后的事件，显式要求才回溯（有上限）。从未激活过的插件没有订阅记录，也不会积压事件。

投递状态：

```
pending ──认领──▶ running ──▶ done                （处理完成，可带 outcome）
   ▲                 ├──────▶ skipped              （无需处理：无变化、已过期、已取消）
   │                 ├──────▶ retry_wait ─到点─▶ pending
   │                 ├──────▶ failed               （重试用尽或不可重试，Web 可见，可手动重试）
   │                 └──────▶ unknown              （处理器声明直接做外部动作，进程中途退出）
   └── 启动回收 running（见“恢复”）                cancelled（调度取消、订阅者被清理）
```

**处理器**：普通代码函数，或显式委派（委派 = 调用已有 `dispatch`/计划，不是“让模型随便看着办”）。结果为 `done | skip | retry | failed`；抛出异常按可重试处理，除非错误带 `retryable:false`。处理器必须按事件 ID 幂等。模型调用只在处理器判断“需要”之后才发生：先读状态、比对摘要，无变化则 `skip`。

**同会话串行**：同一订阅者、同一 `serialKey` 同时最多一个 `running`；不同 key 并行，上限默认 4。等待用户或等待 Run 时不占槽：处理器把等待交给审批/卡片/Run 后即 `done`，后续由新事件（`approval.decided`、`run.finished`）再触发一次新投递。主 Agent 对话本身已由运行时队列串行（`agent-runtime/index.ts:268`），事件层不加全局锁。

**重试**：默认最多 5 次，退避 10 秒、1 分、5 分、30 分、2 小时（可按订阅覆盖）。用尽转 `failed`，保留错误与尝试次数。Web 手动重试把投递放回 `pending` 并记录操作人。

**恢复**：单进程，启动时所有 `running` 投递都属于已死亡的上一个进程，立即回收，不需要租约过期时间。回收规则取决于订阅声明的 `effects`：
- `ledger`：处理器声明它的外部动作**只**经本机的 `effects`、发件箱或带幂等键的 `dispatch` → 回 `pending` 重投。保证是有条件的本地去重：同一个动作 key 在本机最多尝试一次；**远端是否执行过不做保证**，`effects` 记为 `unknown` 的动作停下来等人核实，不自动重发。
- `none`：只读写本库，不调用模型、不联网 → 回 `pending`。
- 调用模型的处理器不能声明 `none`。只读模型调用（不改业务状态，只产生费用）按 `ledger` 处理，条件是：模型只经宿主 `agent` 服务调用，不在处理器里直接联网；结果在同一事务内按事件或信号 ID 本机去重落库。重投可能让**同一请求被模型再次计费**，这是明确接受的成本，不会产生第二份结论。
- `direct`：处理器自己做 I/O，或无法证明受控 → 标 `unknown`，等人核实，不自动重投。

`effects` 是必填字段，没有默认值；不能因为插件“没写”就当作受控。可执行的约束：（1）核心处理器由代码评审确认；（2）插件订阅声明 `ledger` 或 `none` 时，`npm run lint:plugins` 的 AST 检查拒绝该文件导入 `node:net`、`node:http(s)`、`node:dns`、`node:child_process`、写文件的 `node:fs` API 或调用 `fetch`，违反时 CI 失败，需要这些能力就改声明 `direct`；（3）这是依赖边界检查，不是沙箱（5.5），恶意同进程代码无法被它阻止。

不承诺 exactly-once：处理器至少执行一次，外部副作用只有在上述条件下才有本机去重。多进程共享同一数据目录不在支持范围；若以后需要，再加 `leaseUntil` 和续租，现在不预留。外部操作结果不确定时：先查结果（有核对方法就用），没有就停在 `unknown`，不自动重复派发。

**保留**：事件与终态投递默认保留 30 天（配置项）；`failed`/`unknown` 不自动清理。`inactive` 订阅的 `pending` 投递从**事件创建时刻**起保留 7 天，到期由清扫任务转 `skipped(expired)`，并在订阅上记录丢弃数量，Web 可见；7 天内重新激活的订阅会收到全部积压事件（依赖 `staleIf` 判断哪些已过期）。`core.events` 另行默认保留 30 天，数字 ID 游标通过 SQLite 索引读取，单页上限 1000；通知总线仍不保证投递。

#### 调度

集合 `eventbox.schedules`，调度器是一个普通定时器（默认每 5 秒扫描到期项），不调用模型。

| 字段 | 含义 |
| --- | --- |
| `id`、`owner`、`name`、`version` | 拥有者为 `core` 或插件 ID；修改或取消 `version+1` |
| `kind` | `once`（绝对时间，必须带时区偏移）、`interval`（`everySec`≥10，从 `anchorAt` 起算，不从“现在”漂移）、`cron`（五段，**必须**写 `tz`，IANA 名称，不隐式用服务器时区） |
| `nextAt` / `lastFiredFor` | 下一个计划时刻、上一个已触发的计划时刻 |
| `missed` | `coalesce` / `skip` / `catch_up`(带 `catchUpMax`)。默认：`once` 迟到也触发一次；`interval`、`cron` 合并为一次，带 `missedCount` |
| `status` | `active` / `paused` / `done` / `cancelled` / `owner_disabled` |
| `payload` | 调用方提供的业务载荷（纯 JSON，≤4KB）。到点追加的事件固定为核心事件 `schedule.due` v1，`source=core`，`data = {scheduleId, scheduleVersion, owner, name, scheduledFor, missedCount, payload}`；调用方不能指定事件类型或来源 |

**投递过滤**：`schedule.due` 对插件订阅按 `owner` 过滤，插件只收到 `owner` 等于自己的；核心订阅可收到全部。插件因此既不能伪造核心事件，也读不到别人的调度。

**同事务**：每个到期调度在一个 `store.transaction` 内完成“追加事件 + 推进 `nextAt` + 更新 `lastFiredFor`”。事件 `sourceId = schedule:<id>:v<version>:<计划时刻>`，用**调度版本和计划时刻**，不用当前时间：同版本同时刻重放得到同一事件，被去重挡住；改动后的同一时刻因版本不同是另一个事件，不会和旧事件冲突，也不会误绑定旧版本。事件带 `staleIf:{schedule:<id>, version}` 与 `scheduleVersion`。

**修改、取消、恢复**：改时间、改内容、暂停、恢复、取消都 `version+1`，并在同一事务内重算 `nextAt`。规则：
- 旧版本已追加但未处理的事件，认领时发现版本不符 → `skipped(stale)`；取消同时把该调度未开始的投递置 `cancelled`。
- 修改后落在同一计划时刻的触发，`sourceId` 含新版本，是新事件；旧事件按上条跳过，两者不冲突。
- 恢复（含插件重新启用）不重放被暂停期间的旧时刻：`nextAt` 从恢复时刻按 `missed` 规则重算，`coalesce` 最多补一次，事件用新版本和对应计划时刻作 `sourceId`。
- 已经 `running` 的处理器收不到撤回，所以发件箱条目也携带 `staleIf`，发送前再核一次。

**时区与夏令时**：cron 在指定时区计算。本地时间不存在（春季跳时）顺延到下一个有效分钟；重复（秋季回拨）只取第一次。首版阶段先做 `once`/`interval`，`cron` 与时区放到后一阶段，避免一次引入日期库的全部风险（选型见下“工程建议”）。

**插件停用**：该插件的调度转 `owner_disabled`（版本 +1），不触发、不删除；它的持久订阅记录转 `inactive`，期间追加的事件照常建 `pending` 投递，保留 7 天（见“订阅与投递”“保留”）。重新启用时订阅回到 `active` 并按序处理积压，调度回到 `active`，按 `missed` 规则最多补一次（默认合并）。“卸载”（用户在 Web 明确选择清理插件数据）才删除订阅记录、取消调度、取消未开始投递和未发送的发件箱条目；已发送记录保留。停用不撤回已发出的消息，与 5.4 一致。

#### 发件箱

集合 `outbox.items`，只记录“要发什么、发给谁、何时可发”，**不**因入箱而获得发送权限。

| 字段 | 含义 |
| --- | --- |
| `id`、`version`、`owner` | 发布者（核心或插件 ID） |
| `dedupKey` | 必填，`(owner, dedupKey)` 唯一。同键同内容返回已有条目；同键不同内容拒绝 |
| `channel` / `target` | 如 `feishu.bot` / `owner`（配对用户的私聊）或具体会话 ID |
| `content` / `contentHash` | 文本及哈希，用于账本指纹 |
| `relatedTo` / `causedBy` | 关联待办、执行、卡片；产生它的事件 ID |
| `window` | `notBefore`、`expiresAt`；过期转 `expired` 不再发。当前逐条发送；同 batchKey 合批不在本轮完成范围，未提供该字段 |
| `staleIf` | 同事件，发送前复核 |
| `status` | `queued → needs_approval → sending → sent`；其他：`held`（未到窗口、发布者停用或渠道未就绪；未实现额外静默时段规则）、`failed`（确定未发，重试用尽）、`unknown`（结果不确定）、`expired`、`cancelled` |
| `approvalId` / `attempt` | 需要审批时关联审批；当前尝试号 |

**权限**：入箱需要插件权限 `outbox.enqueue:<渠道>`；发送需要用户授权，二选一：
1. 目标为 `owner` 且用户在 Web 为该发布者开启了“可通知我”（默认关闭，按发布者和渠道记录）→ 到窗口后直接发。
2. 其他情况 → 条目转 `needs_approval`，创建一条审批（复用 `feishu-reply` 类，见 `approvals.ts:41`），批准后发。审批绑定内容哈希和版本，内容变化需重新批准。

发送走现有路径：`effects.perform`（key `outbox:<id>:<尝试号>`）→ 渠道 `send` → `channel.send` 钩子仍然生效。确定未发（`delivery:'no'`）才递增尝试号并按退避重试；结果不确定记 `unknown`，Web 提供“已送达 / 未送达，重发”两个人工核实按钮。启动时处理 `sending`：账本记录不存在 → 回 `queued`（还没发起 I/O）；`confirmed` → `sent`；`failed` → 重试；`sent` 或 `unknown` → `unknown`。

架构 4.9 的 `notifyUser` 作为发件箱的上层：以后“告诉用户”统一写发件箱，由它决定即时发还是并入简报。

#### 等待确认

等待时只有数据库里的记录，不占模型、不占串行槽。

1. 要等用户时，处理器创建审批（具体动作、参数和 `version`）或问题卡，然后 `done`。
2. 用户决定 → 审批/卡片在认领的同一事务内追加 `approval.decided` / `interaction.answered` 事件，`data` 含 `id`、`version`、结论，`staleIf` 指向该对象版本。
3. 恢复处理器收到事件后**先复核**：对象版本未变、未过期、关联待办/执行状态仍符合前提（例如待办未被完成、Run 仍是原来那个），再继续。不符则记录原因并 `skipped`，必要时重新提问。
4. 需要执行的动作仍经 `effects`，key 含审批 ID 和版本（`approval:<id>:<version>`，与现有 `workbench.ts:172` 一致）。

首期只把核心已有的审批和卡片接成事件；让插件自定义审批类型要先放开 `Approval.kind` 枚举，放到阶段 5：枚举放开为“核心种类 + `plugin:<插件ID>.<名称>`”，沿用内容与版本绑定，不新增权限面。

#### 事务边界

| 动作 | 同一事务内 | 事务外（可丢，可重做） |
| --- | --- | --- |
| 追加事件 | 事件行 + 每个匹配订阅的投递行 + 序号 | `eventbox.changed` 通知、唤醒调度循环 |
| 认领投递 | `pending→running`，尝试号 +1 | 运行处理器 |
| 处理器完成 | 投递终态 + 处理器自己的本库写入 + 它追加的新事件/发件箱条目 | 模型调用、网络请求 |
| 调度到期 | 追加事件 + 推进 `nextAt` | 通知 |
| 入发件箱 | 条目 + 去重键 | — |
| 发送 | 先 `sending`；账本先落 `sent` 再做 I/O | 渠道 I/O |

一个原则：外部 I/O 永远在事务外；每个事务只写本库，因此提交要么都有要么都没有。

#### 不做

分布式队列、多进程竞争消费、exactly-once、通用工作流/规则引擎、事件溯源（事件不是业务实体的唯一真相，待办、Run、审批仍是真相）、全局串行、把消息收件箱并入事件表。

#### Web 入口（不新做大面板）

放进现有治理页（`apps/web/governance.js`，已有任务计划、交互卡、督办），增加一个“事件与发件”分区，四个只读列表加少量操作：
- 事件处理：按订阅者、状态筛选的投递列表；`failed`/`unknown` 置顶，可看事件正文、尝试次数、错误、因果链；操作：重试、标记已核实。
- 计划：调度列表（下次触发、时区、错过策略、拥有者）；操作：暂停、恢复、取消。
- 发件箱：状态列表；`needs_approval` 直接跳到现有审批；`unknown` 显示核实按钮；可取消 `queued/held`。
- 总览：`failed`/`unknown` 数量并入现有关注入口，不新开页面。

接口放在现有 `/api/v1/` 下：`eventbox/deliveries`、`eventbox/schedules`、`outbox`，鉴权与其他接口相同。

#### 本轮实现与边界

- 核心生产者在原 SQLite 事务内追加事件。同步本库处理器的写入与投递终态同事务；异步 I/O 处理器必须使用宿主服务和持久幂等结果，督办以 `supervisor.processed` 为准。不是跨网络事务或 exactly-once。
- 订阅有独立持久身份、版本匹配、串行 lane、重试、7 天停用积压和可配置的事件/终态保留期；显式回溯最多 1000 条。超时转 unknown，晚到结果不改终态；同 lane 在实际处理器结束前不开始新处理。
- 调度包含 once/interval/cron；cron 通过零依赖 Croner 11.0.1 封装 IANA/DST 计算。到期事件与下一时刻同事务；取消后即使异步简报已经开始，发件仍检查旧版本并停止。
- 发件并发上限 4、发送超时默认 30 秒，超时不自动重发；一个挂起渠道不阻塞调度。入箱和发送授权分离。飞书任务结果只回已配对的原请求人，迁移先查旧账本，旧未知记录留待人工核实；主动通知默认无发送授权。
- 插件激活前冻结后台资源，成功后才启用；失败、停用及卸载清理均有测试。`ledger/none` 示例受 AST 检查。模型服务默认关闭且按插件限额；计划服务只提出等待用户启动的计划。
- `督办与简报 → 事件与发件` 提供投递、计划、发件及授权入口；督办异常显示暂停原因，显式恢复。真实外部消息和付费模型未在本轮测试中调用。

#### 实施阶段与验证点

每阶段独立可发布，向后兼容，先通过再进下一阶段。

| 阶段 | 内容 | 必须通过的验证 |
| --- | --- | --- |
| 1 事件收件箱核心 | 追加/去重、订阅登记、投递行、调度循环、重试退避、启动回收、串行；Web 只读列表和重试；接两个核心生产者（`finishRun`、督办信号）与一个核心消费者（督办 Agent，保留开放信号对账） | ① 同 `sourceId` 同内容重复追加只得一条；内容不同报错 ② 提交后、处理前杀进程再启动：投递仍在并被处理 ③ 处理器抛错按 10s/1m/… 退避，5 次后 `failed` 且可见 ④ `effects:'direct'` 处理器中途退出 → `unknown`，不自动重投 ⑤ 同 `serialKey` 不重叠、不同 key 并行 ⑥ 两个订阅者一个失败不影响另一个 ㉕ 订阅停用期间追加的事件建 `pending` 投递，重新激活后按序处理；超过 7 天的转 `skipped(expired)` 并计数 ㉖ 升级窗口对账：构造“`remindedAt` 已写、信号未解决、无事件”和“信号未处理”的旧数据，首次启动补出事件且重复启动不重复；已解决信号不补 ㉗ 迁移后督办 Agent 对同一信号只处理一次（内存订阅已移除） ㉘ 声明 `ledger` 的插件文件导入 `node:http` 时 AST 检查失败 ㉟ 督办订阅：信号交给 `flush()` 后、review 开始前杀进程 → 重启后重新处理，信号最终只出现在一份 review 中 ㊱ review 事务提交后、投递 `done` 前杀进程 → 重投时见 `processed` 直接 `done`，不重复调用模型、不重复追加 `supervisor.review.created` ㊲ 并发的多个信号投递只触发一次 `flush()`；`deferred` 重试不占次数 |
| 2 调度 | `once`/`interval`、到期事务、错过合并/跳过、版本过期；提醒迁入；补上 `routines`（每日简报）触发 | ⑦ 停机跨过多个间隔后启动只触发一次且 `missedCount` 正确 ⑧ 同计划时刻重放不重复 ⑨ 改版本后旧事件 `skipped(stale)` ⑩ 取消后未开始投递 `cancelled` ㉙ 同一计划时刻修改后，新旧事件 `sourceId` 不同，旧的 `skipped(stale)`、新的正常处理，无冲突 ㉚ 暂停后恢复不重放暂停期间的时刻，`coalesce` 最多补一次 ㉛ 提醒迁移：同一提醒只产生一个事件，且 `remindedAt` 兼容标记仍写入 ㉝ 插件经 API 发布 `run.`/`schedule.` 等保留前缀事件被拒；插件的 `source` 无法被调用方指定 ㉞ 插件只收到 `owner` 为自己的 `schedule.due`，且 `schedule.create` 不接受事件类型字段 |
| 3 发件箱 | 入箱、去重、权限与审批、飞书 `owner` 渠道、发送与 `unknown` 核实；督办/提醒迁入发件箱 | ⑪ 无授权不发，转审批 ⑫ `sending` 中杀进程：不重发，状态为 `unknown` 或按账本修正 ⑬ 确定失败才换尝试号重试 ⑭ 过期、过版本不发 ⑮ 假飞书适配器全程，不发真实消息 |
| 4 插件 SDK | 权限串、贡献类型、`ctx.eventbox/schedule/outbox`、停用与卸载语义；两个示例插件；`cron`+时区 | ⑯ 停用插件：订阅记录 `inactive` 且仍积压投递、调度 `owner_disabled`、重新启用最多补一次 ⑰ 卸载清理 ⑱ 越权调用被拒 ⑲ AST 边界检查覆盖示例 ⑳ DST 跳时/回拨用例 |
| 5 等待确认 | 审批/卡片决定事件；恢复前复核；委派计划提案 | ㉑ 审批版本变更后旧决定不执行 ㉒ 等待期间重启，决定后正常恢复 ㉓ 目标待办已被完成时恢复处理器放弃 |
| 6 浏览器流程 | 端到端 Web 流程 | ㉔ 真实 Chromium：失败重试、取消计划、核实发件 `unknown` |

**兼容与迁移**：全部是新增集合，不改 `core.events`、不改现有 API 响应。`notifications.created` 继续发布给 Web 刷新，不再承担“触发处理”。回滚只是不再读新集合，旧数据无害。每个阶段保持 `npm test`、类型检查、插件 AST 检查通过。

*每种通知只有一个发送方*，迁移按下表逐项切换，同一阶段内“旧路径关闭、新路径开启”一起上线，不并存：

| 通知 | 旧路径 | 切换阶段与方式 |
| --- | --- | --- |
| 督办信号 → 督办 Agent | `supervisor-agent.ts` 内存订阅 `notifications.created` | 阶段 1：改为持久订阅 `supervision.signal`，删除内存订阅；仍保留“从开放信号补齐”，作为对账 |
| 待办提醒 | `supervision.ts` 事务内写 `remindedAt` 后 `publish` | 阶段 2：同一事务改为追加 `todo.reminder_due`（`sourceId` 沿用 `reminder:<todo>:<reminderAt>`），`remindedAt` 仍写，作为兼容标记 |
| 交互卡用户通知（Web 消息） | `workbench.ts` 的 `interactions.user_required` 订阅 | 保持不变，是 Web 渠道，本方案不触碰 |
| 飞书主动通知 | 不存在（`feishu.ts` 丢弃无 `replyTo` 的通知） | 阶段 3 新增，只走发件箱；因此不会与旧路径双发 |

**升级窗口对账（旧认领、未处理）**：升级前的进程可能已写下“已认领”标记，但通知没有送达（例如写 `remindedAt` 后、`publish` 前退出）。阶段 1/2 首次启动时，在 `eventbox.migrations` 记录一次性迁移标记，并在一个事务内执行：对每个**未解决**且不在 `supervisor.processed` 里的督办信号，追加 `supervision.signal` 事件，`sourceId` 取信号自身的确定性 ID，因此重复执行或与新生成的同一信号相遇都会被去重；对 `remindedAt` 已写、提醒信号未解决、且尚无对应事件的提醒，同样补一个 `todo.reminder_due`（`sourceId` 同上）。已解决的信号不补。之后常态对账由督办巡检完成：开放信号没有对应事件就补追加。验证见阶段 1、2 的补充用例。

**工程建议（已收口，可逆，非用户逐项确认）**：以下按维护成本给出推荐，实现时直接采用；发现不合适再改，不阻塞设计交付。

| 事项 | 推荐 | 理由 |
| --- | --- | --- |
| 处理器类型 | `effects` 必填，无默认值；受控的写 `ledger`/`none`，否则写 `direct` | 默认值会让未审查的 I/O 被误当作可重投；必填的成本只是一行声明 |
| cron | 阶段 1–3 只做 `once`/`interval`；阶段 4 用一个零依赖、支持 IANA 时区的成熟库，封装在单个 `nextOccurrence(spec, tz, after)` 函数后面 | 夏令时边界自写成本高；封装后可替换。引入依赖前按项目依赖评审 |
| 停用与卸载 | 停用只暂停，积压保留 7 天；“卸载并清理数据”是阶段 4 的显式 Web 操作 | 避免误停用丢数据；清理不可逆，必须是单独按钮 |
| 存储形态 | 首版 JSON 文档加内存待处理索引；不预先设行数阈值，阶段 1 压测：10 万行投递下认领耗时超过 50ms 才换专用表 | 阈值用实测定，不凭猜测 |
| 保留期与重试默认值 | 事件 30 天、积压 7 天、重试 5 次（10s/1m/5m/30m/2h） | 个人单机的保守默认，均为配置项 |
| 插件提出计划 | 一律只产生待用户点“开始”的计划卡 | 与 4.6 “可写任务需用户开始”一致，不新增权限面 |

**未来启用时才需要用户确认的产品偏好**（本轮不启用，不阻塞）：
- 飞书主动通知：默认关闭；开启时由用户按发布者和渠道单独授权，通知只含摘要和链接。督办结论是否默认通知飞书，在启用阶段 3 时再问。
- 插件调用模型：`core.agent.ask` 默认关闭，开启时用户按插件授权并设每日调用上限；会产生模型费用，因此必须单独授权。

## 5. 插件模型

### 5.1 扩展、扩展点与贡献项

扩展是安装和信任单位；扩展点是带版本的插槽；贡献项是插槽中的实现或数据。扩展点不再由固定 TypeScript 联合类型封闭：宿主与插件均通过同一个 `definePoint` 注册表声明，名称重复或向未声明点贡献会失败。

插件在清单的 `extensionPoints` 中声明 `<插件ID>.<名称>`、`version: 1`。第三方自定义点目前承载纯 JSON 数据；可调用行为通过 JSON 服务注册，避免把函数藏在普通数据中。消费者必须在 `dependencies` 声明提供该点或服务的插件。提供者停用时先停消费者，移除贡献和扩展点；重新启用按依赖顺序恢复。

### 5.2 实际清单

清单文件统一为 `super-mario.extension.json`：

```json
{
  "id": "example.catalog",
  "name": "示例目录",
  "version": "0.1.0",
  "apiVersion": 1,
  "main": "dist/index.js",
  "dependencies": [],
  "extensionPoints": [{ "id": "example.catalog.labels", "version": 1 }],
  "permissions": ["point.define:example.catalog.labels", "service.provide:example.catalog.echo"],
  "config": {}
}
```

清单在导入前校验版本、入口路径、依赖、扩展点、配置等静态字段。`main` 必须留在插件目录内且不经过符号链接。模块导出 `Extension` 或返回它的工厂，模块 ID 必须与清单一致。清单和模块共同描述实际激活逻辑；当前没有“任意 JSON Schema 自动生成配置表单”或“全部贡献项静态声明核对”功能。

### 5.3 公开上下文、服务与钩子

插件只导入公开 SDK/protocol 入口，不直接导入核心实现。SDK 入口导出的 `SDK_STABILITY` 标注接口边界；核心模型、编排、审批和数据库实现属于内部接口，不挂到上下文上。

```ts
interface ExtensionContext {
  id: string;
  dataDir: string;
  config: JsonObject;
  store: Store;
  events: EventBus;
  contributions: Contributions;
  contribute(point, id, implementation): void;
  onEvent(listener): void;
  defer(dispose): void;
  provide(name, handler: (input: Json, signal) => Promise<Json> | Json): Dispose;
  use(name, input: Json): Promise<Json>;
  wrap(name, handler: (input: Json, next, signal) => Promise<Json>, options?): Dispose;
  hook(name, phase, handler, options?): Dispose;
}
```

服务名以提供者插件 ID 为前缀，版本为 1；服务参数和返回值都经过纯 JSON 校验与复制。`use` 只访问已注册服务，不返回核心对象或任意服务实例。函数仅可作为 `contribute` 的已知方法、`provide`、`hook`、`wrap`、`onEvent`、`defer` 的注册回调；普通贡献数据、服务参数、事件和配置不得包含函数、访问器、循环引用或类实例。消费者使用外部服务需声明提供者依赖。

可运行示例是 `plugins/examples/extension-points.ts`：`example.catalog` 声明 JSON 标签点并提供 echo 服务；`example.consumer` 向其贡献数据、包装 echo，并拦截真实派活。`tests/plugin-extension-points.test.ts` 验证跨插件调用和停用清理。`plugins/examples/sdk-only.ts` 另外验证第三方风格插件与系统插件通过相同宿主运行。

#### 有序钩子与服务包装

| 钩子名称 | before 输入与允许修改 | after 输入与约束 | 核心接入位置 |
| --- | --- | --- | --- |
| `work.dispatch` | 执行记录；可审计、拒绝或改写 prompt，不能换执行者、模式与范围 | 原生结果；可改展示正文，不得伪造 pending 或 sessionId | 执行者调用前后，异步派活仍先返回受理记录 |
| `channel.send` | chatId、text、动作 key；只允许改 text，不能换目标/key | 动作返回；发送已发生，不能视为撤回 | 已配置的飞书发送入口；不代表其他 SDK 外的网络请求也被拦截 |
| `knowledge.put` | 标题、正文及归属；不得换知识 ID 或层级/项目 | 已写入条目；后置处理不撤回已经写入的文件 | 核心知识写入入口，包括人工编辑与知识整理 |

`before` 返回 `{action:'continue', value?}` 继续或改写数据；返回 `{action:'deny', reason}` 或抛错则拒绝下游。未返回值表示不改写。`after` 处理已完成动作的返回，不替代原生完成证据。服务包装只作用于通过 `provide/use` 调用的服务，不能通过字符串名称劫持任意核心对象。

钩子与包装按 `order` 从小到大执行，同序号按注册顺序。包装的低序号在外层；`next` 至多调用一次，超时后不能补调。每个回调默认 5 秒，可设为 1–30000ms。前置超时或异常阻止下游；后置异常标为结果未知，不自动重放。AbortSignal 通知插件取消，但同进程代码忽略信号时无法被宿主强杀；这不是进程沙箱。停用会撤销注册，过期列表不会再次调用已撤销项。

### 5.4 生命周期

真实状态为 `waiting / active / disabled / failed`。宿主按依赖顺序激活；激活失败逆序释放本轮资源。停用提供者时先停止依赖方，按注册逆序移除工具、服务、包装、钩子、事件监听与自定义扩展点。重新启用可重试失败激活。停用不撤回已经发出的消息或已经启动的执行。

配置目前由宿主启动时传入；尚不承诺通用 JSON Schema 配置表单和任意插件热更新。

### 5.5 权限与稳定性

`capabilities` 是能力描述，不是安全授权。新增的 `permissions` 约束通过公开上下文调用的能力；显式给出权限数组后，未授予的调用会拒绝。旧插件不写 `permissions` 时沿用可信本地模式，不能把它描述为默认最小权限。系统插件与第三方插件使用同一规则，没有系统插件绕过导入检查的白名单。

| 权限字符串 | 作用 |
| --- | --- |
| `store.read` / `store.write` | 读取或写入公开 Store；不获得数据库关闭权 |
| `events.read` / `events.publish` / `events.subscribe` | 读取、发布和订阅事件 |
| `point.define:<point>` | 声明清单中属于本插件的 JSON 点 |
| `contribute:<point>` | 向该扩展点贡献 |
| `service.provide:<name>` | 注册本插件拥有的 JSON 服务 |
| `service.use:<name>` | 调用该服务，外部服务同时要求依赖声明 |
| `service.wrap:<name>` | 包装该服务 |
| `hook:work.dispatch` / `hook:channel.send` / `hook:knowledge.put` | 注册对应操作的 before/after 钩子 |
| `*` | 显式信任全部上述 SDK 能力，不是进程隔离 |

没有列入表的权限不假装生效，宿主拒绝未知权限字符串。网络、文件系统及 Node 原生 API 不能被同进程权限字符串隔离；确认代码必须建立在信任代码及其作者的前提上。

| 边界 | 版本/稳定性 |
| --- | --- |
| `ExtensionContext`、贡献登记、事件订阅 | SDK apiVersion 1，稳定公开入口 |
| 插件声明的 JSON 点与 JSON 服务 | 每点/服务版本 1；传输值运行时校验 |
| `Store.transaction(fn)`、本地工具/执行者回调及 AbortSignal | local-only；不能直接当作 RPC 接口 |
| 核心 agent runtime、workbench、effects 等实现 | internal；插件禁止深路径导入 |
| 执行机已确认单文件制品加载 | experimental；版本与 SHA256 精确确认 |

`npm run lint:plugins` 用 AST 检查系统及第三方风格插件的导入、重导出和动态导入，CI 失败即阻断；仅允许公开 SDK/protocol 入口、本插件代码、Node 内置及正常第三方库。它是依赖边界检查，不是恶意代码沙箱。

### 5.6 隔离演进边界

当前仅实现可信同进程插件，`runtime:'process'` 明确拒绝。不能把现有整个上下文描述成“全部异步、全部 JSON、加一个 runtime 字段就可零修改隔离”。纯 JSON 服务和数据点可作为以后 RPC 的稳定边界；本地事务、文件系统和执行者回调需适配与新版本协商。普通数据跨边界传函数或类实例立即报错；注册回调留在本地宿主内，不被序列化到执行机。

### 5.7 版本兼容

当前通过 `apiVersion: 1` 校验宿主接口，`version` 必须是合法 semver。若记录宿主版本范围，键名统一为 `engines["super-mario"]`；当前未实现该范围的通用求值，不伪称已经执行 engines 范围校验。扩展点和服务各带 `version: 1`；不认识或未声明的点拒绝贡献并显示激活失败，不静默丢弃。

### 5.8 执行机代码完整性与显式确认

默认执行节点运行随安装包提供的本地适配器，不自动下载远端插件或安装依赖。需要加载额外执行机代码时使用单文件、已打包 ESM 制品：

```json
{
  "manifest": { "id": "example", "version": "1.0.0", "apiVersion": 1, "sha256": "UTF-8源码的SHA256" },
  "source": "export default { id: 'example', version: '1.0.0', activate(ctx) { /* register/defer */ } }"
}
```

1. 在 Web「插件与连接 → 执行机插件制品」选择执行机并暂存源码。服务端计算 SHA256，生成不可变待确认记录。
2. 用户查看完整源码、版本和 SHA256，点击「确认此版本」。确认严格绑定 id、version、sha256；更换任何一项都要重新暂存并确认。
3. 再点击「加载到执行机」。服务端和执行机均校验确认与源码字节哈希，校验不通过时不 import、不 activate。
4. 制品只能静态导入 Node 内置与公开 SDK；相对/任意外部依赖、动态 import、import.meta 在执行前拒绝。使用语法解析器识别依赖，不把注释、正则或字符串中的 import 当成真实导入。
5. 执行机加载器只提供 namespaced 方法注册和清理回调，不暴露服务端 Store。成功回执必须匹配 id、version、sha256 与 loaded:true，才显示已加载。方法仅通过固定 `extension.call` 网关访问当前已验证注册项，不能覆盖核心 RPC 白名单。
6. 加载失败或断线结果未知不自动重试。节点重启只读取历史确认记录为未加载状态，不扫描执行旧文件；需重新确认后加载。

这条路径不提供插件市场、任意远程下载或进程沙箱。已确认代码仍具有执行机 Node 进程权限。`tests/agent-artifacts.test.ts` 验证未确认、哈希/版本不符及外部依赖均不产生代码执行副作用。

### 5.9 持久事件、调度与发件箱的插件接口（experimental）

设计依据见本文 4.13。本节列接口意图，实际形状以 `packages/plugin-sdk/src/background.ts` 为准。旧的独立宿主可不提供后台上下文；产品宿主提供全部三个 API。命名沿用现有风格：订阅与现有 `hooks` 一样作为贡献登记，由宿主持有清理；`ctx.eventbox` 与现有 `ctx.events`（进程内通知）并列但语义不同。

```ts
// 新增贡献类型（ContributionMap）：与 hooks 同样是可登记的本地回调。
event_subscriptions: PluginEventSubscription;

interface PluginEventSubscription {
  name: string;                                   // 与插件 ID 组成订阅 ID：<pluginId>/<name>
  types: Array<{ type: string; version: number }>; // 只收到列出的类型与版本
  subjectKind?: string;                           // 可选：只收某类对象的事件
  effects: 'ledger' | 'none' | 'direct';          // 必填，无默认值：决定重启后自动重投还是转 unknown；ledger/none 受 AST 检查约束（4.13“恢复”）
  serial?: 'subject' | 'none';                    // 默认 'subject'：同 serialKey 串行
  retry?: { max: number; backoffSec: number[] };  // 默认 5 次：10/60/300/1800/7200
  timeoutMs?: number;                             // 默认 60000，最大 600000
  handler(event: DeliveredEvent, signal: AbortSignal): Promise<EventResult> | EventResult;
}
type EventResult =
  | { status: 'done'; outcome?: Json }
  | { status: 'skip'; reason: string }            // 无变化、已过期，不算失败
  | { status: 'retry'; reason: string; afterSec?: number; deferred?: boolean }  // deferred:true 表示“还没到处理时机”，不占重试次数
  | { status: 'failed'; reason: string };         // 不可重试

interface DeliveredEvent {
  id: string; seq: number; type: string; typeVersion: number;
  source: string; sourceId: string; data: Json;
  subject?: { kind: string; id: string }; causedBy?: string; rootId: string;
  attempt: number;                                // 从 1 起；处理器必须按 id 幂等
}

// 新增 ExtensionContext 成员（均为同步、本地、与 store.transaction 同库；local-only，见 5.5）
interface EventInboxApi {
  publish(e: { type: string; typeVersion: number; sourceId: string; data: Json;
    subject?: { kind: string; id: string }; causedBy?: string;
    staleIf?: { ref: string; version: number } }): { id: string; duplicate: boolean };
}
interface ScheduleApi {
  create(s: { name: string; kind: 'once' | 'interval' | 'cron';
    at?: string; everySec?: number; anchorAt?: string; cron?: string; tz?: string;  // cron 必须带 tz
    missed?: 'coalesce' | 'skip' | 'catch_up'; catchUpMax?: number;
    payload?: Json }): { id: string; version: number; nextAt: string };   // 到点由核心发 schedule.due，payload 原样带入；调用方不设事件类型
  update(id: string, patch: Partial<...>): { version: number };   // 改动即 version+1
  cancel(id: string): void;
  list(): ScheduleInfo[];                                         // 只返回本插件拥有的
}
interface OutboxApi {
  enqueue(m: { dedupKey: string; channel: string; target: 'owner' | string;
    content: { text: string }; relatedTo?: { kind: string; id: string }; causedBy?: string;
    window?: { notBefore?: string; expiresAt?: string };
    staleIf?: { ref: string; version: number } }): { id: string; duplicate: boolean; status: string };
}
```

约束：
- **只传 JSON**：`data`、`event`、`content` 都走现有的 `assertJson` 校验（5.6）；回调只能通过贡献登记，不得放进数据里。
- **命名空间**：`source` 由宿主固定为插件 ID，插件发布的事件类型必须以 `<pluginId>.` 开头，核心保留前缀（`run.`、`supervision.`、`supervisor.`、`approval.`、`interaction.`、`schedule.`、`todo.`、`outbox.`）一律拒绝；调度、发件箱、订阅 ID 都带拥有者前缀；插件只能看到和修改自己拥有的调度与发件箱条目。
- **事件类型版本**：每个事件类型有版本号。核心事件（如 `run.finished` v1）按稳定接口管理，升级期间新旧版本并存一个小版本周期；订阅必须写明版本，不认识的版本不投递，并在插件状态里显示原因。
- **事务**：`publish`、`schedule.*`、`outbox.enqueue` 与 `store.transaction` 同库，可以放进同一个事务（local-only，不能直接 RPC 化）。处理器返回结果后，投递终态与其本库写入一起提交。
- **幂等**：重启后可能再次收到同一事件（至少一次）。声明 `ledger` 的处理器，外部动作只能通过发件箱、`effects` 或带幂等键的 `dispatch`，由此得到的只是**本机去重**，远端是否执行不做保证；声明 `direct` 的处理器重启后进入 `unknown`。`effects` 必须显式写，不写则订阅登记失败，插件状态显示原因。
- **订阅身份**：订阅的持久记录由宿主按 `<pluginId>/<name>` 保存，停用只置 `inactive`，不丢积压事件；`handler` 只是激活时登记的回调。
- **错误**：处理器抛错按可重试处理；需要立即终止用 `{status:'failed'}` 或抛出 `retryable:false`。
- **模型与委派**：不给插件任意调用模型的接口。需要时通过核心服务完成：`core.agent.ask`（只读，**默认关闭**，用户按插件授权并设每日上限后才可用，会产生模型费用）；`core.plan.propose`（只产生待用户开始的计划卡）。两者均属实验接口。

新增权限串（加入 `permissions.ts` 的白名单；沿用 `*` 的含义：显式信任全部 SDK 能力，不是进程隔离）：

| 权限字符串 | 作用 |
| --- | --- |
| `eventbox.publish:<类型前缀>` | 发布以该前缀开头的事件；插件自己的 `<pluginId>.` 前缀必须显式写出 |
| `eventbox.subscribe:<类型前缀>` | 订阅该类型；订阅核心类型需要对应权限。订阅 `schedule.due` 只会收到自己拥有的调度 |
| `schedule.manage` | 创建、修改、取消本插件拥有的调度；到期事件由核心发出，不需要也不允许 `eventbox.publish:schedule.` |
| `outbox.enqueue:<渠道>` | 向该渠道入箱。**不含发送授权**，发送授权见 4.13“发件箱” |

停用与清理：订阅、调度状态、发件箱待发条目随停用按 4.13 处理；宿主为订阅登记的释放器在停用时执行，不要求插件自己取消。稳定性：`ctx.eventbox`、`schedule`、`outbox` 首版标 `experimental`，两个示例插件和边界测试通过后再升为稳定。

两个端到端示例见本文 8.5、8.6。

## 6. 扩展点清单（v1）

当前所有点均由同一个声明注册表创建：

| 已接入点 | 值及用途 |
| --- | --- |
| `tools` | 已知 execute 回调的主 Agent 工具 |
| `executors` | 已知 execute 回调的外部执行者 |
| `knowledge_backends` | list/put/remove 知识后端 |
| `routines` | 已知 run 回调的例行任务 |
| `web_extensions` | 纯 JSON 的页面扩展描述 |
| `hooks` | 按名称、阶段、顺序登记的本地钩子 |
| `services` | 带版本的 JSON 输入输出服务 |
| `service_wrappers` | 按序登记的服务包装 |
| `<pluginId>.<point>` | 插件声明的纯 JSON 数据点；消费者无需修改核心 |

`skills`、`context_providers`、`model_providers`、`channels`、`connectors`、`inbox_triage`、`terminal_hosts`、`screen_parsers`、`interaction_policies`、`api`、`events` 通过相同机制预留为数据槽。声明了槽不表示已经有核心消费者；现有飞书、终端等适配器仍按当前服务装配工作，不宣称全部可以仅靠贡献描述替换。旧表实际列了 15 项而非 14 项，现以代码注册表和真实消费者为准。

工具、执行者、知识后端、节点 RPC 和终端宿主的精确类型见公开 SDK；未落地的 hook/transcript/原生会话审批不在此伪装成已实现接口。核心 pi 导入只位于 `packages/core/src/agent-runtime/`。

### 6.1 执行者接口

实际公开接口为 SDK 的 `Executor`：描述可用性与运行位置，并实现 `execute({prompt,cwd,executionMode,signal,onOutput})`，返回正文、pending 与可选会话标识。远端调用由执行节点 RPC 适配；原生 CLI hook/审批和自动接管仍按验收报告记录边界，不把读屏当完成证据。

### 6.2 终端宿主接口

实际公开接口为 SDK 的 `TerminalHost`：status、list、create、read、input、keys、close、watch。画面使用 epoch/seq/full，重连恢复当前画面；控制台观察不等于完整历史回放。接口字段以 `packages/plugin-sdk/src/index.ts` 和共享 protocol 为准。

## 7. 默认插件

默认插件随系统安装，与第三方插件使用同一套接口，可单独停用或替换。

| 插件 | 贡献的扩展点 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `builtin-tools` | `tools` | 主 Agent 的基础工具：派活、查执行状态、列执行者、查知识、建/改待办、问用户 | 核心服务 |
| `knowledge-local` | `knowledge_backends`、`context_providers`、`tools` | 三层知识：Markdown 文件为事实源，SQLite FTS 索引；每轮注入全局原则，其余按需检索；执行者能力描述也存在这里 | — |
| `executor-claude-code` | `executors`（双端）、`screen_parsers` | 在终端运行时中启动 Claude Code；hooks 取提问、权限、计划，transcript 取正文；读屏发送并确认；`--resume` 恢复 | `terminal-host` |
| `executor-codex` | `executors`（双端）、`screen_parsers` | 在终端运行时中启动 Codex，加入其共享 app-server 取状态、审批并发送；加入不了退回读屏；`resume` 恢复 | `terminal-host` |
| `terminal-host` | `terminal_hosts`（执行机一侧） | 在执行机本机调用终端运行时：面板创建、读屏、按键、画面流、控制权；版本与能力握手 | — |
| `feishu` | `channels`、`connectors`、`tools`、`skills` | 机器人渠道（对话入口、卡片）；用户授权的只读消息连接器；首版不以用户身份发消息 | — |
| `inbox-triage` | `inbox_triage`、`context_providers` | 用模型判断消息是否需要处理、合并同一话题、生成待办草稿；记录理由，支持人工纠正 | `knowledge-local`（取项目背景） |
| `daily-brief` | `routines` | 早晚简报：待办、执行结果、待处理卡片、打扰次数与可用率；通过渠道推送 | `feishu`（可选） |

## 8. 关键流程

### 8.1 用户派活（Web 或飞书）

1. 渠道管线收到消息，立即回“处理中”，投递到主对话的输入队列。
2. 主 Agent 运行时组装上下文：全局原则（`knowledge-local`）+ 相关知识与待办（`context_providers`）。
3. 主 Agent 调用 `list_executors` 取得候选和实时在线状态，选定执行者；无法确定时调用“问用户”。
4. 主 Agent 调用 `dispatch`：工作编排登记执行尝试，经副作用账本请执行机代理启动会话，由 `executor-claude-code` 的执行机一半在终端运行时中建面板并启动 CLI。工具立即返回执行尝试 ID，主 Agent 告诉用户“已派给 X”。
5. 执行者插件持续上报信号；Web 实时显示状态，可打开控制台。
6. 执行结束：工作编排把结果作为工作台消息注入主对话；主 Agent 总结后经渠道管线回给用户。

### 8.2 远程接管（回答、审批、输入、中断、控制台）

1. **启动**：工作编排请执行机代理启动会话。执行者插件的执行机一半在终端运行时中建面板，带 hook 启动 CLI，绑定原生会话 ID。会话出现在统一投影里，标为可写。
2. **提问或权限请求**：Claude Code 的 hook（或 Codex 的协议请求）把请求交给代理。代理生成确定性卡片 ID 上报；hook 在本机阻塞等待。
3. **路由**：交互卡片按自动处理策略逐级处理（4.5、4.12）。默认配置下，权限和计划审批交给用户本人。
4. **回答**：用户在 Web 或飞书卡片回答 → 服务端锁内认领（先答者生效，后到的返回“已处理”）→ 代理把回答写回 CLI。如果用户先在电脑终端上答了，`PostToolUse` hook 让卡片撤销。
5. **终端对话框**：hook 覆盖不到的对话框由代理读屏生成 `screen` 卡；回答时比对画面版本，不一致就什么都不按。
6. **发送输入**：经四层去重与确认（4.11），结果为已送达、未送达或不确定；不确定只提示，不重发。
7. **中断、恢复**：按会话的 `capabilities` 显示按钮。恢复是新进程接上原生对话，不是原进程存活；已被别处打开时拒绝。
8. **控制台**：用户打开控制台后默认只读；取得控制权后可直接操作，释放时归还尺寸。
9. **断线**：浏览器断开不影响执行会话，重连后正文按序号补齐，控制台先全量后增量。代理与服务端断开时，hook 卡片在本机等待并在宽限期内续上；超过 30 分钟未答，回到电脑终端的原生对话框。

### 8.3 消息形成待办

1. `feishu` 连接器按游标拉取用户收到的消息，按话题聚合成 `InboxThing`（带 `thread`、`last`）。
2. 核心收件箱服务按 `thread` 合并到已有开放事件；`last` 变化时，先执行静音策略，再调用 `inbox_triage` 分拣。
3. `action` 类事件进入收件箱，分拣插件给出 `todo` 或 `conclusion` 建议；`fyi`、`noise` 按策略归档并保留理由。
4. 用户在 Web 一键确认建议（带版本号）：`todo` 建议生成待办并归档事件；`conclusion` 直接归档。也可以拒绝、改写或给出指示，让分拣插件重新建议。
5. 来源报告“已在别处回复/已读”时自动归档并记录依据；用户可重开。
6. 用户可从待办发起派活（转入流程 8.1，待办与执行尝试关联）。执行结束不自动完成待办。

### 8.4 每日简报

1. 核心调度器默认在 Asia/Shanghai 的 09:00/18:00 触发 `daily-brief` routine；时间和时区可通过调度 API 修改，页面可暂停、恢复和取消。结果持久化，通知进入发件箱。
2. 插件由程序一次性计算“简报事实”：今天到期和逾期的待办、等待中的待办、过去 12 小时完成的待办与执行结果、待处理卡片、今天的打扰次数与可用率。
3. 当前简报由普通代码计算待办与执行计数，不调用模型润色，也不把尚未统计的打扰次数或可用率写成已支持。通知发送仍需发布者授权或逐项审批。
4. 数据读取失败时显示“未知”，不显示 0。

### 8.5 示例一：执行完成 → 督办 → 通知（设计）

涉及现有模块：`finishRun`（`workbench.ts:180`）、督办检测（`supervision.ts`）、督办 Agent（`supervisor-agent.ts`）、交互卡、飞书发送。以下“事件”均指事件收件箱事件。

1. **执行完成**：`finishRun` 在已有的事务内（写 Run 和结果消息）再追加事件 `run.finished` v1，`sourceId = run:<id>:finished`，`subject = {run,<id>}`，`data = {runId, status, todoId?}`。事务提交即持久。`messageId` 守卫保证同一 Run 只会走一次。
2. **督办订阅**：核心订阅 `core/supervisor-review`（`effects:'ledger'`——它会调用只读模型，不能是 `none`；`serial:'none'`，`timeoutMs:600000`）收到 `supervision.signal`（由督办检测从 `run.finished` 等事实生成）。处理器：读信号；已在 `supervisor.processed` 中 → `skip`；否则 `await supervisorAgent.flush()`。`flush()` 复用现有 `review()`：批处理输入每次由开放信号（`signals()`）减去 `processed` 现算，所以**持久身份就是投递行本身**，内存里的 `pending` 只是优化，丢了也不丢信号。同时到来的多个投递共用现有的单飞 `inflight`。`flush()` 返回后：该信号已在 `processed` → `done`；因 `minGapMinutes` 或批量上限没轮到 → `{status:'retry', deferred:true, afterSec:<剩余间隔>}`，投递留在持久的 `retry_wait`，不占重试次数。模型只在批处理非空且超过间隔时调用。模型请求可能因重投被再次计费，结论不会重复：`review` 事务里再复核一次 `processed`，已处理的信号从本批剔除。
3. **复核结论**：督办 Agent 写 `supervisor.review` 记录与 `processed`（已是同一事务），并在该事务内追加核心事件 `supervisor.review.created` v1（`source=core`，`sourceId = review:<reviewId>`，`causedBy` 为触发信号事件的 ID）。现有逻辑据此开“后台督办复核建议”交互卡。
4. **通知**：核心订阅 `core/notify-review` 收到 `supervisor.review.created`，处理器在一个事务里调用 `outbox.enqueue`：`dedupKey = notify:review:<reviewId>`，`channel = feishu.bot`，`target = owner`，`content` 只含摘要和 Web 链接，`relatedTo = {run}`，`staleIf` 为空。
5. **发送**：发件箱到窗口后检查授权。已开启“督办可通知我” → `effects.perform(key=outbox:<id>:1)` → 飞书 `send`；未开启 → 条目 `needs_approval`，生成 `feishu-reply` 审批，用户在 Web 批准后再发。
6. **用户验收**：用户在交互卡或待办上操作；`approval.decided`/`interaction.answered` 事件进入同一条因果链，待办完成仍需用户确认，不因通知发出而自动完成。

崩溃点与结果：

| 在哪里退出 | 重启后 |
| --- | --- |
| 第 1 步事务提交前 | Run 仍在（重启后按现有逻辑为 `unknown`）；只是这次的完成状态、结果消息和事件没有提交；`monitor` 下次轮询原生结果，再次走 `finishRun` |
| 第 1 步提交后、督办处理前 | 投递行仍为 `pending`，启动后处理；不会漏复核 |
| 第 2 步交给批处理后、review 开始前 | 投递仍是 `running`（处理器在等 `flush()`）；重启后回收为 `pending`，重新触发 `flush()`；批处理输入由开放信号现算，没有只存在内存里的待处理项 |
| 模型调用中 | 同上；同一请求可能被再次计费，不会写出两份结论：提交事务内复核 `processed` |
| review 提交后、投递 `done` 前 | 回收为 `pending`；处理器发现该信号已在 `processed` 中 → `done`；后继事件 `supervisor.review.created` 已在 review 事务里提交，不会重复 |
| 第 3 步提交后、通知前 | `notify-review` 投递 `pending`，继续入箱 |
| 发送中（`sending`） | 账本是 `sent` → 条目转 `unknown`，Web 让用户核实“已收到/未收到”，不自动重发 |
| 飞书发送确定失败 | 递增尝试号，按退避重发，最多 5 次，之后 `failed` 可见 |

### 8.6 示例二：定时到期 → 检查 → 按需调用 Agent（设计）

外部插件 `example.waiting-watch`（不属于系统插件）：每个工作日 9:00 检查“等待对方回复超过 2 天”的待办，只在有变化时通知，只在条目较多时才让模型归纳。

插件清单权限：`store.read`、`store.write`、`schedule.manage`、`eventbox.subscribe:schedule.due`、`outbox.enqueue:feishu.bot`、`service.use:core.agent.ask`。

1. **激活**：插件 `activate` 里 `schedule.create({name:'daily-check', kind:'cron', cron:'0 9 * * 1-5', tz:'Asia/Shanghai', missed:'coalesce', payload:{minDays:2}})`，同时登记订阅 `check`（`effects:'ledger'`，订阅核心事件 `schedule.due` v1；宿主只把 `owner` 为本插件的到期事件交给它）。插件没有设置事件类型，也没有发布 `schedule.` 的权限。幂等：同名调度已存在则不重复创建。
2. **到期**：调度器扫描到 `nextAt` 已过，在一个事务内追加核心事件 `schedule.due`（`source=core`，`sourceId = schedule:<id>:v<version>:<计划时刻>`，`staleIf = {schedule:<id>, version}`）并推进 `nextAt`。停机错过多个工作日 → 只触发一次，`data.missedCount` 记录次数。
3. **认领与过期检查**：处理前核对调度版本和状态。已被改动、暂停、取消或插件停用 → `skipped(stale)`，什么都不做。
4. **普通代码先检查**：处理器用 `store.read` 取 `todos`，筛出 `waitingOn` 非空且 `updatedAt` 早于 2 天的，计算排序后摘要哈希，与插件自己的 `lastDigest` 比较。无变化 → `{status:'skip', reason:'无变化'}`；没有模型调用，没有消息。
5. **按需调用模型**：有变化且 ≤3 条 → 用模板拼文本；>3 条 → 仅当用户已为该插件开启 `core.agent.ask`（默认关闭）时才调用它生成一句话归纳（事务外，会产生模型费用）；未开启则用模板列出前 3 条加“另有 N 条”。
6. **入箱并记录摘要**：一个事务内 `outbox.enqueue({dedupKey:'waiting-watch:<日期>:<摘要哈希>', ...})` 与写 `lastDigest`。进程在事务前退出：重新处理，可能重复调用模型但不会重复通知；在事务后、投递标记完成前退出：重投时摘要相同 → `skip`，且 `dedupKey` 兜底。
7. **发送**：同示例一第 5 步，授权与账本一致。用户需要进一步处理时，插件可通过 `core.plan.propose` 提出计划，计划卡等用户点“开始”；开始后产生 Run，结束触发 `run.finished`，接续示例一。

崩溃与取消验证：停机跨周末后启动 → 触发一次；用户暂停调度后已入事件 → `skipped(stale)`；插件停用 → 调度 `owner_disabled`，重新启用最多补一次；发送中退出 → `unknown` 不重发。

## 9. 数据与状态

### 9.1 实体归属

| 实体 | 归属 | 说明 |
| --- | --- | --- |
| 对话、输入队列 | 核心（主 Agent 运行时） | 历史在 pi 会话文件，队列在数据库 |
| 知识条目 | 核心定义接口；`knowledge-local` 存储 | 三层：个人、全局、项目 |
| 收件箱条目、待办 | 核心 | 分拣策略在插件 |
| 执行者、执行尝试 | 核心（工作编排） | 执行者类型来自插件 |
| 机器、执行会话 | 核心（机器连接）；会话由执行机代理发现并上报投影 | 定位键 = 机器 + 会话；写操作还要求会话已绑定 |
| 交互卡片、自动处理策略 | 核心 | 策略存于设置，分全局、项目、任务三层 |
| 副作用记录 | 核心 | — |
| 后台事件、投递进度、调度、发件箱条目（设计） | 核心（4.13） | 事件不是业务真相；待办、执行、审批仍是真相 |

原生 CLI 历史是机器/会话的只读投影，不新增业务 Agent。恢复复用现有审批、Run、绑定和副作用记录：批准后新建尝试并续用原生线程，旧 unknown 不重放。插件构造厂商命令、解析事件并声明 `nativeResultSources`；核心只执行范围、幂等及证据规则，不含厂商事件分支。同步执行插件可返回 `nativeResult`，展示钩子不能改其线程或结论。协议中的执行者标识是注册 ID，内置节点提供两类适配，不把核心类型锁死到这两类。

### 9.2 状态词表

| 对象 | 状态 | 判定方 |
| --- | --- | --- |
| 执行会话 | 启动中 / 工作中 / 等输入 / 等审批 / 空闲 / 已停止 / 未知（带状态来源） | 执行机代理，依据执行者插件信号 |
| 发送输入 | 已送达 / 未送达 / 不确定 | 服务端去重表 + 执行机确认 |
| 执行尝试 | 排队 / 启动中 / 运行中 / 等待输入 / 等待批准 / 已结束（成功、失败、取消、未知） | 工作编排，依据执行者插件信号 |
| 交互卡片 | 待处理 / 已回答 / 已过期 / 已撤回 | 交互卡片服务 |
| 副作用 | 待执行 / 已发送 / 已确认 / 失败 / 未知 | 副作用账本 |
| 事件投递（设计） | pending / running / retry_wait / done / skipped / failed / unknown / cancelled | 事件收件箱 |
| 发件箱条目（设计） | queued / held / needs_approval / sending / sent / failed / unknown / expired / cancelled | 发件箱 |
| 调度（设计） | active / paused / done / cancelled / owner_disabled | 调度器 |
| 收件箱事件 | 已分拣 / 有建议 / 已归档（完成方式：用户、清理、已读、已回、转待办、被替代） | 收件箱服务 |
| 待办 | 不存状态，按事实派生分区：需要你 / 逾期 / 今天 / 等待中 / 之后 / 某天 / 刚完成 / 已完成 | 服务端统一计算；完成由用户确认，或来源已结（可撤销） |

## 10. 对项目计划书的调整

- 决策门 G4（主 Agent 接入）、G5（插件宿主）按本文关闭：pi SDK 同进程 + 单一插件体系 + 桥接扩展。
- 决策门 G10（远端拓扑）改为：执行机代理主动用 WebSocket 连接服务端，在本机调用终端运行时和 CLI。原方案“服务端经 SSH 在执行机侧运行终端观察/控制”作废；调研中“机器转发不支持终端命令”的风险随之消除。技术验证 S1 改为“执行机代理在本机驱动终端运行时：建面板、读屏、按键、画面流”。
- 工作编排、交互卡片、副作用账本、渠道管线、督办与通知、收件箱与待办、机器连接归入核心。
- 新增可部署程序 `apps/agent-node`（执行机代理），新增“双端插件”机制。
- 契约 C1–C8 改为第 5、6 节定义的扩展点接口；M0 先交付插件宿主、`builtin-tools`、一个假执行者（双端）、一个假终端宿主，证明“功能全部能以插件方式接入”。

计划书按本节同步修订。

## 11. 已定决策（2026-11-15）

用户确认按本方案执行，以下事项不再单独确认：

| 事项 | 决定 |
| --- | --- |
| 命名 | 统一用 `super-mario`：npm 包作用域 `@super-mario/*`（如 `@super-mario/core`、`@super-mario/plugin-feishu`）；插件清单 `super-mario.extension.json`；宿主版本键 `engines["super-mario"]`；服务端命令 `super-mario`，执行机代理命令 `super-mario-agent`；数据目录 `~/.super-mario/`；环境变量前缀 `SUPER_MARIO_` |
| 首期插件 | 8 个系统插件全部默认启用；支持本地目录加载自写插件；不做市场 |
| 自动回答与审批 | 全部可配置（第 4.12 节）；默认审批交给用户、Agent 只答普通提问 |
| 常设授权 | 并入可配置规则；CLI 自身的会话级“总是允许”照常可用 |
| 执行机代理部署 | 在执行机上运行一条安装命令，填服务端地址和配对码；首次连接后在 Web 确认 |

### 11.1 常驻运行方向（2026-11-16）

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| 单机版本、事件机制、事件收件箱、发件箱、定时调度，向外部插件公开 | 用户已认可 | 方向已定，不再逐项确认 |
| 事件字段、投递状态、处理器类型、串行与重试默认值、调度错过策略、发件箱授权方式、分阶段顺序 | 设计建议 | 见 4.13，未经用户逐项确认 |
| 处理器 `effects` 必填、cron 选型、停用/卸载语义、存储形态、保留期与重试默认值 | 工程建议（已收口，可逆） | 见 4.13 “工程建议”，非用户逐项确认 |
| 飞书主动通知授权、插件调用模型的授权与费用上限 | 未来启用时向用户确认 | 本轮不启用，不阻塞设计 |


## 多机器人与范围信箱（已实现）

机器人连接是飞书渠道身份，绑定全局、项目、事项或未标记范围；底层复用现有 SQLite、事件通知、副作用账本和执行调度。范围与人工确认独立。业务信件保存原始事件键、机器人、目标、范围和版本，入站受理、出站发送均先认领再执行。未知结果不自动重放。

项目/事项机器人按身份和范围隔离会话，工具执行时固定项目/事项并过滤查询结果。共享工具通过异步调用上下文保留原输入，使派发结果返回原机器人。主 Agent 按需查询所有信箱摘要；不会把全部聊天不断注入主上下文。未标记消息必须先由用户归类再处理。

这里的 `event.mailboxes` 是机器人业务收发记录及确认入口；前文事件订阅进度、调度与插件后台发件协议的整体交付状态仍以对应实现和验收为准，不能据本节视为全部完成。扫码适配器负责平台登录、建应用、配置与发布回读；不把开发者后台请求返回成功等同于线上可用。


### 连续回复与执行机恢复补充

回复跟进是Todo等待状态的证据账本，不是另一套任务。连接器提供账号命名空间、原始消息/发送者身份和直接parent引用；显示来源与昵称不授予匹配权限。选择已观察来源后才建立等待轮次。匹配只撤销当前提醒，Todo、等待轮次及持久事件在同一事务修改；reminderVersion用于现有事件/发件箱的过期检查。

机器标识与代理进程实例分别保存；网络重连不等于代理重启，代理实例也不等于终端daemon实例。当前终端宿主缺少可验证的daemon身份及原子目标条件，历史绑定只能保留描述和原生结果，不能按pane/cwd自动恢复控制。原生CLI恢复继续走现有审批和明确线程验证，不以新派发替代恢复。
