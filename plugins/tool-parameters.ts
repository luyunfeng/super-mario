import type { JsonObject } from '../packages/protocol/src/index.ts';

const nonempty: JsonObject = { type: 'string', minLength: 1, pattern: '\\S' };
const mode: JsonObject = { type: 'string', enum: ['auto', 'suggest', 'off'] };
const handler: JsonObject = { type: 'string', enum: ['user', 'main_agent', 'supervisor', 'rules'] };
// The SDK truncates integer inputs during coercion; multipleOf keeps fractions invalid.
const minutes: JsonObject = { type: 'number', multipleOf: 1, minimum: 1, maximum: 43200 };

// Model-facing patch only; cross-field policy rules remain checked by the host.
export const taskPolicyParameters: JsonObject = {
  type: 'object', additionalProperties: false,
  description: '单任务策略覆盖，各字段可选。模型提出覆盖后计划等待用户核对，start=true也不会启动。',
  properties: {
    rules: {
      type: 'array', description: '替换规则表，id须唯一；空数组清空覆盖规则。',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'kind', 'handler'],
        description: 'rules处理者在auto模式必须提供answer；user处理者不能为off。cwdUnder须为绝对路径。',
        properties: {
          id: nonempty, kind: { type: 'string', enum: ['question', 'permission', 'plan', 'review'] },
          handler, mode, answer: nonempty, executorId: nonempty,
          cwdUnder: { ...nonempty, description: '规则匹配的绝对目录路径。' },
        },
      },
    },
    agentModes: { type: 'object', additionalProperties: false, properties: { supervisor: mode, main_agent: mode } },
    ladder: {
      type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: handler,
      description: '处理者不得重复，必须以user结束；顺序约束仍由宿主校验。',
    },
    escalateAfterMinutes: { ...minutes, description: '升级等待分钟数，1–43200的整数。' },
    userDeadlineMinutes: { ...minutes, description: '用户处理期限分钟数，1–43200的整数。' },
  },
};

export const actionProposeParameters: JsonObject = {
  type: 'object', additionalProperties: false, required: ['title', 'details', 'kind', 'params'],
  // Common names must be declared at the root for additionalProperties:false.
  properties: {
    title: nonempty, details: { type: 'string', description: '供用户核对的动作说明，允许空字符串。' },
    kind: { type: 'string', enum: ['dispatch', 'input', 'feishu-reply'] },
    params: { type: 'object' }, todoId: { ...nonempty, description: '可选，关联待办ID。' },
  },
  oneOf: [
    { properties: {
      kind: { enum: ['dispatch'] },
      params: {
        type: 'object', additionalProperties: false, required: ['prompt'],
        description: '批准后才派发。真实task模式需要doneWhen和expectMinutes；不填写executorId时由宿主自动选择。',
        properties: {
          prompt: nonempty, executorId: { ...nonempty, description: '可选，已有执行器ID。' },
          cwd: { ...nonempty, description: '执行机上已存在的绝对目录；省略时使用宿主默认目录。' },
          projectId: { ...nonempty, description: '可选，已有项目ID。' },
          todoId: { ...nonempty, description: '可选，已有待办ID；顶层todoId优先。' },
          doneWhen: { ...nonempty, description: '可验证的验收标准，真实task模式必需。' },
          expectMinutes: { type: 'number', exclusiveMinimum: 0, maximum: 10080, description: '预计分钟数，大于0且不超过10080，可为小数；真实task模式必需。' },
          executionMode: { type: 'string', enum: ['task', 'interactive'], description: '默认task；interactive允许后续交互输入。' },
          policy: taskPolicyParameters,
        },
      },
    } },
    { properties: {
      kind: { enum: ['input'] },
      params: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: {
        id: { ...nonempty, description: '已派发的交互执行记录ID。' }, text: { ...nonempty, description: '批准后向该会话提交的输入。' },
      } },
    } },
    { properties: {
      kind: { enum: ['feishu-reply'] },
      params: { type: 'object', additionalProperties: false, required: ['chatId', 'text'], properties: {
        chatId: { ...nonempty, description: '飞书目标会话ID。' }, text: { ...nonempty, description: '批准后由机器人发送的回复内容。' },
      } },
    } },
  ],
};
