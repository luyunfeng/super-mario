import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { inspectOffice } from '../plugins/office/inspect.ts';
import { renderDocx } from '../plugins/office/docx.ts';
import { renderXlsx } from '../plugins/office/xlsx.ts';
import { renderPptx } from '../plugins/office/pptx.ts';

test('Office inspection follows internal package types and reports actual Word, Excel and PowerPoint structure', async () => {
  const doc = await renderDocx('# 月报\n\n正文\n\n---\n\n## 结论\n\n|甲|乙|\n|-|-|\n|1|2|', '汇总文档');
  const word = await inspectOffice(doc.bytes);
  assert.equal(word.format, 'docx');
  assert.match(word.summary, /汇总文档/);
  assert.match(word.summary, /2 个标题，1 个表格/);
  assert.match(word.summary, /1 处显式分页/);
  assert.match(word.summary, /月报、结论/);
  const sheet = await renderXlsx(JSON.stringify({ sheets: [
    { name: '成本', header: ['价格','数量','合计'], rows: [[4,2,'=A2*B2']] },
    { name: '归档', header: ['标记'], rows: [['完成']] },
  ] }), '成本统计');
  const workbook = await inspectOffice(sheet.bytes);
  assert.equal(workbook.format, 'xlsx');
  assert.match(workbook.summary, /2 个工作表，8 个单元格，1 个公式/);
  assert.match(workbook.summary, /成本、归档/);
  const deck = await renderPptx('# 第一页\n\n摘要\n\n---\n\n# 第二页\n\n|甲|乙|\n|--|--|\n|1|2|', '演示');
  const presentation = await inspectOffice(deck.bytes);
  assert.equal(presentation.format, 'pptx');
  assert.match(presentation.summary, /2 页幻灯片，1 个表格/);
  assert.match(presentation.summary, /第一页、第二页/);
});

test('inspection refuses unsupported content types, external main parts, malformed XML and DTDs', async () => {
  const { bytes } = await renderDocx('正文', '标题');
  async function edited(part: string, change: (s: string) => string) {
    const zip = await JSZip.loadAsync(bytes);
    zip.file(part, change(await zip.file(part)!.async('string')));
    return zip.generateAsync({ type: 'nodebuffer' });
  }
  const wrongTypes = await edited('[Content_Types].xml', s => s.replace('wordprocessingml.document.main+xml', 'unrecognized'));
  await assert.rejects(inspectOffice(wrongTypes), /内容类型/);
  const external = await edited('_rels/.rels', s => s.replace('Target="word/document.xml"', 'TargetMode="External" Target="https://example.org/unused"'));
  await assert.rejects(inspectOffice(external), /包内关系/);
  await assert.rejects(inspectOffice(await edited('word/document.xml', () => '<unfinished>')), { status: 400 });
  await assert.rejects(inspectOffice(await edited('word/document.xml', s => s.replace('<w:document ', '<!DOCTYPE document><w:document '))), /DTD/);
  const longXml = await edited('word/document.xml', () => 'x'.repeat(12 * 1024 * 1024 + 1));
  await assert.rejects(inspectOffice(longXml), /XML 大小超过限制/);
  await assert.rejects(inspectOffice(Buffer.from('not an office package')), { status: 400 });
});
