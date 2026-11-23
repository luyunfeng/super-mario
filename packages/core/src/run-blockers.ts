import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, Run } from '../../protocol/src/index.ts';
import type { Card } from './interactions.ts';
import type { RunBlocker } from '../../protocol/src/execution-progress.ts';

type ScopedRequest = { projectId?: unknown; todoId?: unknown; request: RunBlocker };

/** Build the index only when a visible run needs it. Share one snapshot across a batch of runs. */
export function readRunBlockers(store: Store) {
  let byRun: Map<string, ScopedRequest[]> | undefined;
  return (run: Run) => {
    if (!byRun) {
      const index = new Map<string, ScopedRequest[]>();
      const add = (id: unknown, projectId: unknown, todoId: unknown, request: RunBlocker) => {
        if (typeof id !== 'string') return;
        const requests = index.get(id) ?? [];
        requests.push({ projectId, todoId, request });
        index.set(id, requests);
      };
      for (const card of store.list<Card>('interactions')) {
        if (card.status !== 'open' || card.handler !== 'user') continue;
        const { id, title, kind, createdAt, version } = card;
        add(card.runId, card.projectId, undefined, { id, title, kind, createdAt, version, href: '#chat?interaction=' + encodeURIComponent(id) });
      }
      for (const approval of store.list<Approval>('approvals').sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))) {
        if (approval.status !== 'pending' || !approval.params) continue;
        const { id, title, createdAt, version, params } = approval;
        const runId = approval.kind === 'input' ? params.id ?? params.runId : params.runId;
        if (params.runId !== undefined && params.runId !== runId) continue;
        if (approval.todoId !== undefined && params.todoId !== undefined && approval.todoId !== params.todoId) continue;
        add(runId, params.projectId, approval.todoId ?? params.todoId, { id, title, createdAt, version, kind: 'approval', href: '#chat?approval=' + encodeURIComponent(id) });
      }
      byRun = index;
    }
    return (byRun.get(run.id) ?? []).filter(item => (item.projectId === undefined || item.projectId === run.projectId) &&
      (item.todoId === undefined || item.todoId === run.todoId)).map(item => item.request);
  };
}
