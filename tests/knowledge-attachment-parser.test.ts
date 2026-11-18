import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';
import { extractKnowledgeAttachment, supportsKnowledgeAttachment, KnowledgeAttachmentError } from '../plugins/knowledge-attachment-parser.ts';

const MAX = 1024 * 1024;
const fixture = (name: string) => readFile(new URL(`./fixtures/knowledge-attachments/${name}`, import.meta.url));
const extract = (bytes: Uint8Array, name = 'test.docx', signal?: AbortSignal) => extractKnowledgeAttachment({ bytes, name, signal });
function error(code: ConstructorParameters<typeof KnowledgeAttachmentError>[0]) {
  return (value: unknown) => {
    assert.ok(value instanceof KnowledgeAttachmentError);
    assert.equal(value.code, code);
    assert.equal(value.message, new KnowledgeAttachmentError(code).message);
    assert.equal(value.cause, undefined);
    assert.deepEqual(Object.keys(value).sort(), ['code', 'name']);
    return true;
  };
}

// Only synthetic packages. Implement ZIP writing here to avoid test-only production dependencies.
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(parts: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(text), compressed = deflateRawSync(data);
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10); entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed); central.push(entry, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function docx(text: string, type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'): Buffer {
  return zip({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${type}"/></Types>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}
function pdf(pages: number, actions = false): Buffer {
  const action = actions ? ' /OpenAction << /S /JavaScript /JS (globalThis.__g21Executed = true) >>' : '';
  const annotations = actions ? ' /Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /URI /URI (https://example.invalid/g21-never-fetch) >> >>]' : '';
  const objects = [`<< /Type /Catalog /Pages 2 0 R${action} >>`,
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: pages }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 ${pages + 4} 0 R >> >> /Contents ${pages + 3} 0 R${annotations} >>`),
    '<< /Length 39 >>\nstream\nBT /F1 12 Tf 20 250 Td (G21 page) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${n.toString().padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(result);
}

test('suffix allowlist rejects old Office, macros, URL queries and trailing extensions', async () => {
  for (const name of ['a.pdf', 'a.PDF', '/local/test.DoCx']) assert.equal(supportsKnowledgeAttachment(name), true);
  for (const name of ['a.doc', 'a.xls', 'a.ppt', 'a.xlsx', 'a.pptx', 'a.docm', 'a.zip', 'a.pdf.exe', 'a.pdf?x', 'a.pdf/x', 'pdf']) {
    assert.equal(supportsKnowledgeAttachment(name), false);
    await assert.rejects(extract(Buffer.from('synthetic'), name), error('UNSUPPORTED'));
  }
});

test('real PDF/DOCX extraction and caller buffer ownership', async () => {
  const pdfBytes = await fixture('text-layer.pdf'), before = Buffer.from(pdfBytes);
  assert.equal((await extract(pdfBytes, 'test.PDF')).trim(), 'G21 PDF fixture');
  assert.deepEqual(pdfBytes, before);
  assert.match(await extract(await fixture('basic.docx')), /G21 DOCX 中文测试/);
  const caller = await fixture('basic.docx');
  const pending = extract(caller);
  caller.fill(0);
  assert.match(await pending, /G21 DOCX 中文测试/);
  assert.ok(caller.buffer.byteLength > 0);
});

test('empty input, blank PDF, image-only PDF and empty DOCX report EMPTY_SOURCE', async () => {
  await assert.rejects(extract(new Uint8Array()), error('EMPTY_SOURCE'));
  await assert.rejects(extract(await fixture('image-only.pdf'), 'scan.pdf'), error('EMPTY_SOURCE'));
  const blank = pdf(1).toString().replace('(G21 page)', '(        )');
  await assert.rejects(extract(Buffer.from(blank), 'blank.pdf'), error('EMPTY_SOURCE'));
  await assert.rejects(extract(docx('  ')), error('EMPTY_SOURCE'));
});

test('damaged files and arbitrary ZIPs fail with fixed errors', async () => {
  for (const [bytes, name] of [
    [Buffer.from('%PDF-1.7\nSENSITIVE_PATH_INVALID'), 'broken.pdf'],
    [Buffer.from('not PDF'), 'renamed.pdf'],
    [Buffer.from('PK'), 'broken.docx'],
    [zip({ 'random.txt': 'secret' }), 'arbitrary.docx'],
    [zip({ '[Content_Types].xml': '<broken', 'word/document.xml': '<broken' }), 'broken.docx'],
    [Buffer.from((await fixture('basic.docx')).subarray(0, 100)), 'truncated.docx'],
  ] as const) await assert.rejects(extract(bytes, name), error('INVALID_RESPONSE'));
  await assert.rejects(extract(docx('macro', 'application/vnd.ms-word.document.macroEnabled.main+xml')), error('UNSUPPORTED'));
  const malformedXml = zip({
    '[Content_Types].xml': '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<w:document><broken',
  });
  await assert.rejects(extract(malformedXml), error('INVALID_RESPONSE'));
});

test('input byte boundary includes exactly 1 MiB and rejects larger input before parsing', async () => {
  const original = await fixture('text-layer.pdf');
  const exact = Buffer.alloc(MAX, 32); original.copy(exact);
  assert.equal((await extract(exact, 'boundary.pdf')).trim(), 'G21 PDF fixture');
  await assert.rejects(extract(Buffer.alloc(MAX + 1), 'too-large.pdf'), error('LIMIT_EXCEEDED'));
});

test('output limit measures UTF8 bytes, includes exactly 1 MiB and never truncates', async () => {
  const exact = await extract(docx('A'.repeat(MAX - 2)));
  assert.equal(Buffer.byteLength(exact), MAX);
  await assert.rejects(extract(docx('A'.repeat(MAX))), error('LIMIT_EXCEEDED'));
  await assert.rejects(extract(docx('中'.repeat(Math.ceil(MAX / 3)))), error('LIMIT_EXCEEDED'));
});

test('DOCX declared expansion budget rejects ZIP bombs', async () => {
  await assert.rejects(extract(docx('A'.repeat(16 * MAX))), error('LIMIT_EXCEEDED'));
});

test('PDF accepts 100 pages and rejects 101 without truncation', async () => {
  assert.equal((await extract(pdf(100), '100.pdf')).match(/G21 page/g)?.length, 100);
  await assert.rejects(extract(pdf(101), '101.pdf'), error('LIMIT_EXCEEDED'));
});

test('pre-aborted signal does not create a worker', async t => {
  const spy = t.mock.method(Worker.prototype, 'terminate');
  await assert.rejects(extract(docx('cancel'), 'test.docx', AbortSignal.abort('private reason')), error('CANCELLED'));
  assert.equal(spy.mock.callCount(), 0);
});

function assertClean(worker: unknown) {
  assert.ok(worker instanceof Worker);
  assert.equal(worker.threadId, -1);
  assert.equal(worker.listenerCount('message'), 0);
  assert.equal(worker.listenerCount('error'), 0);
  assert.equal(worker.listenerCount('exit'), 0);
}

test('abort terminates worker and removes listeners before returning', async t => {
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, 'removeEventListener');
  const stop = t.mock.method(Worker.prototype, 'terminate');
  const pending = extract(docx('cancel'), 'test.docx', controller.signal);
  controller.abort('private reason');
  await assert.rejects(pending, error('CANCELLED'));
  assert.equal(stop.mock.callCount(), 1);
  assertClean(stop.mock.calls[0]!.this);
  assert.equal(remove.mock.callCount(), 1);
});

test('deadline terminates worker, clears timer and removes signal listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, 'removeEventListener');
  const stop = t.mock.method(Worker.prototype, 'terminate');
  const pending = extract(docx('timeout'), 'test.docx', controller.signal);
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, error('TIMEOUT'));
  assert.equal(stop.mock.callCount(), 1);
  assertClean(stop.mock.calls[0]!.this);
  assert.equal(remove.mock.callCount(), 1);
  controller.abort();
  t.mock.timers.tick(30_000);
  assert.equal(stop.mock.callCount(), 1);
});

test('successful and failed real parsing both await worker cleanup and cancel deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = t.mock.method(Worker.prototype, 'terminate');
  await extract(await fixture('basic.docx'));
  await assert.rejects(extract(Buffer.from('bad'), 'bad.pdf'), error('INVALID_RESPONSE'));
  assert.equal(stop.mock.callCount(), 2);
  for (const call of stop.mock.calls) assertClean(call.this);
  t.mock.timers.tick(30_000);
  assert.equal(stop.mock.callCount(), 2);
});

// Audit inside a separate worker: guards never change network/filesystem functions in the service.
// Real parsers and the same production worker entry still execute, including local font loading.
async function audited(bytes: Uint8Array, kind: string): Promise<{ text?: string; code?: string; attempts: string[] }> {
  const entry = new URL('../plugins/knowledge-attachment-worker.ts', import.meta.url).href;
  const bootstrap = `
    import { parentPort } from 'node:worker_threads';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(${JSON.stringify(import.meta.url)});
    const attempts = [];
    const deny = label => (...args) => { attempts.push(label); throw Error('audit denied'); };
    globalThis.fetch = deny('fetch');
    globalThis.__g21Executed = false;
    for (const [module, methods] of [
      ['http', ['request', 'get']], ['https', ['request', 'get']],
      ['net', ['connect', 'createConnection']], ['tls', ['connect']],
      ['dgram', ['createSocket']], ['dns', ['lookup', 'resolve']],
      ['child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
    ]) for (const method of methods) require(module)[method] = deny(module + '.' + method);
    const net = require('net'); net.Socket.prototype.connect = deny('Socket.connect');
    const fs = require('fs');
    for (const target of [fs, fs.promises]) for (const method of ['readFile', 'readFileSync', 'open', 'openSync']) {
      if (typeof target[method] !== 'function') continue;
      const original = target[method];
      target[method] = function(path, ...args) {
        const location = String(path);
        if (location !== '/usr/bin/ldd' && !location.includes('/node_modules/') && !/knowledge-attachment-(worker|parser)\\.ts$/.test(location)) return deny('external file')(path);
        return original.call(this, path, ...args);
      };
    }
    syncBuiltinESMExports();
    const post = parentPort.postMessage.bind(parentPort);
    parentPort.postMessage = value => { if (globalThis.__g21Executed) attempts.push('PDF JavaScript'); post({ ...value, attempts }); };
    await import(${JSON.stringify(entry)});
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    workerData: { bytes, kind }, stdout: true, stderr: true,
  });
  worker.stdout.resume(); worker.stderr.resume();
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', () => reject(new Error('missing audit result')));
    });
  } finally { await worker.terminate(); }
}

