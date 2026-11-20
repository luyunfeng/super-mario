import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../packages/core/src/store.ts";
import { createEventBus } from "../packages/core/src/events.ts";
import { createEventbox } from "../packages/core/src/eventbox.ts";
import { createEffects } from "../packages/core/src/effects.ts";
import { createOutbox } from "../packages/core/src/outbox.ts";
import {
  buildWindowBrief,
  formatWindowBrief,
} from "../packages/core/src/briefing.ts";
import type { Approval } from "../packages/protocol/src/index.ts";
function fixture(t: test.TestContext) {
  const store = createStore(":memory:"),
    events = createEventBus(store),
    effects = createEffects({ store, events }),
    box = createEventbox({ store, events });
  let serial = 0;
  const start = () =>
    createOutbox({
      store,
      effects,
      eventbox: box,
      propose(input) {
        const approval: Approval = {
          ...input,
          id: "approval-" + ++serial,
          version: 1,
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.put("approvals", approval.id, approval);
        return approval;
      },
    });
  let outbox = start();
  t.after(async () => {
    await outbox.close();
    await box.close();
    await effects.close();
    store.close();
  });
  return {
    store,
    get outbox() {
      return outbox;
    },
    async restart() {
      await outbox.close();
      outbox = start();
    },
  };
}

test("internal briefs automatically send once to the bound owner; arbitrary notifications and changed identities do not", async (t) => {
  const { store, outbox } = fixture(t);
  let sent = 0,
    account = "account-v1",
    target = "owner-chat";
  outbox.registerChannel(
    "feishu.test",
    async () => {
      sent++;
    },
    () => target,
    () => account,
  );
  const notice = outbox.enqueueNotice("daily-brief", {
    dedupKey: "brief-1",
    channel: "feishu.test",
    target: "owner",
    content: { text: "合成只读简报" },
  });
  assert.equal((await outbox.send(notice.id)).status, "sent");
  await outbox.send(notice.id);
  assert.equal(sent, 1);
  assert.equal(store.list("approvals").length, 0);
  const ordinary = outbox.enqueue("custom", {
    dedupKey: "custom-1",
    channel: "feishu.test",
    target: "owner",
    content: { text: "普通发送仍按既有授权处理" },
  });
  assert.equal((await outbox.send(ordinary.id)).status, "needs_approval");
  assert.equal(sent, 1);
  const changed = outbox.enqueueNotice("daily-brief", {
    dedupKey: "brief-2",
    channel: "feishu.test",
    target: "owner",
    content: { text: "不能发给新绑定" },
  });
  account = "account-v2";
  target = "other-owner";
  assert.equal((await outbox.send(changed.id)).status, "held");
  assert.equal(sent, 1);
  assert.equal(store.list("approvals").length, 1);
  assert.throws(
    () =>
      outbox.enqueueNotice("custom", {
        dedupKey: "forged",
        channel: "feishu.test",
        target: "owner",
        content: { text: "不可冒充" },
      }),
    (e: any) => e.status === 403,
  );
  assert.throws(
    () =>
      outbox.enqueueNotice("daily-brief", {
        dedupKey: "foreign",
        channel: "feishu.test",
        target: "someone-else",
        content: { text: "不可外发" },
      }),
    (e: any) => e.status === 403,
  );
});

test("a failed connection holds a brief without asking the owner to approve it", async (t) => {
  const { store, outbox } = fixture(t);
  outbox.registerChannel(
    "feishu.test",
    async () => {},
    () => undefined,
    () => undefined,
  );
  const intent = outbox.enqueueNotice("daily-brief", {
    dedupKey: "no-connection",
    channel: "feishu.test",
    target: "owner",
    content: { text: "合成简报" },
  });
  assert.equal((await outbox.send(intent.id)).status, "held");
  assert.equal(store.list("approvals").length, 0);
});

test("briefs omit zero rows and inactive projects, use local readable time and keep real pending decisions", (t) => {
  const { store } = fixture(t),
    from = "2026-11-20T00:00:00Z",
    to = "2026-11-20T01:00:00Z";
  store.put("projects", "empty", { id: "empty", name: "无变化项目" });
  store.put("projects", "active", { id: "active", name: "有进展项目" });
  store.put("todos", "t", {
    id: "t",
    title: "合成工作进展",
    projectId: "active",
    updatedAt: to,
    createdAt: from,
  });
  store.put("approvals", "a", {
    id: "a",
    title: "合成待决定",
    projectId: "active",
    params: { projectId: "active" },
    status: "pending",
    createdAt: from,
  });
  const text = formatWindowBrief(
    buildWindowBrief(store, from, to),
    "morning",
    "Asia/Shanghai",
  );
  assert.match(text, /待你决定 1/);
  assert.match(text, /08:00/);
  assert.match(text, /09:00/);
  assert.match(text, /合成工作进展/);
  assert.doesNotMatch(text, /无变化项目|进展 0|逾期.*0|\.000Z|\[t\]/);
});

test("restart cancels only exact old system brief approvals, preserving ordinary business approvals and unknown outcomes", async (t) => {
  const f = fixture(t);
  f.outbox.registerChannel(
    "feishu.test",
    async () => {},
    () => "owner",
    () => "account",
  );
  f.store.put("background.briefs", "synthetic-event", {
    id: "synthetic-event",
  });
  const old = f.outbox.enqueue("daily-brief", {
    dedupKey: "old",
    channel: "feishu.test",
    target: "owner",
    causedBy: "synthetic-event",
    content: { text: "合成旧简报" },
  });
  await f.outbox.send(old.id);
  const ordinary = f.outbox.enqueue("other", {
    dedupKey: "business",
    channel: "feishu.test",
    target: "owner",
    content: { text: "合成业务发送" },
  });
  await f.outbox.send(ordinary.id);
  const unknown = f.outbox.enqueue("daily-brief", {
    dedupKey: "unknown",
    channel: "feishu.test",
    target: "owner",
    causedBy: "synthetic-event",
    content: { text: "合成不确定结果" },
  });
  f.store.put("outbox.items", unknown.id, { ...unknown, status: "unknown" });
  const prior = f.outbox.list().find((i) => i.id === old.id)!;
  assert.equal(prior.status, "needs_approval");
  await f.restart();
  assert.equal(
    f.outbox.list().find((i) => i.id === old.id)?.status,
    "cancelled",
  );
  assert.equal(
    f.store.get<Approval>("approvals", prior.approvalId!)?.status,
    "rejected",
  );
  assert.equal(
    f.outbox.list().find((i) => i.id === ordinary.id)?.status,
    "needs_approval",
  );
  assert.equal(
    f.outbox.list().find((i) => i.id === unknown.id)?.status,
    "unknown",
  );
});
