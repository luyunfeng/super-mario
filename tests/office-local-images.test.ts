import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import test, { type TestContext } from 'node:test';
import JSZip from 'jszip';
import { officeCli } from '../plugins/office/cli.ts';
import { resolveLocalImages } from '../plugins/office/local-images.ts';
import { renderOffice } from '../plugins/office/render.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3l8AAAAASUVORK5CYII=', 'base64');

async function fixture(t: TestContext) {
  const tmp = await mkdtemp(join(tmpdir(), 'local-office-images-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'source');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', '样 图.png'), png);
  return { dir, md: join(dir, '示例.md') };
}

test('CLI resolves a Markdown reference image beside its source and packages an internal image relationship', async t => {
  const { md } = await fixture(t);
  const source = '# 示例\n\n![季度图][asset]\n\n[asset]: <assets/样 图.png>';
  await writeFile(md, source);
  for (const format of ['pptx', 'docx']) {
    const { file } = await officeCli([format, md]);
    const zip = await JSZip.loadAsync(await readFile(file));
    const doc = format === 'docx' ? 'word/document.xml' : 'ppt/slides/slide1.xml';
    const rels = doc.replace(/([^/]+)$/, '_rels/$1.rels');
    const xml = await zip.file(doc)!.async('string');
    const id = xml.match(/<a:blip[^>]* r:embed="([^"]+)"/)?.[1];
    assert.ok(id);
    const relationship = (await zip.file(rels)!.async('string')).match(new RegExp('<Relationship (?=[^>]*Id="' + id + '")[^>]+>'))![0];
    assert.match(relationship, /relationships\/image"/);
    assert.doesNotMatch(relationship, /TargetMode="External"/);
    const target = posix.join(dirname(doc), relationship.match(/ Target="([^"]+)"/)![1]);
    assert.deepEqual(await zip.file(target)!.async('nodebuffer'), png);
    const check = await officeCli(['check', file]);
    assert.equal('format' in check && check.format, format);

    // The same source sent to the Web renderer has no caller-supplied image map.
    const web = await JSZip.loadAsync((await renderOffice(format, source, '示例')).bytes);
    assert.equal(web.file(/\/media\/[^/]+$/).length, 0);
    assert.match(await web.file(doc)!.async('string'), /季度图/);
  }
});

test('CLI reads only image tokens pointing to ordinary contained files', async t => {
  const { dir, md } = await fixture(t);
  const outside = join(dirname(dir), 'outside.png');
  await writeFile(outside, png);
  await symlink(outside, join(dir, 'link.png'));
  await symlink(dirname(dir), join(dir, 'assets', 'external'));
  if (process.platform === 'linux') execFileSync('mkfifo', [join(dir, 'pipe.png')]);
  const literal = '![实际文件](assets/%E6%A0%B7%20%E5%9B%BE.png)';
  const source = ['~~~', literal, '~~~', '`' + literal + '`', '[非图片链接](assets/%E6%A0%B7%20%E5%9B%BE.png)',
    ...['https://example.invalid/image.png', outside, '../outside.png', '%2E%2E/outside.png', 'link.png', 'pipe.png',
      'assets/external/outside.png', 'file:///outside.png', '//example.invalid/1.png'].map(path => '![说明](' + path + ')')].join('\n\n');
  assert.equal((await resolveLocalImages(source, md)).size, 0);
});

test('cumulative limits count repeated Markdown image placements', async t => {
  const { dir, md } = await fixture(t);
  const image = '![样例](assets/%E6%A0%B7%20%E5%9B%BE.png)';
  await assert.rejects(resolveLocalImages(Array(65).fill(image).join('\n\n'), md), /最多 64 张/);
  const large = Buffer.from(png);
  large.writeUInt32BE(5000, 16);
  large.writeUInt32BE(4000, 20);
  const path = join(dir, 'assets', '样 图.png');
  await writeFile(path, large);
  await assert.rejects(resolveLocalImages([image, image].join('\n\n'), md), /3200 万像素/);
  await writeFile(path, Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
  await assert.rejects(resolveLocalImages([image, image].join('\n\n'), md), /4 MiB/);
});

test('both CLI renderers embed local GIF bytes', async t => {
  const { dir, md } = await fixture(t);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  await writeFile(join(dir, '图.gif'), gif);
  await writeFile(md, '![单像素](图.gif)');
  for (const format of ['pptx', 'docx']) {
    const { file } = await officeCli([format, md]);
    const zip = await JSZip.loadAsync(await readFile(file));
    const [media] = zip.file(/\/media\/.+\.gif$/);
    assert.ok(media);
    assert.deepEqual(await media.async('nodebuffer'), gif);
  }
});
