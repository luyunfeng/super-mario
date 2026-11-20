import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../packages/core/src/store.ts";
import { createEventBus } from "../packages/core/src/events.ts";
import {
  createInboxAssistant,
  type InboxAnalysis,
} from "../packages/core/src/inbox-assistant.ts";
import { collectAttention } from "../packages/core/src/attention.ts";
import type { InboxItem, Todo } from "../packages/protocol/src/index.ts";
const now = Date.parse("2026-11-20T10:00:00Z"),
  time = new Date(now - 10000).toISOString();
function message(id: string, patch: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    version: 1,
    thread: `feishu:message:${JSON.stringify(["oc_test", `om_${id}`])}`,
    last: `om_${id}`,
    source: "feishu:cli_synthetic:ou_owner",
    title: "oc_test",
    text: "合成消息 " + id,
    sender: "测试联系人",
    receivedAt: time,
    updatedAt: time,
    tier: "noise",
    reason: "合成分拣",
    origin: {
      kind: "direct",
      connector: "飞书",
      chatId: "oc_test",
      senderName: "测试联系人",
    },
    ...patch,
  };
}
function fixture(
  t: test.TestContext,
  analyze: (input: any) => Promise<InboxAnalysis>,
) {
  const store = createStore(":memory:"),
    events = createEventBus(store);
  let serial = 0;
  const start = () =>
    createInboxAssistant({
      store,
      events,
      workspace: "/isolated/main-workspace",
      enabled: () => true,
      available: () => ({ available: true }),
      now: () => now,
      debounceMs: 0,
      analyze,
      createTodo(input) {
        const todo: Todo = {
          ...input,
          id: "todo-" + ++serial,
          createdAt: time,
          updatedAt: time,
        };
        store.put("todos", todo.id, todo);
        return todo;
      },
      updateTodo(id, input) {
        const todo = { ...store.get<Todo>("todos", id)!, ...input };
        store.put("todos", id, todo);
        return todo;
      },
      archive(id, version) {
        const item = store.get<InboxItem>("inbox", id)!;
        assert.equal(item.version, version);
        store.put("inbox", id, {
          ...item,
          version: version + 1,
          archivedAt: time,
        });
      },
    });
  let service = start();
  t.after(async () => {
    await service.close();
    store.close();
  });
  return {
    store,
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = start();
      return service;
    },
  };
}
const watching: InboxAnalysis = {
  summary: "已结合上下文保留为知会",
  disposition: "watching",
  tasks: [],
};

test("old and new messages merge by counterparty without merging namesakes, accounts, chats or projects", async (t) => {
  let calls = 0;
  const { store, service } = fixture(t, async () => {
    calls++;
    return watching;
  });
  for (const item of [
    message("a"),
    message("b"),
    message("c", { source: "feishu:cli_other:ou_owner" }),
    message("d", {
      origin: { kind: "direct", chatId: "oc_other", senderName: "测试联系人" },
    }),
    message("e", {
      origin: {
        kind: "group",
        chatId: "oc_group",
        senderName: "同名",
        senderId: "ou_one",
        personalGroupObserved: true,
      },
    }),
    message("f", {
      origin: {
        kind: "group",
        chatId: "oc_group",
        senderName: "同名",
        senderId: "ou_two",
        personalGroupObserved: true,
      },
    }),
  ])
    store.put("inbox", item.id, item);
  assert.equal(service.list().length, 5);
  assert.equal(
    service.list().find((g) => g.kind === "direct" && g.messageIds.length === 2)
      ?.title,
    "测试联系人",
  );
  await service.tick();
  assert.equal(calls, 1);
  assert.equal(store.list("inbox").length, 6);
  assert.equal(store.list("todos").length, 0);
  assert.deepEqual(
    collectAttention({
      inbox: store.list("inbox"),
      inboxConversations: service.list(),
    }),
    [],
    "messages awaiting AI and FYI do not become human decisions",
  );
});

