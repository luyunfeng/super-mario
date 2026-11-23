import type { Store } from '../../plugin-sdk/src/index.ts';
import { readBriefingSettings } from './briefing.ts';

export function decisionQuietNow(store: Pick<Store, 'get'>, now: Date): boolean {
  const { decisionQuietHours: quiet, timezone } = readBriefingSettings(store);
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  return quiet.start < quiet.end
    ? quiet.start <= local && local < quiet.end
    : local >= quiet.start || local < quiet.end;
}
