import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createStore } from "../packages/core/src/store.ts";
import { createEventBus } from "../packages/core/src/events.ts";
import {
  createEventbox,
  referenceCurrent,
} from "../packages/core/src/eventbox.ts";
import {
  createSchedules,
  nextOccurrence,
} from "../packages/core/src/schedules.ts";
import { createOutbox } from "../packages/core/src/outbox.ts";
import { createEffects } from "../packages/core/src/effects.ts";
import { createApprovalService } from "../packages/core/src/approvals.ts";
import { createInteractions } from "../packages/core/src/interactions.ts";
import {
  createContributions,
  PluginHost,
} from "../packages/core/src/plugin-host.ts";
import { createBackground } from "../packages/core/src/background.ts";
import type {
  DurableEvent,
  EventDelivery,
  PluginEventSubscription,
} from "../packages/plugin-sdk/src/index.ts";

function fixture() {
  const store = createStore(":memory:");
  const events = createEventBus(store);
  let time = Date.parse("2026-01-01T00:00:00Z");
  const now = () => time;
  const box = createEventbox({ store, events, now });
  return {
    store,
    events,
    box,
    now,
    advance: (ms: number) => {
      time += ms;
    },
    publish: (id = "one", data: unknown = { value: 1 }) =>
      box.publish("sample", {
        type: "sample.changed",
        typeVersion: 1,
        sourceId: id,
        data: data as DurableEvent["data"],
        subject: { kind: "task", id: "same" },
      }),
    async close() {
      await box.close();
      store.close();
    },
  };
}
const spec = (
  name: string,
  handler: PluginEventSubscription["handler"],
  patch: Partial<PluginEventSubscription> = {},
): PluginEventSubscription => ({
  name,
  types: [{ type: "sample.changed", version: 1 }],
  effects: "none",
  handler,
  ...patch,
});

test("event append: canonical dedup, conflict, rollback and per-subscriber durable rows", async () => {
  const f = fixture();
  try {
    f.box.subscribe(
      "a",
      spec("ok", () => ({ status: "done" })),
    );
    f.box.subscribe(
      "b",
      spec("ok", () => ({ status: "done" })),
    );
    const first = f.publish("one", { b: 2, a: 1 });
    assert.equal(f.publish("one", { a: 1, b: 2 }).duplicate, true);
    assert.throws(() => f.publish("one", { a: 9 }), /source_id_conflict/);
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.publish("rollback");
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(f.box.events().length, 1);
    assert.equal(f.box.deliveries().length, 2);
    assert.equal(f.box.events()[0].id, first.id);
    await f.box.drain();
    assert.ok(f.box.deliveries().every((d) => d.status === "done"));
  } finally {
    await f.close();
  }
});

test("persisted subscriptions retain inactive backlog and activate without replaying done rows", async () => {
  const f = fixture();
  let count = 0;
  try {
    const off = f.box.subscribe(
      "sample",
      spec("consume", () => {
        count++;
        return { status: "done" };
      }),
    );
    off();
    f.publish();
    await f.box.drain();
    assert.equal(count, 0);
    assert.equal(f.box.deliveries()[0].status, "pending");
    f.box.subscribe(
      "sample",
      spec("consume", () => {
        count++;
        return { status: "done" };
      }),
    );
    await f.box.drain();
    assert.equal(count, 1);
    await f.box.drain();
    assert.equal(count, 1);
  } finally {
    await f.close();
  }
});

test("retry backoff, exhaustion, manual retry, deferred waits and independent subscriber", async () => {
  const f = fixture();
  let fail = true,
    good = 0;
  try {
    f.box.subscribe(
      "sample",
      spec(
        "bad",
        () => {
          if (fail) throw new Error("offline");
          return { status: "done" };
        },
        { retry: { max: 2, backoffSec: [10] } },
      ),
    );
    f.box.subscribe(
      "other",
      spec("good", () => {
        good++;
        return { status: "done" };
      }),
    );
    f.publish();
    await f.box.drain();
    assert.equal(good, 1);
    assert.equal(
      f.box.deliveries().find((d) => d.subscriptionId === "sample/bad")!.status,
      "retry_wait",
    );
    f.advance(9999);
    await f.box.drain();
    assert.equal(
      f.box.deliveries().find((d) => d.subscriptionId === "sample/bad")!
        .attempt,
      1,
    );
    f.advance(1);
    await f.box.drain();
    const d = f.box
      .deliveries()
      .find((d) => d.subscriptionId === "sample/bad")!;
    assert.equal(d.status, "failed");
    fail = false;
    f.box.retry(d.id);
    await f.box.drain();
    assert.equal(f.box.deliveries().find((d) => d.id === d.id)?.status, "done");
    f.box.subscribe(
      "wait",
      spec("wait", () => ({
        status: "retry",
        reason: "not due",
        afterSec: 10,
        deferred: true,
      })),
    );
    f.publish("later");
    await f.box.drain();
    assert.equal(
      f.box.deliveries().find((d) => d.subscriptionId === "wait/wait")!
        .failures,
      0,
    );
  } finally {
    await f.close();
  }
});

