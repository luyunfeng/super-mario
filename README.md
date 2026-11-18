# Super Mario

个人 AI 工作台。面向 Linux，一个命令启动服务端和 Web；SQLite 与 Markdown 保存在本地。

```bash
npm install
npm start -- --demo
```

打开终端打印的地址，默认 `http://127.0.0.1:3000`。演示模式无需模型密钥或外部账号。

当前已接入以下能力：

- Web 对话入口；pi SDK 封装；明确标注的离线演示回复。
- 个人、全局、项目三层知识；知识编辑和项目管理；Markdown 文件持久化。
- 独立常驻 Codex / Claude 知识整理 Agent；链接或正文入队，默认个人知识，自动维护来源、知识地图和本地 Git 历史。
- 待办创建、完成、重开；演示派活与执行记录。
- 默认插件的注册与启停。
- 远程执行机、Codex / Claude Code 任务与交互会话，可重连 Web 控制台。
- 原生 CLI 结果自动回送对话、待办委派、版本化审批与副作用去重。
- 1–8 项任务计划、版本化交互卡、全局/项目/任务自动处理规则。
- 独立只读督办 Agent、到期提醒、模型消息分拣与规则回退。
- 从数据目录加载自定义插件，沿用同一套插件接口。
- 用户自行配置的飞书机器人长连接、私聊配对与主 Agent 回复。
- 单独授权后的个人消息采集、规则分拣与确认转待办。

真实执行需要执行机安装终端宿主和已登录的 CLI。机器人连接与个人聊天读取分别配置。任务结果以 CLI 原生事件和退出结果为准；交互会话的终端画面不作为完成证据。待办是否完成由用户验收。审批回复使用机器人身份。

Web 默认进入对话，主导航为对话、Agent、项目、记忆、渠道。模型在「Agent → 主 Agent 模型」配置；常驻记忆整理器在「Agent → 高级」单独选择电脑和执行者。

已登录 Codex 时，可运行 `npm start -- --provider codex-cli --model default` 使用真实主 Agent；也可配置其他模型 API。

开发与验证：

```bash
npm run dev -- --demo
npm run typecheck
npm test
npm run build
```

- [项目验收报告](docs/acceptance-report.md)：覆盖范围、验证证据与外部条件。
- [操作手册](docs/operations.md)：安装、模型配置、执行机、本地验证。
- [代码地图](docs/code-map.md)：入口和模块位置。
- [架构方向](docs/architecture.md)：已确认的总体设计，逐步实现。
- [开发约定](AGENTS.md)：简单优先、并行 worktree 和提交规则；`agent.md` 指向同一文件。

