import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Run, Todo } from '../../protocol/src/index.ts';
import { buildProjectLessonsPrompt } from './prompts.ts';
import { createProjectLessons, type LessonDraft } from './project-lessons.ts';

/** One model call without tools. It rejects when the call fails or is cut short. */
export type LessonAsk = (text: string, signal: AbortSignal) => Promise<string>;

/** A short, public trace of what the task did, for the model that records lessons. */
export function lessonTrace(run: Run): string[] {
  const steps = run.progress?.recentSteps ?? [];
  return steps.slice(-12).map(step => String(step).slice(0, 300));
}

type ReviewState = { status: string; runId: string; evidenceVersion: string; doneWhen: string; round: number };

/**
 * Records what an accepted task taught.
 *
 * Listening keeps acceptance synchronous: a slow or failing model never delays or fails the
 * owner's decision. One acceptance is learned once: its run and evidence version identify
 * it, so a repeated event for the same acceptance does not ask the model again. A reopened
 * task that is accepted again has a new run, and is learned again.
 * Closing the host aborts the call and waits for it to settle.
 */
export function createProjectLessonLearner({ store, events, ask, demo, now = Date.now }: {
  store: Store; events: { subscribe(listener: (event: { type: string; data?: unknown }) => void): () => void };
  ask: LessonAsk; demo: boolean; now?: () => number;
}) {
  const lessons = createProjectLessons(store, now);
  /** "runId/evidenceVersion" of each acceptance already handed to the model. */
  const learned = new Set<string>();
  const running = new Set<Promise<void>>();
  const stop = new AbortController();
  let failures = 0;
  const off = events.subscribe(event => {
    if (event.type !== 'run-review.changed' || stop.signal.aborted) return;
    const todoId = (event.data as { todoId?: unknown } | undefined)?.todoId;
    if (typeof todoId !== 'string') return;
    void learn(todoId);
  });
  function track(task: Promise<void>) {
    running.add(task);
    void task.then(() => { running.delete(task); }, () => { running.delete(task); });
  }
  function learn(todoId: string) {
    const task = extractSafely(todoId);
    track(task);
    return task;
  }
  async function extractSafely(todoId: string) {
    try {
      if (!demo) await extract(todoId);
    } catch {
      // Learning is a side record and is never retried on its own. The next accepted task
      // of the project is the next chance, so a broken model cannot loop here.
      failures++;
      if (failures <= 3) console.error('项目经验提炼失败，已跳过该任务');
    }
  }
  async function extract(todoId: string) {
    const review = store.get<ReviewState>('run-reviews', todoId);
    const todo = store.get<Todo>('todos', todoId);
    // Rework and reopen also publish this event. Only an acceptance is something to learn.
    if (review?.status !== 'accepted' || !todo?.projectId) return;
    const projectId = todo.projectId;
    const run = review.runId ? store.get<Run>('runs', review.runId) : undefined;
    if (!run) return;
    const key = review.runId + '/' + review.evidenceVersion;
    // Marked before the call, so a second event for this acceptance cannot start another.
    if (learned.has(key)) return;
    learned.add(key);
    const reply = await ask(buildProjectLessonsPrompt({
      request: run.prompt.slice(0, 2000), doneWhen: review.doneWhen.slice(0, 2000), reworks: review.round,
      progress: lessonTrace(run), output: run.output.slice(0, 4000),
      known: lessons.known(projectId),
    }), stop.signal);
    // Acceptance may have been reopened while the model was thinking. Then there is nothing to learn.
    if (store.get<ReviewState>('run-reviews', todoId)?.status !== 'accepted') return;
    const drafts = parseLessonReply(reply);
    if (drafts.length) lessons.learn(projectId, { todoId, title: todo.title, runId: run.id }, drafts);
    failures = 0;
  }
  return {
    async close() {
      stop.abort();
      off();
      await Promise.allSettled([...running]);
    },
    list: lessons.list, edit: lessons.edit, remove: lessons.remove, instructions: lessons.instructions,
  };
}

/** The model's reply is data. Anything that is not a well-formed lesson is left out. */
export function parseLessonReply(text: string): LessonDraft[] {
  let value: unknown;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return []; }
  const list = (value as { lessons?: unknown } | null)?.lessons;
  if (!Array.isArray(list)) return [];
  const kinds = new Set(['repeated_mistake', 'missing_context', 'wasted_step', 'improvement']);
  return list.slice(0, 5).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { kind?: unknown; text?: unknown; sameAs?: unknown };
    if (!kinds.has(String(row.kind)) || typeof row.text !== 'string') return [];
    return [{ kind: row.kind as LessonDraft['kind'], text: row.text,
      ...(typeof row.sameAs === 'string' && row.sameAs ? { sameAs: row.sameAs } : {}) }];
  });
}
