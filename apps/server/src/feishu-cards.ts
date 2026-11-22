/** Small Card JSON 1.0 renderer, shared by workbench views and ordinary bot deliveries. */
export const cardPlain = (content: string) => ({ tag: 'plain_text', content });
export type CardButton = { label: string; route?: string; url?: string; value?: Record<string, unknown>; primary?: boolean };
export function cardWebBase(value?: string): string | undefined {
  if (!value || !URL.canParse(value)) return;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
  return url.href;
}
export function cardButtons(buttons: CardButton[], base?: string): Record<string, unknown>[] {
  const actions = buttons.flatMap(button => {
    const externalUrl = button.url && URL.canParse(button.url) && ['http:', 'https:'].includes(new URL(button.url).protocol)
      ? button.url : undefined;
    const target = button.value ? { value: button.value }
      : externalUrl ? { url: externalUrl }
      : base && button.route && /^[a-z][a-z0-9/_.~%-]*$/i.test(button.route)
        ? { url: base + '#' + button.route } : undefined;
    return target ? [{ tag: 'button', text: cardPlain(button.label), type: button.primary ? 'primary' : 'default', ...target }] : [];
  });
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < actions.length; i += 3) rows.push({ tag: 'action', actions: actions.slice(i, i + 3) });
  return rows;
}
export function extractExternalLinks(text: string, limit = 2): Array<{ label: string; url: string }> {
  const matches = text.match(/https?:\/\/[^\s<>()[\]"'，。；！？、]+/g) ?? [];
  const seen = new Set<string>();
  const links: Array<{ label: string; url: string }> = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)\]}]+$/, '');
    if (seen.has(cleaned) || !URL.canParse(cleaned)) continue;
    const parsed = new URL(cleaned);
    if (!['http:', 'https:'].includes(parsed.protocol) || ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) continue;
    seen.add(cleaned);
    const host = parsed.hostname.replace(/^www\./, '');
    const label = host.length > 16 ? `${host.slice(0, 14)}…` : host;
    links.push({ label, url: parsed.href });
    if (links.length >= limit) break;
  }
  return links;
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
  title?: string; webBase?: string; navigation?: string; route?: string; kind?: 'reply' | 'result' | 'brief' | 'notice';
} = {}): Record<string, unknown> | undefined {
  if (Buffer.byteLength(text, 'utf8') > 18000) return;
  const kind = options.kind ?? 'reply';
  const titles = { reply: '💬 Agent 回复', result: '📋 执行结果', brief: '📅 工作简报', notice: '🔔 工作提醒' };
  const body: Record<string, unknown>[] = [];
  // Render untrusted content as plain text: model output cannot introduce mentions, card buttons or HTML.
  const chars = Array.from(text);
  for (let start = 0; start < chars.length; start += 1200)
    body.push({ tag: 'div', text: cardPlain(chars.slice(start, start + 1200).join('')) });
  if (kind === 'result') {
    body.push({ tag: 'note', elements: [cardPlain('直接回复这张卡，就能继续给这个 Agent 派活 · 执行结果与待办验收分别记录，请核对实际交付。')] });
  }
  const destination = (view: 'inbox' | 'home') => options.navigation
    ? { value: { kind: 'workbench.navigate', navigation: options.navigation, view, page: 0 } }
    : { route: view };
  const externalLinks = extractExternalLinks(text, 2);
  if (externalLinks.length) {
    body.push(...cardButtons(externalLinks.map(link => ({ label: link.label, url: link.url }))));
  }
  body.push(...cardButtons([
    { label: kind === 'result' ? '打开网页版' : kind === 'brief' ? '查看完整简报' : '继续处理', route: options.route ?? (kind === 'result' ? 'projects/all/runs' : kind === 'brief' ? 'home' : 'chat'), primary: true },
    { label: '📥 收件箱', ...destination('inbox') }, { label: '🏠 工作台', ...destination('home') },
  ], cardWebBase(options.webBase)));
  const tone = kind === 'result' ? 'green' : kind === 'notice' ? 'orange' : 'blue';
  const card = cardDocument(options.title ? `${titles[kind]} · ${options.title.slice(0, 60)}` : titles[kind], body, tone);
  return Buffer.byteLength(JSON.stringify(card), 'utf8') <= 24000 ? card : undefined;
}
