import type { FeishuMention, FeishuMessageSource } from '../../../plugins/feishu.ts';
import type { Project } from '../../../packages/protocol/src/index.ts';
import type { CommandGroupMember } from '../../../packages/core/src/bot-group-policy.ts';

export type ProjectCandidate = Pick<Project, 'id' | 'name'> & { description?: string };
export type CommandClassifier = (text: string, candidates: ProjectCandidate[]) => Promise<string | undefined>;
export type CommandIdentity = { botId: string; appId: string; revision: number; ownerId: string };
export type CommandTarget = CommandIdentity & { projectId: string; openId?: string; name: string };
export type CommandRoute = {
  chatId: string; messageId: string; main: CommandIdentity; fingerprint: string;
  target?: CommandTarget; question?: string;
};
export type CommandCandidate = { project: ProjectCandidate; target: CommandTarget };

// Mention names and text placeholders are display data. Only platform IDs seen by the main app can select a bot.
function refersTo(mention: FeishuMention, member: Pick<CommandGroupMember, 'openId' | 'appId'>) {
  if (mention.appId && mention.appId !== member.appId) return false;
  if (member.openId && mention.openId && mention.openId !== member.openId) return false;
  return Boolean((mention.openId && mention.openId === member.openId) || (mention.appId && mention.appId === member.appId));
}

export async function chooseCommandTarget(text: string, source: FeishuMessageSource,
  main: CommandGroupMember, candidates: CommandCandidate[], classify?: CommandClassifier): Promise<Pick<CommandRoute, 'target' | 'question'>> {
  const clarify = { question: '请把原任务再发一次，并只 @ 一个已加入的项目机器人。' };
  const mentions = source.mentions ?? [];
  if (mentions.length) {
    const selected = mentions.map(mention => candidates.filter(candidate => refersTo(mention, candidate.target)));
    const mainOnly = mentions.every(mention => refersTo(mention, main))
      || (source.mentionedSelf && mentions.length === 1 && selected[0]?.length === 0);
    if (!mainOnly) {
      const target = selected[0]?.[0]?.target;
      if (!target || !selected.every(matches => matches.length === 1 && matches[0]!.target.botId === target.botId)) return clarify;
      return { target: { ...target, openId: target.openId ?? mentions.find(m => m.appId === target.appId)?.openId } };
    }
  }
  if (!candidates.length) return { question: '当前群没有可接收任务的项目机器人，请先同步群成员。' };
  const projects = [...new Map(candidates.map(c => [c.project.id, c.project])).values()];
  let selected: string | undefined;
  try { selected = await classify?.(text, projects); } catch { return clarify; }
  const matches = candidates.filter(candidate => candidate.project.id === selected);
  return matches.length === 1 ? { target: matches[0]!.target } : clarify;
}

// Each receiving app has its own open_id namespace. For a single @ only, the target's
// verified self-mention and the main app's copy share the platform message and placeholder.
export function createCommandMentionEvidence() {
  const recent = new Map<string, { identity: string; at: number }>();
  const waiters = new Map<string, (value?: string) => void>();
  return {
    observe(key: string, identity: string) {
      if (recent.size >= 512) recent.delete(recent.keys().next().value!);
      recent.set(key, { identity, at: Date.now() });
      waiters.get(key)?.(identity);
    },
    async find(key: string) {
      const evidence = recent.get(key);
      if (evidence && Date.now() - evidence.at < 60_000) return evidence.identity;
      return new Promise<string | undefined>(resolve => {
        const finish = (value?: string) => { clearTimeout(timer); waiters.delete(key); resolve(value); };
        const timer = setTimeout(finish, 1500);
        waiters.set(key, finish);
      });
    },
  };
}
