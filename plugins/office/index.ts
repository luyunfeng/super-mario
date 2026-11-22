import { randomUUID } from 'node:crypto';
import type { Extension, Json } from '../../packages/plugin-sdk/src/index.ts';
import { officeFormats, renderOffice } from './render.ts';

type Document = { id: string; title: string; format: string; filename: string; size: number; summary: string; createdAt: string };
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }

export const officeDocuments: Extension = {
  id: 'office-documents', name: '办公文件', capabilities: ['office.generate'],
  permissions: ['contribute:tools', 'service.provide:office-documents.manage', 'store.read', 'store.write'],
  activate({ store, provide, contribute, defer }) {
    const lifetime = new AbortController();
    defer(() => lifetime.abort(new Error('办公文件插件已停用')));
    async function create(input: Json, signal: AbortSignal) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(k => !['title', 'format', 'source'].includes(k))
        || typeof input.title !== 'string' || typeof input.format !== 'string' || typeof input.source !== 'string')
        fail(400, '请提供文件标题、格式和源内容');
      const { format, source } = input, title = input.title.trim();
      let rendered;
      try { rendered = await renderOffice(format, source, title); }
      catch (cause) { fail(400, cause instanceof Error ? cause.message : '办公文件生成失败'); }
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const { bytes, summary } = rendered;
      if (!bytes.length || bytes.length > 12 * 1024 * 1024) fail(413, '生成文件为空或超过 12 MiB');
      const doc: Document = { id: randomUUID(), title, format, filename: (title.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '') || '办公文件') + '.' + format,
        size: bytes.length, summary, createdAt: new Date().toISOString() };
      store.transaction(() => {
        store.put('office.files', doc.id, bytes.toString('base64'));
        store.put('office.documents', doc.id, doc);
      });
      return doc;
    }
    provide('office-documents.manage', async (args, signal) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, '请求无效');
      const { action, ...input } = args;
      if (action === 'create') return create(input, signal);
      if (action === 'inspect') {
        if (typeof input.base64 !== 'string' || !input.base64.length || input.base64.length > 16 * 1024 * 1024) fail(400, '请选择不超过 12 MiB 的办公文件');
        const bytes = Buffer.from(input.base64, 'base64');
        if (bytes.toString('base64') !== input.base64) fail(400, '文件编码无效');
        const { inspectOffice } = await import('./inspect.ts');
        try { return await inspectOffice(bytes); } catch (cause) { fail(400, cause instanceof Error ? cause.message : '无法识别办公文件'); }
      }
      if (action === 'list') return store.list<Document>('office.documents').sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      if (action !== 'download' || typeof input.id !== 'string') fail(400, '办公文件操作无效');
      const doc = store.get<Document>('office.documents', input.id);
      if (!doc) fail(404, '找不到办公文件');
      const base64 = store.get<string>('office.files', doc.id);
      if (!base64) fail(500, '办公文件内容缺失');
      return { ...doc, base64 };
    });
    contribute('tools', 'office_create', {
      name: 'office_create', description: '用户要求生成 Word 报告、PPT 演示或 Excel 表格时，传入完整内容生成可下载文件。docx 和 pptx 用 Markdown；演示可用独立行 --- 分页。xlsx 用 CSV 或 JSON 对象（sheets 每项含 name、header 和 rows，可附 formats 和 widths）。先核对数据来源。以成功回执的文件名和摘要回复，并提示可从 Web 主对话的「办公文件」下载。生成文件本身不会发送飞书附件。',
      parameters: { type: 'object', required: ['title','format','source'], additionalProperties: false, properties: {
        title: { type: 'string' }, format: { type: 'string', enum: [...officeFormats] }, source: { type: 'string' },
      } }, execute: create,
    });
  },
};
