import type { Extension, Json, Store } from '../packages/plugin-sdk/src/index.ts';
import type { Message, Project } from '../packages/protocol/src/index.ts';

const languages = new Map([
  ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский'], ['pt', 'Português'],
]);
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function readReply(store: Store, conversationId: string, messageId: string) {
  const missing = () => fail(404, '当前对话中没有这条可翻译的回复');
  const message = store.get<Message>('messages', messageId);
  if (!message || message.conversationId !== conversationId || message.role !== 'assistant' ||
      (message.status ?? 'done') !== 'done' || (message.origin && message.origin !== 'user') || (typeof message.text !== 'string' || !message.text.trim())) return missing();
  if (conversationId !== 'main') {
    const projectId = /^project:(.+):work$/.exec(conversationId)?.[1];
    if (!projectId || (message.projectId && message.projectId !== projectId)) return missing();
    const project = store.get<Project>('projects', projectId);
    if (!project || project.archivedAt) return missing();
  }
  return message.text;
}

type Translate = (text: string, language: string, signal: AbortSignal) => Promise<string>;

export function createReplyTranslation(translate: Translate, modelRevision: () => string): Extension {
  return {
    id: 'reply-translation', name: '回复翻译', capabilities: ['conversation.reply.translate'],
    permissions: ['service.provide:reply-translation.translate', 'store.read'],
    activate(context) {
      const lifetime = new AbortController();
      // Keep a small in-memory cache across page reloads. Recheck access before
      // each hit, even when the same reply was already translated.
      const cache = new Map<string, { source: string; text: string }>();
      let cachedModel = modelRevision();
      context.defer(() => lifetime.abort());
      context.provide('reply-translation.translate', async (input: Json, request) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            typeof input.messageId !== 'string' || !input.messageId || typeof input.conversationId !== 'string' || !input.conversationId ||
            typeof input.target !== 'string' || Object.keys(input).some(k => !['messageId', 'conversationId', 'target'].includes(k)))
          fail(400, '请指定回复、所属对话和目标语言');
        const language = languages.get(input.target);
        if (!language) fail(400, '不支持这个翻译目标语言');
        const signal = AbortSignal.any([lifetime.signal, request]);
        signal.throwIfAborted();
        const source = readReply(context.store, input.conversationId, input.messageId);
        const model = modelRevision();
        if (model !== cachedModel) { cache.clear(); cachedModel = model; }
        const key = JSON.stringify([input.conversationId, input.messageId, input.target]);
        const cached = cache.get(key);
        if (cached?.source === source) return { text: cached.text };
        const text = await translate(source, language, signal);
        signal.throwIfAborted();
        // A project may be archived, or a message changed, while the model is running.
        if (readReply(context.store, input.conversationId, input.messageId) !== source)
          fail(409, '回复已更新，请重新翻译');
        if (modelRevision() !== model) fail(409, '翻译模型已改变，请重新翻译');
        if (!cache.has(key) && cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, { source, text });
        return { text };
      });
    },
  };
}
