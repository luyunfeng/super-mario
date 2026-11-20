import { cardButtons, cardDocument, cardPlain, cardSection } from './feishu-cards.ts';

export type SessionList = { capturedAt: string; machines: Array<{ machineId?: string; machineName: string; reason?: string; truncated: boolean; sessions: Array<{ executorId: string; nativeSessionId: string; cwd: string; fileModifiedAt?: string; resumable: boolean }> }> };
export function sessionCardSnapshot(result: SessionList) {
  const all = result.machines.flatMap(m => m.sessions.map(s => ({
    machineId: m.machineId, machine: m.machineName.slice(0,100), agent: s.executorId, id: s.nativeSessionId, cwd: s.cwd,
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
  for (const [offset, row] of data.rows.slice(page * 5, (page + 1) * 5).entries()) {
    elements.push(...cardSection('原生会话', row.agent + ' · ' + row.machine + '\n' + row.cwd.slice(0,360) + '\n会话 ' + row.id + (row.time ? '\n日志更新 ' + row.time : '') +
      (row.resumable ? '\n支持申请恢复' : '\n仅查看历史')));
    if (row.resumable && row.machineId) elements.push(...cardButtons([{label:'申请恢复', value:{
      kind:'workbench.resumeForm', navigation, index: page * 5 + offset,
    }}]));
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

export function resumeForm(row: SessionCardSnapshot['rows'][number], navigation: string, index: number) {
  const field = (name: string, label: string) => ({
    tag: 'input', name, required: true, label_position: 'top', width: 'fill', max_length: 1000, label: cardPlain(label), placeholder: cardPlain(label),
  });
  return {
    schema: '2.0', header: {template:'blue', title:cardPlain('申请恢复 CLI 会话')},
    body: {elements:[
      {tag:'div', text:cardPlain([row.machine, row.agent, row.cwd, row.id].join('\n'))},
      {tag:'form', name:'resume', elements:[
        field('prompt','希望继续做什么？'), field('doneWhen','怎样判断完成？'),
        field('minutes','预计需要多少分钟？'), field('stopped','确认原终端任务已停止后，输入「已停止」'),
        {tag:'button', name:'submit_resume', text:cardPlain('提交审批申请'), type:'primary', form_action_type:'submit',
          behaviors:[{type:'callback', value:{kind:'workbench.resumeSubmit',navigation,index}}]},
      ]},
      {tag:'button',text:cardPlain('返回会话列表'),behaviors:[{type:'callback',value:{kind:'workbench.sessions',navigation,page:Math.floor(index / 5)}}]},
    ]},
  };
}
