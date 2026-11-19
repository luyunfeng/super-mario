import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

const stages = { executable: '安装', profile: '配置目录', version: '版本', authentication: '本地凭证' };
const codes = { 'not-configured': '未配置', missing: '未找到', 'permission-denied': '权限不足', 'profile-unavailable': '配置目录不可用', 'profile-mismatch': '配置目录不匹配', timeout: '检查超时，状态未知', 'output-limit': '输出超限，状态未知', 'execution-failed': '检查失败，状态未知', 'unrecognized-output': '无法识别结果，状态未知' };
export const unsupportedApi = error => [404, 405, 501].includes(error?.status);
export const recoveryUnavailable = '未能读取恢复状态，尚未确认此终端能否安全观察。';
export const legacyRecovery = '旧代理未报告新恢复状态，请升级执行机代理；当前沿用原有终端流程。';
export function recoverySummary(data) {
  const identity = data?.host?.identity?.state === 'known' && typeof data.host.identity.id === 'string' && data.host.identity.id.length > 0 ? '终端实例已报告' : '终端实例未知';
  const control = data?.host?.atomicControl?.state === 'supported' && typeof data.host.atomicControl.source === 'string' ? '恢复控制能力已上报，具体会话以检查结果为准。' : '重启前的终端归属尚未核验。';
  const restored = Array.isArray(data?.sessions) ? data.sessions.filter(s => s.origin === 'restored').length : 0;
  return `${identity}。${control}${restored ? `有 ${restored} 个旧绑定保留历史结果，可从 CLI 会话申请原生恢复。` : '代理在线不代表旧会话已恢复。'}`;
}

/** Only explicit clicks probe the CLI. Raw remote text is never diagnostic UI copy. */
export function agentDiagnostics({ api, machine, active }) {
  return h('div', { class: 'stack' }, ...['codex', 'claude-code', 'pi'].map(executorId => {
    const supported = machine.capabilities?.includes('executor.diagnostics');
    const result = h('div', { class: 'stack small', role: 'status' }, !supported ? '旧代理缺少诊断支持，请升级执行机代理。' : '尚未检查安装与本地凭证。');
    const button = Button({ label: '检查安装与登录', size: 'sm', disabled: !machine.online || !supported, onClick: async () => {
      if (!active()) return;
      replace(result, '正在检查安装与本地凭证…');
      try {
        const data = await api.post(`/machines/${encodeURIComponent(machine.id)}/diagnostics`, { executorId });
        if (!active()) return;
        if (data?.executorId !== executorId) { replace(result, '诊断结果不匹配，状态未知。'); return; }
        const installed = { available: '已安装', missing: '未找到', unknown: '未知' }[data.executable?.state] || '未知';
        const launcher = { available: '可用', unavailable: '不可用', unknown: '未知' }[data.launcher?.state] || '未知';
        // Only a short version identifier is safe to render; never accept arbitrary stdout as a version.
        const version = data.version?.state === 'known' && typeof data.version.value === 'string' && data.version.value.length <= 80 && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(data.version.value) ? data.version.value : '未知';
        const auth = { authenticated: '已认证（本地检查）', unauthenticated: '未认证', unknown: '未知' }[data.authentication?.state] || '未知';
        replace(result, h('dl', { class: 'kv' }, h('dt', null, '安装'), h('dd', null, installed), h('dt', null, '启动器'), h('dd', null, launcher), h('dt', null, '版本'), h('dd', null, version), h('dt', null, '本地凭证'), h('dd', null, auth)),
          (Array.isArray(data.errors) ? data.errors : []).map(e => h('p', { class: 'muted small' }, `${Object.hasOwn(stages, e?.stage) ? stages[e.stage] : '检查'}：${Object.hasOwn(codes, e?.code) ? codes[e.code] : '结果未知'}`)));
      } catch (error) {
        if (active()) replace(result, unsupportedApi(error) ? '代理缺少诊断支持，请升级执行机代理。' : '检查失败或超时，本地凭证状态未知。');
      }
    } });
    return h('section', { class: 'stack' }, h('h4', null, ({ codex: 'Codex', 'claude-code': 'Claude Code', pi: 'Pi CLI' })[executorId]), button, result);
  }), h('p', { class: 'muted small' }, '安装和 PATH 不代表已登录。本地凭证检查不证明模型调用成功。启动器和配置目录由执行机启动配置决定。'));
}
