// Read projections only; a write always needs an explicit action and is never automatically retried.
export function createBackgroundPage({ api, element: el, root }) {
  const section = el("section", undefined, "governance background-governance");
  section.id = "background-governance";
  const heading = el("div", undefined, "section-heading");
  heading.append(el("h2", "事件与发件"));
  const refresh = el("button", "重新读取", "secondary");
  refresh.type = "button";
  heading.append(refresh);
  section.append(heading);
  const description = el(
    "p",
    "事件处理、调度和发件分别记录。入箱不等于获准发送，未知结果需要人工核实。",
    "muted",
  );
  section.append(description);
  const error = el("p");
  error.setAttribute("role", "alert");
  error.hidden = true;
  section.append(error);
  const filters = el("div", undefined, "filter-bar");
  function select(label, entries) {
    const wrapper = el("label", label),
      control = el("select");
    for (const [value, text] of entries) control.add(new Option(text, value));
    wrapper.append(control);
    filters.append(wrapper);
    return control;
  }
  const status = select("投递状态", [
    ["", "全部"],
    ["failed", "失败"],
    ["unknown", "未知"],
    ["pending", "待处理"],
    ["retry_wait", "等待重试"],
    ["done", "已处理"],
  ]);
  const subscription = select("订阅者", [["", "全部"]]);
  section.append(filters);
  const summary = el("p", undefined, "notice");
  const lists = el("div", undefined, "stack");
  section.append(summary, lists);
  root.append(section);
  let generation = 0,
    request = 0,
    busy = false,
    data;
  const names = {
    pending: "待处理",
    running: "处理中",
    done: "已处理",
    skipped: "已跳过",
    retry_wait: "等待重试",
    failed: "失败",
    unknown: "未知",
    cancelled: "已取消",
    active: "启用",
    paused: "暂停",
    owner_disabled: "插件已停用",
    queued: "待发送",
    needs_approval: "待审批",
    sending: "发送中",
    sent: "已发送",
    held: "暂缓",
    expired: "已过期",
    inactive: "已停用",
  };
  function button(text, callback) {
    const b = el("button", text, "secondary");
    b.type = "button";
    b.disabled = busy;
    b.addEventListener("click", callback);
    return b;
  }
  async function write(path, method, body) {
    if (busy) return;
    busy = true;
    section
      .querySelectorAll("button,select,input")
      .forEach((b) => (b.disabled = true));
    error.hidden = true;
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await load(false);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      busy = false;
      section
        .querySelectorAll("button,select,input")
        .forEach((b) => (b.disabled = false));
    }
  }
  function block(title) {
    const card = el("article", undefined, "card");
    card.append(el("h3", title));
    lists.append(card);
    return card;
  }
  function metadata(card, text) {
    card.append(el("p", text, "muted"));
  }
  function render() {
    if (!data) return;
    lists.replaceChildren();
    const selected = subscription.value;
    subscription.replaceChildren(
      new Option("全部", ""),
      ...data.subscriptions.map(
        (s) => new Option(`${s.id} · ${names[s.status] || s.status}`, s.id),
      ),
    );
    subscription.value = selected;
    summary.textContent = `事件失败 ${data.summary.failed} · 事件未知 ${data.summary.unknown} · 发件失败 ${data.summary.outboxFailed} · 发件未知 ${data.summary.outboxUnknown}`;
    const d = block("事件处理");
    d.id = "background-deliveries";
    const filtered = data.deliveries.filter(
      (item) =>
        (!status.value || item.status === status.value) &&
        (!subscription.value || item.subscriptionId === subscription.value),
    );
    for (const item of filtered.slice(0, 80)) {
      const row = el("article", undefined, "action-preview");
      row.dataset.deliveryId = item.id;
      row.append(
        el(
          "strong",
          `${item.subscriptionId} · ${names[item.status] || item.status}`,
        ),
      );
      metadata(
        row,
        `尝试 ${item.attempt} · 失败 ${item.failures} · ${item.reason || "无错误"}${item.nextAt ? ` · 下次 ${item.nextAt}` : ""}`,
      );
      const event = data.events.find((e) => e.id === item.eventId);
      const details = el("details");
      details.append(el("summary", "查看事件与因果"));
      const pre = el("pre");
      pre.textContent = JSON.stringify(event || { id: item.eventId }, null, 2);
      details.append(pre);
      row.append(details);
      if (item.status === "failed")
        row.append(
          button("重试处理", () =>
            write(`/eventbox/deliveries/${item.id}/retry`, "POST", {}),
          ),
        );
      if (item.status === "unknown") {
        row.append(
          button("已核实处理完成", () => {
            if (
              confirm(
                "确认已核实该事件已经处理完成？此操作不会再次执行处理器。",
              )
            )
              void write(
                `/eventbox/deliveries/${item.id}/acknowledge`,
                "POST",
                {},
              );
          }),
        );
        row.append(
          button("确认未执行并重试", () => {
            if (confirm("请先核实外部动作未执行。确认重新处理此未知事件？"))
              void write(`/eventbox/deliveries/${item.id}/retry`, "POST", {
                confirmedNotExecuted: true,
              });
          }),
        );
      }
      d.append(row);
    }
    if (!filtered.length) metadata(d, "当前没有匹配的投递。");
    const plans = block("后台调度");
    plans.id = "background-schedules";
    for (const item of data.schedules) {
      const row = el("article", undefined, "action-preview");
      row.dataset.scheduleId = item.id;
      row.append(
        el(
          "strong",
          `${item.owner} / ${item.name} · ${names[item.status] || item.status}`,
        ),
      );
      metadata(
        row,
        `${item.kind} · ${item.tz || "绝对时间"} · 下次 ${item.nextAt} · 错过 ${item.missed} · 版本 ${item.version}`,
      );
      const update = (value) =>
        write(`/eventbox/schedules/${item.id}`, "PATCH", {
          version: item.version,
          status: value,
        });
      if (item.status === "active")
        row.append(button("暂停计划", () => update("paused")));
      if (item.status === "paused")
        row.append(button("恢复计划", () => update("active")));
      if (!["cancelled", "done"].includes(item.status))
        row.append(
          button("取消计划", () => {
            if (confirm(`确认取消 ${item.name}？`)) void update("cancelled");
          }),
        );
      plans.append(row);
    }
    const outgoing = block("通知发件箱");
    outgoing.id = "background-outbox";
    for (const item of data.outbox.slice(0, 80)) {
      const row = el("article", undefined, "action-preview");
      row.dataset.outboxId = item.id;
      row.append(
        el(
          "strong",
          `${item.owner} → ${item.channel} / ${item.target} · ${names[item.status] || item.status}`,
        ),
        el("p", item.content.text),
      );
      metadata(
        row,
        `尝试 ${item.attempt} · 版本 ${item.version}${item.error ? ` · ${item.error}` : ""}`,
      );
      if (item.status === "needs_approval") {
        const link = el("a", "进入审批，核对内容后决定 ↗");
        link.href = "#approvals";
        row.append(link);
      }
      if (["queued", "held", "needs_approval", "failed"].includes(item.status))
        row.append(
          button("取消发件", () =>
            write(`/outbox/${item.id}/cancel`, "POST", {
              version: item.version,
            }),
          ),
        );
      if (item.status === "unknown") {
        row.append(
          button("已核实送达", () => {
            if (confirm("确认已核实这条消息送达？"))
              void write(`/outbox/${item.id}/verify`, "POST", {
                version: item.version,
                delivered: true,
              });
          }),
        );
        row.append(
          button("未送达，确认重发", () => {
            if (confirm("请先核实未送达。确认使用新的发送尝试重发？"))
              void write(`/outbox/${item.id}/verify`, "POST", {
                version: item.version,
                delivered: false,
              });
          }),
        );
      }
      outgoing.append(row);
    }
    if (!data.outbox.length)
      metadata(
        outgoing,
        "暂无通知发件。主动通知默认不获发送授权，未授权条目需逐项审批。",
      );
    const permissions = block("通知授权");
    metadata(
      permissions,
      "“可通知我”仅允许对应发布者向已配对的本人发送通知。其他目标仍需逐项审批。",
    );
    const owners = [
      ...new Set([
        "daily-brief",
        ...data.subscriptions.map((s) => s.owner),
        ...data.outbox.map((i) => i.owner),
      ]),
    ];
    for (const owner of owners) {
      const grant = data.grants.find(
        (g) => g.owner === owner && g.channel === "feishu.bot",
      );
      permissions.append(
        button(
          `${owner}：${grant?.enabled ? "关闭通知授权" : "开启可通知我"}`,
          () => {
            if (
              !grant?.enabled &&
              !confirm(`允许 ${owner} 通过飞书机器人主动通知已配对的你？`)
            )
              return;
            void write("/outbox/grants", "PUT", {
              owner,
              channel: "feishu.bot",
              enabled: !grant?.enabled,
            });
          },
        ),
      );
    }
    const cleanup = block("已停用插件的数据清理");
    metadata(
      cleanup,
      "停用保留积压；清理会取消未开始的投递、调度和未发送通知，保留已发送和未知记录。",
    );
    const inactive = [
      ...new Set(
        data.subscriptions
          .filter((s) => s.status === "inactive" && s.owner !== "core")
          .map((s) => s.owner),
      ),
    ];
    for (const owner of inactive)
      cleanup.append(
        button(`清理 ${owner}`, () => {
          if (confirm(`确认清理已停用插件 ${owner} 的后台待处理数据？`))
            void write("/eventbox/cleanup-plugin", "POST", {
              owner,
              confirm: true,
            });
        }),
      );
    if (!inactive.length) metadata(cleanup, "暂无已停用的后台订阅插件。");
  }
  async function load(background = true) {
    if (
      background &&
      (busy ||
        (section.contains(document.activeElement) &&
          document.activeElement.matches("input,select,textarea")))
    )
      return;
    const number = ++request,
      epoch = generation;
    try {
      const result = await api("/eventbox");
      if (epoch !== generation || number !== request) return;
      data = result;
      render();
      error.hidden = true;
    } catch (e) {
      if (epoch !== generation) return;
      error.textContent = `后台事件状态读取失败：${e.message}`;
      error.hidden = false;
    }
  }
  status.addEventListener("change", render);
  subscription.addEventListener("change", render);
  refresh.addEventListener("click", () => load(false));
  return {
    load,
    reset() {
      generation++;
      data = undefined;
      lists.replaceChildren();
    },
    destroy() {
      generation++;
      section.remove();
    },
  };
}
