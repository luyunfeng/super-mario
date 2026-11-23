import type { QuestionItem, QuestionResponse } from '../../protocol/src/index.ts';

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

function fields(input: unknown, allowed: string[], name: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)))
    invalid(name + '字段无效');
  return input as Record<string, unknown>;
}
function bounded(value: unknown, limit: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > limit)
    invalid(name + '须为 1 到 ' + limit + ' 字的文本');
  return value.trim();
}
function unique(values: string[], name: string) {
  if (new Set(values).size !== values.length) invalid(name + '不能重复');
}

export function questionItems(value: unknown): QuestionItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) invalid('一张问题卡须包含 1 到 4 题');
  const items = value.map(raw => {
    const row = fields(raw, ['question','header','multiSelect','options'], '问题');
    const question = bounded(row.question, 500, '题目');
    if (row.multiSelect !== undefined && typeof row.multiSelect !== 'boolean') invalid('multiSelect 须为布尔值');
    if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 4) invalid('每题须提供 2 到 4 个选项');
    const options = row.options.map(rawOption => {
      const option = fields(rawOption, ['label','description'], '选项');
      return { label: bounded(option.label, 60, '选项名称'),
        ...(option.description !== undefined && {description: bounded(option.description, 120, '选项说明')}) };
    });
    unique(options.map(option => option.label), '同题选项');
    return { question, options, ...(row.header !== undefined && {header: bounded(row.header, 12, '题目短标题')}),
      ...(typeof row.multiSelect === 'boolean' && {multiSelect: row.multiSelect}) };
  });
  unique(items.map(item => item.question), '题目');
  return items;
}

export function readQuestionResponses(questions: QuestionItem[], value: unknown): {answers: QuestionResponse[]; text: string} {
  if (!Array.isArray(value) || value.length !== questions.length) invalid('请按顺序回答全部问题');
  const answers = questions.map((question, index) => {
    const row = fields(value[index], ['selected','text'], '回答');
    if (!Array.isArray(row.selected) || row.selected.length > question.options.length ||
        row.selected.some(label => typeof label !== 'string' || !question.options.some(option => option.label === label)))
      invalid('只能选择原问题列出的选项');
    const selected = row.selected as string[];
    unique(selected, '所选选项');
    if (!question.multiSelect && selected.length > 1) invalid('这道题只能选择一项');
    if (row.text !== undefined && typeof row.text !== 'string') invalid('自填回答须为文本');
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (Array.from(text).length > 4000) invalid('每题自填回答最多 4000 字');
    if (!selected.length && !text) invalid('每题至少需要一项选择或自填回答');
    // Selection order carries no meaning. A retry with reversed checkboxes has the same receipt.
    return {selected: question.options.map(option => option.label).filter(label => selected.includes(label)), ...(text && {text})};
  });
  const text = answers.map((answer, index) => [
    questions[index]!.question,
    ...(answer.selected.length ? ['选择：' + answer.selected.join('、')] : []),
    ...(answer.text ? ['自填回答：' + answer.text] : []),
  ].join('\n')).join('\n\n');
  return {answers, text};
}

/** Preserve labels and multiline free text as separate evidence in a resumed conversation. */
export function questionEvidence(questions: QuestionItem[], answers: QuestionResponse[]) {
  return questions.map((question, index) => {
    const answer = answers[index]!;
    return {问题: question.question, 已选: answer.selected, ...(answer.text && {补充: answer.text})};
  });
}
