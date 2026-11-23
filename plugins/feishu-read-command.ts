import type { FeishuMention } from './feishu.ts';

const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const command = /^[／/](?:read|读群)(?=$|\p{White_Space})([\s\S]*)$/iu;
function withoutMentions(raw: string, mentions: FeishuMention[]) {
  let text = trim(raw);
  for (;;) {
    const token = mentions.flatMap(m => [m.key, m.name && '@' + m.name]).find(key =>
      key && text.startsWith(key) && (text.length === key.length || /\p{White_Space}/u.test(text[key.length])));
    if (!token) return text;
    text = trim(text.slice(token.length));
  }
}

/** Identity comes from the SDK mention, never from a matching display name on its own. */
export function readGroupCommand(text: string, mentions: FeishuMention[] = []) {
  const match = command.exec(withoutMentions(text, mentions));
  if (!match) return;
  const addressed = command.exec(withoutMentions(text, mentions.filter(m => m.self)));
  return { task: trim(match[1]), addressed: !!addressed };
}

/** Rich posts carry at elements. An adjacent text node can start the command without a space. */
export function readGroupPost(raw: Record<string, unknown>, mentions: FeishuMention[]): string | undefined {
  const post = (Array.isArray(raw.content) ? raw : raw.zh_cn ?? raw.en_us ?? raw.ja_jp) as typeof raw | undefined;
  if (!post || !Array.isArray(post.content)) return;
  let text = typeof post.title === 'string' && trim(post.title) ? trim(post.title) + '\n' : '';
  for (const row of post.content) {
    if (!Array.isArray(row)) return;
    for (const node of row) {
      if (!node || typeof node !== 'object') return;
      if (node.tag === 'at') {
        const mention = mentions.find(m => node.user_id && (m.key === node.user_id || m.openId === node.user_id));
        if (!text.trim() && mention?.self) continue;
        text += ' @' + (mention?.name ?? '成员') + ' ';
      } else if (node.tag === 'text' || node.tag === 'a') text += typeof node.text === 'string' ? node.text : '';
      else if (node.tag === 'img' || node.tag === 'emotion') text += '[图片]';
      else return;
    }
    text += '\n';
  }
  return command.test(text.trim()) ? text.trim() : undefined;
}
