export const officeFormats = ['docx', 'pptx', 'xlsx'] as const;
export type OfficeFormat = typeof officeFormats[number];
export const officeSourceLimit = 512 * 1024;

export async function renderOffice(format: string, source: string, title: string, images?: ReadonlyMap<string, string>) {
  if (!source.trim() || Buffer.byteLength(source) > officeSourceLimit) throw new Error('源内容不能为空，最多 512 KiB');
  if (!title.trim() || title.length > 120 || /[\p{Cc}\p{Cs}]/u.test(title)) throw new Error('标题须为 1 至 120 个字符');
  // A normal chat or server start need not load any document-generation libraries.
  let rendered;
  switch (format) {
    case 'docx': rendered = await (await import('./docx.ts')).renderDocx(source, title, images); break;
    case 'pptx': rendered = await (await import('./pptx.ts')).renderPptx(source, title, images); break;
    case 'xlsx': rendered = await (await import('./xlsx.ts')).renderXlsx(source, title); break;
    default: throw new Error('文件格式须为 docx、pptx 或 xlsx');
  }
  // Report the structure of the finished file, including the actual sheets and slides.
  const { inspectOffice } = await import('./inspect.ts');
  const checked = await inspectOffice(rendered.bytes);
  if (checked.format !== format) throw new Error('生成文件格式校验失败');
  return { bytes: rendered.bytes, summary: checked.summary };
}
