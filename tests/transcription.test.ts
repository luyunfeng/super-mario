import test from 'node:test';
import assert from 'node:assert/strict';
import type { Json, JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createTranscription, transcriptionEngine, transcriptionSeconds } from '../packages/core/src/transcription.ts';
import { TRANSCRIPTION_AUDIO, TRANSCRIPTION_CHUNK_BYTES, TRANSCRIPTION_MAX_SECONDS, TranscriptionError } from '../packages/protocol/src/transcription.ts';

const bytesPerSecond = TRANSCRIPTION_AUDIO.sampleRate * 2;
const audioOf = (seconds: number) => new Uint8Array(Math.round(seconds * bytesPerSecond));
const isProblem = (problem: string) => (error: unknown) => error instanceof TranscriptionError && error.problem === problem;

function fixture(t: { after(fn: () => void): void }, options: { engines?: unknown[]; chosen?: string } = {}) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  if (options.chosen) store.put('transcription.choice', 'current', { service: options.chosen });
  const calls: { service: string; input: JsonObject }[] = [];
  // The stand-in engine answers with one segment covering the chunk it was given, and says how
  // much audio it got, so the test can check that the pieces arrived whole and in order.
  let answer: (input: JsonObject) => Json = input => ({ segments: [{ from: 0, to: Number(input.seconds), text: 'chunk ' + calls.length }], gaps: [] });
  let failing: Error | undefined;
  const engines = options.engines ?? [{ kind: 'transcription', service: 'engine.one', name: '引擎一', languages: ['zh-CN'] }];
  const service = createTranscription({ store, engines: () => engines as never[], call: async (name, input) => {
    calls.push({ service: name, input });
    if (failing) throw failing;
    return answer(input);
  } });
  return { store, service, calls, answerWith: (next: typeof answer) => { answer = next; }, failWith: (error: Error) => { failing = error; } };
}

test('没有引擎、没选引擎、选的引擎被停用时各自如实报告，不转写', async t => {
  const none = fixture(t, { engines: [] });
  assert.equal(none.service.status().reason, '没有安装转写引擎。');
  await assert.rejects(none.service.transcribe({ audio: audioOf(1) }, new AbortController().signal), isProblem('unavailable'));
  assert.equal(none.calls.length, 0);

  const unchosen = fixture(t);
  assert.equal(unchosen.service.status().reason, '还没有选择转写引擎。');
  assert.equal(unchosen.service.status().ready, false);
  await assert.rejects(unchosen.service.transcribe({ audio: audioOf(1) }, new AbortController().signal), isProblem('not_configured'));

  // A choice that names an engine nobody offers any more is reported, not silently replaced.
  const gone = fixture(t, { chosen: 'engine.removed' });
  assert.equal(gone.service.status().reason, '选定的转写引擎已停用或被移除。');
  assert.equal(gone.service.status().choice?.service, 'engine.removed', 'the choice is kept, so it comes back when the engine does');
  await assert.rejects(gone.service.transcribe({ audio: audioOf(1) }, new AbortController().signal), isProblem('not_configured'));

  const ready = fixture(t, { chosen: 'engine.one' });
  assert.equal(ready.service.status().ready, true);
  assert.equal(ready.service.status().reason, '');
});

test('只能选已安装的引擎；清空选择后回到未选择；重启后选择仍在', t => {
  const f = fixture(t);
  assert.throws(() => f.service.choose('engine.other'), isProblem('not_configured'));
  assert.equal(f.service.choice(), undefined);
  assert.deepEqual(f.service.choose('engine.one'), { service: 'engine.one' });
  assert.deepEqual(f.service.choice(), { service: 'engine.one' });
  const reopened = createStore(':memory:');
  t.after(() => reopened.close());
  // The choice is in the store, so it is read again after a restart.
  const saved = f.store.get('transcription.choice', 'current');
  assert.deepEqual(saved, { service: 'engine.one' });
  reopened.put('transcription.choice', 'current', saved as never);
  const again = createTranscription({ store: reopened, engines: () => [], call: async () => ({}) });
  assert.deepEqual(again.choice(), { service: 'engine.one' });
  assert.equal(f.service.choose(''), undefined);
  assert.equal(f.service.choice(), undefined);
});

