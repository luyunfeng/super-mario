import type { Extension } from "../../../packages/plugin-sdk/src/index.ts";
/** Waiting is a database record, not an occupied consumer/model slot. */
export default {
  id: "approval-followup",
  name: "确认后继续示例",
  capabilities: ["eventbox"],
  permissions: [
    "store.read",
    "store.write",
    "eventbox.publish:approval-followup.",
    "eventbox.subscribe:approval-followup.",
    "eventbox.subscribe:approval.",
    "service.use:core.approval.propose",
  ],
  activate(context) {
    if (!context.eventbox) throw new Error("此示例需要持久事件宿主");
    context.contribute("event_subscriptions", "approval-followup/request", {
      name: "request",
      types: [{ type: "approval-followup.requested", version: 1 }],
      effects: "ledger",
      async handler(event) {
        if (context.store.get("approval-followup.waiting", event.id))
          return { status: "done" };
        const approval = (await context.use("core.approval.propose", {
          dedupKey: event.id,
          kind: "plugin:approval-followup.continue",
          title: "确认继续本地示例",
          details: "批准只记录一条本地完成记录，不发送消息或派发外部任务。",
          params: { eventId: event.id },
        })) as { id: string };
        context.store.put("approval-followup.waiting", event.id, {
          approvalId: approval.id,
        });
        return { status: "done" };
      },
    });
    context.contribute("event_subscriptions", "approval-followup/resume", {
      name: "resume",
      types: [{ type: "approval.decided", version: 1 }],
      effects: "none",
      handler(event) {
        const data = event.data as {
          id: string;
          decision: string;
          kind: string;
        };
        if (data.kind !== "plugin:approval-followup.continue")
          return { status: "skip", reason: "not_ours" };
        const approval = context.store.get<{ params: { eventId: string } }>(
          "approvals",
          data.id,
        );
        if (!approval) return { status: "skip", reason: "approval_missing" };
        context.store.put(
          "approval-followup.results",
          approval.params.eventId,
          { decision: data.decision, eventId: event.id },
        );
        return { status: "done" };
      },
    });
  },
} satisfies Extension;