test("background analysis creates one real task, reuses it on new messages and continues after an owner answer", async (t) => {
  let turn = 0;
  const { store, service } = fixture(t, async (input) => {
    turn++;
    if (turn === 1)
      return {
        summary: "多条消息归为一项工作",
        disposition: "work",
        tasks: [
          {
            key: "verification",
            title: "核对合成交付",
            notes: "先核对两个输入",
          },
        ],
      };
    if (turn === 2) {
      assert.equal(input.todos.length, 1);
      return {
        summary: "收到补充，更新已有事项",
        disposition: "work",
        tasks: [
          {
            key: "verification",
            title: "不应覆盖原标题",
            notes: "补充检查步骤",
          },
        ],
      };
    }
    if (turn === 3)
      return {
        summary: "需要主人提供目标环境",
        disposition: "waiting_user",
        question: "使用哪个合成环境？",
        tasks: [],
      };
    assert.deepEqual(input.answers, ["测试环境甲"]);
    return watching;
  });
  for (const id of ["a", "b", "c"]) store.put("inbox", id, message(id));
  await service.tick();
  assert.equal(turn, 1);
  assert.equal(store.list("todos").length, 1);
  await service.tick();
  assert.equal(
    turn,
    1,
    "the unchanged conversation does not repeatedly call the model",
  );
  store.put("inbox", "d", message("d"));
  await service.tick();
  assert.equal(store.list("todos").length, 1);
  assert.match(store.list<Todo>("todos")[0].notes, /补充检查步骤/);
  assert.equal(store.list<Todo>("todos")[0].title, "核对合成交付");
  store.put("inbox", "e", message("e"));
  await service.tick();
  const group = service.list()[0];
  assert.equal(group.status, "waiting_user");
  const attention = collectAttention({
    inbox: store.list("inbox"),
    inboxConversations: service.list(),
  });
  assert.equal(attention.length, 1);
  assert.equal(attention[0].title, "测试联系人");
  service.answer(group.id, group.version, "测试环境甲");
  await service.tick();
  assert.equal(service.list()[0].status, "watching");
  assert.equal(store.list<Todo>("todos")[0].completedAt, undefined);
  assert.throws(
    () => service.answer(group.id, group.version, "迟到回复"),
    (e: any) => e.status === 409,
  );
});

test("late analysis cannot apply to new message versions, paused processing or another project", async (t) => {
  let release!: (value: InboxAnalysis) => void;
  const { store, service } = fixture(
    t,
    () => new Promise((r) => (release = r)),
  );
  store.put("inbox", "a", message("a"));
  const running = service.tick();
  await Promise.resolve();
  store.put("inbox", "b", message("b"));
  release({
    summary: "旧版本结论",
    disposition: "work",
    tasks: [{ key: "old", title: "不能创建", notes: "" }],
  });
  await running;
  assert.equal(store.list("todos").length, 0);
  assert.equal(service.list()[0].status, "queued");
  const second = service.tick();
  await Promise.resolve();
  service.configure(false);
  release({
    summary: "停用后的结果",
    disposition: "work",
    tasks: [{ key: "late", title: "不能创建", notes: "" }],
  });
  await second;
  assert.equal(store.list("todos").length, 0);
  assert.equal(service.list()[0].status, "paused");
});

test("archive is one versioned conversation operation and raw sources remain restorable", async (t) => {
  const { store, service } = fixture(t, async () => watching);
  store.put("inbox", "a", message("a"));
  store.put("inbox", "b", message("b"));
  await service.tick();
  let group = service.list()[0];
  service.archive(group.id, group.version);
  assert.equal(service.list()[0].pendingCount, 0);
  assert.equal(
    store.list<InboxItem>("inbox").filter((item) => item.archivedAt).length,
    2,
  );
  assert.equal(store.list("inbox").length, 2);
  assert.throws(
    () => service.archive(group.id, group.version),
    (e: any) => e.status === 409,
  );
});

test("restart keeps processed state and task links; only a real task phase change starts another analysis", async (t) => {
  let calls = 0;
  const f = fixture(t, async (input) => {
    calls++;
    if (calls === 1)
      return {
        summary: "合成工作",
        disposition: "work",
        tasks: [{ key: "stable", title: "合成事项", notes: "核对" }],
      };
    assert.equal(input.todos.length, 1);
    assert.ok(input.taskKeys.stable);
    return watching;
  });
  f.store.put("inbox", "a", message("a"));
  await f.service.tick();
  const group = f.service.list()[0];
  await f.restart();
  await f.service.tick();
  assert.equal(calls, 1);
  assert.deepEqual(f.service.list()[0].todoIds, group.todoIds);
  const todo = f.store.list<Todo>("todos")[0];
  f.store.put("todos", todo.id, { ...todo, completedAt: time });
  await f.service.tick();
  assert.equal(calls, 2);
  assert.equal(f.store.list("todos").length, 1);
});