test('一段不超过八秒的音频整块交给引擎，带格式、时长和语言提示', async t => {
  const f = fixture(t, { chosen: 'engine.one' });
  const audio = audioOf(5.5);
  const result = await f.service.transcribe({ audio, language: 'zh-CN', label: '周会' }, new AbortController().signal);
  assert.equal(f.calls.length, 1, 'short audio is one call');
  const { input } = f.calls[0]!;
  assert.equal(f.calls[0]!.service, 'engine.one');
  assert.equal(input.encoding, 'pcm16');
  assert.equal(input.sampleRate, 16000);
  assert.equal(input.channels, 1);
  assert.equal(input.seconds, 5.5);
  assert.equal(input.language, 'zh-CN');
  assert.equal(input.label, '周会');
  assert.deepEqual(Buffer.from(String(input.audio), 'base64'), Buffer.from(audio), 'the audio arrives whole');
  assert.equal(result.seconds, 5.5);
  assert.equal(result.engine, 'engine.one');
  assert.deepEqual(result.segments, [{ from: 0, to: 5.5, text: 'chunk 1' }]);
});

test('超过八秒的音频按顺序分块，每块不超过上限，时间戳从整段的开头算起', async t => {
  const f = fixture(t, { chosen: 'engine.one' });
  // 20 seconds is three chunks: 8, 8 and 4.
  const audio = audioOf(20);
  for (let i = 0; i < audio.length; i += bytesPerSecond) audio[i] = (i / bytesPerSecond) % 2 ? 1 : 2;
  const result = await f.service.transcribe({ audio }, new AbortController().signal);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(call => call.input.seconds), [8, 8, 4]);
  // The pieces are consecutive: joined again they are the original audio, in order.
  const joined = Buffer.concat(f.calls.map(call => Buffer.from(String(call.input.audio), 'base64')));
  assert.deepEqual(joined, Buffer.from(audio));
  // The stand-in numbers its answers from one, because it counts the call it is answering.
  assert.deepEqual(result.segments, [
    { from: 0, to: 8, text: 'chunk 1' }, { from: 8, to: 16, text: 'chunk 2' }, { from: 16, to: 20, text: 'chunk 3' },
  ]);
  assert.equal(result.seconds, 20);
  assert.ok(f.calls.every(call => Buffer.from(String(call.input.audio), 'base64').length <= TRANSCRIPTION_CHUNK_BYTES));
});

test('引擎不确定的区间作为空白带回，位置按整段算，不编造文字', async t => {
  const f = fixture(t, { chosen: 'engine.one' });
  let index = 0;
  f.answerWith(() => {
    const first = index++ === 0;
    return first
      ? { segments: [{ from: 0, to: 3, text: '前半句' }], gaps: [{ from: 3, to: 8 }] }
      : { segments: [{ from: 2, to: 5, text: '后半句' }], gaps: [{ from: 0, to: 2 }] };
  });
  const result = await f.service.transcribe({ audio: audioOf(13) }, new AbortController().signal);
  assert.deepEqual(result.segments, [{ from: 0, to: 3, text: '前半句' }, { from: 10, to: 13, text: '后半句' }]);
  assert.deepEqual(result.gaps, [{ from: 3, to: 8 }, { from: 8, to: 10 }]);
});

