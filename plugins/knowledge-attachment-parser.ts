import { Worker } from 'node:worker_threads';
import type { KnowledgeSourceErrorCode } from '../packages/protocol/src/index.ts';

export type KnowledgeAttachmentErrorCode = Extract<KnowledgeSourceErrorCode,
  'UNSUPPORTED' | 'EMPTY_SOURCE' | 'LIMIT_EXCEEDED' | 'CANCELLED' | 'TIMEOUT' | 'INVALID_RESPONSE'>;
const messages: Record<KnowledgeAttachmentErrorCode, string> = {
  UNSUPPORTED: '附件仅支持 PDF 和 DOCX 格式',
  EMPTY_SOURCE: '附件没有可提取的正文（PDF 不支持 OCR）',
  LIMIT_EXCEEDED: '附件超过解析限制（输入或正文 1 MiB、PDF 100 页）',
  CANCELLED: '附件解析已取消',
  TIMEOUT: '附件解析超时',
  INVALID_RESPONSE: '附件格式损坏或无法解析',
};

/** Never attach a cause or parser diagnostics: these can contain document text and local paths. */
export class KnowledgeAttachmentError extends Error {
  readonly code: KnowledgeAttachmentErrorCode;
  constructor(code: KnowledgeAttachmentErrorCode) {
    super(messages[code]);
    this.name = 'KnowledgeAttachmentError';
    this.code = code;
  }
}

const MAX_BYTES = 1024 * 1024;
function format(name: string): 'pdf' | 'docx' | undefined {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension === 'pdf' || extension === 'docx' ? extension : undefined;
}
export function supportsKnowledgeAttachment(name: string): boolean { return format(name) !== undefined; }

export async function extractKnowledgeAttachment(input: {
  bytes: Uint8Array; name: string; signal?: AbortSignal;
}): Promise<string> {
  const { bytes, name, signal } = input;
  if (signal?.aborted) throw new KnowledgeAttachmentError('CANCELLED');
  const kind = format(name);
  if (!kind) throw new KnowledgeAttachmentError('UNSUPPORTED');
  if (!(bytes instanceof Uint8Array)) throw new KnowledgeAttachmentError('INVALID_RESPONSE');
  if (bytes.byteLength > MAX_BYTES) throw new KnowledgeAttachmentError('LIMIT_EXCEEDED');
  if (!bytes.byteLength) throw new KnowledgeAttachmentError('EMPTY_SOURCE');

  return new Promise<string>((resolve, reject) => {
    let worker: Worker;
    try {
      // new URL string literals are NOT rewritten by rewriteRelativeImportExtensions.
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      worker = new Worker(new URL(`./knowledge-attachment-worker.${extension}`, import.meta.url), {
        // structured clone copies the input, including Buffer slices; never transfer caller storage.
        workerData: { bytes: new Uint8Array(bytes), kind },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        execArgv: [], stdout: true, stderr: true,
      });
    } catch { reject(new KnowledgeAttachmentError('INVALID_RESPONSE')); return; }
    // Capture library warnings as well as logs during dynamic import. Never forward them to the service.
    worker.stdout.resume();
    worker.stderr.resume();
    let finished = false;
    const finish = (code?: KnowledgeAttachmentErrorCode, text?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Keep error/exit listeners until termination completes, including cancellation races.
      void worker.terminate().catch(() => undefined).then(() => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (code) reject(new KnowledgeAttachmentError(code));
        else resolve(text!);
      });
    };
    const onAbort = () => finish('CANCELLED');
    const onError = (error: Error & { code?: string }) => finish(
      error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'LIMIT_EXCEEDED' : 'INVALID_RESPONSE');
    const onExit = () => finish('INVALID_RESPONSE');
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== 'object') { finish('INVALID_RESPONSE'); return; }
      const result = value as { text?: unknown; code?: unknown };
      if (typeof result.code === 'string' && Object.hasOwn(messages, result.code)) {
        finish(result.code as KnowledgeAttachmentErrorCode); return;
      }
      if (typeof result.text !== 'string') { finish('INVALID_RESPONSE'); return; }
      if (Buffer.byteLength(result.text, 'utf8') > MAX_BYTES) { finish('LIMIT_EXCEEDED'); return; }
      if (!result.text.trim()) { finish('EMPTY_SOURCE'); return; }
      finish(undefined, result.text);
    };
    const timer = setTimeout(() => finish('TIMEOUT'), 15_000);
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
