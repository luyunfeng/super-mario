import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCalendarConflicts, fetchCalendarAgenda } from '../plugins/feishu-calendar.ts';

test('detectCalendarConflicts computes overlapping minutes and ignores declined meetings', () => {
  const conflicts = detectCalendarConflicts([
    { summary: '项目同步例会', startTime: '2026-11-21T17:30:00+08:00', endTime: '2026-11-21T18:00:00+08:00', status: 'accept' },
    { summary: '技术分享会', startTime: '2026-11-21T17:30:00+08:00', endTime: '2026-11-21T18:30:00+08:00', status: 'needs_action' },
    { summary: '已拒绝会议', startTime: '2026-11-21T17:30:00+08:00', endTime: '2026-11-21T18:00:00+08:00', status: 'declined' },
  ]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], { first: '项目同步例会', second: '技术分享会', overlapMinutes: 30 });
});

test('fetchCalendarAgenda parses agenda items, meeting urls and conflicts via injected CLI', async () => {
  const calls: string[][] = [];
  const result = await fetchCalendarAgenda({
    profile: 'test-profile',
    start: '2026-11-21T00:00:00+08:00',
    end: '2026-11-21T23:59:59+08:00',
    signal: new AbortController().signal,
    async runCLI(args) {
      calls.push(args);
      return {
        ok: true,
        data: {
          items: [
            {
              event_id: 'ev1',
              summary: '项目同步例会',
              start_time: { timestamp: '2026-11-21T17:30:00+08:00' },
              end_time: { timestamp: '2026-11-21T18:00:00+08:00' },
              self_status: 'accept',
              vchat: { meeting_url: 'https://vc.example.com/j/123456' },
            },
            {
              event_id: 'ev2',
              summary: '技术分享会',
              start_time: { timestamp: '2026-11-21T17:30:00+08:00' },
              end_time: { timestamp: '2026-11-21T18:30:00+08:00' },
              self_status: 'tentative',
            },
          ],
        },
      };
    },
  }) as { available: boolean; count: number; events: Array<{ summary: string; meetingUrl?: string }>; conflicts: Array<{ overlapMinutes: number }> };

  assert.equal(result.available, true);
  assert.equal(result.count, 2);
  assert.equal(result.events[0]!.meetingUrl, 'https://vc.example.com/j/123456');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.overlapMinutes, 30);
  assert.ok(calls[0]!.includes('calendar') && calls[0]!.includes('+agenda'));
});

test('fetchCalendarAgenda reports unavailable clearly when personal account is not configured', async () => {
  const result = await fetchCalendarAgenda({ signal: new AbortController().signal }) as { available: boolean; reason: string };
  assert.equal(result.available, false);
  assert.match(result.reason, /尚未授权/);
});