test("restart recovers ledger/none running, direct remains unknown until explicit verification", async () => {
  const f = fixture();
  try {
    for (const effects of ["ledger", "none", "direct"] as const)
      f.box.subscribe(
        effects,
        spec("x", () => ({ status: "done" }), { effects }),
      );
    f.publish();
    for (const d of f.box.deliveries())
      f.store.put("eventbox.deliveries", d.id, {
        ...d,
        status: "running",
        attempt: 1,
      });
    await f.box.close();
    const restarted = createEventbox({
      store: f.store,
      events: f.events,
      now: f.now,
    });
    try {
      let calls = 0;
      for (const effects of ["ledger", "none", "direct"] as const)
        restarted.subscribe(
          effects,
          spec(
            "x",
            () => {
              calls++;
              return { status: "done" };
            },
            { effects },
          ),
        );
      await restarted.drain();
      assert.equal(calls, 2);
      const d = restarted
        .deliveries()
        .find((d) => d.subscriptionId === "direct/x")!;
      assert.equal(d.status, "unknown");
      assert.throws(() => restarted.retry(d.id), /核实/);
      restarted.acknowledge(d.id);
      assert.equal(
        restarted.deliveries().find((r) => r.id === d.id)!.status,
        "done",
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});

test("subject lanes serialize same task and allow other tasks in parallel", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started: string[] = [];
  try {
    f.box.subscribe(
      "sample",
      spec("work", async (e) => {
        started.push(e.sourceId);
        if (e.sourceId === "one") await gate;
        return { status: "done" };
      }),
    );
    f.publish("one");
    f.publish("two");
    f.box.publish("sample", {
      type: "sample.changed",
      typeVersion: 1,
      sourceId: "other",
      data: null,
      subject: { kind: "task", id: "other" },
    });
    f.box.pump();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(started, ["one", "other"]);
    release();
    await f.box.drain();
    assert.deepEqual(started, ["one", "other", "two"]);
  } finally {
    release?.();
    await f.close();
  }
});

test("stale schedules skip delivery, seven-day inactive expiry counts, failed rows survive cleanup", async () => {
  const f = fixture();
  try {
    const off = f.box.subscribe(
      "sample",
      spec("x", () => ({ status: "done" })),
    );
    f.publish();
    off();
    f.advance(8 * 86400000);
    f.box.cleanup();
    assert.equal(f.box.deliveries()[0].status, "skipped");
    assert.equal(f.box.subscriptions()[0].expiredCount, 1);
    f.box.subscribe(
      "bad",
      spec("x", () => ({ status: "failed", reason: "manual" })),
    );
    f.publish("failed");
    await f.box.drain();
    f.advance(31 * 86400000);
    f.box.cleanup();
    assert.ok(f.box.deliveries().some((d) => d.status === "failed"));
    f.store.put("eventbox.schedules", "version", {
      version: 2,
      status: "active",
    });
    f.box.publish("core", {
      type: "sample.changed",
      typeVersion: 1,
      sourceId: "stale",
      data: null,
      staleIf: { ref: "schedule:version", version: 1 },
    });
    await f.box.drain();
    assert.ok(
      f.box
        .deliveries()
        .filter(
          (d) =>
            d.eventId === f.box.events()[0].id && d.subscriptionId === "bad/x",
        )
        .every((d) => d.status === "skipped"),
    );
  } finally {
    await f.close();
  }
});

test("schedule atomic due/version dedup, fixed interval anchor, missed strategies and owner isolation", async () => {
  const f = fixture();
  const schedules = createSchedules({
    store: f.store,
    eventbox: f.box,
    now: f.now,
  });
  try {
    f.box.subscribe("a", {
      name: "due",
      types: [{ type: "schedule.due", version: 1 }],
      effects: "none",
      handler: () => ({ status: "done" }),
    });
    f.box.subscribe("b", {
      name: "due",
      types: [{ type: "schedule.due", version: 1 }],
      effects: "none",
      handler: () => ({ status: "done" }),
    });
    const api = schedules.forOwner("a");
    const s = api.create({ name: "interval", kind: "interval", everySec: 10 });
    f.advance(35000);
    schedules.tick();
    schedules.tick();
    assert.equal(f.box.events().length, 1);
    assert.equal(f.box.deliveries().length, 1);
    assert.equal((f.box.events()[0].data as any).missedCount, 3);
    assert.equal(schedules.list()[0].nextAt, "2026-01-01T00:00:40.000Z");
    assert.throws(() => schedules.forOwner("b").cancel(s.id), /不存在/);
    const version = schedules.list()[0].version;
    api.update(s.id, { payload: { changed: true } }, version);
    assert.equal(schedules.list()[0].version, 2);
    await f.box.drain();
    assert.equal(f.box.deliveries()[0].status, "skipped");
    const one = api.create({
      name: "once",
      kind: "once",
      at: new Date(f.now() - 1000).toISOString(),
    });
    schedules.tick();
    assert.equal(schedules.list().find((r) => r.id === one.id)!.status, "done");
    const catchup = api.create({
      name: "catch",
      kind: "interval",
      everySec: 10,
      missed: "catch_up",
      catchUpMax: 2,
    });
    f.advance(100000);
    schedules.tick();
    assert.equal(
      f.box.events().filter((e) => (e.data as any).scheduleId === catchup.id)
        .length,
      2,
    );
    const skip = api.create({
      name: "skip",
      kind: "interval",
      everySec: 10,
      missed: "skip",
    });
    f.advance(30000);
    schedules.tick();
    assert.equal(
      f.box.events().filter((e) => (e.data as any).scheduleId === skip.id)
        .length,
      0,
    );
  } finally {
    schedules.close();
    await f.close();
  }
});

test("schedule create and event enqueue roll back together; edits/cancel invalidate old work", async () => {
  const f = fixture();
  const schedules = createSchedules({
    store: f.store,
    eventbox: f.box,
    now: f.now,
  });
  try {
    assert.throws(
      () =>
        f.store.transaction(() => {
          schedules
            .forOwner("core")
            .create({
              name: "rollback",
              kind: "once",
              at: new Date(f.now()).toISOString(),
            });
          throw Error("fail");
        }),
      /fail/,
    );
    assert.equal(schedules.list().length, 0);
    const s = schedules
      .forOwner("core")
      .create({
        name: "test",
        kind: "once",
        at: new Date(f.now()).toISOString(),
      });
    const original = f.box.publish;
    f.box.publish = () => {
      throw Error("injected");
    };
    assert.throws(() => schedules.tick(), /injected/);
    assert.equal(schedules.list()[0].status, "active");
    f.box.publish = original;
    schedules.tick();
    assert.equal(f.box.events().length, 1);
    const updated = schedules.update(s.id, {
      payload: { new: true },
      status: "active",
    });
    schedules.tick();
    assert.equal(f.box.events().length, 2);
    schedules.update(s.id, { status: "cancelled" }, updated.version);
    assert.equal(
      referenceCurrent(f.store, {
        ref: `schedule:${s.id}`,
        version: updated.version,
      }),
      false,
    );
  } finally {
    await f.close();
  }
});

test("cron requires timezone, DST spring gap advances and fall overlap fires once", async () => {
  const f = fixture();
  const schedules = createSchedules({
    store: f.store,
    eventbox: f.box,
    now: f.now,
  });
  try {
    assert.throws(
      () =>
        schedules
          .forOwner("x")
          .create({ name: "bad", kind: "cron", cron: "0 9 * * *" }),
      /时区/,
    );
    const spec = {
      name: "dst",
      kind: "cron" as const,
      cron: "30 2 * * *",
      tz: "America/New_York",
    };
    assert.equal(
      nextOccurrence(spec, Date.parse("2026-03-08T06:59:59Z")),
      "2026-03-08T07:00:00.000Z",
    );
    const fall = { ...spec, cron: "30 1 * * *" };
    const first = nextOccurrence(fall, Date.parse("2026-11-01T04:00:00Z"));
    assert.equal(first, "2026-11-01T05:30:00.000Z");
    assert.equal(
      nextOccurrence(fall, Date.parse(first)),
      "2026-11-02T06:30:00.000Z",
    );
  } finally {
    await f.close();
  }
});

function outFixture() {
  const f = fixture();
  const effects = createEffects(f);
  let out!: ReturnType<typeof createOutbox>;
  const approvals = createApprovalService({
    store: f.store,
    events: f.events,
    execute: async (a) => (await out.approve(a)) as any,
  });
  out = createOutbox({
    ...f,
    effects,
    eventbox: f.box,
    propose: (input) => approvals.propose(input),
  });
  return {
    ...f,
    effects,
    approvals,
    out,
    async close() {
      await out.close();
      await approvals.close();
      await effects.close();
      await f.close();
    },
  };
}

test("outbox dedup, default approval, exact content/version and no implicit sending authorization", async () => {
  const f = outFixture();
  let sent = 0;
  try {
    f.out.registerChannel(
      "feishu.bot",
      async () => {
        sent++;
      },
      () => "owner-chat",
    );
    const input = {
      dedupKey: "one",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "hello" },
    };
    const entry = f.out.enqueue("sample", input);
    assert.equal(f.out.enqueue("sample", input).duplicate, true);
    assert.throws(
      () =>
        f.out.enqueue("sample", { ...input, content: { text: "different" } }),
      /conflict/,
    );
    await f.out.tick();
    assert.equal(sent, 0);
    assert.equal(f.out.list()[0].status, "needs_approval");
    const approval = f.approvals.list()[0];
    await f.approvals.approve(approval.id, approval.version);
    assert.equal(sent, 1);
    await f.out.tick();
    assert.equal(sent, 1);
    assert.equal(f.out.list()[0].status, "sent");
    const arbitrary = f.out.enqueue("sample", {
      ...input,
      dedupKey: "two",
      target: "other",
    });
    f.out.grant("sample", "feishu.bot", true);
    await f.out.send(arbitrary.id);
    assert.equal(sent, 1);
    assert.equal(
      f.out.list().find((i) => i.id === arbitrary.id)!.status,
      "needs_approval",
    );
  } finally {
    await f.close();
  }
});

test("outbox unknown never retries, explicit verification uses new key, definite no retries with backoff", async () => {
  const f = outFixture();
  let mode = "unknown",
    calls = 0;
  try {
    f.out.grant("sample", "feishu.bot", true);
    f.out.registerChannel(
      "feishu.bot",
      async () => {
        calls++;
        if (mode !== "ok")
          throw Object.assign(new Error(mode), {
            delivery: mode === "no" ? "no" : "unknown",
          });
      },
      () => "owner",
    );
    const e = f.out.enqueue("sample", {
      dedupKey: "one",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "x" },
    });
    await f.out.tick();
    assert.equal(f.out.list()[0].status, "unknown");
    f.advance(999999);
    await f.out.tick();
    assert.equal(calls, 1);
    mode = "ok";
    f.out.verify(e.id, false, 1);
    await f.out.tick();
    assert.equal(calls, 2);
    assert.equal(f.out.list()[0].status, "sent");
    assert.equal(
      f.effects.list().filter((r) => r.key.startsWith(`outbox:${e.id}:`))
        .length,
      2,
    );
    mode = "no";
    const no = f.out.enqueue("sample", {
      dedupKey: "no",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "x" },
    });
    await f.out.tick();
    assert.equal(f.out.list().find((i) => i.id === no.id)!.status, "held");
    const before = calls;
    await f.out.tick();
    assert.equal(calls, before);
    f.advance(10000);
    mode = "ok";
    await f.out.tick();
    assert.equal(f.out.list().find((i) => i.id === no.id)!.status, "sent");
  } finally {
    await f.close();
  }
});

