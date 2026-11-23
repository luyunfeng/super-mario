import type { Card } from "./interactions.ts";
import { cardAcceptsAnswer } from "./question-deadline.ts";
import { readRunDeadlineTarget } from "./run-question-deadline.ts";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
interface ExecutionScope {
  event: DurableEvent;
  signal: AbortSignal;
  active: boolean;
}
const deliveryScope = new AsyncLocalStorage<ExecutionScope>();
export const currentBackgroundEvent = () => deliveryScope.getStore()?.event;
export function assertBackgroundExecution() {
  const scope = deliveryScope.getStore();
  if (scope && (!scope.active || scope.signal.aborted))
    throw Object.assign(new Error("事件执行范围已失效，拒绝迟到动作"), {
      retryable: false,
    });
}
import { assertJson } from "../../plugin-sdk/src/index.ts";
import type {
  DurableEvent,
  EventDelivery,
  EventInput,
  EventResult,
  EventSubscriptionRecord,
  PluginEventSubscription,
  Store,
  EventBus,
  StaleReference,
} from "../../plugin-sdk/src/index.ts";

const collections = {
  events: "eventbox.events",
  subs: "eventbox.subs",
  deliveries: "eventbox.deliveries",
  meta: "eventbox.metadata",
};
const terminal = new Set(["done", "skipped", "cancelled"]);
export function backgroundError(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
export function backgroundText(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    backgroundError(`${name}不能为空`);
}
export function stableJson(value: unknown): string {
  assertJson(value);
  const order = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(order)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, order((v as Record<string, unknown>)[key])]),
          )
        : v;
  return JSON.stringify(order(value));
}
export const digest = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");
export function referenceCurrent(
  store: Store,
  stale?: StaleReference,
  at = Date.now(),
): boolean {
  if (!stale) return true;
  const split = stale.ref.indexOf(":");
  const kind = stale.ref.slice(0, split),
    id = stale.ref.slice(split + 1);
  // Timestamp equality alone cannot distinguish a restored reminder from an
  // earlier cycle. Legacy Todos belong to generation 1.
  if (kind === "reminder") {
    if (!Number.isSafeInteger(stale.version) || stale.version < 1) return false;
    try {
      const pair: unknown = JSON.parse(id);
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== "string")) return false;
      const todo = store.get<{reminderAt?: string; reminderVersion?: number; completedAt?: string}>("todos", pair[0]);
      return !!todo && !todo.completedAt && typeof todo.reminderAt === "string" && todo.reminderAt === pair[1]
        && (todo.reminderVersion ?? 1) === stale.version;
    } catch { return false; }
  }
  const collection = (
    {
      schedule: "eventbox.schedules",
      approval: "approvals",
      plan: "plans",
      interaction: "interactions",
      todo: "todos",
      run: "runs",
    } as Record<string, string>
  )[kind];
  if (
    split < 1 ||
    !collection ||
    !Number.isSafeInteger(stale.version) ||
    stale.version < 1
  )
    return false;
  const item = store.get<{
    version?: number;
    decisionVersion?: number;
    status?: string;
    completedAt?: string;
    expiresAt?: string;
    decisionDeadlineAt?: string;
    todoId?: string;
    runId?: string;
    params?: { todoId?: string };
  }>(collection, id);
  if (kind === "interaction" && item?.decisionDeadlineAt) {
    const card = store.get<Card>("interactions", id)!;
    return card.id === id && card.version === stale.version && cardAcceptsAnswer(card, at) &&
      (!card.runId || !!readRunDeadlineTarget(store, card));
  }
  if (item && (kind === "approval" || kind === "interaction")) {
    const todoId = item.todoId || item.params?.todoId;
    if (
      todoId &&
      store.get<{ completedAt?: string }>("todos", todoId)?.completedAt
    )
      return false;
    const run = item.runId
      ? store.get<{ status: string }>("runs", item.runId)
      : undefined;
    if (
      item.runId &&
      (!run || ["completed", "failed", "cancelled"].includes(run.status))
    )
      return false;
  }
  return Boolean(
    item &&
      (item.decisionVersion ?? item.version) === stale.version &&
      ![
        "cancelled",
        "withdrawn",
        "expired",
        "paused",
        "owner_disabled",
      ].includes(item.status || "") &&
      !item.completedAt &&
      (!item.expiresAt || Date.parse(item.expiresAt) > at),
  );
}

