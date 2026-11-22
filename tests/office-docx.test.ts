import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { renderDocx } from '../plugins/office/docx.ts';

test('Word package preserves Markdown semantics, heading links, table alignment and list numbering', async () => {
  const source = [
    '# 审阅', '', '转到[结果](#结果)。参考[外部资料](https://example.org/report?a=1&b=2)。',
    '', '**加粗与 *嵌套斜体***、~~删除~~、`行内代码`。', '',
    '3. 一项', '   - [x] 检查', '4. 下一项', '', '> 引用内容', '',
    '```js', 'const x = "<tag>";', '  next();', '```', '', '---', '', '## 结果', '',
    '| 项目 | 数量 |', '| :---: | ---: |', '| **甲** | 12 |',
  ].join('\n');
  const file = await renderDocx(source, '验收报告');
  const zip = await JSZip.loadAsync(file.bytes, { checkCRC32: true });
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.match(await zip.file('docProps/core.xml')!.async('string'), /<dc:title>验收报告<\/dc:title>/);
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /<w:hyperlink[^>]* w:anchor="heading_2"/);
  assert.match(xml, /w:bookmarkStart w:name="heading_2"/);
  assert.match(xml, /w:pStyle w:val="Heading2"\/><w:pageBreakBefore\/>/);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /<w:i\/>/);
  assert.match(xml, /<w:strike\/>/);
  assert.match(xml, /w:rFonts[^>]+Consolas/);
  assert.match(xml, /☑ 检查/);
  assert.match(xml, /<w:ilvl w:val="1"/);
  assert.match(xml, /w:pStyle w:val="WorkQuote"/);
  assert.match(xml, /w:pStyle w:val="WorkCode"/);
  assert.match(xml, /const x = &quot;&lt;tag&gt;&quot;;/);
  assert.match(xml, /xml:space="preserve">  next\(\);/);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.match(xml, /<w:jc w:val="center"/);
  assert.match(xml, /<w:jc w:val="right"/);
  assert.match(xml, /<w:pgSz w:w="11906" w:h="16838"/);
  const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
  assert.match(rels, /Target="https:\/\/example.org\/report\?a=1&amp;b=2"/);
  const numbering = await zip.file('word/numbering.xml')!.async('string');
  assert.match(numbering, /<w:start w:val="3"\/><w:numFmt w:val="decimal"\/>/);
  assert.match(file.summary, /2 个标题，1 个表格/);
});

test('Word embeds inline image bytes and keeps captions for local, remote or invalid image sources', async () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==';
  const source = [
    '![像素](data:image/png;base64,' + pixel + ')', '![本地配图](file:///unused/private.png)',
    '![远程配图](https://example.org/image.png)', '![无效配图](data:image/png;base64,QQ==)',
  ].join('\n\n');
  const zip = await JSZip.loadAsync((await renderDocx(source, '图片')).bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  const images = Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('word/media/'));
  assert.equal(images.length, 1);
  assert.deepEqual(await images[0].async('nodebuffer'), Buffer.from(pixel, 'base64'));
  assert.match(xml, /descr="像素"/);
  for (const label of ['本地配图','远程配图','无效配图']) assert.ok(xml.includes('［图片：' + label + '］'));
  assert.doesNotMatch(await zip.file('word/_rels/document.xml.rels')!.async('string'), /example.org|private.png/);
  await assert.rejects(renderDocx('   ', '空'), /不能为空/);
});
