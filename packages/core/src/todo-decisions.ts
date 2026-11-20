import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Run, Todo } from '../../protocol/src/index.ts';
import type { createWorkDecisionService } from './work-decision-service.ts';
import type { WorkDecision } from './work-decisions.ts';
import { randomUUID } from 'node:crypto';
import type { Card } from './interactions.ts';

type Decision = { id: string; text: string; source: 'manual' | 'answer'; sourceId?: string; active: boolean };
type Ledger = ReturnType<typeof createWorkDecisionService>;
const withdrawals = 'todo.decision-answer-withdrawals';

function manual(fact: WorkDecision): Decision {
  return { id: fact.id, text: fact.text, source: 'manual', sourceId: fact.source.messageId, active: fact.status === 'active' };
}

// Interaction cards have free-form questions and answers, with no credential field type.
// Exclude credential prompts even when their answer is just an unrecognisable short string.
const credential = /密码|口令|验证码|校验码|动态码|密钥|秘钥|私钥|令牌|凭[据证]|助记词|恢复码|password|passwd|passphrase|passcode|credential|secret|api[ _-]?key|private[ _-]?key|access[ _-]?key|token|bearer\s|cookie|one[ -]time[ -](?:code|pin)|verification[ -]code|\b(?:otp|totp|2fa|mfa|pin)\b|-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]{8,}|\bAKIA[A-Z0-9]{16}\b/i;

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

export function createTodoDecisions(store: Store, workDecisions: Ledger) {
  function readTodo(todoId: string) {
    return store.get<Todo>('todos', todoId) ?? fail('待办不存在', 404);
  }

  function facts(todo: Todo) {
    const page = workDecisions.list({ todoId: todo.id, projectId: todo.projectId });
    if (!page.truncated) return page.items;
    // The ledger's generic UI page caps at 100. Validate each extra fact through the same ledger.
    const seen = new Set(page.items.map(fact => fact.id));
    const rest = store.list<WorkDecision>('work.decisions').filter(fact => fact.scope.kind === 'task' &&
      fact.scope.todoId === todo.id && fact.scope.projectId === todo.projectId && !seen.has(fact.id));
    return page.items.concat(rest.map(fact => workDecisions.ledger.get(fact.id)!));
  }

  const withdrawalKey = (todo: Todo, cardId: string) => JSON.stringify([todo.id, todo.projectId ?? null, cardId]);
  function list(todoId: string): Decision[] {
    const todo = readTodo(todoId);
    const runs = new Set(store.list<Run>('runs')
      .filter(run => run.todoId === todoId && run.projectId === todo.projectId).map(run => run.id));
    const decisions = facts(todo).map(manual);
    for (const card of store.list<Card>('interactions')) {
      // user_chat is authored by the model's answer tool. Only a direct user answer is evidence.
      if (card.kind !== 'question' || !card.runId || !runs.has(card.runId) || card.projectId !== todo.projectId ||
          card.status !== 'answered' || card.answeredBy !== 'user' || !card.answer?.trim()) continue;
      // The deadline limits answering. An answer recorded in time remains a historical decision.
      if (!(Date.parse(card.answeredAt ?? '') < Date.parse(card.expiresAt))) continue;
      if ([card.title, card.body, card.answer].some(value => credential.test(value))) continue;
      decisions.push({ id: 'answer:' + card.id, text: card.title + '：' + card.answer.trim(),
        source: 'answer', sourceId: card.id, active: !store.get(withdrawals, withdrawalKey(todo, card.id)) });
    }
    return decisions;
  }

  return {
    list,
    add(todoId: string, text: unknown): Decision {
      return store.transaction(() => {
        const todo = readTodo(todoId);
        if (typeof text !== 'string' || !text.trim()) fail('决定内容必须为非空文本', 400);
        const value = text.trim();
        const existing = facts(todo).find(fact => fact.status === 'active' && fact.text === value);
        if (existing) return manual(existing);
        return manual(workDecisions.recordFromWeb({ todoId, projectId: todo.projectId, key: randomUUID(), text: value }));
      });
    },
    withdraw(todoId: string, id: string): Decision {
      return store.transaction(() => {
        const todo = readTodo(todoId);
        if (!id.startsWith('answer:')) {
          const fact = facts(todo).find(item => item.id === id);
          if (!fact) fail('待办决定不存在', 404);
          return fact.status === 'active' ? manual(workDecisions.changeFromWeb({ id, version: fact.version }, true)) : manual(fact);
        }
        const answer = list(todoId).find(item => item.id === id);
        if (!answer?.sourceId) fail('待办决定不存在', 404);
        if (answer.active) store.put(withdrawals, withdrawalKey(todo, answer.sourceId), true);
        return { ...answer, active: false };
      });
    },
    context(todoId: string): string {
      const sourcesByText = new Map<string, string[]>();
      for (const decision of list(todoId)) {
        if (!decision.active) continue;
        const source = decision.source === 'answer' ? `问答卡 ${decision.sourceId}` : `工作决定 ${decision.id}，来源消息 ${decision.sourceId}`;
        const sources = sourcesByText.get(decision.text);
        if (sources) sources.push(source);
        else sourcesByText.set(decision.text, [source]);
      }
      const lines = [...sourcesByText].map(([text, sources]) => `- [${sources.join('；')}] ${text}`);
      return lines.length ? '待办已确认的决定：\n' + lines.join('\n') : '';
    },
  };
}
