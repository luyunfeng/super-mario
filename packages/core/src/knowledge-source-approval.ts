import { createHash } from 'node:crypto';
import type { Store, EventBus } from '../../plugin-sdk/src/index.ts';
import type { Approval, JsonObject, Project } from '../../protocol/src/index.ts';
import { stableJson } from './eventbox.ts';

export const knowledgeSourceApprovalKind = 'plugin:knowledge-local.read-source' as const;
export interface KnowledgeSourceApprovalJob {
  id: string; url?: string; layer: 'personal' | 'project'; projectId?: string;
  requestOrigin?: 'web' | 'agent'; sourceMessageId?: string;
}
type SavedJob = KnowledgeSourceApprovalJob & { status?: string };
type ReaderIdentity = { enabled: boolean; configured: boolean; key: string; ready?: boolean };
type Proposal = Pick<Approval, 'kind' | 'title' | 'details' | 'params'>;
type Options = {
  store: Store; events: EventBus;
  proposeApproval: (input: Proposal) => Approval;
  readerIdentity: () => ReaderIdentity;
  validateJob?: (job: KnowledgeSourceApprovalJob) => void;
  onApproved: (jobId: string) => void;
  onRejected?: (jobId: string, reason: string) => void;
  rejectApproval?: (id: string, version: number) => void;
};
// Coordination evidence for one existing Job/Approval, never an account-wide grant.
interface Grant {
  jobId: string; binding: string; params: JsonObject; approvalId: string;
  version: number; readerKey: string; approved: boolean; invalid?: string;
}
const collection = 'knowledge.source-approvals';
const messages: Record<string, string> = {
  AWAITING_APPROVAL: '受保护来源需要主人确认', READER_DISABLED: '受保护来源读取未开启',
  SOURCE_READER_NOT_READY: '读取账号正在核验，请稍后重试',
  MISSING_PROFILE: '请先配置来源读取账号', SOURCE_CHANGED: '来源已撤回或内容、归属已变化，请重新投放',
  SOURCE_INVALID: '来源或目标项目已失效（可能已归档），请重新投放', CONNECTION_CHANGED: '读取身份已变化，请重新投放',
  APPROVAL_INVALID: '来源审批已变化或失效，请重新投放', INVALID_CONFIG: '来源读取配置无效',
};
export class KnowledgeSourceApprovalError extends Error {
  readonly code: string;
  readonly approvalId?: string;
  constructor(code: string, approvalId?: string) {
    super(messages[code] ?? messages.SOURCE_INVALID);
    this.name = 'KnowledgeSourceApprovalError'; this.code = code;
    if (approvalId) this.approvalId = approvalId;
  }
}
function fail(code: string): never { throw new KnowledgeSourceApprovalError(code); }
function synchronous<T>(callback: () => T): T {
  if (callback.constructor.name === 'AsyncFunction') throw new TypeError('Knowledge source approval callbacks must be synchronous');
  const value = callback();
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError('Knowledge source approval callbacks must be synchronous');
  }
  return value;
}
function identityFields(job: KnowledgeSourceApprovalJob) {
  return { id: job.id, url: job.url ?? null, layer: job.layer, projectId: job.projectId ?? null,
    requestOrigin: job.requestOrigin ?? null, sourceMessageId: job.sourceMessageId ?? null };
}

/** Host wiring (server-only, never expose approve as an Agent tool):
 * - Set requestOrigin from the authenticated entry point, never Agent parameters.
 * - In the protected readSource callback call check(job) immediately before CLI,
 *   and preserve AWAITING_APPROVAL as the Job's awaiting_approval state.
 * - Route executeApproved's exact knowledgeSourceApprovalKind to approve(approval).
 *   Generic plugin {accepted:true} does not grant access. No read happens here.
 * - onApproved/onRejected must only update Store synchronously in this transaction;
 *   schedule workers after commit. Invoke sync on relevant source/config changes.
 * readerIdentity.key is a host digest of revision + actual profile/account, not a
 * profile/token. Consent neither expands OAuth scope nor proves a read succeeded.
 */
