/** Small Card JSON 1.0 renderer, shared by workbench views and ordinary bot deliveries. */
export const cardPlain = (content: string) => ({ tag: 'plain_text', content });
export type CardButton = { label: string; route?: string; value?: Record<string, unknown>; primary?: boolean };
export function cardWebBase(value?: string): string | undefined {
  if (!value || !URL.canParse(value)) return;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
  return url.href;
}
export function cardButtons(buttons: CardButton[], base?: string): Record<string, unknown>[] {
  const actions = buttons.flatMap(button => {
    const target = button.value ? { value: button.value } : base && button.route && /^[a-z][a-z0-9/_.~%-]*$/i.test(button.route)
      ? { url: base + '#' + button.route } : undefined;
    return target ? [{ tag: 'button', text: cardPlain(button.label), type: button.primary ? 'primary' : 'default', ...target }] : [];
  });
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < actions.length; i += 3) rows.push({ tag: 'action', actions: actions.slice(i, i + 3) });
  return rows;
}
export function cardSection(title: string, content: string): Record<string, unknown>[] {
  return [{ tag: 'div', text: { tag: 'lark_md', content: '**' + title + '**' } },
    { tag: 'div', text: cardPlain(content) }];
}
export function cardDocument(title: string, elements: Record<string, unknown>[], tone = 'blue') {
  return { config: { wide_screen_mode: true }, header: { template: tone, title: cardPlain(title) }, elements };
}

/** Formatting is computed before the single remote send; oversize content uses its original text. */
export function buildFeishuMessageCard(text: string, options: {
  title?: string; webBase?: string; route?: string; kind?: 'reply' | 'result' | 'brief' | 'notice';
} = {}): Record<string, unknown> | undefined {
  if (Buffer.byteLength(text, 'utf8') > 18000) return;
  const kind = options.kind ?? 'reply';
  const titles = { reply: '💬 Agent 回复', result: '📋 执行结果', brief: '📅 工作简报', notice: '🔔 工作提醒' };
  const body: Record<string, unknown>[] = [];
  // Render untrusted content as plain text: model output cannot introduce mentions, card buttons or HTML.
  const chars = Array.from(text);
  for (let start = 0; start < chars.length; start += 1200)
    body.push({ tag: 'div', text: cardPlain(chars.slice(start, start + 1200).join('')) });
  if (kind === 'result') body.push({ tag: 'note', elements: [cardPlain('执行结果与待办验收分别记录，请核对实际交付。')] });
  body.push(...cardButtons([
    { label: kind === 'result' ? '查看执行' : kind === 'brief' ? '查看完整简报' : '继续处理', route: options.route ?? (kind === 'result' ? 'projects/all/runs' : kind === 'brief' ? 'home' : 'chat'), primary: true },
    { label: '📥 收件箱', route: 'inbox' }, { label: '🏠 工作台', route: 'home' },
  ], cardWebBase(options.webBase)));
  const card = cardDocument(options.title ? `${titles[kind]} · ${options.title.slice(0, 60)}` : titles[kind], body, kind === 'notice' ? 'orange' : 'blue');
  return Buffer.byteLength(JSON.stringify(card), 'utf8') <= 24000 ? card : undefined;
}
