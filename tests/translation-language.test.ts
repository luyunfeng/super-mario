import assert from 'node:assert/strict';
import test from 'node:test';
const { needsTranslation, translationLanguages } = await import(new URL('../apps/web/js/lib/translation-language.js', import.meta.url).href);

test('自动翻译识别十种目标语言，对证据不足的短消息保留手动入口', () => {
  const examples = [
    '今天的工作已经完成。', '這次的工作已經完成。', 'Please review the report today.', 'こちらの予定を確認します。',
    '오늘 회의 내용을 확인하세요.', 'Bonjour, merci pour votre réponse.', 'Danke für die gute Nachricht.',
    'Hola, muchas gracias por el informe.', 'Спасибо за сообщение.', 'Obrigado, você tem uma mensagem.',
  ];
  for (const [i, [target]] of translationLanguages.entries()) {
    assert.equal(needsTranslation(examples[i], target), false, target);
    assert.equal(needsTranslation(target.startsWith('zh') ? examples[2] : examples[0], target), true, target);
  }
  assert.equal(needsTranslation('OK 👍 123', 'zh-Hans'), false);
  assert.equal(needsTranslation('Chromium', 'fr'), false);
  assert.equal(needsTranslation('本周 API 设计已确认。', 'zh-Hans'), false);
});
