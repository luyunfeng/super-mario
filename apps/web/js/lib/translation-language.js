// Use each language's own name in the picker.
export const translationLanguages = [
  ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский'], ['pt', 'Português'],
];

const latinHints = [
  ['en', 'the and are is was with this that please thanks you your we will today hello for from have can about to of', null],
  ['fr', 'le la les des dans nous vous avec pour une bonjour merci est et ce cette sont au aux du', /[œèêëàâîôùû]/g],
  ['de', 'der die das den dem ist sind mit und für nicht wir sie eine vielen danke bitte von heute', /[äöüß]/g],
  ['es', 'el la los las de que en con por para una es son gracias hola está nos del favor', /[ñ¿¡]/g],
  ['pt', 'os as de que em um uma para com obrigado obrigada você não da dos das hoje bom por', /[ãõ]/g],
].map(([language, words, accents]) => ({ language, words: new Set(words.split(' ')), accents }));

// Automatic requests need evidence of a different language. Short replies,
// product names and ambiguous Latin text remain available for manual translation.
export function needsTranslation(text, target) {
  const sample = String(text ?? '').slice(0, 1500).toLowerCase();
  const family = target.split('-')[0];
  const letters = sample.match(/\p{L}/gu) ?? [];
  if (letters.length < 6) return false;
  const count = pattern => (sample.match(pattern) ?? []).length;
  const han = count(/\p{Script=Han}/gu), kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const korean = count(/\p{Script=Hangul}/gu), russian = count(/\p{Script=Cyrillic}/gu), latin = count(/\p{Script=Latin}/gu);
  const weights = [
    [kana && kana * 10 >= han + kana ? 'ja' : 'zh', 4 * (han + kana)], ['ko', 4 * korean], ['ru', russian],
    ['latin', latin], ['other', letters.length - han - kana - korean - russian - latin],
  ];
  const [script] = weights.reduce((best, next) => next[1] > best[1] ? next : best);
  if (script !== 'latin') return script !== family;
  if (!latinHints.some(row => row.language === family)) return true;
  const words = sample.match(/\p{L}+/gu) ?? [];
  const ranked = latinHints.map(row => ({
    language: row.language,
    score: words.filter(word => row.words.has(word)).length + (row.accents ? count(row.accents) : 0),
  })).sort((a, b) => b.score - a.score);
  return ranked[0].score >= 2 && ranked[0].score > ranked[1].score && ranked[0].language !== family;
}