test('空音频、半个采样、超过十五分钟、无效语言提示在发给引擎之前就拒绝', async t => {
  const f = fixture(t, { chosen: 'engine.one' });
  const signal = new AbortController().signal;
  await assert.rejects(f.service.transcribe({ audio: new Uint8Array(0) }, signal), isProblem('invalid_audio'));
  await assert.rejects(f.service.transcribe({ audio: new Uint8Array(1025) }, signal), isProblem('invalid_audio'));
  await assert.rejects(f.service.transcribe({ audio: audioOf(TRANSCRIPTION_MAX_SECONDS + 1) }, signal), isProblem('too_long'));
  await assert.rejects(f.service.transcribe({ audio: audioOf(1), language: 'not a tag' }, signal), isProblem('invalid_audio'));
  await assert.rejects(f.service.transcribe({ audio: audioOf(1), label: 'x'.repeat(41) }, signal), isProblem('invalid_audio'));
  assert.equal(f.calls.length, 0, 'nothing is sent for audio that is refused');
  // The limit itself is allowed.
  const atLimit = await f.service.transcribe({ audio: audioOf(TRANSCRIPTION_MAX_SECONDS) }, signal);
  assert.equal(atLimit.seconds, TRANSCRIPTION_MAX_SECONDS);
});

test('引擎返回不合法的结果时明确失败，不把半截答案当成转写', async t => {
  const f = fixture(t, { chosen: 'engine.one' });
  for (const bad of [null, 'text', [], {}, { segments: 'none' }, { segments: 7 }]) {
    f.answerWith(() => bad as Json);
    await assert.rejects(f.service.transcribe({ audio: audioOf(1) }, new AbortController().signal), isProblem('failed'), JSON.stringify(bad));
  }
  // A segment that is out of range or has no text is left out; the rest is kept.
  f.answerWith(() => ({ segments: [{ from: 0, to: 1, text: '保留' }, { from: 5, to: 9, text: '越界' }, { from: 1, to: 2, text: '  ' }, { from: 2, to: 1, text: '倒置' }] }));
  const result = await f.service.transcribe({ audio: audioOf(3) }, new AbortController().signal);
  assert.deepEqual(result.segments, [{ from: 0, to: 1, text: '保留' }]);
  // An engine that fails is reported as a failure.
  f.failWith(new Error('引擎内部错误'));
  await assert.rejects(f.service.transcribe({ audio: audioOf(1) }, new AbortController().signal), /引擎内部错误/);
});

test('引擎清单只认合法的条目，同一个服务被报两次时取第一个', () => {
  assert.deepEqual(transcriptionEngine({ kind: 'transcription', service: 'engine.one', name: ' 引擎一 ', languages: ['zh-CN', 7, 'bad tag'] }),
    { kind: 'transcription', service: 'engine.one', name: '引擎一', languages: ['zh-CN'] });
  for (const bad of [null, 'x', [], { kind: 'other', service: 'a.b', name: 'x' }, { kind: 'transcription', service: 'Bad Service', name: 'x' },
    { kind: 'transcription', service: 'a.b', name: '' }, { kind: 'transcription', name: 'x' }]) {
    assert.equal(transcriptionEngine(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(transcriptionSeconds(bytesPerSecond * 3), 3);
  assert.equal(transcriptionSeconds(bytesPerSecond + 2), 1 + 1 / 16000);
});

test('选定的引擎没了但还有别的引擎时，说明可以改选；只剩它一个时说明没有别的', t => {
  const engines = [
    { kind: 'transcription', service: 'engine.one', name: '引擎一' },
    { kind: 'transcription', service: 'engine.two', name: '引擎二' },
  ];
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.put('transcription.choice', 'current', { service: 'engine.one' });
  let offered = engines;
  const service = createTranscription({ store, engines: () => offered as never, call: async () => ({}) });
  assert.equal(service.status().ready, true);
  // The chosen one is gone, but another is installed.
  offered = engines.slice(1);
  assert.equal(service.status().ready, false);
  assert.equal(service.status().reason, '选定的转写引擎已停用或被移除。');
  assert.deepEqual(service.status().engines.map(engine => engine.service), ['engine.two']);
  // Choosing the one that is left makes it ready again.
  service.choose('engine.two');
  assert.equal(service.status().ready, true);
  // When the chosen one was the only engine, the owner is told there is no other.
  offered = [];
  assert.equal(service.status().reason, '选定的转写引擎已停用或被移除，当前没有其他引擎。');
});
