import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { renderPptx } from '../plugins/office/pptx.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3l8AAAAASUVORK5CYII=';

async function slides(source: string) {
  const { bytes, summary } = await renderPptx(source, '示例演示');
  const zip = await JSZip.loadAsync(bytes);
  const parts = zip.file(/^ppt\/slides\/slide\d+\.xml$/);
  parts.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return { zip, summary, pages: await Promise.all(parts.map(part => part.async('string'))) };
}

test('explicit separators create widescreen slides with a cover, native numbering, bullets and editable table', async () => {
  const { zip, pages, summary } = await slides([
    '# 进度报告', '', '发布计划', '', '---', '', '# 总览', '', '## 范围', '',
    '4. 试点', '5. 推广', '   - 验收', '', '| 部门 | 进度 |', '|---|---|', '| 研发 | A & B |',
  ].join('\n'));
  assert.equal(pages.length, 2);
  assert.match(summary, /2 页/);
  assert.match(await zip.file('ppt/presentation.xml')!.async('string'), /<p:sldSz cx="12192000" cy="6858000"/);
  assert.match(await zip.file('docProps/core.xml')!.async('string'), /示例演示/);
  assert.match(pages[0], /封面标题.*进度报告.*封面副标题.*发布计划/s);
  assert.match(pages[1], /总览.*范围/s);
  assert.match(pages[1], /buAutoNum[^>]+startAt="4".*试点.*buAutoNum[^>]+startAt="5".*推广/s);
  assert.match(pages[1], /buChar.*验收.*<a:tbl>.*A &amp; B/s);
});

test('without separators H1/H2 split slides, while fenced code and H3 stay on the current slide', async () => {
  const { pages } = await slides('# 封面\n\n## 说明\n\n### 细节\n\n```\n---\n# 示例\n```\n\n## 结论');
  assert.equal(pages.length, 3);
  assert.match(pages[1], /说明.*细节.*---.*# 示例/s);
  assert.match(pages[2], /结论/);
  await assert.rejects(renderPptx('\n---\n', '空'), /没有可生成/);
});

test('embedded PNG uses only supplied bytes, and file and remote references keep their labels', async () => {
  const { zip, pages } = await slides([
    '# 示意图', '', '![样例 & 图](data:image/png;base64,' + png + ')', '',
    '![相对文件](private/report.png)', '', '![本机文件](file:///private/report.png)', '', '![网络文件](https://example.invalid/private.png)',
  ].join('\n'));
  const media = zip.file(/^ppt\/media\/.+$/);
  assert.equal(media.length, 1);
  assert.deepEqual(await media[0].async('nodebuffer'), Buffer.from(png, 'base64'));
  assert.match(pages.join(''), /<p:pic>/);
  assert.match(pages.join(''), /descr="样例 &amp; 图"/);
  assert.match(pages.join(''), /相对文件.*本机文件.*网络文件/s);
  assert.doesNotMatch(pages.join(''), /private|example\.invalid/);
  const rels = await Promise.all(zip.file(/\.rels$/).map(part => part.async('string')));
  assert.doesNotMatch(rels.join(''), /TargetMode="External"/);
});

test('embedded images must match their media type and cumulative pixel budget', async () => {
  await assert.rejects(renderPptx('![错](data:image/jpeg;base64,' + png + ')', '测试'), /格式不符/);
  const largeHeader = Buffer.from(png, 'base64');
  largeHeader.writeUInt32BE(5000, 16);
  largeHeader.writeUInt32BE(4000, 20);
  const image = '![大图](data:image/png;base64,' + largeHeader.toString('base64') + ')';
  await assert.rejects(renderPptx([image, image].join('\n\n'), '测试'), /累计超过 3200 万像素/);
});

test('large tables repeat their header on continuation slides and preserve every data row in order', async () => {
  const rows = Array.from({ length: 38 }, (_, i) => '| 项目-' + (i + 1) + ' | 进行中 |');
  const { pages } = await slides(['## 排期', '', '| 编号 | 状态 |', '|---|---|', ...rows].join('\n'));
  assert.ok(pages.length > 1);
  for (const page of pages) assert.match(page, /排期.*<a:tbl>.*编号.*状态/s);
  assert.deepEqual(Array.from(pages.join('').matchAll(/<a:t>(项目-\d+)<\/a:t>/g), m => m[1]), rows.map((_, i) => '项目-' + (i + 1)));
});

test('JPEG, body text and an editable table fit side by side on one slide', async () => {
  // A synthetic 1×1 grey JPEG.
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAB/9k=';
  const { zip, pages } = await slides(['# 预算', '', '- 采购', '', '![图示](data:image/jpeg;base64,' + jpeg + ')', '', '| 条目 | 数量 |', '|---|---|', '| 样本 | 2 |'].join('\n'));
  assert.equal(pages.length, 1);
  assert.deepEqual(await zip.file(/^ppt\/media\/.+$/)[0].async('nodebuffer'), Buffer.from(jpeg, 'base64'));
  const image = pages[0].match(/<p:pic>.*?<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/s)!;
  const table = pages[0].match(/<p:graphicFrame>.*?<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/s)!;
  assert.ok(Number(table[1]) + Number(table[3]) < Number(image[1]));
  assert.ok(Number(image[1]) + Number(image[3]) <= 12192000);
  assert.ok(Number(image[2]) + Number(image[4]) <= 6858000);
});
