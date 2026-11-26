import { randomUUID } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { DeletedProjectLesson, ProjectLesson, ProjectLessonKind, ProjectLessonSource } from '../../protocol/src/project-lessons.ts';

const lessons = 'project.lessons', deleted = 'project.lessons.deleted';
const kinds: ProjectLessonKind[] = ['repeated_mistake', 'missing_context', 'wasted_step', 'improvement'];
// A lesson not taught again for this long stops being handed to new Agents. It stays listed.
const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SOURCES = 8;
const MAX_TEXT = 600;

/** One lesson as the model proposes it after a task is accepted. */
export type LessonDraft = { kind: ProjectLessonKind; text: string; sameAs?: string };

export class ProjectLessonError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ProjectLessonError'; this.status = status; }
}

export function createProjectLessons(store: Store, now: () => number = Date.now) {
  function of(projectId: string) {
    return store.list<ProjectLesson>(lessons).filter(item => item.projectId === projectId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id));
  }
  function stale(item: ProjectLesson, at: number) { return at - Date.parse(item.lastSeenAt) >= STALE_AFTER_MS; }
  function view(item: ProjectLesson, at = now()) {
    return { ...item, stale: stale(item, at), sources: item.sources.slice(0, MAX_SOURCES) };
  }
  return {
    list(projectId: string, at = now()) { return of(projectId).map(item => view(item, at)); },
    /** What a new Agent of this project is told. Stale lessons are left out. */
    instructions(projectId: string, at = now()) {
      const active = of(projectId).filter(item => !stale(item, at));
      if (!active.length) return '';
      return '这个项目已验收的任务留下以下经验，开始类似工作前先读：\n' + active.map(item => '- ' + item.text).join('\n');
    },
    /**
     * Record what one accepted task taught. A draft that repeats a live lesson adds a source
     * to it; the owner's wording is kept. A draft naming a lesson the owner deleted, or one
     * of another project, is dropped rather than revived.
     */
    learn(projectId: string, source: ProjectLessonSource, drafts: LessonDraft[], at = now()) {
      const atText = new Date(at).toISOString();
      const live = new Map(of(projectId).map(item => [item.id, item]));
      return store.transaction(() => {
        const saved: ProjectLesson[] = [];
        for (const draft of drafts) {
          const text = draft.text?.trim();
          if (!kinds.includes(draft.kind) || !text || text.length > MAX_TEXT) continue;
          if (draft.sameAs) {
            const existing = live.get(draft.sameAs);
            // Unknown ids are dropped too: they may be a deleted lesson or another project's.
            if (!existing) continue;
            const next: ProjectLesson = { ...existing, seen: existing.seen + 1, lastSeenAt: atText, stale: false,
              sources: [source, ...existing.sources.filter(item => item.todoId !== source.todoId)].slice(0, MAX_SOURCES), version: existing.version + 1 };
            store.put(lessons, next.id, next); live.set(next.id, next); saved.push(next);
            continue;
          }
          const item: ProjectLesson = { id: randomUUID(), projectId, kind: draft.kind, text, seen: 1, firstSeenAt: atText, lastSeenAt: atText,
            sources: [source], edited: false, stale: false, version: 1 };
          store.put(lessons, item.id, item); live.set(item.id, item); saved.push(item);
        }
        return saved.map(item => view(item, at));
      });
    },
    /** The owner rewrites a lesson. Its meaning is theirs from then on. */
    edit(projectId: string, id: string, text: string, version: number) {
      const item = store.get<ProjectLesson>(lessons, id);
      if (!item || item.projectId !== projectId) throw new ProjectLessonError('经验不存在', 404);
      if (item.version !== version) throw new ProjectLessonError('经验已有新版本，请重新核对', 409);
      const cleaned = text?.trim();
      if (!cleaned || cleaned.length > MAX_TEXT) throw new ProjectLessonError('经验须为 1 至 600 字');
      return store.transaction(() => {
        const next: ProjectLesson = { ...item, text: cleaned, edited: true, version: item.version + 1 };
        store.put(lessons, id, next); return view(next);
      });
    },
    /** Deleting remembers the wording, so a later round cannot teach the same thing again. */
    remove(projectId: string, id: string, version: number) {
      const item = store.get<ProjectLesson>(lessons, id);
      if (!item || item.projectId !== projectId) throw new ProjectLessonError('经验不存在', 404);
      if (item.version !== version) throw new ProjectLessonError('经验已有新版本，请重新核对', 409);
      return store.transaction(() => {
        store.remove(lessons, id);
        store.put(deleted, id, { id, projectId, text: item.text, deletedAt: new Date(now()).toISOString() } satisfies DeletedProjectLesson);
        return { id };
      });
    },
    /** Ids of live lessons the model may point at with sameAs, with their text. */
    known(projectId: string) { return of(projectId).map(({ id, text}) => ({ id, text })); },
  };
}
