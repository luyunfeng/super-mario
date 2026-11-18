// 用户可见文案的统一词表。技术字段与诊断日志保留原文。
export const terms = { interaction: '提问', supervision: '自动跟进', policy: '自动处理', knowledge: '记忆', artifact: '插件文件', machine: '电脑', todo: '待办', run: '执行', plan: '计划' };
export const forbiddenTerms = ['Herdr', 'SSH', 'hook', '终端宿主', '制品', 'WebSocket', ' ID', '交互卡', '分层策略', '待推进工作', '记录事项'];

// 仅用于系统标签和通知，用户原文、代码和诊断日志不改写。
export function systemText(value) {
  return String(value ?? '').replace(/交互卡/g,terms.interaction).replace(/督办/g,terms.supervision).replace(/分层策略/g,terms.policy).replace(/知识/g,terms.knowledge).replace(/制品/g,terms.artifact).replace(/执行机/g,terms.machine).replace(/事项/g,terms.todo).replace(/终端宿主/g,'终端').replace(/Herdr|SSH|WebSocket|hook/gi,'连接服务').replace(/\bCLI\b/g,'命令行').replace(/\bID\b/g,'标识');
}