test('real parsers do not fetch external references, read external images or execute system commands', async () => {
  for (const [name, kind] of [['external-links.docx', 'docx'], ['text-layer.pdf', 'pdf'], ['image-only.pdf', 'pdf'], ['actions.pdf', 'pdf']]) {
    const result = await audited(name === 'actions.pdf' ? pdf(1, true) : await fixture(name!), kind!);
    assert.deepEqual(result.attempts, []);
    if (name === 'image-only.pdf') assert.equal(result.code, 'EMPTY_SOURCE');
    else assert.match(result.text!, /G21/);
    if (kind === 'docx') assert.match(result.text!, /external link label/);
  }
});


test('worker errors, unexpected exits and malformed replies clean up without exposing diagnostics', async t => {
  const stop = t.mock.method(Worker.prototype, 'terminate');
  const subscribe = t.mock.method(Worker.prototype, 'on');
  for (const scenario of ['error', 'oom', 'exit', 'reply']) {
    const pending = extract(docx('worker failure'));
    const worker = subscribe.mock.calls.at(-1)!.this;
    assert.ok(worker instanceof Worker);
    if (scenario === 'error' || scenario === 'oom') worker.emit('error', Object.assign(new Error('PRIVATE_PATH_AND_PARAMETERS'), {
      code: scenario === 'oom' ? 'ERR_WORKER_OUT_OF_MEMORY' : 'PRIVATE_CODE',
    }));
    else if (scenario === 'exit') worker.emit('exit', 1);
    else worker.emit('message', { code: 'PRIVATE_CODE', text: 42 });
    await assert.rejects(pending, error(scenario === 'oom' ? 'LIMIT_EXCEEDED' : 'INVALID_RESPONSE'));
    assertClean(worker);
  }
  assert.equal(stop.mock.callCount(), 4);
});