test("outbox windows, stale source, disabled owner and rejected approval prevent I/O", async () => {
  const f = outFixture();
  let calls = 0;
  try {
    f.out.registerChannel(
      "feishu.bot",
      async () => {
        calls++;
      },
      () => "owner",
    );
    f.out.grant("sample", "feishu.bot", true);
    const future = f.out.enqueue("sample", {
      dedupKey: "f",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "x" },
      window: { notBefore: new Date(f.now() + 60000).toISOString() },
    });
    await f.out.tick();
    assert.equal(f.out.list().find((i) => i.id === future.id)!.status, "held");
    const expired = f.out.enqueue("sample", {
      dedupKey: "e",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "x" },
      window: { expiresAt: new Date(f.now() - 1).toISOString() },
    });
    await f.out.tick();
    assert.equal(
      f.out.list().find((i) => i.id === expired.id)!.status,
      "expired",
    );
    f.store.put("eventbox.schedules", "s", { version: 2, status: "cancelled" });
    const stale = f.out.enqueue("sample", {
      dedupKey: "s",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "x" },
      staleIf: { ref: "schedule:s", version: 1 },
    });
    await f.out.tick();
    assert.equal(
      f.out.list().find((i) => i.id === stale.id)!.status,
      "cancelled",
    );
    f.out.ownerEnabled("sample", false);
    f.advance(60000);
    await f.out.tick();
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("SDK permissions/namespaces, lifecycle handles and schedule/outbox owner isolation", async () => {
  const f = fixture();
  const effects = createEffects(f);
  let approvals!: ReturnType<typeof createApprovalService>;
  const background = createBackground({
    ...f,
    effects,
    propose: (i) => approvals.propose(i),
  });
  approvals = createApprovalService({
    store: f.store,
    events: f.events,
    execute: async () => null,
  });
  const contributions = createContributions();
  const host = new PluginHost({
    ...f,
    contributions,
    dataDir: "/tmp/test-only",
    background: background.host,
  });
  let ctx: any;
  try {
    host.register({
      id: "sample",
      name: "Sample",
      capabilities: [],
      permissions: [
        "eventbox.publish:sample.",
        "eventbox.subscribe:sample.",
        "schedule.manage",
        "outbox.enqueue:feishu.bot",
      ],
      activate(context) {
        ctx = context;
        context.contribute(
          "event_subscriptions",
          "sample-sub",
          spec("events", () => ({ status: "done" })),
        );
      },
    });
    await host.start();
    assert.equal(host.list()[0].status, "active");
    ctx.eventbox.publish({
      type: "sample.changed",
      typeVersion: 1,
      sourceId: "one",
      data: null,
    });
    assert.throws(
      () =>
        ctx.eventbox.publish({
          type: "run.finished",
          typeVersion: 1,
          sourceId: "x",
          data: null,
        }),
      /requires|核心/,
    );
    const schedule = ctx.schedule.create({
      name: "a",
      kind: "interval",
      everySec: 10,
    });
    await host.setEnabled("sample", false);
    assert.equal(background.schedules.list()[0].status, "owner_disabled");
    assert.throws(() => ctx.schedule.list(), /closed/);
    await host.setEnabled("sample", true);
    assert.equal(background.schedules.list()[0].status, "active");
    assert.equal(background.schedules.list()[0].id, schedule.id);
  } finally {
    await host.close();
    await background.close();
    await approvals.close();
    await effects.close();
    await f.close();
  }
});

