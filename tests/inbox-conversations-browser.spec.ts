import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../apps/server/src/index.ts";
import { createInboxAssistant } from "../packages/core/src/inbox-assistant.ts";

test(
  "real HTTP inbox merges people, processes in background and continues after owner reply without one-todo-per-message",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mario-inbox-people-"));
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      demo: true,
      token: "people-fixture",
    });
    await server.app.inboxAssistant.close();
    let turn = 0;
    const assistant = createInboxAssistant({
      store: server.app.store,
      events: server.app.events,
      workspace: join(dir, "pi/workspace"),
      enabled: () => true,
      available: () => ({ available: true }),
      debounceMs: 0,
      analyze: async (input) => {
        turn++;
        if (turn === 1) {
          assert.equal(input.messages.length, 3);
          return {
            summary: "三条消息合并成一个问题，缺少目标环境",
            disposition: "waiting_user",
            question: "这项工作使用哪个合成环境？",
            tasks: [],
          };
        }
        assert.deepEqual(input.answers, ["环境甲"]);
        return {
          summary: "信息已补齐，合并为一个实际工作事项",
          disposition: "work",
          tasks: [
            {
              key: "one-task",
              title: "核对合成交付",
              notes: "按主人补充的环境推进",
            },
          ],
        };
      },
      createTodo: (input) => server.app.createTodo(input),
      updateTodo: (id, input) => server.app.updateTodo(id, input),
      archive: (id, version) => server.app.inbox.archive(id, version),
    });
    server.app.inboxAssistant = assistant;
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    });
    try {
      const now = new Date().toISOString();
      await server.app.inbox.ingest(
        "feishu:cli_test:ou_owner",
        [1, 2, 3].map((n) => ({
          thread: `feishu:message:${JSON.stringify(["oc_test", "om_" + n])}`,
          last: "om_" + n,
          title: "oc_test",
          text: "合成上下文 " + n,
          sender: "测试联系人甲",
          receivedAt: now,
          origin: {
            kind: "direct",
            connector: "飞书",
            chatId: "oc_test",
            senderName: "测试联系人甲",
          },
        })),
      );
      assert.equal(server.app.todos().length, 0);
      await assistant.tick();
      assert.equal(server.app.attention().length, 1);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(7000);
      await page.goto(server.url + "/#inbox?token=people-fixture");
      const inbox = page.locator("#inbox");
      await expect(
        inbox.getByRole("heading", { name: "测试联系人甲", exact: true }),
      ).toHaveCount(1);
      await expect(inbox).toContainText("3 条消息已合并");
      await expect(
        inbox.getByRole("button", { name: "转为待办", exact: true }),
      ).toHaveCount(0);
      await expect(inbox).not.toContainText("oc_test");
      await inbox
        .getByLabel("回复主 Agent：测试联系人甲", { exact: true })
        .fill("环境甲");
      await inbox
        .getByRole("button", { name: "回复主 Agent，继续处理", exact: true })
        .click();
      await expect
        .poll(() => assistant.list()[0].status)
        .not.toBe("waiting_user");
      await assistant.tick();
      await expect(inbox).toContainText("核对合成交付");
      assert.equal(server.app.todos().length, 1);
      assert.equal(server.app.store.list("inbox").length, 3);
      assert.equal(server.app.attention().length, 0);
      await inbox.getByText("查看原始消息（3 条）", { exact: true }).click();
      await expect(
        inbox.getByText("合成上下文 1", { exact: false }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.deepEqual(errors, []);
      assert.equal(
        (await fetch(server.url + "/api/v1/inbox/assistant")).status,
        401,
      );
    } finally {
      await browser.close();
      await assistant.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
