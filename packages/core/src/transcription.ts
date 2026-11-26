import { TRANSCRIPTION_AUDIO, TRANSCRIPTION_CHUNK_BYTES, TRANSCRIPTION_MAX_SECONDS, TranscriptionError } from '../../protocol/src/transcription.ts';
import type { Json, JsonObject, Store } from '../../plugin-sdk/src/index.ts';
import type { TranscriptionChoice, TranscriptionEngine, TranscriptionJob, TranscriptionResult, TranscriptionSegment } from '../../protocol/src/transcription.ts';

/** How one chunk of audio reaches an engine, and what comes back for it. */
export type TranscriptionCall = (service: string, input: JsonObject, signal: AbortSignal) => Promise<Json>;
export type TranscriptionEngines = () => TranscriptionEngine[];

const choiceKey = 'transcription.choice';
const bytesPerSecond = TRANSCRIPTION_AUDIO.sampleRate * 2;

/** An engine as it is allowed to offer itself. Anything else is not listed. */
export function transcriptionEngine(value: unknown): TranscriptionEngine | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const engine = value as Record<string, unknown>;
  if (engine.kind !== 'transcription' || typeof engine.service !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,99}$/.test(engine.service)
    || typeof engine.name !== 'string' || !engine.name.trim() || engine.name.length > 120) return undefined;
  const languages = Array.isArray(engine.languages) ? engine.languages.filter((tag): tag is string => typeof tag === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag)) : [];
  return { kind: 'transcription', service: engine.service, name: engine.name.trim(), ...(languages.length ? { languages } : {}) };
}

/**
 * The seconds of audio a byte count holds, in the one format every engine takes. It is exact:
 * the pieces of one job are placed by adding these, so rounding here would move every later
 * piece a little.
 */
export function transcriptionSeconds(bytes: number): number {
  return bytes / bytesPerSecond;
}

/**
 * Checks the audio before any of it is sent. The engine is told the format and relies on it,
 * so an odd byte count (half a sample) or an empty job is refused here.
 */
function checkedAudio(job: TranscriptionJob): Uint8Array {
  if (!(job.audio instanceof Uint8Array) || job.audio.length === 0) throw new TranscriptionError('invalid_audio', '没有可转写的音频。');
  if (job.audio.length % 2 !== 0) throw new TranscriptionError('invalid_audio', '音频不是完整的 16 位采样。');
  if (transcriptionSeconds(job.audio.length) > TRANSCRIPTION_MAX_SECONDS) throw new TranscriptionError('too_long', '一段音频最多十五分钟，请分段转写。');
  if (job.language !== undefined && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(job.language)) throw new TranscriptionError('invalid_audio', '语言提示须为 BCP 47 标签。');
  if (job.label !== undefined && (typeof job.label !== 'string' || Array.from(job.label).length > 40)) throw new TranscriptionError('invalid_audio', '名称最多 40 个字符。');
  return job.audio;
}

/** One chunk's answer. Its times are from the start of that chunk, not of the whole piece. */
type Chunk = Pick<TranscriptionResult, 'segments' | 'gaps'>;

/** Reads an engine's answer for one chunk. What is not a well-formed answer is refused. */
function readChunk(value: unknown, chunkSeconds: number): Chunk {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!row || !Array.isArray(row.segments)) throw new TranscriptionError('failed', '转写引擎没有返回分段。');
  const span = (item: unknown): item is { from: number; to: number } => {
    if (!item || typeof item !== 'object') return false;
    const { from, to } = item as Record<string, unknown>;
    return typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to <= chunkSeconds + 0.5;
  };
  const segments: TranscriptionSegment[] = [];
  for (const item of row.segments) {
    if (!span(item)) continue;
    const text = (item as Record<string, unknown>).text;
    if (typeof text !== 'string' || !text.trim()) continue;
    segments.push({ from: (item as { from: number }).from, to: (item as { to: number }).to, text: text.trim() });
  }
  const gaps = Array.isArray(row.gaps) ? row.gaps.filter(span).map(item => ({ from: (item as { from: number }).from, to: (item as { to: number }).to })) : [];
  return { segments, gaps };
}

