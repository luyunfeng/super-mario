import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/super-mario.js', import.meta.url));

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-office-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const office = async (...args: string[]) => {
    const { stdout } = await run(process.execPath, [bin, 'office', ...args], {
      cwd: dir, env: { SUPER_MARIO_DEV: '1' }, timeout: 15000,
    });
    return JSON.parse(stdout);
  };
  return { dir, office };
}

test('真实 office CLI 生成 Word、PowerPoint 和 Excel，并从产物读取检查结果', async t => {
  const { dir, office } = await fixture(t);
  const heading = '合成季度交付';
  await writeFile(join(dir, '输入材料.md'), '# ' + heading + '\n\n合成核验记录。');
  await writeFile(join(dir, '工作簿.json'), JSON.stringify({
    sheets: [{ name: '样例数据', header: ['数量', '剩余'], rows: [[12, '=A2-4']] }],
  }));

  for (const [format, source, member, expected] of [
    ['docx', '输入材料.md', 'word/document.xml', heading],
    ['pptx', '输入材料.md', 'ppt/slides/slide1.xml', heading],
    ['xlsx', '工作簿.json', 'xl/worksheets/sheet1.xml', 'A2-4'],
  ]) {
    const target = '交付 样例.' + format;
    const receipt = await office(format, source, '-o', target, '--title', '季度核验');
    assert.equal(receipt.file, join(dir, target));
    const bytes = await readFile(receipt.file);
    assert.equal(receipt.bytes, bytes.length);
    assert.ok(receipt.summary);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    assert.ok((await zip.file(member)!.async('string')).includes(expected));
    const checked = await office('check', target);
    assert.equal(checked.format, format);
    assert.equal(receipt.summary, checked.summary);
    assert.equal(checked.file, receipt.file);
    assert.ok(checked.summary.includes(format === 'xlsx' ? '样例数据' : heading));
    if (format === 'xlsx') assert.match(checked.summary, /1 个公式/);
    assert.deepEqual(await readFile(receipt.file), bytes);
  }
});

test('office CLI 保留已有目标，拒绝错误扩展、非法源文件和损坏的检查目标', async t => {
  const { dir, office } = await fixture(t);
  await writeFile(join(dir, '原稿.md'), '# 合成源稿\n');
  const original = '已有目标必须原样保留';
  await writeFile(join(dir, '原稿.docx'), original);
  await assert.rejects(office('docx', '原稿.md'), /EEXIST|已存在/);
  assert.equal(await readFile(join(dir, '原稿.docx'), 'utf8'), original);

  await assert.rejects(office('docx', '原稿.md', '-o', '错误.xlsx'), /扩展名/);
  await writeFile(join(dir, '无效.json'), '{"sheets":');
  await assert.rejects(office('xlsx', '无效.json'), /JSON/);
  await assert.rejects(office('check', '原稿.docx'), /Office|ZIP/);
  assert.deepEqual((await readdir(dir)).sort(), ['原稿.md', '原稿.docx', '无效.json'].sort());
});
