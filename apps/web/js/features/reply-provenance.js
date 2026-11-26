// What a reply says of where it came from: which model gave it, and what the exchange used.
// A conversation can have its model changed partway through; each reply keeps the model that
// gave it, and the page marks the place where the model changed.

/** The model of a reply as a person reads it, or nothing when the reply does not say. */
export function replyModel(message) {
  const model = message?.model;
  if (!model || typeof model.model !== 'string' || !model.model) return '';
  return typeof model.provider === 'string' && model.provider && model.provider !== model.model ? model.provider + ' / ' + model.model : model.model;
}

/** Whether this reply is where the model changed: it is the first reply in the conversation, or
 *  the one before it was given by another model. */
export function modelChangedAt(message, previous) {
  const model = replyModel(message);
  if (!model) return false;
  return replyModel(previous) !== model;
}

/** A number of tokens as a person reads it: 1234 is 1,234, and 123456 is 123k. */
export function tokenText(count) {
  if (!Number.isSafeInteger(count) || count < 0) return '';
  return count >= 10000 ? Math.round(count / 1000) + 'k' : count.toLocaleString('zh-CN');
}

/** What the exchange used, in a few words, or nothing when the model did not say. */
export function usageText(message) {
  const usage = message?.usage;
  if (!usage || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens <= 0) return '';
  const parts = ['输入 ' + tokenText(usage.input), '输出 ' + tokenText(usage.output)];
  // The cache is worth a word only when something was read from it: it is what made the turn cheap.
  if (Number.isSafeInteger(usage.cacheRead) && usage.cacheRead > 0) parts.push('缓存读取 ' + tokenText(usage.cacheRead));
  return parts.join(' · ');
}

/** What goes under a reply: the model when it changed here, and what the exchange used. */
export function provenance(message, previous) {
  const model = replyModel(message);
  const usage = usageText(message);
  return {
    changed: modelChangedAt(message, previous),
    model: model ? (modelChangedAt(message, previous) && previous ? '切换到 ' + model : model) : '',
    usage,
  };
}
