import { createHash } from 'node:crypto';
import type { InboxItem } from '../../protocol/src/index.ts';

type Provenance = { requestOrigin: 'meeting'; sourceMessageId: string; sourceKey: string };
type Source = { input: Record<string, unknown>; provenance: Provenance };
type AddSource = (input: Record<string, unknown>, provenance: Provenance) => unknown;

// Take whole links first so an embedded document URL in a redirect query cannot qualify.
const links = /https?:\/\/[^\s<>"'`\[\]{}()，。；！？、（）【】]+/gi;
const documentURL = /^https:\/\/([a-z0-9.-]+)\/(docx|wiki)\/([A-Za-z0-9_-]{1,256})\/?(?:[?#].*)?$/i;
const officialHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)$/;

// Without a readable document, only keep text with evidence of an actual meeting discussion.
function hasMeetingContent(text: string): boolean {
  const body = text.replace(links, '').replace(/\[([^\]]*)\]\(\s*\)/g, '').trim();
  const sections = /(?:(?:会议)?(?:摘要|结论|要点)|会议内容|讨论(?:内容|要点)|决议|行动项|待办(?:事项)?|下一步|风险|阻塞|负责人|完成时间)[：:]\s*([^\n]+)(?:$|\n)|(?:^|\n)#{0,3}\s*(?:会议摘要|讨论要点|决议|行动项|待办事项|下一步)[：:]?\s*\n([^\n]+)/g;
  // A link card can contain section headings with only a “查看详情” call to action.
  const substantive = (value: string) => value.trim().length >= 3 && !/^(?:[-*·]\s*)?(?:[【\[])?(?:点击|点此|打开|查看|前往|暂无|未提供)/.test(value.trim());
  for (const match of body.matchAll(sections)) {
    if (substantive(match[1] || match[2] || '')) return true;
  }
  return /(?:会上|本次(?:会议|评审|讨论)|参会(?:人|方)|团队|双方|大家).{0,18}(?:决定|确认|同意|提出|讨论了|建议|认为|明确|反馈|达成一致).{3,}/.test(body)
    || /(?:^|[。；\n])\s*(?:决定|达成一致|确认采用|计划于|约定由|下周由).{4,}/.test(body)
    || /(?:^|\n)\s*(?:Decision|Minutes|Action items?|Next steps?|Blockers?)\s*:\s*[^\s].{5,}/i.test(body)
    || /(?:^|\n)(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s+)[^\n]{6,}/.test(body);
}

export function meetingMemorySources(item: InboxItem, trustedHosts: readonly string[] = []): Source[] {
  const sources: Source[] = [];
  const origin = item.origin;
  if (!origin?.meetingMinutes || origin.connector !== '飞书' ||
      !/^feishu:cli_[A-Za-z0-9_-]+:ou_[A-Za-z0-9_-]+$/.test(item.source) ||
      !item.thread.startsWith('feishu:message:') || !origin.chatId) return sources;
  if (origin.kind !== 'direct' && !(origin.kind === 'group' && origin.personalGroupObserved &&
      origin.senderId && typeof origin.personalGroupUserCount === 'number' &&
      origin.personalGroupUserCount > 0 && origin.personalGroupUserCount <= 50)) return sources;

  // Keep the connector envelope out of a text-only memory.
  const prefix = `[${item.last.split(':')[0]}] ${item.sender}: `;
  const text = (item.text.startsWith(prefix) ? item.text.slice(prefix.length) : item.text).trim();
  if (!text) return sources;

  const enqueue = (identity: string[], input: Record<string, unknown>) => {
    const sourceKey = createHash('sha256').update(JSON.stringify([item.source, ...identity])).digest('hex');
    sources.push({ input: { ...input, layer: 'personal' }, provenance: { requestOrigin: 'meeting', sourceMessageId: item.id, sourceKey } });
  };
  const documents = new Set<string>();
  for (const occurrence of text.matchAll(links)) {
    const link = occurrence[0];
    const match = documentURL.exec(link.replace(/[.,;!]+$/, ''));
    if (!match) continue;
    const host = match[1]!.toLowerCase();
    if (!officialHost.test(host) && !trustedHosts.some(value => value.toLowerCase() === host)) continue;
    const url = `https://${host}/${match[2]!.toLowerCase()}/${match[3]}`;
    // A URL job must have no text. Otherwise the curator would save the notification instead of reading the document.
    if (documents.has(url)) continue;
    const before = text.slice(Math.max(0, occurrence.index - 210), occurrence.index);
    const label = /\[([^\[\]\r\n]{1,200})\]\(\s*$/.exec(before)?.[1]?.trim();
    enqueue(['document', url], { url, title: label || `会议纪要文档 · ${match[3]}` });
    documents.add(url);
  }
  if (documents.size || !hasMeetingContent(text)) return sources;
  const title = /https?:\/\//i.test(text) ? '会议消息原文（所含链接未读取）' : '会议消息原文';
  // The curator accepts at most 200000 characters per source; preserve oversized messages in order.
  for (let offset = 0; offset < text.length; offset += 190000) {
    const part = text.slice(offset, offset + 190000);
    enqueue(['message', item.id, item.last, String(offset)], { text: part, title });
  }
  return sources;
}

export function enqueueMeetingMemory(items: InboxItem[], add: AddSource, trustedHosts: readonly string[] = []): void {
  const seen = new Set<string>();
  for (const item of items) {
    for (const source of meetingMemorySources(item, trustedHosts)) {
      if (seen.has(source.provenance.sourceKey)) continue;
      add(source.input, source.provenance);
      seen.add(source.provenance.sourceKey);
    }
  }
}
