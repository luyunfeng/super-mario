import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../packages/core/src/store.ts";
import { createEventBus } from "../packages/core/src/events.ts";
import { createProjectWorkspace } from "../packages/core/src/project-workspace.ts";
import { startServer } from "../apps/server/src/index.ts";
import type { KnowledgeBackend } from "../packages/plugin-sdk/src/index.ts";
import type {
  KnowledgeEntry,
  Message,
} from "../packages/protocol/src/index.ts";
function fixture() {
  const store = createStore(":memory:"),
    events = createEventBus(store);
  const pages = new Map<string, KnowledgeEntry>();
  const knowledge: KnowledgeBackend = {
    async list(query) {
      return [...pages.values()].filter(
        (p) => !query?.projectId || p.projectId === query.projectId,
      );
    },
    async put(input) {
      const entry = {
        ...input,
        id: input.id || "new",
        updatedAt: new Date().toISOString(),
      };
      pages.set(entry.id, entry);
      return entry;
    },
    async remove(id) {
      return pages.delete(id);
    },
  };
  for (const id of ["a", "b"])
    store.put("projects", id, {
      id,
      name: id,
      description: "context " + id,
      createdAt: "now",
      updatedAt: "now",
    });
  return { store, events, pages, knowledge };
}
const answer = (text: string): Message => ({
  id: "answer",
  conversationId: "memory",
  role: "assistant",
  text,
  status: "done",
  createdAt: new Date().toISOString(),
});

test("memory model sees one project, persists traceable knowledge and never completes a todo", async () => {
  const f = fixture();
  let prompt = "";
  const service = createProjectWorkspace({
    ...f,
    demo: false,
    knowledge: () => f.knowledge,
    bots: () => [],
    available: () => true,
    agentStatus: () => ({ conversationId: "work", available: true }),
    post: async () => answer("work"),
    summarize: async (_id, text) => {
      prompt = text;
      return answer(
        JSON.stringify({
          summary: "事实总结",
          decisions: ["选择 A"],
          nextSteps: ["核对回执"],
          risks: ["尚未验收"],
        }),
      );
    },
  });
  try {
    for (const id of ["a", "b"]) {
      f.store.put("todos", id, {
        id,
        projectId: id,
        title: id === "a" ? "A task" : "SECRET B",
        notes: "",
        createdAt: "now",
        updatedAt: "now",
      });
      f.store.put("messages", id, {
        id,
        projectId: id,
        conversationId: "bot:" + id,
        role: "user",
        text: id === "a" ? "A context" : "SECRET MESSAGE B",
        status: "done",
        createdAt: "now",
      });
    }
    await service.run("a", true);
    assert.match(prompt, /A context/);
    assert.doesNotMatch(prompt, /SECRET/);
    assert.equal(service.memory("a").status, "completed");
    assert.ok(f.pages.get("project-memory-a")?.content.includes("a"));
    assert.equal(f.store.get<any>("todos", "a").completedAt, undefined);
    assert.equal(service.memory("b").summary, undefined);
    assert.equal(service.progress("a").open, 1);
    assert.match(JSON.stringify(service.context("a")), /事实总结/);
  } finally {
    await service.close();
    f.store.close();
  }
});

test("memory failure, concurrent requests, human edits and archival never overwrite confirmed memory", async () => {
  const f = fixture();
  let release!: (m: Message) => void,
    calls = 0;
  const gate = new Promise<Message>((r) => (release = r));
  const service = createProjectWorkspace({
    ...f,
    demo: false,
    knowledge: () => f.knowledge,
    bots: () => [],
    available: () => true,
    agentStatus: () => ({ conversationId: "work", available: true }),
    post: async () => answer("work"),
    summarize: async () => {
      calls++;
      return gate;
    },
  });
  try {
    const job = service.run("a", true);
    await new Promise((r) => setImmediate(r));
    service.request("a");
    assert.equal(calls, 1);
    await f.knowledge.put({
      id: "project-memory-a",
      layer: "project",
      projectId: "a",
      title: "human",
      content: "保留人工修订",
    });
    release(
      answer(
        JSON.stringify({
          summary: "late",
          decisions: [],
          nextSteps: [],
          risks: [],
        }),
      ),
    );
    await job;
    assert.equal(service.memory("a").status, "failed");
    assert.match(service.memory("a").error!, /人工修改/);
    assert.equal(f.pages.get("project-memory-a")?.content, "保留人工修订");
    f.store.put("projects", "a", {
      ...f.store.get<any>("projects", "a"),
      archivedAt: "now",
    });
    assert.throws(() => service.request("a"), /已归档/);
  } finally {
    release?.(answer("{}"));
    await service.close();
    f.store.close();
  }
});

