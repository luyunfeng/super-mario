import { createHash } from "node:crypto";
import type { EventBus, Store } from "../../plugin-sdk/src/index.ts";
import type {
  InboxItem,
  InboxConversation,
  NormalizedReplyEvidence,
  Todo,
  Project,
  Run,
} from "../../protocol/src/index.ts";

const collection = "inbox.assistant";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Row {
  id: string;
  version: number;
  inputHash: string;
  processedHash?: string;
  status: InboxConversation["status"];
  summary?: string;
  question?: string;
  error?: string;
  updatedAt: string;
  attemptedAt?: number;
  attempts?: number;
  tasks: Record<string, string>;
  answers?: string[];
}
interface Group {
  view: InboxConversation;
  items: InboxItem[];
  signature: string;
  row?: Row;
}
export interface InboxAnalysis {
  summary: string;
  disposition: "watching" | "quiet" | "waiting_user" | "work";
  question?: string;
  tasks: Array<{
    key: string;
    title: string;
    notes: string;
    existingTodoId?: string;
  }>;
}
const humanName = (value?: string) =>
  value && !/^(?:o[uc]_|unknown$)/i.test(value) ? value : undefined;

/** Raw messages remain authoritative. Conversation state records the main Agent's interpretation and local task links. */
export function createInboxAssistant(options: {
  store: Store;
  events: EventBus;
  workspace: string;
  context?(projectId?: string): unknown;
  available(): { available: boolean; reason?: string };
  enabled(): boolean;
  analyze(input: {
    title: string;
    messages: Array<{
      id: string;
      at: string;
      text: string;
      truncated: boolean;
    }>;
    todos: Todo[];
    taskKeys: Record<string, string>;
    runs: Array<Pick<Run, "id" | "todoId" | "status" | "output" | "error">>;
    answers: string[];
    previousSummary?: string;
    context?: unknown;
  }): Promise<InboxAnalysis>;
  createTodo(input: { title: string; notes: string; projectId?: string }): Todo;
  updateTodo(id: string, input: { notes: string }): Todo;
  archive(id: string, version: number): void;
  now?: () => number;
  debounceMs?: number;
}) {
  const { store, events } = options,
    now = options.now ?? Date.now;
  let closed = false,
    pending: Promise<void> | undefined;
  const enabled = () =>
    store.get<{ enabled: boolean }>("settings", "inbox-assistant")?.enabled !==
      false && options.enabled();
  const publish = () => events.publish("inbox.assistant.changed", {});
  function save(row: Row) {
    store.put(collection, row.id, row);
    publish();
  }
  for (const row of store.list<Row>(collection))
    if (row.status === "processing")
      save({
        ...row,
        status: "queued",
        version: row.version + 1,
        error: "后台整理被中断，将按原消息继续",
      });
  function dependencies(row?: Row) {
    const ids = new Set(Object.values(row?.tasks ?? {}));
    return [
      Object.values(row?.tasks ?? {}).map((id) => {
        const todo = store.get<Todo>("todos", id);
        return [
          id,
          todo?.projectId,
          todo?.title,
          todo?.notes,
          todo?.dueAt,
          todo?.completedAt,
        ];
      }),
      store
        .list<Run>("runs")
        .filter((run) => run.todoId && ids.has(run.todoId))
        .map((run) => [run.id, run.status]),
    ];
  }
  const signatureFor = (items: InboxItem[], row?: Row) =>
    hash([
      items.map((item) => [
        item.id,
        item.last,
        item.text,
        item.archivedAt ?? null,
        item.todoId ?? null,
      ]),
      row?.answers ?? [],
      dependencies(row),
    ]);
  function groups(): Group[] {
    const evidence = new Map(
      store
        .list<NormalizedReplyEvidence>("todo.reply-sources")
        .map((row) => [
          JSON.stringify([row.source, row.chatId, row.messageId]),
          row,
        ]),
    );
    function senderFor(item: InboxItem) {
      const origin = item.origin!;
      let sender = origin.senderId
        ? `${origin.senderIdType || "open_id"}:${origin.senderId}`
        : undefined;
      if (!sender && item.thread.startsWith("feishu:message:")) {
        try {
          const [chat, id] = JSON.parse(
            item.thread.slice("feishu:message:".length),
          );
          const ref = evidence.get(JSON.stringify([item.source, chat, id]));
          if (ref && chat === origin.chatId)
            sender = `${ref.senderIdType}:${ref.senderId}`;
        } catch {
          /* Missing identity is never inferred from a display name. */
        }
      }
      return sender;
    }
    const buckets = new Map<string, InboxItem[]>();
    for (const item of store.list<InboxItem>("inbox")) {
      const origin = item.origin;
      if (
        !item.source.startsWith("feishu:") ||
        !origin?.chatId ||
        !["direct", "group"].includes(origin.kind)
      )
        continue;
      const sender = senderFor(item);
      // A private chat is already a stable counterparty. Unknown group identities must never merge namesakes.
      const id = hash([
        item.source,
        item.projectId ?? null,
        origin.kind,
        origin.chatId,
        origin.kind === "group" ? (sender ?? item.id) : null,
      ]);
      const items = buckets.get(id) ?? [];
      items.push(item);
      buckets.set(id, items);
    }
    return [...buckets]
      .map(([id, items]) => {
        items.sort(
          (a, b) =>
            (a.receivedAt ?? a.updatedAt).localeCompare(
              b.receivedAt ?? b.updatedAt,
            ) || a.id.localeCompare(b.id),
        );
        const latest = items.at(-1)!,
          row = store.get<Row>(collection, id),
          person =
            humanName(latest.origin?.senderName) ??
            humanName(latest.sender) ??
            "未命名联系人";
        const chatName = humanName(latest.origin?.chatName),
          title =
            latest.origin!.kind === "group"
              ? `${person} · ${chatName || "群聊"}`
              : person;
        const activeProject =
          !latest.projectId ||
          Boolean(
            store.get<Project>("projects", latest.projectId) &&
              !store.get<Project>("projects", latest.projectId)!.archivedAt,
          );
        const allowed =
          latest.origin?.kind !== "group" ||
          (Boolean(senderFor(latest)) &&
            latest.origin.personalGroupObserved === true &&
            typeof latest.origin.personalGroupUserCount === "number" &&
            latest.origin.personalGroupUserCount <= 50);
        const pendingCount =
          activeProject && allowed
            ? items.filter((item) => !item.archivedAt && !item.todoId).length
            : 0;
        const signature = signatureFor(items, row);
        const fresh = row?.processedHash === signature;
        const active = row?.inputHash === signature;
        const status: InboxConversation["status"] = !pendingCount
          ? "quiet"
          : !enabled()
            ? "paused"
            : fresh
              ? row!.status
              : active && ["processing", "failed"].includes(row!.status)
                ? row!.status
                : "queued";
        return {
          items,
          row,
          signature,
          view: {
            id,
            // Opaque revision binds both analysis and the full current source set.
            version:
              Number.parseInt(
                hash([row?.version ?? 0, signature]).slice(0, 12),
                16,
              ) + 1,
            ...(latest.projectId ? { projectId: latest.projectId } : {}),
            title,
            person,
            ...(chatName ? { chatName } : {}),
            kind: latest.origin!.kind as "direct" | "group",
            messageIds: items.map((item) => item.id),
            pendingCount,
            ...(!activeProject
              ? { reason: "项目已归档或不存在，原消息保留，不自动处理" }
              : !allowed
                ? {
                    reason:
                      "群聊身份或成员数未核实，或超过五十人，原消息保留，不自动处理",
                  }
                : {}),
            latestAt: latest.receivedAt ?? latest.updatedAt,
            preview: latest.text,
            status,
            ...(row?.summary ? { summary: row.summary } : {}),
            ...(fresh && row?.question ? { question: row.question } : {}),
            ...(row?.error ? { error: row.error } : {}),
            todoIds: [
              ...new Set([
                ...Object.values(row?.tasks ?? {}),
                ...items.flatMap((item) => (item.todoId ? [item.todoId] : [])),
              ]),
            ],
            ...(row ? { updatedAt: row.updatedAt } : {}),
          },
        };
      })
      .sort(
        (a, b) =>
          Number(
            Boolean(
              b.row?.answers?.length && b.row.processedHash !== b.signature,
            ),
          ) -
            Number(
              Boolean(
                a.row?.answers?.length && a.row.processedHash !== a.signature,
              ),
            ) ||
          Number(a.view.kind === "group") - Number(b.view.kind === "group") ||
          a.view.latestAt.localeCompare(b.view.latestAt),
      );
  }
  function get(id: string, version?: number) {
    const group = groups().find((group) => group.view.id === id);
    if (!group) throw Object.assign(Error("合并会话不存在"), { status: 404 });
    if (version !== undefined && group.view.version !== version)
      throw Object.assign(Error("会话已更新，请核对最新内容"), { status: 409 });
    return group;
  }
  function current(id: string, version: number) {
    if (!Number.isSafeInteger(version) || version < 1)
      throw Object.assign(Error("请提供当前会话版本"), { status: 400 });
    return get(id, version);
  }
  async function work() {
    if (closed || !enabled() || !options.available().available) return;
    const group = groups().find(
      (g) =>
        g.view.pendingCount &&
        g.row?.processedHash !== g.signature &&
        (!g.row ||
          g.row.inputHash !== g.signature ||
          g.row.status !== "failed" ||
          ((g.row.attempts ?? 0) < 3 &&
            now() - (g.row.attemptedAt ?? 0) >= 300000)) &&
        now() - Date.parse(g.items.at(-1)!.updatedAt) >=
          (options.debounceMs ?? 3000),
    );
    if (!group) return;
    const project =
      group.view.projectId &&
      store.get<Project>("projects", group.view.projectId);
    if (group.view.projectId && (!project || project.archivedAt)) return;
    const row: Row = {
      ...group.row,
      id: group.view.id,
      version: (group.row?.version ?? 0) + 1,
      inputHash: group.signature,
      status: "processing",
      tasks: { ...group.row?.tasks },
      updatedAt: new Date(now()).toISOString(),
      attemptedAt: now(),
      attempts:
        group.row?.inputHash === group.signature
          ? (group.row.attempts ?? 0) + 1
          : 1,
      error: undefined,
    };
    save(row);
    try {
      const linked = new Set(Object.values(row.tasks));
      const todos = store
        .list<Todo>("todos")
        .filter(
          (t) =>
            t.projectId === group.view.projectId &&
            (!t.completedAt || linked.has(t.id)),
        )
        .slice(-10);
      const runs = store
        .list<Run>("runs")
        .filter(
          (run) =>
            run.todoId &&
            linked.has(run.todoId) &&
            run.projectId === group.view.projectId,
        )
        .slice(-10)
        .map((run) => ({
          id: run.id,
          todoId: run.todoId,
          status: run.status,
          output: run.output.slice(-400),
          error: run.error?.slice(0, 400),
        }));
      const result = await options.analyze({
        title: group.view.title,
        messages: group.items.slice(-20).map((item) => ({
          id: item.id,
          at: item.receivedAt ?? item.updatedAt,
          text: item.text.slice(0, 400),
          truncated: item.text.length > 400,
        })),
        todos: todos.map((t) => ({ ...t, notes: t.notes.slice(-400) })),
        taskKeys: Object.fromEntries(
          Object.entries(row.tasks).filter(([, id]) =>
            todos.some((t) => t.id === id),
          ),
        ),
        runs,
        context: options.context?.(group.view.projectId),
        answers: (row.answers ?? []).slice(-2),
        previousSummary: row.summary,
      });
      // Optional references are often emitted as JSON null or an empty string.
      // Canonicalize absence; a nonempty reference must still match a supplied Todo.
      if (result && Array.isArray(result.tasks))
        result.tasks = result.tasks.map((task) =>
          task && (task.existingTodoId === null || task.existingTodoId === "")
            ? { ...task, existingTodoId: undefined }
            : task,
        );
      if (
        !result ||
        typeof result.summary !== "string" ||
        !result.summary.trim() ||
        result.summary.length > 4000 ||
        !["watching", "quiet", "waiting_user", "work"].includes(
          result.disposition,
        ) ||
        !Array.isArray(result.tasks) ||
        result.tasks.length > 4 ||
        (result.disposition === "waiting_user" &&
          (typeof result.question !== "string" ||
            !result.question.trim() ||
            result.question.length > 2000)) ||
        (result.disposition === "work" && !result.tasks.length) ||
        new Set(result.tasks.map((task) => task?.key)).size !==
          result.tasks.length ||
        result.tasks.some(
          (task) =>
            !task ||
            typeof task.key !== "string" ||
            !task.key.trim() ||
            task.key.length > 100 ||
            ["__proto__", "constructor", "prototype"].includes(task.key) ||
            typeof task.title !== "string" ||
            !task.title.trim() ||
            task.title.length > 500 ||
            typeof task.notes !== "string" ||
            task.notes.length > 4000 ||
            (task.existingTodoId !== undefined &&
              !todos.some((t) => t.id === task.existingTodoId)),
        )
      )
        throw Error("后台整理未返回有效结论");
      if (closed || !enabled()) return;
      const current = get(group.view.id);
      if (!current.view.pendingCount || current.signature !== group.signature) {
        save({ ...row, status: "queued", version: row.version + 1 });
        return;
      }
      store.transaction(() => {
        // Local, reversible organization only. Incoming messages never grant CLI execution, approval or external sends.
        if (result.disposition === "work")
          for (const task of result.tasks) {
            const id = row.tasks[task.key] ?? task.existingTodoId;
            if (id) {
              const existing = store.get<Todo>("todos", id);
              if (
                !existing ||
                existing.projectId !== group.view.projectId ||
                existing.completedAt
              )
                throw Error("关联事项已改变，请核对");
              if (task.notes.trim() && !existing.notes.includes(task.notes))
                options.updateTodo(id, {
                  notes: `${existing.notes}\n\n收件整理补充：${task.notes}`,
                });
              row.tasks[task.key] = id;
            } else {
              const created = options.createTodo({
                title: task.title,
                notes: `${task.notes}\n\n来源：${group.view.title}（${group.items.length}条原始消息已保留）`,
                ...(group.view.projectId
                  ? { projectId: group.view.projectId }
                  : {}),
              });
              row.tasks[task.key] = created.id;
            }
          }
        save({
          ...row,
          version: row.version + 1,
          inputHash: signatureFor(group.items, row),
          processedHash: signatureFor(group.items, row),
          status:
            result.disposition === "work" ? "watching" : result.disposition,
          summary: result.summary,
          question:
            result.disposition === "waiting_user" ? result.question : undefined,
          error: undefined,
          updatedAt: new Date(now()).toISOString(),
        });
      });
    } catch {
      if (!closed && enabled())
        save({
          ...row,
          status: "failed",
          version: row.version + 1,
          error: "后台整理尚未完成，原消息已保留，可检查模型后重试",
        });
    }
  }
  function tick() {
    if (!pending && !closed)
      pending = work().finally(() => {
        pending = undefined;
      });
    return pending ?? Promise.resolve();
  }
  const timer = setInterval(() => {
    void tick().catch(() =>
      events.publish("agent.error", {
        conversationId: "inbox-assistant",
        error: "后台收件状态写入失败，请检查数据目录",
      }),
    );
  }, 3000);
  timer.unref();
  return {
    list: () => groups().map((group) => group.view),
    status: () => ({
      enabled: enabled(),
      ...options.available(),
      workspace: options.workspace,
    }),
    tick,
    configure(value: unknown) {
      if (value === true && !options.enabled())
        throw Object.assign(Error("请先启用飞书和收件整理插件"), {
          status: 409,
        });
      if (typeof value !== "boolean")
        throw Object.assign(Error("请选择是否自动整理"), { status: 400 });
      store.put("settings", "inbox-assistant", { enabled: value });
      publish();
      return this.status();
    },
    answer(id: string, version: number, text: string) {
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 4000 ||
        text.includes("\0")
      )
        throw Object.assign(Error("请填写有效回复"), { status: 400 });
      const group = current(id, version);
      const row = group.row;
      if (!row || group.view.status !== "waiting_user")
        throw Object.assign(Error("当前会话没有待你回复的问题"), {
          status: 409,
        });
      save({
        ...row,
        version: row.version + 1,
        answers: [...(row.answers ?? []), text.trim()].slice(-20),
        processedHash: undefined,
        status: "queued",
        attempts: 0,
        question: undefined,
      });
      return this.list().find((item) => item.id === id);
    },
    archive(id: string, version: number) {
      const group = current(id, version);
      store.transaction(() => {
        for (const item of group.items)
          if (!item.archivedAt) options.archive(item.id, item.version);
      });
      publish();
      return this.list().find((item) => item.id === id);
    },
    retry(id: string, version: number) {
      const group = current(id, version);
      if (group.row)
        save({
          ...group.row,
          status: "queued",
          attemptedAt: 0,
          attempts: 0,
          processedHash: undefined,
          version: group.row.version + 1,
          error: undefined,
        });
      return this.list().find((item) => item.id === id);
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
    },
  };
}
