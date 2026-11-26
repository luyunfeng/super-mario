import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Extension, Json, JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { TRANSCRIPTION_AUDIO } from '../packages/protocol/src/transcription.ts';

const bytesPerSecond = TRANSCRIPTION_AUDIO.sampleRate * 2;
const audioOf = (seconds: number) => new Uint8Array(seconds * bytesPerSecond);

/** A stand-in engine. It answers one segment covering the chunk it was given and counts calls.
 *  A plugin's service must be named after the plugin, so the id is made from the service. */
function enginePlugin(service: string, name: string, seen: { calls: JsonObject[] }): Extension {
  const id = service.split('.')[0]!;
  return {
    id, name, capabilities: ['transcription'],
    permissions: ['contribute:connectors', 'service.provide:' + service],
    activate(context) {
      context.contribute('connectors', service, { kind: 'transcription', service, name, languages: ['zh-CN'] } as Json);
      context.contribute('services', service, { name: service, version: 1, readOnly: true, async handler(value) {
        const input = value as JsonObject;
        seen.calls.push(input);
        return { segments: [{ from: 0, to: Number(input.seconds), text: '转写结果 ' + seen.calls.length }], gaps: [] };
      } });
    },
  };
}

async function start(t: test.TestContext, extensions: Extension[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-transcription-flow-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-transcription' });
  for (const extension of extensions) { server.app.plugins.register(extension); await server.app.plugins.start(); }
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer offline-transcription', 'content-type': 'application/json' };
  const get = async (path: string) => {
    const response = await fetch(server.url + '/api/v1' + path, { headers });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  const choose = async (body: unknown) => {
    const response = await fetch(server.url + '/api/v1/transcription/choice', { method: 'PUT', headers, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  const transcribe = async (audio: Uint8Array, query = '') => {
    const response = await fetch(server.url + '/api/v1/transcription/jobs' + query, { method: 'POST',
      headers: { authorization: 'Bearer offline-transcription', 'content-type': 'application/octet-stream' }, body: Buffer.from(audio) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  return { server, get, choose, transcribe };
}

test('没有引擎时如实报告；安装后可选；选定后上传音频得到带时间的分段', async t => {
  const none = await start(t);
  assert.deepEqual(await none.get('/transcription'), { status: 200, data: { engines: [], ready: false, reason: '没有安装转写引擎。' } });
  const refused = await none.transcribe(audioOf(3));
  assert.equal(refused.status, 409);
  assert.match(String(refused.data.error), /没有安装转写引擎/);

  const seen = { calls: [] as JsonObject[] };
  const f = await start(t, [enginePlugin('enginefixture.transcribe', '夹具引擎', seen)]);
  const listed = await f.get('/transcription');
  assert.equal(listed.data.ready, false);
  assert.equal(listed.data.reason, '还没有选择转写引擎。');
  assert.deepEqual(listed.data.engines, [{ kind: 'transcription', service: 'enginefixture.transcribe', name: '夹具引擎', languages: ['zh-CN'] }]);
  // Choosing an engine that is not installed is refused.
  assert.equal((await f.choose({ service: 'engine.other' })).status, 409);
  assert.equal((await f.choose({ service: 7 })).status, 400);
  assert.equal((await f.choose({ service: 'engine.fixture', extra: 1 })).status, 400);
  const chosen = await f.choose({ service: 'enginefixture.transcribe' });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.data.ready, true);
  assert.equal(chosen.data.reason, '');
  // Still not chosen: a refused choice changes nothing.

  const result = await f.transcribe(audioOf(12), '?language=zh-CN&label=' + encodeURIComponent('周会'));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.seconds, 12);
  assert.equal(result.data.engine, 'enginefixture.transcribe');
  assert.deepEqual(result.data.segments, [{ from: 0, to: 8, text: '转写结果 1' }, { from: 8, to: 12, text: '转写结果 2' }]);
  assert.equal(seen.calls.length, 2, 'twelve seconds is two chunks');
  assert.deepEqual(seen.calls.map(call => call.seconds), [8, 12 - 8]);
  assert.equal(seen.calls[0]!.language, 'zh-CN');
  assert.equal(seen.calls[0]!.label, '周会');
  // The audio reached the engine whole: the two chunks join back into what was sent.
  const joined = Buffer.concat(seen.calls.map(call => Buffer.from(String(call.audio), 'base64')));
  assert.equal(joined.length, 12 * bytesPerSecond);
  // Oversized or malformed requests are refused before any engine is called.
  const before = seen.calls.length;
  assert.equal((await f.transcribe(audioOf(1), '?extra=1')).status, 400);
  assert.equal((await f.transcribe(new Uint8Array(1025))).status, 400);
  assert.equal(seen.calls.length, before);
});

test('只在连接器里登记、却没有提供服务的引擎不算已安装；停用后选定的引擎如实报告', async t => {
  // A connector entry that names a service nobody provides must not be listed.
  const hollow: Extension = {
    id: 'hollow-engine', name: '空壳引擎', capabilities: ['transcription'], permissions: ['contribute:connectors'],
    activate(context) { context.contribute('connectors', 'engine.hollow', { kind: 'transcription', service: 'engine.hollow', name: '空壳引擎' } as Json); },
  };
  const f = await start(t, [hollow]);
  assert.deepEqual((await f.get('/transcription')).data.engines, []);
  assert.equal((await f.choose({ service: 'engine.hollow' })).status, 409);

  const seen = { calls: [] as JsonObject[] };
  const g = await start(t, [enginePlugin('enginefixture.transcribe', '夹具引擎', seen)]);
  await g.choose({ service: 'enginefixture.transcribe' });
  assert.equal((await g.get('/transcription')).data.ready, true);
  // Disabling the plugin removes its contribution. The choice stays and says what happened.
  await g.server.app.plugins.setEnabled('enginefixture', false);
  const after = await g.get('/transcription');
  assert.equal(after.data.ready, false);
  // It was the only engine, so the owner is told that there is no other to fall back to.
  assert.equal(after.data.reason, '选定的转写引擎已停用或被移除，当前没有其他引擎。');
  assert.equal((after.data.choice as { service: string }).service, 'enginefixture.transcribe');
  assert.equal((await g.transcribe(audioOf(1))).status, 409);
  assert.equal(seen.calls.length, 0);
});
