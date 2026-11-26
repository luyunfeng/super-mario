// A stand-in for the codex command, for tests of what model a purpose is given. It writes down
// the model it was asked for and answers with the JSON it was asked for. It runs no model.
import { writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
// The provider first asks the command's app-server for its configuration. Answer as a real one
// would, with nothing configured, so that the preflight passes and no real CLI is involved.
if (args.includes('app-server')) {
  const readline = await import('node:readline');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    // Only a request is answered. A notification has no id, and is not answered.
    if (message.id === undefined) return;
    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
    if (message.method === 'config/read') process.stdout.write(JSON.stringify({ id: message.id, result: { config: {}, origins: {} } }) + '\n');
  });
} else {
const record = process.env.STAND_IN_RECORD;
const answerPath = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
// The model is named by -m or --model; one that is not named is the command's own default.
const at = Math.max(args.indexOf('-m'), args.indexOf('--model'));
const model = at >= 0 ? args[at + 1] : 'default';
if (record) appendFileSync(record, JSON.stringify({ model, args }) + '\n');
// The answer the provider reads is its own shape: the text, and no tool calls. A translation is
// asked for JSON with texts, and that JSON is the text.
const wantsTexts = prompt.includes('texts');
writeFileSync(answerPath, JSON.stringify({ text: wantsTexts ? JSON.stringify({ texts: ['translated by ' + model] }) : 'synthetic answer', toolCalls: [] }));
}
