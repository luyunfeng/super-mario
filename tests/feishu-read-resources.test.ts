import assert from 'node:assert/strict';
import { access, mkdtemp, open, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { readGroupResources } from '../plugins/feishu-read-resources.ts';
import { runPersonalCLI, type PersonalCLI } from '../plugins/feishu-personal.ts';

const signal = new AbortController().signal;
const input = { profile: 'fixture-user', task: '整理附件内容', signal, check: async () => {} };
const row = (key: string, name: string) => ({ id: 'om_' + key, text: '<file key="' + key + '" name="' + name + '"/>' });
test('读群按模型选择读取真实文本、表格、归档目录和图片，隔离文件名并清理', async () => {
  const book = new JSZip();
  book.file('xl/sharedStrings.xml', '<sst><si><t>合成项目</t></si></sst>');
  book.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
  const zip = new JSZip();
  zip.file('报告.txt', '禁止作为正文读取');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNn0AAAAASUVORK5CYII=', 'base64');
  const data = new Map([
    ['file_text', Buffer.from('真实日志')], ['file_sheet', await book.generateAsync({ type: 'nodebuffer' })],
    ['file_zip', await zip.generateAsync({ type: 'nodebuffer' })], ['img_picture', png], ['img_next', png],
  ]);
  const rows = [row('file_text', '../../../日志.txt'), row('file_sheet', '数据.xlsx'), row('file_zip', '归档.zip'),
    { id: 'om_picture', text: '[Image: img_picture]' }, { id: 'om_next', text: '![截图](img_next)' }, row('file_skip', '跳过.txt'), { id: 'om_missing', text: '[Image]' }];
  let cwd = '', reads = 0;
  const cli: PersonalCLI = async (args, options) => {
    assert.deepEqual(args.slice(0, 6), ['--profile', 'fixture-user', '--as', 'user', 'im', '+messages-resources-download']);
    const file = args[args.indexOf('--output') + 1];
    assert.match(file, /^lark-im-resources\/\d+\.bin$/);
    assert.equal(options.maxFileBytes, 50 * 1024 * 1024);
    cwd = options.cwd!;
    const bytes = data.get(args[args.indexOf('--file-key') + 1])!;
    await writeFile(join(cwd, file), bytes); reads++;
    return { data: { size_bytes: bytes.length } };
  };
  const result = await readGroupResources({ ...input, rows, choose: async () => '[2,1,3,5,4]' }, cli);
  assert.equal(reads, 5);
  assert.match(result.texts[0], /A1 合成项目\nB1 42/);
  assert.match(result.texts[1], /日志\.txt.*\n真实日志/);
  assert.match(result.texts[2], /报告\.txt/);
  assert.doesNotMatch(result.texts[2], /禁止作为正文读取/);
  assert.equal(result.images.length, 2);
  assert.deepEqual(result.images[0], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  assert.match(result.texts[3], /图片 1 对应资源 5.*om_next/);
  assert.match(result.texts[4], /图片 2 对应资源 4.*om_picture/);
  assert.match(result.notes.join(' '), /未取得图片资源标识/);
  assert.match(result.notes.join(' '), /未选取 1/);
  await assert.rejects(access(cwd));
});
test('畸形选择和缺失、超大、符号链接资源均不成为正文或图片', async () => {
  const rows = [row('file_x', 'x.txt')];
  const invalid = await readGroupResources({ ...input, rows, choose: async () => '["../../x"]' }, async () => assert.fail());
  assert.equal(invalid.texts.length, 0);
  for (const mode of ['symlink', 'oversize', 'missing', 'truncated']) {
    let dir = '';
    const result = await readGroupResources({ ...input, rows, choose: async () => '[1]' }, async (args, options) => {
      dir = options.cwd!;
      const path = join(dir, args.at(-1)!);
      if (mode === 'symlink') await symlink(import.meta.filename, path);
      if (mode === 'oversize') { const file = await open(path, 'w'); try { await file.truncate(options.maxFileBytes! + 1); } finally { await file.close(); } }
      if (mode === 'truncated') await writeFile(path, '片段');
      return { data: { size_bytes: 1024 } };
    });
    assert.deepEqual(result.texts, []); assert.deepEqual(result.images, []); assert.ok(result.notes.length);
    await assert.rejects(access(dir));
  }
});
test('下载过程中撤销授权会丢弃本轮证据并清理临时目录', async () => {
  let dir = '';
  await assert.rejects(readGroupResources({ ...input, rows: [row('file_auth', '数据.txt')], choose: async () => '[1]',
    check: async () => { if (dir) throw Error('授权变化'); } }, async (args, options) => {
    dir = options.cwd!;
    await writeFile(join(dir, args.at(-1)!), '不应送入模型'); return {};
  }), /授权变化/);
  await assert.rejects(access(dir));
});

test('资源选择提示有大小上限，超过窗口以及无资源占位会明确说明', async () => {
  const rows = Array.from({ length: 130 }, (_, i) => row('file_' + i, '大'.repeat(300) + '.txt'));
  let prompt = '';
  const result = await readGroupResources({ ...input, rows, task: '长'.repeat(5000), choose: async text => { prompt = text; return '[]'; } }, async () => assert.fail());
  assert.ok(prompt.length < 50000);
  assert.equal(JSON.parse(prompt).resources.length, 100);
  assert.match(result.notes.join(' '), /其余 30 项/);
  assert.match(result.notes.join(' '), /4000/);
});

test('图片最多二十张，未完成的下载按最坏大小计入总限额', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNn0AAAAASUVORK5CYII=', 'base64');
  const rows = Array.from({ length: 21 }, (_, i) => ({ id: 'om_' + i, text: '[Image: img_' + i + ']' }));
  const options = { ...input, rows, choose: async () => JSON.stringify(rows.map((_, i) => i + 1)) };
  let downloads = 0;
  const actual = await readGroupResources(options, async (args, opts) => {
    downloads++;
    await writeFile(join(opts.cwd!, args.at(-1)!), png);
    return {};
  });
  assert.equal(downloads, 20); assert.equal(actual.images.length, 20);
  assert.match(actual.notes.join(' '), /20 张图片上限/);
  downloads = 0;
  const failed = await readGroupResources(options, async () => { downloads++; throw Error(); });
  assert.equal(downloads, 4);
  assert.match(failed.notes.join(' '), /200 MiB/);
});

test('Linux 对下载子进程本身执行文件大小限制', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-fsize-test-')), previous = process.env.PATH;
  try {
    await writeFile(join(dir, 'lark-cli'), '#!/bin/sh\nexec dd if=/dev/zero of=fixture.bin bs=1024 count=4 status=none\n', { mode: 0o700 });
    process.env.PATH = dir + ':' + previous;
    await assert.rejects(runPersonalCLI([], { cwd: dir, signal, maxFileBytes: 1024 }));
    assert.equal((await stat(join(dir, 'fixture.bin'))).size, 1024);
  } finally { process.env.PATH = previous; await rm(dir, { recursive: true, force: true }); }
});