test("approval/interaction decision events persist with decision version across delivery confirmation", async () => {
  const f = fixture();
  const approvals = createApprovalService({
    ...f,
    publish: (i) => f.box.publish("core", i),
    execute: async () => null,
  });
  const interactions = createInteractions({
    ...f,
    publish: (i) => f.box.publish("core", i),
    decide: () => ({ handler: "user", layer: "default" }),
    answer: async () => {},
  });
  try {
    const a = approvals.propose({
      kind: "plugin:sample.resume",
      title: "test",
      details: "",
      params: {},
    });
    await approvals.approve(a.id, a.version);
    const ae = f.box.events().find((e) => e.type === "approval.decided")!;
    assert.ok(ae);
    assert.ok(referenceCurrent(f.store, ae.staleIf));
    const c = interactions.open({
      kind: "question",
      title: "Q",
      body: "answer",
    });
    await interactions.answer(c.id, c.version, "A");
    const e = f.box.events().find((e) => e.type === "interaction.answered")!;
    assert.ok(e);
    assert.equal(interactions.list()[0].version, 3);
    assert.ok(referenceCurrent(f.store, e.staleIf));
    assert.throws(() => interactions.answer(c.id, c.version, "B"), /更新|处理/);
  } finally {
    await interactions.close();
    await approvals.close();
    await f.close();
  }
});

