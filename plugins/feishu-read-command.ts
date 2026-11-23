import type { FeishuMention } from './feishu.ts';

const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const readCommand = /^[／/](?:read|读群)(?=$|\p{White_Space})([\s\S]*)$/iu;
const taskCommand = /^[／/]ai(?=$|\p{White_Space})([\s\S]*)$/iu;
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
function parseCommand(command: RegExp, text: string, mentions: FeishuMention[]) {
  const match = command.exec(withoutMentions(text, mentions));
  if (!match) return;
  const addressed = command.exec(withoutMentions(text, mentions.filter(m => m.self)));
  return { task: trim(match[1]), addressed: !!addressed };
}

export function topicOwnerWords(text: string, mentions: FeishuMention[] = []) {
  return withoutMentions(text, mentions.filter(m => m.self));
}

export function readGroupCommand(text: string, mentions: FeishuMention[] = []) {
  return parseCommand(readCommand, text, mentions);
}

export function groupTaskCommand(text: string, mentions: FeishuMention[] = []) {
  return parseCommand(taskCommand, text, mentions);
}

/** Enrollment commands accept leading platform mention keys or labels, even adjacent to the slash. */
export function topicGroupCommand(raw: string, mentions: FeishuMention[] = []): 'on' | 'off' | 'home' | undefined {
  const tokens = mentions.flatMap(m => [m.key ?? '', m.name ? '@' + m.name : ''])
    .filter(token => token && token !== '@').sort((a, b) => b.length - a.length);
  let text = trim(raw);
  for (;;) {
    const prefix = tokens.find(token => text.startsWith(token));
    if (!prefix) break;
    text = trim(text.slice(prefix.length));
  }
  if (!/^[／/]/u.test(text)) return;
  const words = trim(text.slice(1)).toLowerCase().split(/\p{White_Space}+/u);
  if (words.length > 2 || !['topics', '话题群'].includes(words[0])) return;
  switch (words[1]) {
    case undefined: case 'on': case '开': return 'on';
    case 'off': case '关': case '关闭': return 'off';
    case 'home': case '主群': return 'home';
  }
}

/** Rich posts carry at elements. An adjacent text node can start the command without a space. */
export function readGroupPost(raw: Record<string, unknown>, mentions: FeishuMention[],
  enabled: { readGroup?: boolean; groupTasks?: boolean; topicCommands?: boolean; topicBody?: boolean } = { readGroup: true }): string | undefined {
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
        const label = mention?.name || (node.user_id === 'all' ? '所有人' : node.user_name) || '成员';
        text += ' @' + label + ' ';
      } else if (node.tag === 'a' && (enabled.topicCommands || enabled.topicBody) && typeof node.href === 'string') {
        text += '[' + (typeof node.text === 'string' ? node.text : '') + '](' + node.href + ')';
      } else if (node.tag === 'text' || node.tag === 'a' || (enabled.topicBody && node.tag === 'md')) text += typeof node.text === 'string' ? node.text : '';
      else if (enabled.topicBody && node.tag === 'hr') text += '---';
      else if (enabled.topicBody && node.tag === 'emotion') text += '[' + (node.emoji_type || '表情') + ']';
      else if (node.tag === 'img' || node.tag === 'emotion') text += '[图片]';
      else if (enabled.topicBody && node.tag === 'code_block' && typeof node.text === 'string') {
        let size = 3;
        for (const match of node.text.matchAll(/`+/g)) size = Math.max(size, match[0].length + 1);
        const fence = '`'.repeat(size);
        text += '\n' + fence + '\n' + node.text + '\n' + fence + '\n';
      }
      else if (enabled.topicBody && (node.tag === 'file' || node.tag === 'media')) text += node.tag === 'media' ? '[视频]' : '[文件]';
      else return;
    }
    text += '\n';
  }
  const result = trim(text);
  if (enabled.topicBody || (enabled.topicCommands && topicGroupCommand(result, mentions)) ||
    (enabled.readGroup && readCommand.test(result)) || (enabled.groupTasks && taskCommand.test(result))) return result;
}
