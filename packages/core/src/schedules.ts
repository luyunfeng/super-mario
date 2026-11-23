import { Cron } from "croner";
import type {
  ScheduleApi,
  ScheduleInfo,
  ScheduleInput,
  Store,
  Json,
} from "../../plugin-sdk/src/index.ts";
import { backgroundError, backgroundText, digest } from "./eventbox.ts";
import type { Eventbox } from "./eventbox.ts";
const collection = "eventbox.schedules";
export function nextOccurrence(spec: ScheduleInput, after: number): string {
  if (spec.kind === "once") return spec.at!;
  if (spec.kind === "interval") {
    const anchor = Date.parse(spec.anchorAt!);
    const step = spec.everySec! * 1000;
    return new Date(
      anchor + Math.max(0, Math.floor((after - anchor) / step) + 1) * step,
    ).toISOString();
  }
  const cron = new Cron(spec.cron!, { timezone: spec.tz, paused: true });
  try {
    const next = cron.nextRun(new Date(after));
    if (!next) backgroundError("cron 没有后续触发时间");
    return next.toISOString();
  } finally {
    cron.stop();
  }
}
function validate(input: ScheduleInput, now: number): ScheduleInput {
  backgroundText(input.name, "调度名称");
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "name",
          "kind",
          "at",
          "everySec",
          "anchorAt",
          "cron",
          "tz",
          "until",
          "missed",
          "catchUpMax",
          "payload",
          "id",
          "owner",
          "version",
          "status",
          "nextAt",
          "lastFiredFor",
          "endedAt",
          "createdAt",
          "updatedAt",
        ].includes(key),
    )
  )
    backgroundError("调度包含未知字段，事件类型由核心固定");
  if (!["once", "interval", "cron"].includes(input.kind))
    backgroundError("调度类型无效");
  const result: ScheduleInput = {
    ...input,
    missed: input.missed || "coalesce",
  };
  const zoned = (value: unknown) =>
    typeof value === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value));
  if (input.until !== undefined && (input.kind === 'once' || !zoned(input.until)))
    backgroundError('周期结束时间必须带时区，且仅适用于重复计划');
  if (input.kind === "once" && !zoned(input.at))
    backgroundError("一次调度时间必须带时区");
  if (input.kind === "interval") {
    if (!Number.isSafeInteger(input.everySec) || input.everySec! < 10)
      backgroundError("间隔必须至少 10 秒");
    result.anchorAt ??= new Date(now).toISOString();
    if (!zoned(result.anchorAt)) backgroundError("间隔基准时间必须带时区");
  }
  if (input.kind === "cron") {
    if (
      typeof input.cron !== "string" ||
      input.cron.trim().split(/\s+/).length !== 5 ||
      !input.tz
    )
      backgroundError("cron 必须为五段表达式并指定时区");
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.tz }).format();
      nextOccurrence(input, now);
    } catch {
      backgroundError("cron 或 IANA 时区无效");
    }
  }
  if (!["coalesce", "skip", "catch_up"].includes(result.missed!))
    backgroundError("错过策略无效");
  if (
    result.missed === "catch_up" &&
    (!Number.isSafeInteger(input.catchUpMax) ||
      input.catchUpMax! < 1 ||
      input.catchUpMax! > 100)
  )
    backgroundError("补执行上限必须在 1–100 之间");
  if (
    input.payload !== undefined &&
    Buffer.byteLength(JSON.stringify(input.payload)) > 4096
  )
    backgroundError("调度载荷超过 4KB");
  return result;
}
/** Preview a newly activated cron rule with the scheduler's clock and timezone semantics. */
export function previewCron(input: Record<string, unknown>, now = Date.now()) {
  if (typeof input.cron !== 'string' || typeof input.tz !== 'string')
    backgroundError('需要五段 cron 表达式和 IANA 时区');
  const spec = validate({ name: '排期预览', kind: 'cron', cron: input.cron.trim(), tz: input.tz.trim(), ...(input.until !== undefined ? { until: input.until as string } : {}) }, now);
  const nextRuns: string[] = [];
  let cursor = now - 1;
  while (nextRuns.length < 3) {
    const at = nextOccurrence(spec, cursor);
    cursor = Date.parse(at);
    if (spec.until && cursor >= Date.parse(spec.until)) break;
    const previous = nextRuns.at(-1);
    if (!previous || wall(previous, spec.tz!) !== wall(at, spec.tz!)) nextRuns.push(at);
  }
  return { cron: spec.cron!, tz: spec.tz!, nextRuns };
}