export function createTranscription({ store, engines, call }: { store: Store; engines: TranscriptionEngines; call: TranscriptionCall }) {
  function available(): TranscriptionEngine[] {
    // Two engines naming one service would make the choice ambiguous, so the first wins.
    const seen = new Set<string>();
    return engines().flatMap(engine => {
      const valid = transcriptionEngine(engine);
      if (!valid || seen.has(valid.service)) return [];
      seen.add(valid.service);
      return [valid];
    });
  }
  function choice(): TranscriptionChoice | undefined {
    const saved = store.get<TranscriptionChoice>(choiceKey, 'current');
    return saved && typeof saved.service === 'string' && saved.service ? saved : undefined;
  }
  function status() {
    const chosen = choice();
    const installed = available();
    return {
      engines: installed,
      choice: chosen,
      // Ready only when the chosen engine is still offered. A disabled plugin leaves a choice
      // that names a service nobody provides, which is said plainly.
      ready: !!chosen && installed.some(engine => engine.service === chosen.service),
      reason: installed.length === 0 ? '没有安装转写引擎。'
        : !chosen ? '还没有选择转写引擎。'
        : !installed.some(engine => engine.service === chosen!.service) ? '选定的转写引擎已停用或被移除。' : '',
    };
  }
  return {
    engines: available,
    choice,
    status,
    /** Chooses among the engines that are installed. A service that is not offered cannot be chosen. */
    choose(service: string): TranscriptionChoice | undefined {
      if (service === '') { store.remove(choiceKey, 'current'); return undefined; }
      if (!available().some(engine => engine.service === service)) throw new TranscriptionError('not_configured', '这个转写引擎尚未安装。');
      const next = { service };
      store.put(choiceKey, 'current', next);
      return next;
    },
    /**
     * Transcribes one piece of audio with the chosen engine. The audio goes in chunks of at
     * most eight seconds, because that is the most an engine is asked to take at once. The
     * chunks are consecutive, so each answer's times are moved by the audio before it, and the
     * times of the whole are from the start of the piece.
     */
    async transcribe(job: TranscriptionJob, signal: AbortSignal): Promise<TranscriptionResult & { engine: string }> {
      const audio = checkedAudio(job);
      const state = status();
      if (state.reason) throw new TranscriptionError(state.engines.length ? 'not_configured' : 'unavailable', state.reason);
      const engine = state.engines.find(item => item.service === state.choice!.service)!;
      const seconds = transcriptionSeconds(audio.length);
      const segments: TranscriptionSegment[] = [], gaps: { from: number; to: number }[] = [];
      // The chunk size is a whole number of samples, so a boundary never falls inside one.
      const chunkBytes = TRANSCRIPTION_CHUNK_BYTES;
      for (let offset = 0, start = 0; offset < audio.length;) {
        signal.throwIfAborted();
        const end = Math.min(audio.length, offset + chunkBytes);
        const chunk = audio.subarray(offset, end);
        const chunkSeconds = transcriptionSeconds(chunk.length);
        const answer = await call(engine.service, {
          audio: Buffer.from(chunk).toString('base64'), seconds: chunkSeconds,
          ...TRANSCRIPTION_AUDIO, ...(job.language ? { language: job.language } : {}), ...(job.label ? { label: job.label } : {}),
        }, signal);
        const read = readChunk(answer, chunkSeconds);
        for (const item of read.segments) {
          segments.push({ from: start + item.from, to: start + item.to, text: item.text });
        }
        for (const gap of read.gaps) {
          gaps.push({ from: start + gap.from, to: start + gap.to });
        }
        offset = end;
        start += chunkSeconds;
      }
      return { segments, gaps, seconds, engine: engine.service };
    },
  };
}
export type Transcription = ReturnType<typeof createTranscription>;