test("failed analysis is bounded and retryable; source-set revisions reject stale bulk archive", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    throw Error("synthetic model failure");
  });
  f.store.put("inbox", "a", message("a"));
  await f.service.tick();
  assert.equal(f.service.list()[0].status, "failed");
  await f.service.tick();
  assert.equal(calls, 1);
  let group = f.service.list()[0];
  f.service.retry(group.id, group.version);
  await f.service.tick();
  assert.equal(calls, 2);
  f.store.put("inbox", "b", message("b"));
  group = f.service.list()[0];
  f.store.put("inbox", "c", message("c"));
  assert.throws(
    () => f.service.archive(group.id, group.version),
    (e: any) => e.status === 409,
  );
  assert.equal(
    f.store.list<InboxItem>("inbox").filter((i) => i.archivedAt).length,
    0,
  );
});

test("group ingestion requires verified small membership and stable sender identity; archived projects never run", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return watching;
  });
  f.store.put("projects", "archived", { id: "archived", archivedAt: time });
  f.store.put("inbox", "a", message("a", { projectId: "archived" }));
  const origin = {
    kind: "group" as const,
    chatId: "oc_synthetic_group",
    senderName: "同名",
    personalGroupObserved: true as const,
  };
  for (const id of ["b", "c"])
    f.store.put(
      "inbox",
      id,
      message(id, { origin: { ...origin, personalGroupUserCount: 3 } }),
    );
  f.store.put(
    "inbox",
    "d",
    message("d", { origin: { ...origin, senderId: "ou_one" } }),
  );
  f.store.put(
    "inbox",
    "e",
    message("e", {
      origin: { ...origin, senderId: "ou_one", personalGroupUserCount: 51 },
    }),
  );
  assert.equal(f.service.list().length, 4);
  await f.service.tick();
  await f.service.tick();
  await f.service.tick();
  assert.equal(
    calls,
    0,
    "unknown member counts, large groups, unknown identities and archived projects remain raw sources",
  );
});

test("main Agent shared context sees scoped merged progress, never raw cross-project messages", async (t) => {
  const { buildWorkContext } = await import(
    "../packages/core/src/work-context.ts"
  );
  const f = fixture(t, async () => watching);
  f.store.put("projects", "p", { id: "p", name: "合成项目" });
  f.store.put("inbox", "a", message("a", { projectId: "p" }));
  f.store.put("inbox", "b", message("b"));
  await f.service.tick();
  await f.service.tick();
  const live = { inboxConversations: f.service.list() };
  const main = buildWorkContext(f.store, undefined, undefined, live);
  const scoped = buildWorkContext(
    f.store,
    { kind: "project", projectId: "p" },
    undefined,
    live,
  );
  assert.equal(main.inboxAssistant?.total, 2);
  assert.equal(scoped.inboxAssistant?.total, 1);
  assert.equal(scoped.inboxAssistant?.items[0].projectId, "p");
  assert.doesNotMatch(JSON.stringify(scoped.inboxAssistant), /合成消息/);
});

test("absent task references emitted as null or empty strings are accepted, foreign references still fail", async (t) => {
  let calls = 0;
  const f = fixture(
    t,
    async () =>
      ({
        summary: "合成事项",
        disposition: "work",
        tasks: [
          {
            key: "stable",
            title: "合成待办",
            notes: "仅本地整理",
            existingTodoId: ++calls === 1 ? null : calls === 2 ? "" : "foreign",
          },
        ],
      }) as unknown as InboxAnalysis,
  );
  f.store.put("inbox", "a", message("a"));
  await f.service.tick();
  assert.equal(f.service.list()[0].status, "watching");
  assert.equal(f.store.list("todos").length, 1);
  f.store.put("inbox", "b", message("b"));
  await f.service.tick();
  assert.equal(f.service.list()[0].status, "watching");
  assert.equal(f.store.list("todos").length, 1);
  f.store.put("inbox", "c", message("c"));
  await f.service.tick();
  assert.equal(f.service.list()[0].status, "failed");
  assert.equal(f.store.list("todos").length, 1);
});