export function createSchedules({
  store,
  eventbox,
  now = Date.now,
}: {
  store: Store;
  eventbox: Eventbox;
  now?: () => number;
}) {
  let closed = false;
  const timestamp = () => new Date(now()).toISOString();
  function read(id: string, owner?: string, version?: number) {
    const item = store.get<ScheduleInfo>(collection, id);
    if (!item || (owner && item.owner !== owner))
      backgroundError("调度不存在", 404);
    if (version !== undefined && item.version !== version)
      backgroundError("调度版本已改变", 409);
    return item;
  }
  const service = {
    list: () => store.list<ScheduleInfo>(collection),
    forOwner(owner: string): ScheduleApi {
      return {
        create(input) {
          if (closed) backgroundError("调度器已关闭", 503);
          if (
            Object.keys(input).some(
              (key) =>
                ![
                  "name",
                  "kind",
                  "at",
                  "everySec",
                  "anchorAt",
                  "cron",
                  "tz",
                  "until",
                  "missed",
                  "catchUpMax",
                  "payload",
                ].includes(key),
            )
          )
            backgroundError("调度包含未知字段，来源与事件类型由宿主固定");
          const spec = validate(input, now()),
            id = digest([owner, spec.name]);
          if (spec.until && Date.parse(spec.until) <= now()) backgroundError('结束时间必须晚于当前时间');
          if (store.get(collection, id)) backgroundError("调度名称已存在", 409);
          const item: ScheduleInfo = {
            ...spec,
            id,
            owner,
            version: 1,
            status:
              store.get<{ enabled: boolean }>("eventbox.owners", owner)
                ?.enabled === false
                ? "owner_disabled"
                : "active",
            nextAt:
              spec.kind === "once" ? spec.at! : nextOccurrence(spec, now() - 1),
            createdAt: timestamp(),
            updatedAt: timestamp(),
          };
          store.put(collection, id, item);
          return structuredClone(item);
        },
        update(id, patch, version) {
          return service.update(id, patch, version, owner);
        },
        cancel(id, version) {
          service.update(id, { status: "cancelled" }, version, owner);
        },
        list: () => service.list().filter((s) => s.owner === owner),
      };
    },
    update(
      id: string,
      patch: Partial<ScheduleInput> & {
        status?: "active" | "paused" | "cancelled";
      },
      version?: number,
      owner?: string,
    ) {
      if (closed) backgroundError("调度器已关闭", 503);
      return store.transaction(() => {
        const previous = read(id, owner, version);
        if (
          Object.keys(patch).some(
            (key) =>
              ![
                "name",
                "kind",
                "at",
                "everySec",
                "anchorAt",
                "cron",
                "tz",
                "until",
                "missed",
                "catchUpMax",
                "payload",
                "status",
              ].includes(key),
          )
        )
          backgroundError("调度修改包含未知字段");
        if (patch.name !== undefined && patch.name !== previous.name)
          backgroundError("调度名称不可改变");
        if (
          patch.status &&
          !["active", "paused", "cancelled"].includes(patch.status)
        )
          backgroundError("调度状态无效");
        if (previous.status === "cancelled") backgroundError("调度已取消", 409);
        const spec = validate({ ...previous, ...patch }, now());
        const desiredStatus = patch.status ?? previous.status;
        const status =
          desiredStatus === "active" &&
          store.get<{ enabled: boolean }>("eventbox.owners", previous.owner)
            ?.enabled === false
            ? "owner_disabled"
            : desiredStatus;
        // A pure resume coalesces at most once; edits compute a new timeline.
        const resuming =
          patch.status === "active" && previous.status !== "active";
        const nextAt =
          resuming &&
          previous.missed === "coalesce" &&
          Date.parse(previous.nextAt) <= now()
            ? previous.nextAt
            : spec.kind === "once"
              ? spec.at!
              : nextOccurrence(spec, now() - 1);
        const next = {
          ...previous,
          ...spec,
          status,
          nextAt,
          version: previous.version + 1,
          updatedAt: timestamp(),
        };
        store.put(collection, id, next);
        if (status === "cancelled")
          eventbox.cancelWhere((e) => e.staleIf?.ref === `schedule:${id}`);
        return structuredClone(next);
      });
    },
    ownerEnabled(owner: string, enabled: boolean) {
      for (const s of service.list().filter((s) => s.owner === owner)) {
        if (!enabled && s.status === "active")
          store.put(collection, s.id, {
            ...s,
            status: "owner_disabled",
            version: s.version + 1,
            updatedAt: timestamp(),
          });
        else if (enabled && s.status === "owner_disabled")
          service.update(s.id, { status: "active" });
      }
    },
    cleanupOwner(owner: string) {
      for (const s of service
        .list()
        .filter((s) => s.owner === owner && s.status !== "cancelled"))
        service.update(s.id, { status: "cancelled" });
    },
    tick() {
      if (closed) return;
      const tickAt = now();
      for (const original of service.list()) {
        const expired = original.until !== undefined && Date.parse(original.until) <= tickAt;
        if (expired ? !['active', 'paused', 'owner_disabled'].includes(original.status)
          : original.status !== 'active' || Date.parse(original.nextAt) > tickAt) continue;
        store.transaction(() => {
          const item = read(original.id);
          if (item.version !== original.version || item.status !== original.status) return;
          if (expired) {
            const endedAt = new Date(tickAt).toISOString();
            store.put(collection, item.id, { ...item, status: 'done', endedAt, updatedAt: endedAt });
            return;
          }
          let next = Date.parse(item.nextAt),
            missed = 0;
          const due: number[] = [];
          if (item.kind === "interval") {
            missed = Math.max(
              0,
              Math.floor((tickAt - next) / (item.everySec! * 1000)),
            );
            const count =
              item.missed === "catch_up"
                ? Math.min(missed + 1, item.catchUpMax!)
                : 1;
            for (let i = 0; i < count; i++)
              due.push(
                next +
                  (item.missed === "catch_up" ? i : missed) *
                    item.everySec! *
                    1000,
              );
            next += (missed + 1) * item.everySec! * 1000;
          } else if (item.kind === "once") {
            due.push(next);
          } else {
            // Croner handles DST gaps; suppress duplicate wall-clock minutes at fall-back.
            let previousWall = item.lastFiredFor
              ? wall(item.lastFiredFor, item.tz!)
              : "";
            while (next <= tickAt) {
              if (
                wall(new Date(next).toISOString(), item.tz!) !== previousWall
              ) {
                due.push(next);
                previousWall = wall(new Date(next).toISOString(), item.tz!);
              }
              missed++;
              if (missed > 100000)
                backgroundError("积压过多，请暂停并更新调度", 409);
              next = Date.parse(nextOccurrence(item, next));
            }
            missed = Math.max(0, due.length - 1);
            if (item.missed === "coalesce")
              due.splice(0, Math.max(0, due.length - 1));
            else if (item.missed === "catch_up") due.splice(item.catchUpMax!);
          }
          const skip =
            item.missed === "skip" &&
            (missed > 0 || tickAt - Date.parse(item.nextAt) > 5000);
          if (!skip)
            for (const at of due) {
              const scheduledFor = new Date(at).toISOString();
              eventbox.publish("core", {
                type: "schedule.due",
                typeVersion: 1,
                sourceId: `schedule:${item.id}:v${item.version}:${scheduledFor}`,
                data: {
                  scheduleId: item.id,
                  scheduleVersion: item.version,
                  owner: item.owner,
                  name: item.name,
                  scheduledFor,
                  missedCount: missed,
                  payload: item.payload ?? null,
                },
                subject: { kind: "schedule", id: item.id },
                staleIf: { ref: `schedule:${item.id}`, version: item.version },
              });
            }
          store.put(collection, item.id, {
            ...item,
            nextAt: new Date(next).toISOString(),
            ...(due.length && !skip
              ? { lastFiredFor: new Date(due.at(-1)!).toISOString() }
              : {}),
            status: item.kind === "once" ? "done" : "active",
            updatedAt: timestamp(),
          });
        });
      }
    },
    close() {
      closed = true;
    },
  };
  return service;
}
function wall(date: string, tz: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}
