import { parentPort, workerData } from 'node:worker_threads';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { KnowledgeAttachmentError } from './knowledge-attachment-parser.ts';

const MAX_BYTES = 1024 * 1024;
// canvas has a libc-detection fallback that can invoke ldd on some hosts. This parsing
// thread never needs subprocesses; block that fallback before loading any dependency.
// Builtin module instances are local to this worker, so the service is unaffected.
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  Object.defineProperty(childProcess, method, { value: () => { throw new KnowledgeAttachmentError('UNSUPPORTED'); } });
}
syncBuiltinESMExports();
function fail(code: 'UNSUPPORTED' | 'INVALID_RESPONSE' | 'LIMIT_EXCEEDED'): never {
  throw new KnowledgeAttachmentError(code);
}

/** Preflight classic OOXML ZIPs before Mammoth expands XML. No archive paths are opened on disk.
 * This declared-size check complements the worker deadline/heap limit; it is not a hard RSS limit.
 */
function checkDocx(bytes: Buffer): void {
  if (bytes.readUInt32LE(0) !== 0x04034b50) fail('INVALID_RESPONSE');
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && (bytes.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  if (end < minimum) fail('INVALID_RESPONSE');
  const count = bytes.readUInt16LE(end + 10);
  if (count > 2048) fail('LIMIT_EXCEEDED');
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) ||
      bytes.readUInt16LE(end + 8) !== count) fail('INVALID_RESPONSE');
  let offset = bytes.readUInt32LE(end + 16);
  if (offset + bytes.readUInt32LE(end + 12) !== end) fail('INVALID_RESPONSE');
  const names = new Set<string>();
  let expanded = 0;
  let contentTypes = '';
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('INVALID_RESPONSE');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > end) fail('INVALID_RESPONSE');
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (names.has(name)) fail('INVALID_RESPONSE');
    names.add(name);
    if (flags & 1 || (method !== 0 && method !== 8)) fail('UNSUPPORTED');
    expanded += size;
    if (expanded > 16 * MAX_BYTES) fail('LIMIT_EXCEEDED');
    if (name === '[Content_Types].xml') {
      const local = bytes.readUInt32LE(offset + 42);
      if (local + 30 > end || bytes.readUInt32LE(local) !== 0x04034b50) fail('INVALID_RESPONSE');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + compressed > end) fail('INVALID_RESPONSE');
      const data = bytes.subarray(start, start + compressed);
      contentTypes = (method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_BYTES })).toString('utf8');
    }
    offset = next;
  }
  if (offset !== end || !contentTypes || ![...names].some(name => name.endsWith('.xml') && name !== '[Content_Types].xml')) fail('INVALID_RESPONSE');
  // Reject renamed macro documents and non-Word OOXML. Mammoth validates the actual main part/XML.
  if (/macroEnabled|vbaProject/i.test(contentTypes)) fail('UNSUPPORTED');
  if (!contentTypes.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) fail('INVALID_RESPONSE');
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') fail('INVALID_RESPONSE');
  // Only this worker imports native canvas/PDF.js. Paths come exclusively from the installed dependency.
  const { PDFParse } = await import('pdf-parse');
  const require = createRequire(import.meta.url);
  const pdfRequire = createRequire(require.resolve('pdf-parse'));
  const root = dirname(pdfRequire.resolve('pdfjs-dist/package.json'));
  PDFParse.setWorker(pathToFileURL(join(root, 'legacy/build/pdf.worker.mjs')).href);
  const parser = new PDFParse({
    data: bytes, useWorkerFetch: false,
    cMapUrl: join(root, 'cmaps') + sep, cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts') + sep,
    wasmUrl: join(root, 'wasm') + sep,
    isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    disableAutoFetch: true, disableRange: true, disableStream: true,
    enableXfa: false, stopAtErrors: true, verbosity: 0,
  });
  try {
    const info = await parser.getInfo();
    if (info.total > 100) fail('LIMIT_EXCEEDED');
    // No annotations, JavaScript action APIs, rendering, images or OCR are invoked.
    const result = await parser.getText({ parseHyperlinks: false, pageJoiner: '' });
    return result.pages.map(page => page.text).join('\n\n');
  } finally { await parser.destroy(); }
}

async function extract(): Promise<string> {
  const { bytes, kind } = workerData as { bytes: Uint8Array; kind: string };
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) fail('INVALID_RESPONSE');
  if (bytes.byteLength > MAX_BYTES) fail('LIMIT_EXCEEDED');
  let text: string;
  if (kind === 'pdf') text = await pdfText(bytes);
  else if (kind === 'docx') {
    const buffer = Buffer.from(bytes);
    checkDocx(buffer);
    const { default: mammoth } = await import('mammoth');
    // extractRawText has ONE argument. Its reader defaults externalFileAccess to false;
    // supplying only buffer (no path or conversion hooks) retains that restriction.
    const result = await mammoth.extractRawText({ buffer });
    if (result.messages.some(message => message.type === 'error')) fail('INVALID_RESPONSE');
    text = result.value;
  } else fail('UNSUPPORTED');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('LIMIT_EXCEEDED');
  if (!text.trim()) throw new KnowledgeAttachmentError('EMPTY_SOURCE');
  return text;
}

if (parentPort) {
  try { parentPort.postMessage({ text: await extract() }); }
  catch (error) {
    // Library error messages/names are never sent across the worker boundary.
    parentPort.postMessage({ code: error instanceof KnowledgeAttachmentError ? error.code : 'INVALID_RESPONSE' });
  } finally { parentPort.close(); }
}
