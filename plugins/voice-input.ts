import type { Extension } from '../packages/plugin-sdk/src/index.ts';

const formats = new Map([
  ['wav', 'audio/wav'], ['mp3', 'audio/mpeg'], ['webm', 'audio/webm'], ['m4a', 'audio/mp4'],
  ['mp4', 'audio/mp4'], ['ogg', 'audio/ogg'], ['flac', 'audio/flac'],
]);
const limit = 8 * 1024 * 1024;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export const voiceInput: Extension = {
  id: 'voice-input', name: '语音输入', capabilities: ['web.conversation.dictation', 'audio.transcription'],
  permissions: ['service.provide:voice-input.transcribe'],
  activate(context) {
    const lifetime = new AbortController();
    context.defer(() => lifetime.abort());
    context.provide('voice-input.transcribe', async (input, request) => {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          typeof input.format !== 'string' || !formats.has(input.format) || typeof input.audio !== 'string' ||
          !input.audio || input.audio.length > Math.ceil(limit / 3) * 4) fail(400, '请选择不超过 8 MiB 的受支持录音');
      const bytes = Buffer.from(input.audio, 'base64');
      if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== input.audio) fail(400, '录音数据无效');
      const endpoint = process.env.SUPER_MARIO_TRANSCRIPTION_URL?.trim();
      const model = process.env.SUPER_MARIO_TRANSCRIPTION_MODEL?.trim();
      if (!endpoint || !model) fail(503, '服务端需配置 SUPER_MARIO_TRANSCRIPTION_URL 和 SUPER_MARIO_TRANSCRIPTION_MODEL');
      const form = new FormData();
      form.set('model', model);
      const responseFormat = process.env.SUPER_MARIO_TRANSCRIPTION_RESPONSE_FORMAT?.trim();
      if (responseFormat) {
        if (!['json', 'verbose_json', 'diarized_json'].includes(responseFormat)) fail(503, '转写响应格式配置无效');
        form.set('response_format', responseFormat);
        if (responseFormat === 'diarized_json') form.set('chunking_strategy', 'auto');
      }
      form.set('file', new Blob([bytes], { type: formats.get(input.format) }), 'audio.' + input.format);
      const key = process.env.SUPER_MARIO_TRANSCRIPTION_API_KEY?.trim();
      const signal = AbortSignal.any([request, lifetime.signal]);
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', body: form, signal,
        headers: key ? { authorization: 'Bearer ' + key } : {} });
      if (!response.ok) { await response.body?.cancel(); fail(502, '转写服务返回 HTTP ' + response.status); }
      const answer = await response.json().catch(() => fail(502, '转写服务返回了无效的 JSON')) as { text?: unknown; segments?: unknown } | null;
      if (typeof answer?.text !== 'string' || !answer.text.trim()) fail(422, '转写服务未返回可用文字');
      signal.throwIfAborted();
      const segments = [];
      if (Array.isArray(answer.segments)) {
        for (const row of answer.segments) {
          if (!row || typeof row.text !== 'string' || !row.text.trim() ||
              !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end < row.start) continue;
          const speaker = typeof row.speaker === 'string' ? row.speaker.trim() : '';
          segments.push({ start: row.start, end: row.end, text: row.text.trim(), ...(speaker ? { speaker } : {}) });
        }
      }
      return { text: answer.text.trim(), ...(segments.length ? { segments } : {}) };
    });
  },
};