test("core.events numeric cursor and retention never reset monotonic IDs", () => {
  const store = createStore(":memory:");
  let now = Date.parse("2026-01-01Z");
  try {
    const events = createEventBus(store, { now: () => now, retentionDays: 1 });
    const one = events.publish("x", null);
    now += 2 * 86400000;
    const two = events.publish("x", null);
    assert.equal(events.since(one.id).length, 1);
    assert.equal(events.since(0)[0].id, two.id);
    assert.equal(two.id, 2);
    assert.throws(() => events.since(-1), /游标/);
  } finally {
    store.close();
  }
});

test("100k terminal deliveries do not slow indexed pending claim beyond 50ms", async () => {
  const f = fixture();
  try {
    const off = f.box.subscribe(
      "sample",
      spec("work", () => ({ status: "done" })),
    );
    const e = f.publish();
    const template = f.box.deliveries()[0];
    f.store.transaction(() => {
      for (let n = 0; n < 100000; n++)
        f.store.put("eventbox.deliveries", `old-${n}`, {
          ...template,
          id: `old-${n}`,
          status: "done",
        });
    });
    off();
    await f.box.close();
    const restarted = createEventbox({ store: f.store, events: f.events });
    try {
      restarted.subscribe(
        "sample",
        spec("work", () => ({ status: "done" })),
      );
      const start = performance.now();
      restarted.pump();
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 50, `claim ${elapsed.toFixed(2)}ms`);
      await restarted.drain();
      assert.equal(
        f.store.get<EventDelivery>("eventbox.deliveries", template.id)!.status,
        "done",
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});

test("handler timeout becomes unknown, keeps its subject blocked, and close cannot hang", async () => {
  const f = fixture();
  let finish!: (v: any) => void;
  const gate = new Promise<any>((r) => (finish = r));
  let calls = 0;
  try {
    f.box.subscribe(
      "sample",
      spec(
        "timeout",
        async () => {
          calls++;
          await gate;
          return { status: "done" };
        },
        { timeoutMs: 20 },
      ),
    );
    f.publish("one");
    f.publish("two");
    await f.box.drain();
    assert.equal(calls, 1);
    assert.ok(f.box.deliveries().some((d) => d.status === "unknown"));
    await f.box.close();
  } finally {
    finish?.({ status: "done" });
    await new Promise((r) => setImmediate(r));
    await f.close();
  }
});

test("outbox recovery maps all five ledger states without sending or changing dedup identity", async () => {
  const f = outFixture();
  try {
    const expected = {
      absent: "queued",
      confirmed: "sent",
      failed: "queued",
      sent: "unknown",
      unknown: "unknown",
    } as const;
    const rows = Object.entries(expected).map(([state]) => {
      const e = f.out.enqueue("sample", {
        dedupKey: state,
        channel: "feishu.bot",
        target: "owner",
        content: { text: state },
      });
      const item = f.out.list().find((i) => i.id === e.id)!;
      f.store.put("outbox.items", item.id, {
        ...item,
        status: "sending",
        attempt: 1,
      });
      if (state !== "absent")
        f.store.put("effects", `outbox:${item.id}:1`, {
          id: state,
          key: `outbox:${item.id}:1`,
          kind: "test",
          target: "owner",
          summary: "test",
          fingerprint: "test",
          status: state,
          updatedAt: new Date(f.now()).toISOString(),
        });
      return { state, id: item.id };
    });
    await f.out.close();
    const recovered = createOutbox({
      store: f.store,
      effects: f.effects,
      eventbox: f.box,
      propose: (i) => f.approvals.propose(i),
      now: f.now,
    });
    try {
      for (const row of rows)
        assert.equal(
          recovered.list().find((i) => i.id === row.id)!.status,
          expected[row.state as keyof typeof expected],
        );
    } finally {
      await recovered.close();
    }
  } finally {
    await f.close();
  }
});

test("plugin disable preserves backlog and explicit cleanup cancels pending work but retains sent facts", async () => {
  const f = fixture();
  const effects = createEffects(f);
  let approvals!: ReturnType<typeof createApprovalService>;
  const bg = createBackground({
    ...f,
    effects,
    propose: (i) => approvals.propose(i),
  });
  approvals = createApprovalService({
    store: f.store,
    events: f.events,
    execute: async () => null,
  });
  try {
    const off = bg.eventbox.subscribe(
      "sample",
      spec("events", () => ({ status: "done" })),
    );
    off();
    bg.publish({
      type: "sample.changed",
      typeVersion: 1,
      sourceId: "one",
      data: null,
    });
    bg.schedules
      .forOwner("sample")
      .create({
        name: "future",
        kind: "once",
        at: new Date(f.now() + 3600000).toISOString(),
      });
    bg.host.ownerEnabled("sample", false);
    const item = bg.outbox.enqueue("sample", {
      dedupKey: "x",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "x" },
    });
    bg.cleanupOwner("sample");
    assert.equal(bg.eventbox.subscriptions().length, 0);
    assert.equal(bg.eventbox.deliveries()[0].status, "cancelled");
    assert.equal(bg.schedules.list()[0].status, "cancelled");
    assert.equal(
      bg.outbox.list().find((i) => i.id === item.id)!.status,
      "cancelled",
    );
  } finally {
    await bg.close();
    await approvals.close();
    await effects.close();
    await f.close();
  }
});

test("synchronous handler local writes and delivery terminal state commit or roll back together", async () => {
  const f = fixture();
  try {
    f.box.subscribe(
      "sample",
      spec("atomic", () => {
        f.store.put("local", "side-effect", { done: true });
        return { status: "done" };
      }),
    );
    f.publish();
    const put = f.store.put.bind(f.store);
    let injected = false;
    f.store.put = (collection, id, value) => {
      if (
        collection === "eventbox.deliveries" &&
        (value as any).status === "done" &&
        !injected
      ) {
        injected = true;
        throw Error("commit injection");
      }
      put(collection, id, value);
    };
    await f.box.drain();
    assert.equal(f.store.get("local", "side-effect"), undefined);
    assert.equal(f.box.deliveries()[0].status, "retry_wait");
    f.store.put = put;
    f.advance(10000);
    await f.box.drain();
    assert.deepEqual(f.store.get("local", "side-effect"), { done: true });
    assert.equal(f.box.deliveries()[0].status, "done");
  } finally {
    await f.close();
  }
});

test("failed plugin activation freezes schedules and authorized outbox entries", async () => {
  const f = fixture();
  const effects = createEffects(f);
  let approvals!: ReturnType<typeof createApprovalService>;
  const bg = createBackground({
    ...f,
    effects,
    propose: (i) => approvals.propose(i),
  });
  approvals = createApprovalService({
    store: f.store,
    events: f.events,
    execute: async () => null,
  });
  const host = new PluginHost({
    ...f,
    contributions: createContributions(),
    dataDir: "/tmp/test-only",
    background: bg.host,
  });
  let sends = 0;
  try {
    bg.outbox.registerChannel(
      "feishu.bot",
      async () => {
        sends++;
      },
      () => "owner",
    );
    bg.outbox.grant("broken", "feishu.bot", true);
    host.register({
      id: "broken",
      name: "broken",
      capabilities: [],
      activate(ctx) {
        ctx.schedule!.create({
          name: "due",
          kind: "once",
          at: new Date(f.now()).toISOString(),
        });
        ctx.outbox!.enqueue({
          dedupKey: "x",
          channel: "feishu.bot",
          target: "owner",
          content: { text: "x" },
        });
        throw Error("activate failed");
      },
    });
    await host.start();
    await bg.tick();
    assert.equal(host.list()[0].status, "failed");
    assert.equal(sends, 0);
    assert.equal(bg.schedules.list()[0].status, "owner_disabled");
    assert.equal(bg.outbox.list()[0].status, "held");
  } finally {
    await host.close();
    await bg.close();
    await approvals.close();
    await effects.close();
    await f.close();
  }
});

test("hanging channel does not block schedule ticks; timeout becomes unknown and other outbox sends proceed", async () => {
  const f = fixture();
  const effects = createEffects(f);
  let approvals!: ReturnType<typeof createApprovalService>;
  const bg = createBackground({
    ...f,
    effects,
    propose: (i) => approvals.propose(i),
  });
  approvals = createApprovalService({
    store: f.store,
    events: f.events,
    execute: async () => null,
  });
  const out = createOutbox({
    store: f.store,
    effects,
    eventbox: f.box,
    propose: (i) => approvals.propose(i),
    sendTimeoutMs: 20,
  });
  try {
    bg.outbox.grant("sample", "feishu.bot", true);
    bg.outbox.registerChannel(
      "feishu.bot",
      async () => new Promise<void>(() => {}),
      () => "owner",
    );
    bg.outbox.enqueue("sample", {
      dedupKey: "hang",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "hang" },
    });
    const pending = bg.tick();
    await new Promise((r) => setImmediate(r));
    bg.schedules
      .forOwner("core")
      .create({
        name: "due",
        kind: "once",
        at: new Date(f.now()).toISOString(),
      });
    void bg.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(
      bg.eventbox.events().filter((e) => e.type === "schedule.due").length,
      1,
    );
    out.grant("test", "feishu.bot", true);
    out.registerChannel(
      "feishu.bot",
      async () => new Promise<void>(() => {}),
      () => "owner",
    );
    out.enqueue("test", {
      dedupKey: "x",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "x" },
    });
    await out.tick();
    assert.equal(out.list()[0].status, "unknown");
    await bg.close();
    await pending;
  } finally {
    await out.close();
    await bg.close();
    await approvals.close();
    await effects.close();
    await f.close();
  }
});

