import type { Approval, Json } from "../../protocol/src/index.ts";
import type {
  OutboxApi,
  OutboxInput,
  OutboxItem,
  Store,
} from "../../plugin-sdk/src/index.ts";
import type { Eventbox } from "./eventbox.ts";
import {
  backgroundError,
  backgroundText,
  digest,
  referenceCurrent,
  assertBackgroundExecution,
} from "./eventbox.ts";
import type { createEffects } from "./effects.ts";

const collection = "outbox.items";
type Sender = (target: string, text: string, key: string) => Promise<void>;
/** Intent and authority are separate. Unknown delivery is never retried without a human decision. */
export function createOutbox({
  store,
  effects,
  eventbox,
  propose,
  now = Date.now,
  sendTimeoutMs = 30000,
}: {
  store: Store;
  effects: ReturnType<typeof createEffects>;
  eventbox: Eventbox;
  propose: (input: {
    kind: "feishu-reply";
    title: string;
    details: string;
    params: Record<string, Json>;
  }) => Approval;
  now?: () => number;
  sendTimeoutMs?: number;
}) {
  const sendControllers = new Map<string, AbortController>();
  const senders = new Map<
    string,
    {
      send: Sender;
      ownerTarget: () => string | undefined;
      accountId?: () => string | undefined;
    }
  >();
  let closed = false;
  const jobs = new Map<string, Promise<OutboxItem>>();
  const timestamp = () => new Date(now()).toISOString();
  const enabledOwner = (owner: string) =>
    store.get<{ enabled: boolean }>("outbox.owners", owner)?.enabled !== false;
  function read(id: string, version?: number) {
    const item = store.get<OutboxItem>(collection, id);
    if (!item) backgroundError("发件不存在", 404);
    if (version !== undefined && version !== item.version)
      backgroundError("发件版本已更新", 409);
    return item;
  }
  function save(item: OutboxItem) {
    store.put(collection, item.id, item);
    return structuredClone(item);
  }
  function approved(item: OutboxItem) {
    if (!item.approvalId) return false;
    const a = store.get<Approval>("approvals", item.approvalId);
    return (
      a &&
      ["running", "completed"].includes(a.status) &&
      a.params.outboxVersion === item.version &&
      a.params.contentHash === item.contentHash
    );
  }
  function grant(item: OutboxItem) {
    const reply = store.get<{ accountId: string; target: string }>(
      "outbox.reply-grants",
      item.id,
    );
    const channel = senders.get(item.channel);
    if (
      item.owner === "core" &&
      reply &&
      reply.accountId === channel?.accountId?.() &&
      reply.target === channel.ownerTarget() &&
      item.target === reply.target
    )
      return true;
    return (
      item.target === "owner" &&
      store.get<{ enabled: boolean }>(
        "outbox.grants",
        `${item.owner}:${item.channel}`,
      )?.enabled === true
    );
  }
  for (const item of store.list<OutboxItem>(collection)) {
    if (item.status !== "sending") continue;
    const effect = effects
      .list()
      .find((e) => e.key === `outbox:${item.id}:${item.attempt}`);
    save({
      ...item,
      status: !effect
        ? "queued"
        : effect.status === "confirmed"
          ? "sent"
          : effect.status === "failed"
            ? "queued"
            : "unknown",
      attempt:
        effect?.status === "failed"
          ? item.attempt
          : !effect
            ? Math.max(0, item.attempt - 1)
            : item.attempt,
      updatedAt: timestamp(),
      error:
        effect?.status === "confirmed"
          ? undefined
          : "服务重启，依据副作用账本恢复发送状态",
    });
  }
  const service = {
    registerChannel(
      channel: string,
      send: Sender,
      ownerTarget: () => string | undefined,
      accountId?: () => string | undefined,
    ) {
      senders.set(channel, { send, ownerTarget, accountId });
      return () => {
        senders.delete(channel);
      };
    },
    enqueueReply(input: OutboxInput, accountId: string) {
      return store.transaction(() => {
        const result = service.enqueue("core", input);
        store.put("outbox.reply-grants", result.id, {
          accountId,
          target: input.target,
        });
        return result;
      });
    },
    list: () =>
      store
        .list<OutboxItem>(collection)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    grants: () =>
      store.list<{
        id: string;
        owner: string;
        channel: string;
        enabled: boolean;
      }>("outbox.grants"),
    grant(owner: string, channel: string, enabled: boolean) {
      backgroundText(owner, "owner");
      backgroundText(channel, "channel");
      if (typeof enabled !== "boolean") backgroundError("授权值无效");
      store.put("outbox.grants", `${owner}:${channel}`, {
        id: `${owner}:${channel}`,
        owner,
        channel,
        enabled,
      });
    },
    ownerEnabled(owner: string, enabled: boolean) {
      store.put("outbox.owners", owner, { enabled });
    },
    forOwner(owner: string): OutboxApi {
      return { enqueue: (input) => service.enqueue(owner, input) };
    },
    enqueue(owner: string, input: OutboxInput) {
      assertBackgroundExecution();
      if (closed) backgroundError("发件箱已关闭", 503);
      for (const [key, value] of Object.entries({
        owner,
        dedupKey: input.dedupKey,
        channel: input.channel,
        target: input.target,
        text: input.content?.text,
      }))
        backgroundText(value, key);
      if (input.channel !== "feishu.bot" && !/^feishu\.bot:[a-zA-Z0-9_-]+:[a-f0-9]{16}$/.test(input.channel) && !/^feishu\.personal:[a-f0-9]{16}$/.test(input.channel))
        backgroundError("不支持此飞书发件渠道");
      const id = digest([owner, input.dedupKey]),
        hash = digest(input);
      for (const at of [input.window?.notBefore, input.window?.expiresAt])
        if (
          at !== undefined &&
          (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at) ||
            !Number.isFinite(Date.parse(at)))
        )
          backgroundError("发件窗口必须使用带时区的时间");
      if (
        input.window?.expiresAt &&
        input.window?.notBefore &&
        Date.parse(input.window.expiresAt) <= Date.parse(input.window.notBefore)
      )
        backgroundError("发件窗口无效");
      return store.transaction(() => {
        const previous = store.get<OutboxItem>(collection, id);
        if (previous) {
          if (previous.contentHash !== hash)
            backgroundError("dedup_key_conflict", 409);
          return { id, duplicate: true, status: previous.status };
        }
        const item: OutboxItem = {
          ...structuredClone(input),
          id,
          owner,
          version: 1,
          contentHash: hash,
          attempt: 0,
          status: "queued",
          createdAt: timestamp(),
          updatedAt: timestamp(),
        };
        save(item);
        return { id, duplicate: false, status: item.status };
      });
    },
    async send(id: string): Promise<OutboxItem> {
      if (closed) backgroundError("发件箱已关闭", 503);
      const existing = jobs.get(id);
      if (existing) return existing;
      const item = read(id);
      if (!["queued", "held", "needs_approval"].includes(item.status))
        return item;
      if (!enabledOwner(item.owner))
        return save({
          ...item,
          status: "held",
          error: "发布者已停用",
          updatedAt: timestamp(),
        });
      if (!referenceCurrent(store, item.staleIf, now()))
        return save({
          ...item,
          status: "cancelled",
          error: "关联事实已失效",
          updatedAt: timestamp(),
        });
      if (
        item.relatedTo?.kind === "todo" &&
        store.get<{ completedAt?: string }>("todos", item.relatedTo.id)
          ?.completedAt
      )
        return save({
          ...item,
          status: "cancelled",
          error: "待办已完成",
          updatedAt: timestamp(),
        });
      if (item.window?.expiresAt && Date.parse(item.window.expiresAt) <= now())
        return save({ ...item, status: "expired", updatedAt: timestamp() });
      if (
        (item.window?.notBefore && Date.parse(item.window.notBefore) > now()) ||
        (item.nextAt && Date.parse(item.nextAt) > now())
      )
        return save({ ...item, status: "held", updatedAt: timestamp() });
      if (!grant(item) && !approved(item)) {
        const a = item.approvalId
          ? store.get<Approval>("approvals", item.approvalId)
          : undefined;
        if (a?.status === "rejected")
          return save({
            ...item,
            status: "cancelled",
            error: "用户拒绝发送",
            updatedAt: timestamp(),
          });
        if (!a)
          return store.transaction(() => {
            const approval = propose({
              kind: "feishu-reply",
              title: "确认发送通知",
              details: `${item.owner} → ${item.channel} / ${item.target}\n${item.content.text}`,
              params: {
                outboxId: item.id,
                outboxVersion: item.version,
                contentHash: item.contentHash,
                chatId: item.target,
                text: item.content.text,
              },
            });
            return save({
              ...item,
              status: "needs_approval",
              approvalId: approval.id,
              updatedAt: timestamp(),
            });
          });
        return save({
          ...item,
          status: "needs_approval",
          updatedAt: timestamp(),
        });
      }
      const channel = senders.get(item.channel),
        target = item.target === "owner" ? channel?.ownerTarget() : item.target;
      if (!channel || !target)
        return save({
          ...item,
          status: "held",
          error: "渠道未配置或尚未配对",
          updatedAt: timestamp(),
        });
      if (jobs.size >= 4) return item;
      const claimed = save({
        ...item,
        status: "sending",
        attempt: item.attempt + 1,
        updatedAt: timestamp(),
      });
      const controller = new AbortController();
      sendControllers.set(id, controller);
      const job = Promise.resolve()
        .then(async () => {
          try {
            await effects.perform({
              key: `outbox:${claimed.id}:${claimed.attempt}`,
              kind: "outbox.send",
              target,
              summary: "已授权的通知",
              content: {
                contentHash: claimed.contentHash,
                text: claimed.content.text,
              },
              run: async () => {
                if (
                  closed ||
                  !enabledOwner(claimed.owner) ||
                  !referenceCurrent(store, claimed.staleIf, now()) ||
                  (!grant(claimed) && !approved(claimed))
                )
                  throw Object.assign(new Error("发送条件已改变"), {
                    delivery: "no",
                  });
                let watchdog: ReturnType<typeof setTimeout> | undefined;
                try {
                  await Promise.race([
                    channel.send(
                      target,
                      claimed.content.text,
                      `outbox:${claimed.id}:${claimed.attempt}:channel`,
                    ),
                    new Promise<never>((_resolve, reject) => {
                      const abort = () =>
                        reject(
                          Object.assign(
                            new Error("渠道发送超时或服务关闭，送达结果未知"),
                            { delivery: "unknown" },
                          ),
                        );
                      if (controller.signal.aborted) abort();
                      else
                        controller.signal.addEventListener("abort", abort, {
                          once: true,
                        });
                      watchdog = setTimeout(
                        () => controller.abort(),
                        sendTimeoutMs,
                      );
                    }),
                  ]);
                } finally {
                  if (watchdog) clearTimeout(watchdog);
                }
              },
            });
            return save({
              ...claimed,
              status: "sent",
              error: undefined,
              updatedAt: timestamp(),
            });
          } catch (error) {
            const definite =
              error &&
              typeof error === "object" &&
              "delivery" in error &&
              error.delivery === "no";
            return save({
              ...claimed,
              status: definite
                ? claimed.attempt >= 5
                  ? "failed"
                  : "held"
                : "unknown",
              error: error instanceof Error ? error.message : String(error),
              nextAt: new Date(
                now() +
                  [10, 60, 300, 1800, 7200][Math.min(claimed.attempt - 1, 4)]! *
                    1000,
              ).toISOString(),
              updatedAt: timestamp(),
            });
          }
        })
        .finally(() => {
          jobs.delete(id);
          sendControllers.delete(id);
        });
      jobs.set(id, job);
      return job;
    },
    async tick() {
      if (closed) return;
      const ready = service
        .list()
        .filter(
          (item) =>
            !jobs.has(item.id) &&
            ["queued", "held", "needs_approval"].includes(item.status),
        );
      await Promise.allSettled(ready.map((item) => service.send(item.id)));
    },
    async approve(approval: Approval) {
      const item = read(String(approval.params.outboxId));
      if (
        item.version !== approval.params.outboxVersion ||
        item.contentHash !== approval.params.contentHash ||
        item.approvalId !== approval.id ||
        item.target !== approval.params.chatId ||
        item.content.text !== approval.params.text
      )
        backgroundError("发件内容与批准版本不一致", 409);
      return service.send(item.id);
    },
    cancel(id: string, version?: number) {
      const item = read(id, version);
      if (["sent", "sending", "unknown"].includes(item.status))
        backgroundError("该状态不能取消", 409);
      return save({
        ...item,
        status: "cancelled",
        version: item.version + 1,
        updatedAt: timestamp(),
      });
    },
    verify(id: string, delivered: boolean, version: number) {
      const item = read(id, version);
      if (item.status !== "unknown") backgroundError("仅未知发件需要核实", 409);
      return save({
        ...item,
        status: delivered ? "sent" : "queued",
        nextAt: timestamp(),
        auditedBy: "user",
        error: delivered ? "用户核实已送达" : "用户核实未送达并明确重发",
        updatedAt: timestamp(),
      });
    },
    cleanupOwner(owner: string) {
      for (const item of service.list())
        if (
          item.owner === owner &&
          !["sent", "sending", "unknown", "cancelled"].includes(item.status)
        )
          service.cancel(item.id);
    },
    async close() {
      closed = true;
      for (const controller of sendControllers.values()) controller.abort();
      await Promise.allSettled([...jobs.values()]);
      senders.clear();
    },
  };
  return service;
}
