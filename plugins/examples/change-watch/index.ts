import type { Extension } from "../../../packages/plugin-sdk/src/index.ts";
/** Plain code checks facts. No model runs while there is no change. */
export default {
  id: "change-watch",
  name: "待办变化通知示例",
  capabilities: ["schedule", "outbox"],
  permissions: [
    "store.read",
    "store.write",
    "schedule.manage",
    "eventbox.subscribe:schedule.",
    "outbox.enqueue:feishu.bot",
  ],
  activate(context) {
    if (!context.schedule || !context.outbox)
      throw new Error("此示例需要后台调度宿主");
    if (!context.schedule.list().some((s) => s.name === "check"))
      context.schedule.create({
        name: "check",
        kind: "interval",
        everySec: 60,
      });
    context.contribute("event_subscriptions", "change-watch/check", {
      name: "check",
      types: [{ type: "schedule.due", version: 1 }],
      effects: "none",
      handler(event) {
        const open = context.store
          .list<{ id: string; title: string; completedAt?: string }>("todos")
          .filter((t) => !t.completedAt);
        const signature = JSON.stringify(open.map((t) => [t.id, t.title]));
        if (context.store.get("change-watch.state", "signature") === signature)
          return { status: "skip", reason: "no_change" };
        context.store.transaction(() => {
          context.outbox!.enqueue({
            dedupKey: `check:${event.id}`,
            channel: "feishu.bot",
            target: "owner",
            content: { text: `待推进事项有变化，当前 ${open.length} 项。` },
            causedBy: event.id,
          });
          context.store.put("change-watch.state", "signature", signature);
        });
        return { status: "done" };
      },
    });
  },
} satisfies Extension;