test("causal event chains stop visibly at eight hops and do not spin forever", async () => {
  const f = fixture();
  try {
    f.box.subscribe(
      "sample",
      spec("loop", (e) => {
        f.box.publish("sample", {
          type: "sample.changed",
          typeVersion: 1,
          sourceId: `child:${e.id}`,
          data: null,
          causedBy: e.id,
        });
        return { status: "done" };
      }),
    );
    f.publish();
    await f.box.drain();
    assert.equal(f.box.events().length, 9);
    assert.equal(
      f.box.deliveries().filter((d) => d.status === "failed").length,
      1,
    );
    assert.match(
      f.box.deliveries().find((d) => d.status === "failed")!.reason!,
      /8 层/,
    );
  } finally {
    await f.close();
  }
});

test("unknown schedule/event fields and unrelated event versions are rejected or not delivered", async () => {
  const f = fixture();
  const schedules = createSchedules({
    store: f.store,
    eventbox: f.box,
    now: f.now,
  });
  try {
    assert.throws(
      () =>
        schedules
          .forOwner("sample")
          .create({
            name: "fake",
            kind: "interval",
            everySec: 10,
            type: "run.finished",
          } as any),
      /未知字段/,
    );
    assert.throws(
      () =>
        f.box.publish("sample", {
          type: "sample.changed",
          typeVersion: 1,
          sourceId: "source",
          data: null,
          source: "core",
        } as any),
      /宿主固定/,
    );
    assert.throws(
      () =>
        f.box.subscribe("sample", {
          name: "bad",
          types: [{ type: "x", version: 1 }],
          handler: () => ({ status: "done" }),
        } as any),
      /effects/,
    );
    f.box.subscribe(
      "sample",
      spec("v1", () => ({ status: "done" })),
    );
    f.box.publish("sample", {
      type: "sample.changed",
      typeVersion: 2,
      sourceId: "v2",
      data: null,
    });
    assert.equal(f.box.deliveries().length, 0);
  } finally {
    await f.close();
  }
});

