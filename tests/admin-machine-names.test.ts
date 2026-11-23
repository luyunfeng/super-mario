import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MachineInfo } from '../packages/protocol/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createAdminOverview } from '../apps/server/src/admin-overview.ts';

test('machine display names survive restart, follow live state and reset to the latest reported name', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-admin-machines-'));
  let store = createStore(join(dir, 'test.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const machine: MachineInfo = { id:'node-a',name:'Agent A',online:true,platform:'linux',connectedAt:'2026-11-20T12:00:00Z',
    capabilities:['executor.input'],agentInstanceId:'instance-a',executors:[] };
  const second = { ...machine, id:'node-b' };
  const overview = () => createAdminOverview({ store, version:'fixture', startedAt:machine.connectedAt, demo:true, address:()=>null,
    plugins:()=>[],devices:()=>[], machines:()=>[machine,second] });
  let admin = overview();
  const [a,b] = admin.renameMachine('node-a','  工作站  ').machines;
  assert.deepEqual(a, { id:machine.id,name:'工作站',reportedName:'Agent A',online:true,platform:'linux',connectedAt:machine.connectedAt,
    capabilities:['executor.input'] });
  assert.equal(b.name,'Agent A');
  assert.equal(machine.name,'Agent A');
  store.close();
  store = createStore(join(dir, 'test.sqlite'));
  admin = overview();
  machine.name='Agent B'; machine.online=false; machine.capabilities=['executor.list'];
  const latest = admin.machineList().machines[0];
  assert.deepEqual([latest.name,latest.reportedName,latest.online,latest.capabilities], ['工作站','Agent B',false,['executor.list']]);
  for(const invalid of ['x\n','x\u0000','\u2028a', '🙂'.repeat(65), 7]) assert.throws(()=>admin.renameMachine(machine.id,invalid), {status:400});
  assert.throws(()=>admin.renameMachine('not-registered','别名'),{status:404});
  assert.equal(admin.renameMachine(machine.id,'🙂'.repeat(64)).machines[0].name,'🙂'.repeat(64));
  assert.equal(admin.renameMachine(machine.id,'   ').machines[0].name,'Agent B');
});
