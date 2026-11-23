type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const hasPost = (value: Row) => Array.isArray(value.content) || !!string(value.title);

// Incoming posts usually have direct paragraphs. Read-back may contain several translations.
function pickPost(value: Row): Row | undefined {
  if (hasPost(value)) return value;
  for (const key of new Set(['zh_cn', 'en_us', 'ja_jp', ...Object.keys(value)])) {
    const candidate = row(value[key]);
    if (hasPost(candidate)) return candidate;
  }
}

export function renderFeishuPost(value: Row, rawMentions: unknown, direct = false, onImage?: (key:string) => void): string {
  const post = pickPost(value);
  if (!post) return '';
  const names = new Map<string, string>();
  for (const raw of Array.isArray(rawMentions) ? rawMentions : []) {
    const mention = row(raw), id = row(mention.id), name = string(mention.name);
    if (!name) continue;
    for (const key of [mention.key, id.open_id, id.user_id, id.union_id, mention.id]) {
      if (typeof key === 'string' && key) names.set(key, name);
    }
  }
  const expandMentions = (text: string) => text.replace(/@_user_\d+/g, key => names.has(key) ? '@' + names.get(key) : key);
  const title = string(post.title);
  let plain = !title;
  function nodes(elements: unknown, depth: number): string {
    if (!Array.isArray(elements) || depth > 8) { plain = false; return '[未识别的富文本元素]'; }
    return elements.map(value => {
      const node = row(value), tag = string(node.tag), text = string(node.text);
      if (tag === 'text' && typeof node.text === 'string') return expandMentions(text);
      plain = false;
      switch (tag) {
        case 'md': return expandMentions(text);
        case 'a': return '[' + expandMentions(text) + '](' + string(node.href) + ')';
        case 'at': {
          const id = string(node.user_id);
          return '@' + (string(node.user_name) || (id === 'all' ? '所有人' : names.get(id)) || '成员');
        }
        case 'img': case 'image':
          onImage?.(string(node.image_key));
          return '[图片]';
        case 'media': return '[视频]';
        case 'file': return '[文件]';
        case 'audio': return '[语音消息]';
        case 'emotion': return '[' + (string(node.emoji_type) || '表情') + ']';
        case 'hr': return '---';
        case 'code_block': {
          let size = 3;
          for (const match of text.matchAll(/`+/g)) size = Math.max(size, match[0].length + 1);
          const fence = '`'.repeat(size), language = string(node.language).toLowerCase();
          return '\n' + fence + (/^[a-z0-9_+#.-]{1,40}$/.test(language) ? language : '') +
            '\n' + text.replace(/\n+$/, '') + '\n' + fence + '\n';
        }
        case 'note': return nodes(node.elements, depth + 1);
        case 'button': case 'select_static': return '[' + (text || string(node.placeholder) || '控件') + ']';
        default: return '[未识别的富文本元素]';
      }
    }).join('');
  }
  const lines = title ? ['**' + expandMentions(title) + '**'] : [];
  if (Array.isArray(post.content)) for (const para of post.content) lines.push(nodes(para, 0));
  const result = lines.join('\n').trim();
  // Only an owner's literal text can be a slash command. For example a note may
  // contain a single "/new" button or a slash may be adjacent to a rich label.
  return direct && !plain && /^[／/]/u.test(result) ? '[富文本]\n' + result : result;
}
