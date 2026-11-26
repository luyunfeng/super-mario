/** What a project's accepted tasks taught. Handed to the project's new Agents. */
export type ProjectLessonKind = 'repeated_mistake' | 'missing_context' | 'wasted_step' | 'improvement';
export interface ProjectLessonSource { todoId: string; title?: string; runId?: string }
export interface ProjectLesson {
  id: string;
  projectId: string;
  kind: ProjectLessonKind;
  /** One or two sentences, written for an Agent that is about to start similar work. */
  text: string;
  /** How many accepted tasks taught this, counting the first. */
  seen: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** The accepted tasks that taught it, newest first. */
  sources: ProjectLessonSource[];
  /** The owner rewrote the text. Later rounds keep the owner's wording. */
  edited: boolean;
  /** Not taught for this long: no longer handed to new Agents. */
  stale: boolean;
  version: number;
}
/** Lessons the owner deleted stay remembered by meaning, so a later round does not bring them back. */
export interface DeletedProjectLesson { id: string; projectId: string; text: string; deletedAt: string }
