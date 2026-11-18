import type { BotScope } from './bots.ts';

export interface WorkDecisionSource { messageId: string; createdAt: string }
/** A deliberately supplied summary, never an automatic copy of conversation history. */
export interface WorkDecision {
  id: string;
  key: string;
  text: string;
  scope: BotScope;
  version: number;
  status: 'active' | 'withdrawn';
  source: WorkDecisionSource;
  recordSource: WorkDecisionSource;
  createdAt: string;
  updatedAt: string;
}