test("missing model reports waiting and interrupted memory remains unknown until explicit action", async () => {
  const f = fixture();
  f.store.put("project.memory", "a", {
    projectId: "a",
    enabled: true,
    status: "running",
    summary: "previous",
  });
  let calls = 0;
  const service = createProjectWorkspace({
    ...f,
    demo: false,
    knowledge: () => f.knowledge,
    bots: () => [],
    available: () => false,
    agentStatus: () => ({ conversationId: "work", available: false }),
    post: async () => answer("work"),
    summarize: async () => {
      calls++;
      return answer("{}");
    },
  });
  try {
    assert.equal(service.memory("a").status, "unknown");
    await service.run("a", false);
    assert.equal(calls, 0);
    await service.run("b", true);
    assert.equal(service.memory("b").status, "waiting");
    assert.equal(calls, 0);
    assert.equal(service.memory("a").summary, "previous");
  } finally {
    await service.close();
    f.store.close();
  }
});

test("HTTP project workspace has isolated real queues/history, progress, demo memory and restart persistence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mario-project-workspace-"));
  let server = await startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    demo: true,
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    const a = (await api("/projects", "POST", { name: "A" })).data,
      b = (await api("/projects", "POST", { name: "B" })).data;
    await api("/todos", "POST", { title: "A task", projectId: a.id });
    assert.equal(
      (await api(`/projects/${a.id}/messages`, "POST", { text: "A context" }))
        .status,
      202,
    );
    await api(`/projects/${b.id}/messages`, "POST", { text: "B context" });
    for (let n = 0; n < 100; n++) {
      const view = (await api(`/projects/${a.id}/workspace`)).data;
      if (view.messages.length === 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const view = (await api(`/projects/${a.id}/workspace`)).data;
    assert.equal(view.progress.open, 1);
    assert.ok(view.messages.every((m: Message) => m.projectId === a.id));
    assert.ok(view.messages.some((m: Message) => m.text.includes("A context")));
    assert.ok(
      !view.messages.some((m: Message) => m.text.includes("B context")),
    );
    await server.app.projectWorkspace.run(a.id, true);
    assert.equal(
      (await api(`/projects/${a.id}/workspace`)).data.agents.memory.mode,
      "demo",
    );
    assert.equal(
      (await api(`/projects/${a.id}/workspace`)).data.knowledge.length,
      1,
    );
    await server.close();
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      demo: true,
    });
    assert.ok(
      (
        await api(`/projects/${a.id}/workspace`)
      ).data.agents.memory.summary.includes("演示"),
    );
    await api(`/projects/${a.id}`, "DELETE");
    assert.equal(
      (await api(`/projects/${a.id}/messages`, "POST", { text: "stop" }))
        .status,
      409,
    );
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('automatic memory is opt-in for legacy projects and skips unchanged evidence after one refinement',async()=>{
 const f=fixture();let time=Date.parse('2026-01-01T00:00:00Z'),calls=0;const service=createProjectWorkspace({...f,now:()=>time,demo:false,knowledge:()=>f.knowledge,bots:()=>[],available:()=>true,agentStatus:()=>({conversationId:'work',available:true}),post:async()=>answer('work'),summarize:async()=>{calls++;return answer(JSON.stringify({summary:'confirmed summary',decisions:[],nextSteps:[],risks:[]}));}});
 try{f.store.put('todos','task',{id:'task',projectId:'a',title:'work',notes:'',createdAt:'now',updatedAt:'now'});await service.run('a',false);assert.equal(calls,0);service.configure('a',true);await service.run('a',false);assert.equal(calls,1);time+=120000;await service.run('a',false);assert.equal(calls,1);const memory=await service.view('a');assert.equal(memory.agents.memory.sources[0].title,'work');}finally{await service.close();f.store.close();}
});