test("an already completed todo invalidates a waiting approval continuation", async () => {
  const f = fixture();
  try {
    f.store.put("todos", "done", {
      id: "done",
      completedAt: new Date().toISOString(),
    });
    f.store.put("approvals", "a", {
      id: "a",
      version: 1,
      status: "completed",
      todoId: "done",
    });
    f.box.subscribe("sample", {
      name: "resume",
      types: [{ type: "approval.decided", version: 1 }],
      effects: "none",
      handler: () => {
        throw Error("must not run");
      },
    });
    f.box.publish("core", {
      type: "approval.decided",
      typeVersion: 1,
      sourceId: "done",
      data: null,
      staleIf: { ref: "approval:a", version: 1 },
    });
    await f.box.drain();
    assert.equal(f.box.deliveries()[0].status, "skipped");
  } finally {
    await f.close();
  }
});

test("late event callbacks lose SDK authority after timeout even while their plugin remains enabled", async () => {
  const f = fixture();
  const effects = createEffects(f);
  let approvals!: ReturnType<typeof createApprovalService>;
  const bg = createBackground({
    ...f,
    effects,
    propose: (i) => approvals.propose(i),
  });
  approvals = createApprovalService({
    store: f.store,
    events: f.events,
    execute: async () => null,
  });
  const host = new PluginHost({
    ...f,
    contributions: createContributions(),
    dataDir: "/tmp/test-only",
    background: bg.host,
  });
  let release!: () => void,
    lateError = "";
  const gate = new Promise<void>((r) => (release = r));
  try {
    host.register({
      id: "late",
      name: "Late",
      capabilities: [],
      activate(ctx) {
        ctx.contribute("event_subscriptions", "late-sub", {
          name: "events",
          types: [{ type: "late.test", version: 1 }],
          effects: "ledger",
          timeoutMs: 10,
          async handler() {
            await gate;
            try {
              ctx.outbox!.enqueue({
                dedupKey: "late",
                channel: "feishu.bot",
                target: "owner",
                content: { text: "late" },
              });
            } catch (error) {
              lateError = (error as Error).message;
            }
            return { status: "done" };
          },
        });
      },
    });
    await host.start();
    bg.eventbox.publish("late", {
      type: "late.test",
      typeVersion: 1,
      sourceId: "x",
      data: null,
    });
    await bg.eventbox.drain();
    assert.equal(bg.eventbox.deliveries()[0].status, "unknown");
    release();
    await new Promise((r) => setImmediate(r));
    assert.match(lateError, /失效/);
    assert.equal(bg.outbox.list().length, 0);
  } finally {
    release?.();
    await host.close();
    await bg.close();
    await approvals.close();
    await effects.close();
    await f.close();
  }
});