/** One worker per SQLite store. Durable rows are authoritative; lanes only accelerate pending work. */
export function createEventbox({
  store,
  events,
  now = Date.now,
  concurrency = 4,
  retentionDays = 30,
  inactiveDays = 7,
}: {
  store: Store;
  events: EventBus;
  now?: () => number;
  concurrency?: number;
  retentionDays?: number;
  inactiveDays?: number;
}) {
  const handlers = new Map<string, PluginEventSubscription["handler"]>();
  const lanes = new Map<string, Set<string>>();
  const runningLanes = new Set<string>();
  const detachedLanes = new Set<string>();
  const jobs = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  let closed = false,
    started = false,
    scheduled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const timestamp = () => new Date(now()).toISOString();
  const settings = () => ({
    retentionDays,
    inactiveDays,
    ...store.get<{ retentionDays: number; inactiveDays: number }>(
      "eventbox.settings",
      "retention",
    ),
  });
  const subs = () => store.list<EventSubscriptionRecord>(collections.subs);
  const subCache = new Map(subs().map((sub) => [sub.id, sub]));
  // A persisted identity is not a live callback. Only re-registration reactivates it.
  for (const [id, sub] of subCache)
    if (sub.status === "active") {
      const inactive = {
        ...sub,
        status: "inactive" as const,
        inactiveSince: timestamp(),
      };
      store.put(collections.subs, id, inactive);
      subCache.set(id, inactive);
    }
  const lane = (d: EventDelivery) =>
    `${d.subscriptionId}:${subCache.get(d.subscriptionId)?.serial === "none" ? d.id : d.serialKey}`;
  function index(d: EventDelivery) {
    const key = lane(d);
    if (["pending", "retry_wait", "running"].includes(d.status)) {
      let queue = lanes.get(key);
      if (!queue) lanes.set(key, (queue = new Set()));
      queue.add(d.id);
    } else {
      const queue = lanes.get(key);
      queue?.delete(d.id);
      if (!queue?.size) lanes.delete(key);
    }
  }
  function save(d: EventDelivery) {
    store.put(collections.deliveries, d.id, d);
    index(d);
  }
  function notify() {
    try {
      events.publish("eventbox.changed", {});
    } catch {
      /* Notifications do not own durable progress. */
    }
  }
  const readEvent = (id: string) =>
    store.get<DurableEvent>(collections.events, id);
  for (const d of store.list<EventDelivery>(collections.deliveries)) {
    if (d.status === "running") {
      const effects = subCache.get(d.subscriptionId)?.effects;
      save({
        ...d,
        status: effects && effects !== "direct" ? "pending" : "unknown",
        reason: "上次进程中断，按处理器副作用声明恢复",
        updatedAt: timestamp(),
      });
    } else index(d);
  }
  function matches(sub: EventSubscriptionRecord, e: DurableEvent) {
    const data =
      e.data && typeof e.data === "object" && !Array.isArray(e.data)
        ? e.data
        : {};
    return (
      sub.types.some((t) => t.type === e.type && t.version === e.typeVersion) &&
      (!sub.subjectKind || sub.subjectKind === e.subject?.kind) &&
      (e.type !== "schedule.due" ||
        sub.owner === "core" ||
        data.owner === sub.owner)
    );
  }
  function addDelivery(sub: EventSubscriptionRecord, e: DurableEvent) {
    const id = digest([sub.id, e.id]);
    if (!store.get(collections.deliveries, id))
      save({
        id,
        subscriptionId: sub.id,
        eventId: e.id,
        seq: e.seq,
        serialKey: e.subject ? `${e.subject.kind}:${e.subject.id}` : e.id,
        status: "pending",
        attempt: 0,
        failures: 0,
        createdAt: e.createdAt,
        updatedAt: timestamp(),
      });
  }
  function publish(source: string, input: EventInput) {
    if (closed) backgroundError("事件收件箱已关闭", 503);
    stableJson(input);
    if (
      Object.keys(input).some(
        (key) =>
          ![
            "type",
            "typeVersion",
            "sourceId",
            "data",
            "subject",
            "causedBy",
            "staleIf",
          ].includes(key),
      )
    )
      backgroundError("事件包含未知字段，来源与序号由宿主固定");
    if (input.subject) {
      backgroundText(input.subject.kind, "subject.kind");
      backgroundText(input.subject.id, "subject.id");
    }
    if (
      input.staleIf &&
      (!Number.isSafeInteger(input.staleIf.version) ||
        input.staleIf.version < 1 ||
        typeof input.staleIf.ref !== "string")
    )
      backgroundError("事实版本引用无效");
    backgroundText(source, "source");
    backgroundText(input.type, "type");
    backgroundText(input.sourceId, "sourceId");
    if (!Number.isSafeInteger(input.typeVersion) || input.typeVersion < 1)
      backgroundError("事件版本无效");
    stableJson(input);
    const identity = digest([source, input.sourceId]);
    const result = store.transaction(() => {
      const previous = readEvent(identity);
      if (previous) {
        const {
          id: _id,
          seq: _seq,
          rootId: _root,
          hops: _hops,
          createdAt: _at,
          source: _source,
          ...old
        } = previous;
        if (stableJson(old) !== stableJson(input))
          backgroundError("source_id_conflict", 409);
        return { id: identity, duplicate: true };
      }
      const seq = (store.get<number>(collections.meta, "lastSeq") || 0) + 1;
      const parent = input.causedBy ? readEvent(input.causedBy) : undefined;
      if (input.causedBy && !parent) backgroundError("因果事件不存在");
      const hops = parent ? (parent.hops ?? 0) + 1 : 0;
      if (hops > 8)
        throw Object.assign(new Error("事件因果链超过 8 层，停止自激处理"), {
          status: 409,
          retryable: false,
        });
      const e: DurableEvent = {
        ...structuredClone(input),
        id: identity,
        source,
        seq,
        hops,
        rootId: parent?.rootId || identity,
        createdAt: timestamp(),
      };
      store.put(collections.events, identity, e);
      store.put(collections.meta, "lastSeq", seq);
      for (const sub of subCache.values())
        if (matches(sub, e)) addDelivery(sub, e);
      return { id: identity, duplicate: false };
    });
    // May run after an outer transaction rolls back: drain always rereads persisted rows.
    wake();
    return result;
  }
  function subscribe(owner: string, spec: PluginEventSubscription) {
    if (closed) backgroundError("事件收件箱已关闭", 503);
    backgroundText(spec.name, "订阅名称");
    if (
      !/^[\w.-]+$/.test(spec.name) ||
      !["none", "ledger", "direct"].includes(spec.effects) ||
      !Array.isArray(spec.types) ||
      !spec.types.length ||
      spec.types.some(
        (t) =>
          typeof t.type !== "string" ||
          !t.type.trim() ||
          !Number.isSafeInteger(t.version) ||
          t.version < 1,
      ) ||
      typeof spec.handler !== "function" ||
      (spec.serial !== undefined && !["subject", "none"].includes(spec.serial))
    )
      backgroundError("订阅声明无效，effects 与事件版本必填");
    const max = spec.retry?.max ?? 5,
      backoff = spec.retry?.backoffSec ?? [10, 60, 300, 1800, 7200],
      timeout = spec.timeoutMs ?? 60000;
    if (
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > 100 ||
      !backoff.length ||
      backoff.some((n) => !Number.isFinite(n) || n < 0) ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 600000
    )
      backgroundError("订阅重试或超时配置无效");
    if (
      spec.replay !== undefined &&
      (!Number.isSafeInteger(spec.replay) ||
        spec.replay < 0 ||
        spec.replay > 1000)
    )
      backgroundError("回溯上限必须为 0–1000");
    const id = `${owner}/${spec.name}`;
    if (handlers.has(id)) backgroundError("订阅处理器重复", 409);
    const previous = store.get<EventSubscriptionRecord>(collections.subs, id);
    const { handler, ...definition } = spec;
    const enabled =
      store.get<{ enabled: boolean }>("eventbox.owners", owner)?.enabled !==
      false;
    const next: EventSubscriptionRecord = {
      ...definition,
      serial: spec.serial || "subject",
      retry: { max, backoffSec: backoff },
      timeoutMs: timeout,
      id,
      owner,
      status: enabled ? "active" : "inactive",
      ...(!enabled ? { inactiveSince: timestamp() } : {}),
      registeredAt: previous?.registeredAt || timestamp(),
      expiredCount: previous?.expiredCount || 0,
    };
    store.put(collections.subs, id, next);
    subCache.set(id, next);
    handlers.set(id, handler);
    if (!previous && spec.replay)
      for (const e of store
        .list<DurableEvent>(collections.events)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, spec.replay)
        .reverse())
        if (matches(next, e)) addDelivery(next, e);
    wake();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      handlers.delete(id);
      const current = store.get<EventSubscriptionRecord>(collections.subs, id);
      if (current) {
        const next = {
          ...current,
          status: "inactive" as const,
          inactiveSince: timestamp(),
        };
        store.put(collections.subs, id, next);
        subCache.set(id, next);
      }
    };
  }
  async function execute(
    d: EventDelivery,
    sub: EventSubscriptionRecord,
    handler: PluginEventSubscription["handler"],
  ) {
    const e = readEvent(d.eventId);
    if (!e || !referenceCurrent(store, e.staleIf, now())) {
      save({
        ...d,
        status: "skipped",
        reason: "stale",
        updatedAt: timestamp(),
      });
      return;
    }
    const claimed = {
      ...d,
      attempt: d.attempt + 1,
      status: "running" as const,
      updatedAt: timestamp(),
    };
    save(claimed);
    const controller = new AbortController();
    controllers.set(d.id, controller);
    const execution: ExecutionScope = {
      event: e,
      signal: controller.signal,
      active: true,
    };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false,
      syncCommitted = false;
    try {
      const apply = (result: EventResult) => {
        if (
          !result ||
          !["done", "skip", "retry", "failed"].includes(result.status)
        )
          throw new Error("事件处理器返回值无效");
        if (result.status === "retry")
          retryResult(
            claimed,
            sub,
            result.reason,
            result.afterSec,
            result.deferred,
          );
        else
          save({
            ...claimed,
            status: result.status === "skip" ? "skipped" : result.status,
            ...(result.status === "done" && result.outcome !== undefined
              ? { outcome: result.outcome }
              : {}),
            ...("reason" in result ? { reason: result.reason } : {}),
            updatedAt: timestamp(),
          });
      };
      const work = Promise.resolve().then(() => {
        let result!: EventResult | Promise<EventResult>;
        store.transaction(() => {
          result = deliveryScope.run(execution, () =>
            handler({ ...e, attempt: claimed.attempt }, controller.signal),
          );
          // Synchronous local handlers commit their writes and delivery completion atomically.
          // Async I/O handlers must persist idempotent outcomes themselves (e.g. supervisor.processed).
          if (
            !result ||
            typeof (result as Promise<EventResult>).then !== "function"
          ) {
            apply(result as EventResult);
            syncCommitted = true;
          }
        });
        return result;
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        const fail = () => {
          timedOut = true;
          detachedLanes.add(lane(claimed));
          reject(new Error("事件处理超时或服务关闭，结果需核实"));
        };
        controller.signal.addEventListener("abort", fail, { once: true });
        watchdog = setTimeout(() => controller.abort(), sub.timeoutMs!);
      });
      void work
        .finally(() => {
          detachedLanes.delete(lane(claimed));
          if (timedOut) runningLanes.delete(lane(claimed));
          wake();
        })
        .catch(() => {});
      const result = await Promise.race([work, deadline]);
      if (syncCommitted) return;
      if (timedOut) {
        save({
          ...claimed,
          status: "unknown",
          reason: "处理器超时，结果需核实",
          updatedAt: timestamp(),
        });
        return;
      }
      store.transaction(() => apply(result));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (timedOut || sub.effects === "direct")
        save({ ...claimed, status: "unknown", reason, updatedAt: timestamp() });
      else if (
        error &&
        typeof error === "object" &&
        "retryable" in error &&
        error.retryable === false
      )
        save({ ...claimed, status: "failed", reason, updatedAt: timestamp() });
      else retryResult(claimed, sub, reason);
    } finally {
      execution.active = false;
      if (watchdog) clearTimeout(watchdog);
      controllers.delete(d.id);
      notify();
    }
  }
  function retryResult(
    d: EventDelivery,
    sub: EventSubscriptionRecord,
    reason: string,
    afterSec?: number,
    deferred = false,
  ) {
    if (afterSec !== undefined && (!Number.isFinite(afterSec) || afterSec < 0))
      throw new Error("重试等待时间无效");
    const failures = d.failures + (deferred ? 0 : 1),
      retry = sub.retry!;
    save({
      ...d,
      failures,
      status: failures >= retry.max ? "failed" : "retry_wait",
      reason,
      nextAt: new Date(
        now() +
          (afterSec ??
            retry.backoffSec[
              Math.min(Math.max(0, failures - 1), retry.backoffSec.length - 1)
            ]!) *
            1000,
      ).toISOString(),
      updatedAt: timestamp(),
    });
  }
  function pump() {
    if (closed) return;
    for (const [key, ids] of lanes) {
      if (jobs.size >= concurrency) break;
      if (runningLanes.has(key)) continue;
      const id = ids.values().next().value as string | undefined;
      if (!id) continue;
      const d = store.get<EventDelivery>(collections.deliveries, id);
      if (!d || !["pending", "retry_wait"].includes(d.status)) {
        ids.delete(id);
        if (!ids.size) lanes.delete(key);
        continue;
      }
      const sub = subCache.get(d.subscriptionId),
        handler = handlers.get(d.subscriptionId);
      if (
        !sub ||
        store.get<{ enabled: boolean }>("eventbox.owners", sub.owner)
          ?.enabled === false ||
        sub.status !== "active" ||
        !handler ||
        (d.nextAt && Date.parse(d.nextAt) > now())
      )
        continue;
      runningLanes.add(key);
      const job = execute(d, sub, handler).finally(() => {
        jobs.delete(job);
        if (!detachedLanes.has(key)) runningLanes.delete(key);
        wake();
      });
      jobs.add(job);
    }
  }
  function wake() {
    if (!started || closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  }
  const api = {
    publish,
    subscribe,
    pump,
    settings,
    ownerEnabled(owner: string, enabled: boolean) {
      store.put("eventbox.owners", owner, { enabled });
      for (const sub of subCache.values())
        if (sub.owner === owner) {
          const next = {
            ...sub,
            status:
              enabled && handlers.has(sub.id)
                ? ("active" as const)
                : ("inactive" as const),
            ...(!enabled ? { inactiveSince: timestamp() } : {}),
          };
          store.put(collections.subs, sub.id, next);
          subCache.set(sub.id, next);
        }
      wake();
    },
    configure(patch: { retentionDays?: number; inactiveDays?: number }) {
      if (
        !patch ||
        Object.keys(patch).some(
          (k) => !["retentionDays", "inactiveDays"].includes(k),
        ) ||
        Object.values(patch).some(
          (n) => !Number.isSafeInteger(n) || n < 1 || n > 3650,
        )
      )
        backgroundError("保留天数必须为 1–3650");
      const next = { ...settings(), ...patch };
      store.put("eventbox.settings", "retention", next);
      return next;
    },
    start() {
      if (started || closed) return;
      started = true;
      timer = setInterval(() => pump(), 250);
      timer.unref();
      wake();
    },
    async drain() {
      pump();
      while (jobs.size) {
        await Promise.allSettled([...jobs]);
        pump();
      }
    },
    events: () =>
      store
        .list<DurableEvent>(collections.events)
        .sort((a, b) => b.seq - a.seq),
    subscriptions: subs,
    deliveries: () =>
      store
        .list<EventDelivery>(collections.deliveries)
        .sort((a, b) => b.seq - a.seq),
    retry(id: string, actor = "user", confirmed = false) {
      const d = store.get<EventDelivery>(collections.deliveries, id);
      if (!d || !["failed", "unknown"].includes(d.status))
        backgroundError("只有失败或未知投递可以重试", 409);
      if (d.status === "unknown" && !confirmed)
        backgroundError("结果未知，需先明确核实未执行再重试", 409);
      save({
        ...d,
        status: "pending",
        failures: 0,
        nextAt: timestamp(),
        reason: "人工核实并重试",
        auditedBy: actor,
        updatedAt: timestamp(),
      });
      wake();
    },
    acknowledge(id: string, actor = "user") {
      const d = store.get<EventDelivery>(collections.deliveries, id);
      if (!d || d.status !== "unknown")
        backgroundError("投递不是未知状态", 409);
      save({
        ...d,
        status: "done",
        auditedBy: actor,
        reason: "用户核实已处理",
        updatedAt: timestamp(),
      });
      notify();
    },
    cancelWhere(test: (e: DurableEvent) => boolean) {
      for (const d of store.list<EventDelivery>(collections.deliveries)) {
        const e = readEvent(d.eventId);
        if (["pending", "retry_wait"].includes(d.status) && e && test(e))
          save({ ...d, status: "cancelled", updatedAt: timestamp() });
      }
    },
    cleanupOwner(owner: string) {
      for (const sub of subs().filter((s) => s.owner === owner)) {
        if (sub.status === "active") backgroundError("请先停用插件再清理", 409);
        handlers.delete(sub.id);
        subCache.delete(sub.id);
        store.remove(collections.subs, sub.id);
      }
      for (const d of store.list<EventDelivery>(collections.deliveries))
        if (
          d.subscriptionId.startsWith(owner + "/") &&
          ["pending", "retry_wait"].includes(d.status)
        )
          save({ ...d, status: "cancelled", updatedAt: timestamp() });
    },
    cleanup() {
      store.transaction(() => {
        const rows = store.list<EventDelivery>(collections.deliveries);
        for (const d of rows) {
          const sub = subCache.get(d.subscriptionId);
          if (
            sub?.status === "inactive" &&
            ["pending", "retry_wait"].includes(d.status) &&
            Date.parse(d.createdAt) < now() - settings().inactiveDays * 86400000
          ) {
            save({
              ...d,
              status: "skipped",
              reason: "expired",
              updatedAt: timestamp(),
            });
            sub.expiredCount++;
            store.put(collections.subs, sub.id, sub);
          } else if (
            terminal.has(d.status) &&
            Date.parse(d.updatedAt) <
              now() - settings().retentionDays * 86400000
          ) {
            store.remove(collections.deliveries, d.id);
            index({ ...d, status: "done" });
          }
        }
        const referenced = new Set(
          store
            .list<EventDelivery>(collections.deliveries)
            .map((d) => d.eventId),
        );
        for (const e of api.events())
          if (
            Date.parse(e.createdAt) <
              now() - settings().retentionDays * 86400000 &&
            !referenced.has(e.id)
          )
            store.remove(collections.events, e.id);
      });
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([...jobs]);
      handlers.clear();
    },
  };
  return api;
}
export type Eventbox = ReturnType<typeof createEventbox>;
