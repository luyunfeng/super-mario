import { h } from '../lib/dom.js';
const labels = { starting: '正在启动', thinking: '正在分析', tool: '正在调用工具', responding: '正在输出', waiting: '等待后续事件' };

/**
 * Live progress indicator + on-demand expandable thinking/context trace drawer.
 * Keeps message.text / message.progress clean while letting the user inspect
 * full pi thinking blocks, tool calls, and prompt distribution when expanded.
 */
export function agentProgress(message, api) {
  if (!message || message.role !== 'assistant' || message.origin === 'notification') return null;
  const progress = message.status === 'pending' ? message.progress : null;
  const inspectorHref = `/inspector.html?conversationId=${encodeURIComponent(message.conversationId || 'main')}&turnId=${encodeURIComponent(message.id)}`;

  const box = h('div', { class: 'agent-trace-box', style: { marginBottom: '6px' } });
  if (progress) {
    box.append(h('p', {
      class: 'small muted', role: 'status', dataset: { agentProgress: message.id },
      style: { overflowWrap: 'anywhere', margin: '0 0 4px' },
    }, labels[progress.phase] ?? '正在处理', progress.toolName ? ` · ${progress.toolName}` : '', progress.detail ? ` · ${progress.detail}` : ''));
  }

  if (api) {
    const body = h('div', { style: { marginTop: '6px', fontSize: 'calc(12px * var(--reading-scale, 1))', color: 'var(--text-2, #444)', background: 'var(--surface-2, #F4F2EC)', border: '1px solid var(--line, #D8D5CC)', borderRadius: '8px', padding: '8px 10px' } }, '点击展开加载思考过程与上下文分布…');
    let loaded = false;
    const loadTrace = async () => {
      try {
        const trace = await api.get(`/traces/turns/${encodeURIComponent(message.id)}`);
        loaded = true;
        body.replaceChildren();
        const used = trace.usage?.totalTokens ?? 0;
        const win = trace.contextWindow ?? 128000;
        const pct = win ? Math.min(100, Math.round((used / win) * 100)) : 0;
        body.append(h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'space-between', marginBottom: '6px', fontFamily: 'var(--mono, monospace)', fontSize: 'calc(11px * var(--reading-scale, 1))' } },
          h('span', null, `Pi · ${trace.provider}/${trace.model} · ${used} / ${win} tok (${pct}%)`),
          h('a', { href: inspectorHref, target: '_blank', rel: 'noopener', style: { color: 'var(--accent, #C75B39)', textDecoration: 'none', fontWeight: '600' } }, '打开上下文透视 ↗')));
        if (trace.runtime) {
          const rt = trace.runtime;
          const metaLines = [
            rt.endpoint ? `请求：${rt.method || 'POST'} ${rt.endpoint}` : `方式：${rt.transport}${rt.cliCommand ? ' · ' + rt.cliCommand : ''}`,
            `账号：${rt.account || 'local'}${rt.cliConfigDir ? ' · ' + rt.cliConfigDir : ''}`,
            `凭据来源：${rt.tokenSource || '未记录'}`,
          ];
          body.append(h('pre', { style: { margin: '0 0 6px', padding: '6px 8px', background: 'var(--surface, #fff)', border: '1px solid var(--line, #D8D5CC)', borderRadius: '6px', fontFamily: 'var(--mono, monospace)', fontSize: 'calc(11px * var(--reading-scale, 1))', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, metaLines.join('\n')));
        }
        if (trace.thinkingBlocks?.length) {
          for (const [idx, block] of trace.thinkingBlocks.entries()) {
            body.append(h('div', { style: { marginBottom: '6px' } },
              h('div', { style: { fontWeight: '600', marginBottom: '2px' } }, `思考过程 #${idx + 1} (${block.tokens} tok)`),
              h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '260px', overflowY: 'auto', fontSize: 'calc(12px * var(--reading-scale, 1))', fontFamily: 'inherit' } }, block.text)));
          }
        } else {
          body.append(h('p', { class: 'small muted', style: { margin: '0 0 6px' } }, '这一轮模型没输出独立 thinking 块，点右上角可以看完整系统提示词和工具分布。'));
        }
        if (trace.toolCalls?.length) {
          body.append(h('div', { style: { marginTop: '4px' } },
            h('div', { style: { fontWeight: '600', marginBottom: '2px' } }, `工具调用 (${trace.toolCalls.length})`),
            ...trace.toolCalls.map(c => h('details', { style: { fontFamily: 'var(--mono, monospace)', fontSize: 'calc(11.5px * var(--reading-scale, 1))', padding: '2px 0' } },
              h('summary', { style: { cursor: 'pointer' } }, `${c.isError ? '✖' : '✔'} ${c.name} (${c.tokens} tok)`),
              h('pre', { style: { margin: '4px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflowY: 'auto', background: 'var(--surface, #fff)', padding: '6px', borderRadius: '6px' } }, `入参：\n${c.args}\n\n返回：\n${c.result ?? '（执行中…）'}`)))));
        }
      } catch {
        body.textContent = '本条消息暂无上下文追踪记录（历史旧消息或演示回复）。';
      }
    };

    const details = h('details', {
      style: { fontSize: 'calc(12px * var(--reading-scale, 1))' },
      ontoggle: () => { if (details.open && (!loaded || message.status === 'pending')) void loadTrace(); },
    },
    h('summary', { style: { cursor: 'pointer', color: 'var(--muted, #76756F)', display: 'inline-flex', alignItems: 'center', gap: '8px' } },
      progress ? '展开思考过程与工具' : '思考过程 · 上下文详情',
      h('a', {
        href: inspectorHref, target: '_blank', rel: 'noopener',
        onclick: e => e.stopPropagation(),
        style: { color: 'var(--accent, #C75B39)', textDecoration: 'none', fontSize: 'calc(11.5px * var(--reading-scale, 1))' },
      }, '上下文分布 ↗')),
    body);
    box.append(details);
  }

  return box.childNodes.length ? box : null;
}
