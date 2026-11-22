import { h } from "../lib/dom.js";
import { createThreadTranslations } from "./inbox-thread-translation.js";
import { timeAgo } from "../lib/format.js";
import { Button, Card, Banner, TextArea, Pill } from "../ui/kit.js";

const LABEL = {
  queued: "主 Agent 待整理",
  processing: "主 Agent 正在处理",
  watching: "后台跟进",
  quiet: "已消化",
  waiting_user: "待你回复",
  failed: "后台暂未完成",
  paused: "自动整理已暂停",
};
export function createInboxConversationsUI({
  api,
  store,
  router,
  redraw,
  openSource,
}) {
  const translations = createThreadTranslations({ api, store, router });
  const drafts = new Map(),
    errors = new Map(),
    pending = new Set();
  const key = (id) => `${api.token?.() || ""}:${id}`;
  async function action(group, operation, text) {
    const id = key(group.id);
    if (pending.has(id)) return;
    pending.add(id);
    errors.delete(id);
    redraw();
    try {
      await api.post(
        `/inbox/conversations/${encodeURIComponent(group.id)}/${operation}`,
        { version: group.version, ...(text ? { text } : {}) },
      );
      if (key(group.id) === id && drafts.get(id) === text) drafts.delete(id);
      await store.refresh();
    } catch (error) {
      errors.set(
        id,
        error.status === 409
          ? "会话已有更新，请核对最新问题；回复草稿已保留。"
          : `未能完成：${error.message}`,
      );
    } finally {
      pending.delete(id);
      redraw();
    }
  }
  return {
    signature: (group) => [
      translations.currentGroup() === group.id,
      store.view.snapshotOwner,
      pending.has(key(group.id)),
      errors.get(key(group.id)),
    ],
    header(state) {
      if (!state) return;
      return h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "row row--between row--wrap" },
          h(
            "p",
            { class: "small muted" },
            state.enabled
              ? "主 Agent 在后台合并消息、整理事项和跟进；只有需要你回答时才进入“待你回复”。"
              : "自动整理已暂停，原消息与已有事项仍保留。",
          ),
          Button({
            label: state.enabled ? "暂停自动整理" : "开启自动整理",
            size: "sm",
            onClick: async () => {
              try {
                errors.delete("config");
                await api.put("/inbox/assistant", { enabled: !state.enabled });
                await store.refresh();
              } catch (error) {
                errors.set("config", error.message);
              }
              redraw();
            },
          }),
        ),
        errors.has("config") &&
          Banner({ tone: "danger", children: errors.get("config") }),
        !state.available &&
          Banner({
            tone: "warn",
            children:
              state.reason || "等待主模型配置，消息已保存，尚未进行 AI 整理。",
          }),
        h(
          "details",
          null,
          h("summary", { class: "small muted" }, "后台状态与工作目录"),
          h("p", { class: "small folder-path" }, state.workspace),
        ),
      );
    },
    card(group, items) {
      const id = key(group.id),
        busy = pending.has(id),
        question = group.status === "waiting_user";
      const answer = question
        ? TextArea({
            rows: 2,
            value: drafts.get(id) || "",
            placeholder: "把关键信息回复给主 Agent，它会继续处理",
            "aria-label": `回复主 Agent：${group.title}`,
          })
        : undefined;
      answer?.addEventListener("input", () => drafts.set(id, answer.value));
      const focused = translations.currentGroup() === group.id;
      const originalMessages = h("details", { open: focused },
        h("summary", null, `查看原始消息（${items.length} 条）`),
        items.map(item => h("article", { class: "stack card__body" },
          h("p", { class: "small muted" },
            `${item.raw.origin?.senderName || item.raw.sender || group.person} · ${timeAgo(item.time)}`),
          h("p", { class: focused ? "mailbox-thread-body" : "mailbox-preview", dataset: { threadMessage: item.id } }, item.text),
          Button({ label: "查看此消息来源", size: "sm", onClick: () => openSource(item.id) }),
        )),
      );
      if (focused) translations.mount(group.id, originalMessages, items);
      return Card({
        title: group.title,
        className: "mailbox-group",
        sub: `${group.messageIds.length} 条消息已合并 · ${group.kind === "direct" ? "私聊" : group.chatName || "群聊"}`,
        tools: h("div", { class: "row row--wrap" },
          !focused && h("a", { class: "btn btn--sm", href: router.href("inbox") + "?conversation=" + encodeURIComponent(group.id) }, "打开会话"),
          Pill(LABEL[group.status] || "后台处理中", question ? "warn" : group.status === "failed" ? "danger" : ""),
        ),
        body: h(
          "div",
          { class: "stack" },
          h(
            "p",
            { class: "mailbox-preview" },
            group.reason ||
              group.summary ||
              (group.status === "quiet"
                ? "消息已归档或已关联事项，原始记录仍可查看。"
                : group.status === "queued"
                  ? "已收到消息，主 Agent 将结合上下文统一整理。"
                  : "正在结合上下文整理，原消息已保留。"),
          ),
          group.todoIds?.length > 0 &&
            h(
              "div",
              { class: "stack" },
              h("strong", null, "合并后的工作事项"),
              group.todoIds.map((todoId) => {
                const todo = store.view.snapshot?.todos.find(
                  (item) =>
                    item.id === todoId && item.projectId === group.projectId,
                );
                return h(
                  "a",
                  {
                    href: router.href(
                      "projects",
                      group.projectId || "all",
                      "todos",
                    ),
                  },
                  `${todo?.completedAt ? "已完成" : "跟进中"} · ${todo?.title || "事项归属已变化，请核对"}`,
                );
              }),
            ),
          question &&
            h(
              "div",
              { class: "stack" },
              h("strong", null, group.question),
              answer,
              Button({
                label: "回复主 Agent，继续处理",
                kind: "primary",
                disabled: busy,
                onClick: () => action(group, "answer", answer.value.trim()),
              }),
            ),
          group.error && h("p", { class: "small muted" }, group.error),
          errors.has(id) &&
            Banner({ tone: "danger", children: errors.get(id) }),
          originalMessages,
          h(
            "div",
            { class: "row row--wrap" },
            group.status === "failed" &&
              Button({
                label: "重试后台整理",
                size: "sm",
                disabled: busy,
                onClick: () => action(group, "retry"),
              }),
            group.pendingCount > 0 &&
              Button({
                label: "归档此会话",
                size: "sm",
                disabled: busy,
                onClick: () => action(group, "archive"),
              }),
          ),
        ),
      });
    },
  };
}
