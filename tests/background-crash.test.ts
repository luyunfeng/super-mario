import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createStore } from "../packages/core/src/store.ts";
import { createEventBus } from "../packages/core/src/events.ts";
import { createEventbox } from "../packages/core/src/eventbox.ts";
import { createSupervisorAgent } from "../packages/core/src/supervisor-agent.ts";
const root = new URL("../", import.meta.url);
const imports = `
import {createStore} from ${JSON.stringify(new URL("packages/core/src/store.ts", root).href)};
import {createEventBus} from ${JSON.stringify(new URL("packages/core/src/events.ts", root).href)};
import {createEventbox} from ${JSON.stringify(new URL("packages/core/src/eventbox.ts", root).href)};
import {createSupervisorAgent} from ${JSON.stringify(new URL("packages/core/src/supervisor-agent.ts", root).href)};
const store=createStore(process.env.MARIO_CRASH_DB),events=createEventBus(store),box=createEventbox({store,events});
setInterval(()=>{},1000);
`;
async function crash(script: string, path: string) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", imports + script],
    {
      env: { ...process.env, MARIO_CRASH_DB: path },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    errors = "";
  child.stderr.on("data", (c) => (errors += c));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("crash fixture timeout " + errors)),
        8000,
      );
      child.stdout.on("data", (c) => {
        output += c;
        if (output.includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("fixture exited " + errors));
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
for (const phase of ["committed", "direct"] as const)
  test(`process SIGKILL: ${phase} delivery survives with the correct recovery state`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mario-event-crash-"));
    const path = join(dir, "data.sqlite");
    try {
      await crash(
        `box.subscribe('core',{name:'work',types:[{type:'test',version:1}],effects:'${phase === "direct" ? "direct" : "none"}',handler:async()=>{console.log('READY');await new Promise(()=>{});return{status:'done'};}});box.publish('core',{type:'test',typeVersion:1,sourceId:'one',data:null});${phase === "committed" ? "console.log('READY');" : "box.pump();"}`,
        path,
      );
      const store = createStore(path),
        events = createEventBus(store),
        box = createEventbox({ store, events });
      let calls = 0;
      try {
        box.subscribe("core", {
          name: "work",
          types: [{ type: "test", version: 1 }],
          effects: phase === "direct" ? "direct" : "none",
          handler: () => {
            calls++;
            return { status: "done" };
          },
        });
        await box.drain();
        assert.equal(calls, phase === "direct" ? 0 : 1);
        assert.equal(
          box.deliveries()[0].status,
          phase === "direct" ? "unknown" : "done",
        );
      } finally {
        await box.close();
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
for (const phase of ["before_review", "after_review"] as const)
  test(`process SIGKILL: supervisor ${phase} recovers exactly one local review`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mario-supervisor-crash-"));
    const path = join(dir, "data.sqlite");
    try {
      await crash(
        `
const signal={id:'signal',kind:'review',text:'local fixture',createdAt:new Date().toISOString()};store.put('supervision.signals',signal.id,signal);
const agent={status:()=>({available:true}),ask:async()=>({id:'answer',conversationId:'supervisor',role:'assistant',text:'local review',status:'done',createdAt:new Date().toISOString()})};
const supervisor=createSupervisorAgent({store,events,agent,signals:()=>store.list('supervision.signals'),durable:true,publish:e=>box.publish('core',e)});
box.subscribe('core',{name:'supervisor',types:[{type:'supervision.signal',version:1}],effects:'ledger',handler:async e=>{
${phase === "after_review" ? "await supervisor.flush();" : ""}
console.log('READY');await new Promise(()=>{});return{status:'done'};
}});box.publish('core',{type:'supervision.signal',typeVersion:1,sourceId:'signal',data:{id:'signal'}});box.pump();`,
        path,
      );
      const store = createStore(path),
        events = createEventBus(store),
        box = createEventbox({ store, events });
      let calls = 0;
      const service = createSupervisorAgent({
        store,
        events,
        signals: () => store.list("supervision.signals"),
        durable: true,
        publish: (e) => box.publish("core", e),
        agent: {
          status: () => ({ available: true }),
          ask: async () => {
            calls++;
            return {
              id: "second",
              conversationId: "supervisor",
              role: "assistant",
              text: "recovered local review",
              status: "done",
              createdAt: new Date().toISOString(),
            };
          },
        },
      });
      try {
        box.subscribe("core", {
          name: "supervisor",
          types: [{ type: "supervision.signal", version: 1 }],
          effects: "ledger",
          handler: async () => {
            if (!store.get("supervisor.processed", "signal"))
              await service.flush();
            return { status: "done" };
          },
        });
        await box.drain();
        assert.equal(service.reviews().length, 1);
        assert.equal(calls, phase === "after_review" ? 0 : 1);
        assert.equal(box.deliveries()[0].status, "done");
        assert.equal(
          box.events().filter((e) => e.type === "supervisor.review.created")
            .length,
          1,
        );
      } finally {
        await service.close();
        await box.close();
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
