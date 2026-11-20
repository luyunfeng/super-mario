import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/server/src/index.ts";
import { createStore } from "../packages/core/src/store.ts";
import watch from "../plugins/examples/change-watch/index.ts";
import followup from "../plugins/examples/approval-followup/index.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mario-bg-http-"));
  let server = await startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    demo: true,
    token: "test-background",
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer test-background",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  return {
    dir,
    get server() {
      return server;
    },
    api,
    async restart() {
      await server.close();
      server = await startServer({
        host: "127.0.0.1",
        port: 0,
        dataDir: dir,
        demo: true,
        token: "test-background",
      });
    },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("HTTP background authentication, schedule version guards, outbox approval and exact send only once", async () => {
  const f = await fixture();
  let sends = 0;
  try {
    assert.equal((await fetch(f.server.url + "/api/v1/eventbox")).status, 401);
    const scheduled = await f.api("/eventbox/schedules", "POST", {
      name: "http-once",
      kind: "once",
      at: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(scheduled.status, 201);
    assert.equal(
      (
        await f.api(`/eventbox/schedules/${scheduled.data.id}`, "PATCH", {
          version: 9,
          status: "paused",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.api(`/eventbox/schedules/${scheduled.data.id}`, "PATCH", {
          version: 1,
          status: "paused",
        })
      ).data.status,
      "paused",
    );
    assert.equal(
      (
        await f.api("/eventbox/settings", "PUT", {
          retentionDays: 20,
          inactiveDays: 3,
        })
      ).status,
      200,
    );
    f.server.app.background.outbox.registerChannel(
      "feishu.bot",
      async () => {
        sends++;
      },
      () => "owner",
    );
    const outgoing = await f.api("/outbox", "POST", {
      owner: "sample",
      dedupKey: "http",
      channel: "feishu.bot",
      target: "owner",
      content: { text: "offline test" },
    });
    assert.equal(outgoing.status, 201);
    await f.server.app.background.tick();
    const pending = f.server.app.background.outbox
      .list()
      .find((i) => i.id === outgoing.data.id)!;
    assert.equal(pending.status, "needs_approval");
    assert.equal(sends, 0);
    const approval = f.server.app.approvals
      .list()
      .find((a) => a.id === pending.approvalId)!;
    const result = await f.api(`/approvals/${approval.id}/approve`, "POST", {
      version: approval.version,
    });
    assert.equal(result.status, 200);
    assert.equal(sends, 1);
    await f.server.app.background.tick();
    assert.equal(sends, 1);
    await f.restart();
    assert.equal(
      f.server.app.background.outbox.list().find((i) => i.id === pending.id)!
        .status,
      "sent",
    );
  } finally {
    await f.close();
  }
});

test("run completion and signal events persist, terminal timestamp updates do not create duplicate facts", async () => {
  const f = await fixture();
  try {
    const run = f.server.app.dispatch({
      executorId: "demo",
      prompt: "local background check",
    });
    for (let n = 0; n < 100; n++) {
      if (
        f.server.app.store.get<{ status: string }>("runs", run.id)?.status ===
        "completed"
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    f.server.app.supervision.tick();
    await f.server.app.background.eventbox.drain();
    const before = f.server.app.background.eventbox
      .events()
      .filter((e) => e.type === "run.finished");
    assert.equal(
      before.filter((e) => (e.data as any).runId === run.id).length,
      1,
    );
    const completed = f.server.app.store.get<any>("runs", run.id);
    f.server.app.store.put("runs", run.id, {
      ...completed,
      updatedAt: new Date(Date.now() + 5000).toISOString(),
    });
    f.server.app.supervision.tick();
    assert.equal(
      f.server.app.supervision
        .signals()
        .filter((s) => s.kind === "review" && s.runId === run.id).length,
      1,
    );
    await f.restart();
    assert.equal(
      f.server.app.background.eventbox
        .events()
        .filter(
          (e) => e.type === "run.finished" && (e.data as any).runId === run.id,
        ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("a failed supervisor exposes pause, persists it across restart and explicit resume continues", async () => {
  const f = await fixture();
  try {
    const signal = {
      id: "controlled-signal",
      kind: "review",
      text: "test",
      runId: "local",
      createdAt: new Date().toISOString(),
    };
    f.server.app.store.put("supervision.signals", signal.id, signal);
    const original = f.server.app.supervisorRuntime.ask;
    f.server.app.supervisorRuntime.ask = async () => {
      throw new Error("fake model unavailable");
    };
    await assert.rejects(f.server.app.supervisorAgent.flush(), /fake model/);
    const state = await f.api("/supervisor");
    assert.equal(state.data.settings.state, "paused");
    assert.equal(state.data.settings.canResume, true);
    assert.match(state.data.settings.lastError, /fake model/);
    f.server.app.supervisorRuntime.ask = original;
    await f.restart();
    assert.equal((await f.api("/supervisor")).data.settings.canResume, true);
    const resumed = await f.api("/supervisor/resume", "POST", {});
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.canResume, false);
  } finally {
    await f.close();
  }
});

test("shipped plugins exercise scheduler and confirmed resumption without occupying a waiting lane", async () => {
  const f = await fixture();
  try {
    f.server.app.plugins.register(watch);
    f.server.app.plugins.register(followup);
    await f.server.app.plugins.start();
    const schedule = f.server.app.background.schedules
      .list()
      .find((s) => s.owner === "change-watch")!;
    const time = new Date().toISOString();
    f.server.app.store.put("eventbox.schedules", schedule.id, {
      ...schedule,
      nextAt: time,
    });
    await f.server.app.background.tick();
    await f.server.app.background.eventbox.drain();
    assert.equal(
      f.server.app.background.outbox
        .list()
        .filter((i) => i.owner === "change-watch").length,
      1,
    );
    const first = f.server.app.background.eventbox.publish(
      "approval-followup",
      {
        type: "approval-followup.requested",
        typeVersion: 1,
        sourceId: "test",
        data: null,
      },
    );
    await f.server.app.background.eventbox.drain();
    const approval = f.server.app.approvals
      .list()
      .find((a) => a.kind === "plugin:approval-followup.continue")!;
    assert.ok(approval);
    assert.equal(
      f.server.app.store.get("approval-followup.results", first.id),
      undefined,
    );
    assert.equal(
      f.server.app.background.eventbox
        .deliveries()
        .filter((d) => d.status === "running").length,
      0,
    );
    await f.server.app.approvals.approve(approval.id, approval.version);
    await f.server.app.background.eventbox.drain();
    assert.equal(
      f.server.app.store.get<any>("approval-followup.results", first.id)
        ?.decision,
      "approved",
    );
    await f.server.app.plugins.setEnabled("change-watch", false);
    assert.equal(
      f.server.app.background.schedules
        .list()
        .find((s) => s.id === schedule.id)!.status,
      "owner_disabled",
    );
    assert.equal(
      (
        await f.api("/eventbox/cleanup-plugin", "POST", {
          owner: "change-watch",
          confirm: true,
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("daily brief schedule produces a held notification without approval when no owner is configured", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const routine = f.server.app.contributions
      .list("routines")
      .find((i) => i.id === "dailybrief")!.value;
    const original = routine.run;
    routine.run = async () => {
      calls++;
      return original();
    };
    const schedule = f.server.app.background.schedules
      .list()
      .find((s) => s.owner === "daily-brief" && s.name === "morning")!;
    f.server.app.store.put("eventbox.schedules", schedule.id, {
      ...schedule,
      nextAt: new Date().toISOString(),
    });
    await f.server.app.background.tick();
    await f.server.app.background.eventbox.drain();
    await f.server.app.background.outbox.tick();
    assert.equal(calls, 1);
    assert.equal(f.server.app.store.list("background.briefs").length, 1);
    assert.equal(
      f.server.app.background.outbox.list()[0].status,
      "held",
    );
    assert.equal(f.server.app.approvals.list().length,0);
    await f.server.app.background.tick();
    await f.server.app.background.eventbox.drain();
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("upgrade reconciles old claimed reminders and signals once; resolved signals are not replayed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mario-bg-migrate-"));
  const store = createStore(join(dir, "workbench.sqlite"));
  const now = new Date().toISOString();
  const todo = {
    id: "legacy",
    title: "reminder",
    notes: "",
    createdAt: now,
    updatedAt: now,
    reminderAt: now,
    remindedAt: now,
  };
  store.put("todos", todo.id, todo);
  store.put("supervision.signals", "old-reminder", {
    id: "old-reminder",
    kind: "reminder",
    text: "legacy reminder",
    todoId: todo.id,
    createdAt: now,
  });
  store.put("supervision.signals", "resolved", {
    id: "resolved",
    kind: "review",
    text: "resolved",
    createdAt: now,
    resolvedAt: now,
  });
  store.close();
  let server = await startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    demo: true,
  });
  try {
    const read = () => server.app.background.eventbox.events();
    assert.equal(
      read().filter((e) => e.type === "todo.reminder_due").length,
      1,
    );
    assert.equal(
      read().filter((e) => (e.data as any).id === "resolved").length,
      0,
    );
    await server.close();
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      demo: true,
    });
    assert.equal(
      read().filter((e) => e.type === "todo.reminder_due").length,
      1,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a brief cancelled while the routine is awaiting cannot send its stale notification", async () => {
  const f = await fixture();
  let release!: (value: any) => void,
    sends = 0;
  const gate = new Promise<any>((r) => (release = r));
  try {
    f.server.app.background.outbox.grant("daily-brief", "feishu.bot", true);
    f.server.app.background.outbox.registerChannel(
      "feishu.bot",
      async () => {
        sends++;
      },
      () => "owner",
    );
    const routine = f.server.app.contributions
      .list("routines")
      .find((i) => i.id === "dailybrief")!.value;
    routine.run = () => gate;
    const schedule = f.server.app.background.schedules
      .list()
      .find((s) => s.owner === "daily-brief" && s.name === "morning")!;
    f.server.app.store.put("eventbox.schedules", schedule.id, {
      ...schedule,
      nextAt: new Date().toISOString(),
    });
    await f.server.app.background.tick();
    await new Promise((r) => setImmediate(r));
    f.server.app.background.schedules.update(
      schedule.id,
      { status: "paused" },
      schedule.version,
    );
    release({ count: 1 });
    await f.server.app.background.eventbox.drain();
    await f.server.app.background.outbox.tick();
    assert.equal(sends, 0);
    assert.equal(f.server.app.background.outbox.list()[0].status, "cancelled");
  } finally {
    release?.({});
    await f.close();
  }
});

test("reminders enqueue a notification once without automatically authorizing the send", async () => {
  const f = await fixture();
  try {
    const todo = f.server.app.createTodo({
      title: "local reminder",
      reminderAt: new Date(Date.now() - 1000).toISOString(),
    });
    f.server.app.supervision.tick();
    await f.server.app.background.eventbox.drain();
    await f.server.app.background.outbox.tick();
    const reminders = f.server.app.background.eventbox
      .events()
      .filter((e) => e.type === "todo.reminder_due");
    assert.equal(
      reminders.filter((e) => (e.data as any).todoId === todo.id).length,
      1,
    );
    const out = f.server.app.background.outbox
      .list()
      .filter((i) => i.owner === "reminders");
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "needs_approval");
    f.server.app.supervision.tick();
    await f.server.app.background.eventbox.drain();
    assert.equal(
      f.server.app.background.outbox
        .list()
        .filter((i) => i.owner === "reminders").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test(
  "production outbox Feishu adapter uses one ledger and shutdown returns after a hung send timeout",
  { timeout: 5000 },
  async () => {
    const { createFeishuController } = await import(
      "../apps/server/src/feishu.ts"
    );
    const { createOutbox } = await import("../packages/core/src/outbox.ts");
    const { createEventBus } = await import("../packages/core/src/events.ts");
    const { createEventbox } = await import("../packages/core/src/eventbox.ts");
    const { createEffects } = await import("../packages/core/src/effects.ts");
    const dir = await mkdtemp(join(tmpdir(), "mario-single-ledger-")),
      store = createStore(":memory:"),
      events = createEventBus(store),
      effects = createEffects({ store, events }),
      box = createEventbox({ store, events });
    const app = {
      store,
      events,
      effects,
      plugins: {
        list: () => [{ id: "feishu", enabled: true, status: "active" }],
      },
    } as unknown as Parameters<typeof createFeishuController>[0];
    const controller = createFeishuController(
      app,
      { dataDir: dir, host: "127.0.0.1", port: 0, demo: true },
      () => ({
        async start() {},
        async close() {},
        async send() {
          await new Promise(() => {});
        },
        async collect() {
          return [];
        },
        status: () => ({ connected: true }),
      }),
    );
    const out = createOutbox({
      store,
      effects,
      eventbox: box,
      propose: () => {
        throw Error("unexpected approval");
      },
      sendTimeoutMs: 20,
    });
    try {
      await controller.update({
        appId: "cli_FakeTestOnly1",
        appSecret: "fake-test-secret",
        enabled: true,
      });
      out.grant("sample", "feishu.bot", true);
      out.registerChannel(
        "feishu.bot",
        (target, text, key) => controller.sendFromOutbox(target, text, key),
        () => "owner",
      );
      out.enqueue("sample", {
        dedupKey: "x",
        channel: "feishu.bot",
        target: "owner",
        content: { text: "test" },
      });
      await out.tick();
      assert.equal(out.list()[0].status, "unknown");
      assert.equal(effects.list().length, 1);
      await controller.close();
      await out.close();
      await effects.close();
    } finally {
      await controller.close();
      await out.close();
      await box.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("plugin model service is off by default, enforces its daily cap, and plan service cannot auto-start", async () => {
  const f = await fixture();
  let context!: import("../packages/plugin-sdk/src/index.ts").ExtensionContext;
  try {
    f.server.app.plugins.register({
      id: "reader",
      name: "Reader",
      capabilities: [],
      permissions: [
        "service.use:core.agent.ask",
        "service.use:core.plan.propose",
      ],
      activate(ctx) {
        context = ctx;
      },
    });
    await f.server.app.plugins.start();
    const before = f.server.app.store.list("messages").length;
    await assert.rejects(
      context.use("core.agent.ask", { text: "local demo only" }),
      /未获授权/,
    );
    assert.equal(f.server.app.store.list("messages").length, before);
    assert.equal(
      (
        await f.api("/eventbox/model-grants", "PUT", {
          owner: "reader",
          enabled: true,
          dailyLimit: 1,
        })
      ).status,
      200,
    );
    await context.use("core.agent.ask", { text: "local demo only" });
    await assert.rejects(
      context.use("core.agent.ask", { text: "over quota" }),
      /上限/,
    );
    const plan = (await context.use("core.plan.propose", {
      title: "Plugin plan",
      start: true,
      tasks: [
        {
          prompt: "Do not start",
          doneWhen: "User confirms",
          expectMinutes: 1,
          executorId: "demo",
        },
      ],
    })) as { status: string };
    assert.equal(plan.status, "pending");
  } finally {
    await f.close();
  }
});