test("new subscriptions and schedules stay frozen throughout asynchronous plugin activation", async () => {
  const f = fixture();
  const effects = createEffects(f);
  let approvals!: ReturnType<typeof createApprovalService>;
  const bg = createBackground({
    ...f,
    effects,
    propose: (i) => approvals.propose(i),
  });
  approvals = createApprovalService({
    store: f.store,
    events: f.events,
    execute: async () => null,
  });
  const host = new PluginHost({
    ...f,
    contributions: createContributions(),
    dataDir: "/tmp/test-only",
    background: bg.host,
  });
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((r) => (release = r));
  try {
    host.register({
      id: "slow",
      name: "Slow",
      capabilities: [],
      async activate(ctx) {
        ctx.schedule!.create({
          name: "now",
          kind: "once",
          at: new Date(f.now()).toISOString(),
        });
        ctx.contribute("event_subscriptions", "slow-sub", {
          name: "events",
          types: [{ type: "slow.test", version: 1 }],
          effects: "none",
          handler() {
            calls++;
            return { status: "done" };
          },
        });
        await gate;
      },
    });
    const activation = host.start();
    await new Promise((r) => setImmediate(r));
    bg.eventbox.publish("slow", {
      type: "slow.test",
      typeVersion: 1,
      sourceId: "x",
      data: null,
    });
    await bg.tick();
    await bg.eventbox.drain();
    assert.equal(calls, 0);
    assert.equal(bg.schedules.list()[0].status, "owner_disabled");
    assert.equal(bg.eventbox.subscriptions()[0].status, "inactive");
    release();
    await activation;
    await bg.tick();
    await bg.eventbox.drain();
    assert.equal(calls, 1);
    assert.equal(bg.schedules.list()[0].status, "done");
  } finally {
    release?.();
    await host.close();
    await bg.close();
    await approvals.close();
    await effects.close();
    await f.close();
  }
});
