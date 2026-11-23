import type { QuestionResponse } from '../../protocol/src/index.ts';
import type { Card } from './interactions.ts';
import { readQuestionResponses } from './question-responses.ts';

/** Interpret only the current owner's message. The host verifies the audience and
 * counts actionable cards before allowing an unqualified single-option reply. */
export function readRunQuestionChoice(card:Card, actorText:string, id:string, version:number, uniqueInAudience=false):QuestionResponse[] {
  if (card.id!==id || card.version!==version || card.status!=='open') {
    throw Object.assign(new Error('原卡版本或状态已变化，请查看最新问题'),{status:409});
  }
  if (card.kind!=='question' || !card.runId || card.handler!=='user' || !card.questions?.length) {
    throw Object.assign(new Error('只能向执行中的原结构化提问提交主人选择'),{status:403});
  }
  const message=actorText.trim().replace(/\r\n/g,'\n');
  const questions=card.questions;
  if (uniqueInAudience && questions.length===1 && questions[0]!.options.some(option=>option.label===message))
    return [{selected:[message]}];
  const [header,...lines]=message.split('\n');
  const expected='回答提问 '+id+' v'+version;
  if (header!==expected || !lines.length)
    throw Object.assign(new Error('请单独发送「'+expected+'」，另起一行按「1. 原选项」填写每题选择。'),{status:403});
  const answers=questions.map(()=>({selected:[] as string[]}));
  for (const line of lines) {
    const match=/^([1-4])\. (.+)$/u.exec(line);
    if (!match || Number(match[1])>questions.length) throw Object.assign(new Error('请逐行填写题号和原选项，多选可重复该题号。'),{status:400});
    answers[Number(match[1])-1]!.selected.push(match[2]!);
  }
  return readQuestionResponses(questions,answers).answers;
}
