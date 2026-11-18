import type { Approval } from "../../protocol/src/index.ts";
import type {
  BackgroundHost,
  EventInput,
  PluginEventSubscription,
  Store,
  EventBus,
  Json,
} from "../../plugin-sdk/src/index.ts";
import type { createEffects } from "./effects.ts";
import type { createApprovalService } from "./approvals.ts";
import {
  backgroundError,
  backgroundText,
  createEventbox,
  currentBackgroundEvent,
  assertBackgroundExecution,
} from "./eventbox.ts";
import { createSchedules } from "./schedules.ts";
import { createOutbox } from "./outbox.ts";

export function createBackground({
  store,
  events,
  effects,
  propose,
  now = Date.now,
  acceptChannel,
  channelApprovalKind,
}: {
  store: Store;
  events: EventBus;
  effects: ReturnType<typeof createEffects>;
  propose: (
    input: Parameters<ReturnType<typeof createApprovalService>["propose"]>[0],
  ) => ReturnType<ReturnType<typeof createApprovalService>["propose"]>;
  now?: () => number;
  acceptChannel?: (channel: string) => boolean;
  channelApprovalKind?: (channel: string) => Approval["kind"];
}) {
  const eventbox = createEventbox({ store, events, now });
  const schedules = createSchedules({ store, eventbox, now });
  const outbox = createOutbox({ store, effects, eventbox, propose, now, acceptChannel, channelApprovalKind });
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastCleanup = 0;
  const reserved =
    /^(run|supervision|supervisor|approval|interaction|schedule|todo|outbox)\./;
  const host: BackgroundHost = {
    subscribe(owner, spec) {
      return eventbox.subscribe(owner, spec);
    },
    ownerEnabled(owner, enabled) {
      eventbox.ownerEnabled(owner, enabled);
      schedules.ownerEnabled(owner, enabled);
      outbox.ownerEnabled(owner, enabled);
    },
    context(owner, permit) {
      const alive = () => {
        assertBackgroundExecution();
        if (closed) backgroundError("后台服务已关闭", 503);
      };
      return {
        eventbox: {
          publish(input) {
            alive();
            backgroundText(input.type, "type");
            permit(`eventbox.publish:${input.type}`);
            if (
              !input.type.startsWith(`${owner}.`) ||
              reserved.test(input.type)
            )
              backgroundError("插件不能发布核心或其他插件的事件类型", 403);
            const current = currentBackgroundEvent();
            if (current && input.causedBy && input.causedBy !== current.id)
              backgroundError("处理器不能改写事件因果来源", 403);
            return eventbox.publish(
              owner,
              current ? { ...input, causedBy: current.id } : input,
            );
          },
        },
        schedule: {
          create(input) {
            alive();
            permit("schedule.manage");
            return schedules.forOwner(owner).create(input);
          },
          update(id, patch, version) {
            alive();
            permit("schedule.manage");
            return schedules.forOwner(owner).update(id, patch, version);
          },
          cancel(id, version) {
            alive();
            permit("schedule.manage");
            schedules.forOwner(owner).cancel(id, version);
          },
          list() {
            alive();
            permit("schedule.manage");
            return schedules.forOwner(owner).list();
          },
        },
        outbox: {
          enqueue(input) {
            alive();
            permit(`outbox.enqueue:${input.channel}`);
            return outbox.enqueue(owner, input);
          },
        },
      };
    },
  };
  async function tick() {
    if (closed) return;
    schedules.tick();
    eventbox.pump();
    if (now() - lastCleanup > 3600000) {
      eventbox.cleanup();
      lastCleanup = now();
    }
    await outbox.tick();
  }
  return {
    host,
    eventbox,
    schedules,
    outbox,
    tick,
    publish(input: EventInput) {
      assertBackgroundExecution();
      return eventbox.publish("core", input);
    },
    summary() {
      const deliveries = eventbox.deliveries();
      const items = outbox.list();
      return {
        failed: deliveries.filter((d) => d.status === "failed").length,
        unknown: deliveries.filter((d) => d.status === "unknown").length,
        outboxFailed: items.filter((i) => i.status === "failed").length,
        outboxUnknown: items.filter((i) => i.status === "unknown").length,
      };
    },
    modelGrants: () =>
      store.list<{ owner: string; enabled: boolean; dailyLimit: number }>(
        "background.model-grants",
      ),
    modelGrant(owner: string, enabled: boolean, dailyLimit: number) {
      backgroundText(owner, "owner");
      if (
        typeof enabled !== "boolean" ||
        !Number.isSafeInteger(dailyLimit) ||
        dailyLimit < 1 ||
        dailyLimit > 100
      )
        backgroundError("模型授权需显式开关及 1–100 次的每日上限");
      store.put("background.model-grants", owner, {
        owner,
        enabled,
        dailyLimit,
      });
    },
    claimModel(owner: string) {
      return store.transaction(() => {
        const grant = store.get<{ enabled: boolean; dailyLimit: number }>(
          "background.model-grants",
          owner,
        );
        if (!grant?.enabled) backgroundError("该插件的模型调用未获授权", 403);
        const id = `${owner}:${new Date(now()).toISOString().slice(0, 10)}`,
          used = store.get<number>("background.model-usage", id) || 0;
        if (used >= grant.dailyLimit)
          backgroundError("已达该插件每日模型调用上限", 429);
        store.put("background.model-usage", id, used + 1);
      });
    },
    start() {
      if (timer || closed) return;
      eventbox.start();
      timer = setInterval(
        () =>
          void tick().catch((error) => console.error("后台调度失败", error)),
        5000,
      );
      timer.unref();
    },
    cleanupOwner(owner: string) {
      eventbox.cleanupOwner(owner);
      schedules.cleanupOwner(owner);
      outbox.cleanupOwner(owner);
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      schedules.close();
      await eventbox.close();
      await outbox.close();
    },
  };
}
