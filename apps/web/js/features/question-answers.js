import { h } from '../lib/dom.js';
import { Field, TextArea } from '../ui/kit.js';

let groupSequence = 0;

export function createQuestionAnswers(questions) {
  const fields = questions.map(question => {
    const name = 'question-choice-' + ++groupSequence;
    const choices = question.options.map(option => {
      const input = h('input', { type: question.multiSelect ? 'checkbox' : 'radio', name, value: option.label });
      const label = h('label', { class: 'check' }, input, h('span', null, option.label),
        question.recommend === option.label && h('span', {class:'small muted'}, '（推荐）'));
      return { input, el: h('div', null, label, option.description && h('p', { class: 'small muted' }, option.description)) };
    });
    const free = TextArea({ rows: 2 });
    const el = h('fieldset', { class: 'stack question-field' },
      h('legend', null, question.question),
      question.header && h('span', { class: 'small muted' }, question.header),
      h('p', { class: 'small' }, question.multiSelect ? '可多选，也可填写回答。' : '可单选，也可填写回答。'),
      choices.map(choice => choice.el),
      !question.multiSelect && choices.length > 0 && h('label', { class: 'check' },
        h('input', { type: 'radio', name }), '仅填写文字'),
      Field({ label: '文字回答', control: free }));
    return { el, answer() {
      const selected = choices.filter(choice => choice.input.checked).map(choice => choice.input.value);
      const text = free.value.trim();
      return { selected, ...(text && { text }) };
    } };
  });
  const el = h('div', { class: 'stack' }, fields.map(field => field.el));
  return { el,
    answers() {
      const answers = fields.map(field => field.answer());
      return answers.every(item => item.selected.length || item.text) ? answers : undefined;
    },
    disable(disabled) { for (const field of fields) field.el.disabled = disabled; },
  };
}

export function questionDeadlineText(card) {
  if (!card.decisionDeadlineAt) return '';
  const date = new Date(card.decisionDeadlineAt);
  if (!Number.isFinite(date.getTime())) return '';
  const when = date.toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short',hour12:false});
  if (card.deadlineRemindedAt) return '已过决定截止时间 ' + when + '。这项决定仍需你亲自回答。';
  if (card.wait === false) return '决定截止时间 ' + when + '。若期间在原对话另发消息，到期将关闭提问。' + (card.reversible ? '若未另发消息或答卡，到期将采用每题的推荐选项。' : '若未另发消息或答卡，到期只提醒一次，仍需你亲自决定。');
  return '决定截止时间 ' + when + (card.reversible ? '。届时未回答，将采用每题的推荐选项。' : '。届时未回答，只提醒一次，仍需你亲自决定。');
}