export function createKnowledgeSourceApproval(options: Options) {
  const { store, events } = options;
  for (const callback of [options.proposeApproval, options.readerIdentity, options.validateJob,
    options.onApproved, options.onRejected, options.rejectApproval]) {
    if (callback?.constructor.name === 'AsyncFunction') throw new TypeError('Knowledge source approval callbacks must be synchronous');
  }
  function reader(): ReaderIdentity {
    let value: ReaderIdentity;
    try { value = synchronous(options.readerIdentity); } catch { fail('INVALID_CONFIG'); }
    if (value?.enabled !== true) fail('READER_DISABLED');
    if (value.ready === false) fail('SOURCE_READER_NOT_READY');
    if (value.configured !== true || !value.key) fail('MISSING_PROFILE');
    if (typeof value.key !== 'string') fail('INVALID_CONFIG');
    return value;
  }
  function source(input: KnowledgeSourceApprovalJob) {
    const job = store.get<SavedJob>('knowledge.sources', input.id);
    if (!job || stableJson(identityFields(job)) !== stableJson(identityFields(input))) fail('SOURCE_CHANGED');
    if (!job.url || !['personal', 'project'].includes(job.layer) ||
        ['cancelled', 'failed', 'unknown'].includes(job.status ?? '')) fail('SOURCE_INVALID');
    try {
      const url = new URL(job.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('SOURCE_INVALID');
    } catch { fail('SOURCE_INVALID'); }
    if (job.layer === 'personal' && job.projectId) fail('SOURCE_INVALID');
    if (job.layer === 'project') {
      const project = job.projectId && store.get<Project>('projects', job.projectId);
      if (!project || project.id !== job.projectId || project.archivedAt) fail('SOURCE_INVALID');
    }
    // Snapshot all message evidence except lifecycle fields. role/readOnly/origin
    // are evidence only: a reflected user role can NEVER approve an Agent job.
    let evidence: unknown = null;
    if (job.sourceMessageId) {
      const message = store.get<Record<string, unknown>>('messages', job.sourceMessageId);
      if (!message || message.id !== job.sourceMessageId) fail('SOURCE_CHANGED');
      const { status: _status, updatedAt: _updatedAt, ...content } = message;
      evidence = content;
    }
    try { synchronous(() => options.validateJob?.(structuredClone(job))); }
    catch { fail('SOURCE_INVALID'); }
    const binding = createHash('sha256').update(stableJson({ job: identityFields(job), evidence })).digest('hex');
    return { job, binding };
  }
  function params(job: KnowledgeSourceApprovalJob, key: string): JsonObject {
    return { jobId: job.id, url: job.url!, layer: job.layer,
      ...(job.projectId ? { projectId: job.projectId } : {}),
      ...(job.sourceMessageId ? { sourceMessageId: job.sourceMessageId } : {}), readerKey: key };
  }
  function matching(row: Grant, approval: Approval | undefined): approval is Approval {
    return !!approval && approval.id === row.approvalId && approval.version === row.version &&
      approval.kind === knowledgeSourceApprovalKind && stableJson(approval.params) === stableJson(row.params);
  }
  function invalidReason(row: Grant): string | undefined {
    if (row.invalid) return row.invalid;
    try {
      if (reader().key !== row.readerKey) return 'CONNECTION_CHANGED';
      const input = { id: row.jobId, url: row.params.url, layer: row.params.layer,
        projectId: row.params.projectId, sourceMessageId: row.params.sourceMessageId };
      const job = store.get<SavedJob>('knowledge.sources', row.jobId);
      if (!job || job.url !== input.url || job.layer !== input.layer ||
          job.projectId !== input.projectId || job.sourceMessageId !== input.sourceMessageId ||
          source(job).binding !== row.binding) return 'SOURCE_CHANGED';
      const approval = store.get<Approval>('approvals', row.approvalId);
      if (!matching(row, approval) || !['pending', 'running', 'completed'].includes(approval.status) ||
          (row.approved ? approval.status === 'pending' : approval.status === 'completed')) return 'APPROVAL_INVALID';
    } catch (error) {
      return error instanceof KnowledgeSourceApprovalError && error.code === 'SOURCE_READER_NOT_READY' ? undefined : error instanceof KnowledgeSourceApprovalError ? error.code : 'SOURCE_INVALID';
    }
  }
  function invalidate(row: Grant, reason: string) {
    if (row.invalid) return;
    store.put(collection, row.jobId, { ...row, invalid: reason });
    // Publish only identifiers and safe reason codes, never URL/message/account.
    events.publish('knowledge.source-approval.invalidated', { jobId: row.jobId, approvalId: row.approvalId, reason });
    synchronous(() => options.onRejected?.(row.jobId, reason));
    const approval = store.get<Approval>('approvals', row.approvalId);
    if (matching(row, approval) && approval.status === 'pending') {
      synchronous(() => options.rejectApproval?.(approval.id, approval.version));
    }
  }
  return {
    check(input: KnowledgeSourceApprovalJob): void {
      const error = store.transaction(() => {
        const row = store.get<Grant>(collection, input.id);
        if (row) {
          const reason = invalidReason(row);
          if (reason) { invalidate(row, reason); return new KnowledgeSourceApprovalError(reason); }
        }
        const current = source(input), identity = reader();
        // Only the host-authenticated direct Web/API path carries this intent.
        if (current.job.requestOrigin === 'web') return;
        if (row?.approved) return;
        if (row) return new KnowledgeSourceApprovalError('AWAITING_APPROVAL', row.approvalId);
        const publicParams = params(current.job, identity.key);
        const approval = synchronous(() => options.proposeApproval({ kind: knowledgeSourceApprovalKind,
          title: '读取受保护知识来源', details: '仅确认此任务、链接、归属和当前读取身份；不扩大账号权限，也不代表读取成功。', params: structuredClone(publicParams) }));
        const saved = store.get<Approval>('approvals', approval.id);
        const next: Grant = { jobId: current.job.id, binding: current.binding, params: publicParams,
          approvalId: approval.id, version: approval.version, readerKey: identity.key, approved: false };
        if (!matching(next, saved) || saved.status !== 'pending') fail('APPROVAL_INVALID');
        store.put(collection, next.jobId, next);
        return new KnowledgeSourceApprovalError('AWAITING_APPROVAL', approval.id);
      });
      // Awaiting/invalid state must commit, rather than rolling back the proposal.
      if (error) throw error;
    },
    approve(approval: Approval): void {
      const error = store.transaction(() => {
        const jobId = approval.params?.jobId;
        const row = typeof jobId === 'string' ? store.get<Grant>(collection, jobId) : undefined;
        const saved = store.get<Approval>('approvals', approval.id);
        if (!row || !matching(row, approval) || !matching(row, saved) ||
            approval.status !== 'running' || saved.status !== 'running') fail('APPROVAL_INVALID');
        reader();
        const reason = invalidReason(row);
        if (reason) { invalidate(row, reason); return new KnowledgeSourceApprovalError(reason); }
        if (row.approved) return;
        store.put(collection, row.jobId, { ...row, approved: true });
        synchronous(() => options.onApproved(row.jobId));
      });
      if (error) throw error;
    },
    sync(): void {
      const identity = synchronous(options.readerIdentity);
      if (identity.enabled && identity.ready === false) return;
      store.transaction(() => {
        for (const row of store.list<Grant>(collection)) {
          const reason = invalidReason(row);
          if (reason) invalidate(row, reason);
        }
      });
    },
  };
}
