import { cardButtons, cardDocument, cardPlain, cardSection } from './feishu-cards.ts';

export type SessionList = { capturedAt: string; machines: Array<{ machineName: string; reason?: string; truncated: boolean; sessions: Array<{ executorId: string; nativeSessionId: string; cwd: string; fileModifiedAt?: string; resumable: boolean }> }> };
export function sessionCardSnapshot(result: SessionList) {
  const all = result.machines.flatMap(m => m.sessions.map(s => ({
    machine: m.machineName.slice(0,100), agent: s.executorId, id: s.nativeSessionId, cwd: s.cwd,
    time: s.fileModifiedAt ?? '', resumable: s.resumable,
  }))).sort((a,b) => b.time.localeCompare(a.time));
  return { capturedAt: result.capturedAt, total: all.length, rows: all.slice(0,100),
    warnings: result.machines.flatMap(m => m.reason || m.truncated ? [m.machineName + '：' + (m.reason || '记录已截断')] : []).slice(0,5) };
}
export type SessionCardSnapshot = ReturnType<typeof sessionCardSnapshot>;
export function sessionCard(data: SessionCardSnapshot, navigation: string, requestedPage = 0) {
  const pages = Math.max(1, Math.ceil(data.rows.length / 5));
  const page = Math.min(requestedPage, pages - 1);
  const elements: Record<string,unknown>[] = [];
  for (const row of data.rows.slice(page * 5, (page + 1) * 5)) {
    elements.push(...cardSection('原生会话', row.agent + ' · ' + row.machine + '\n' + row.cwd.slice(0,360) + '\n会话 ' + row.id + (row.time ? '\n日志更新 ' + row.time : '') +
      (row.resumable ? '\n可在工作台申请恢复' : '\n仅查看历史')));
  }
  if (!data.rows.length) elements.push(...cardSection('CLI 会话','本次没有读到会话记录。'));
  const navigate = (p:number) => ({kind:'workbench.sessions', navigation, page:p});
  elements.push(...cardButtons([
    ...(page ? [{label:'上一页',value:navigate(page-1)}] : []),
    ...(page+1 < pages ? [{label:'下一页',value:navigate(page+1)}] : []),
    {label:'返回工作台',value:{kind:'workbench.navigate',navigation,view:'home',page:0}},
  ]));
  elements.push({tag:'note',elements:[cardPlain(['第 '+(page+1)+' / '+pages+' 页 · 已发现 '+data.total+' 条，展示最近 '+data.rows.length+' 条',...data.warnings,'采集于 '+data.capturedAt+'。发送「CLI 会话」重新读取。'].join('\n'))]});
  return cardDocument('CLI 会话 · 只读历史', elements);
}
