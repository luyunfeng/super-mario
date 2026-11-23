/** Multiple bot connections and versioned event mailboxes. Credentials live only in the form until submitted. */
export function createBotMailboxesUI({ api, element, getState, onChanged, showRegistration: registrationEnabled = true }) {
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const root = node('section', undefined, 'card stack bot-mailboxes');
  root.append(node('h2', '飞书机器人与事件信箱'), node('p', '每个机器人独立设置工作范围与确认要求。原有飞书配置是单独的默认连接。待发信件先存草稿，再由你确认。', 'muted'));
  const notice = node('p'); notice.setAttribute('role', 'status');
  const error = node('p'); error.setAttribute('role', 'alert');
  root.append(notice, error);
  const botList = node('div', undefined, 'stack bot-list');
  const form = node('form', undefined, 'form-grid bot-form');
  const formTitle = node('h3', '添加机器人'); form.append(formTitle);
  function field(parent, name, title, tag = 'input', required = false) {
    const label = node('label', title), input = node(tag);
    input.name = name; input.required = required; label.append(input); parent.append(label);
    return input;
  }
  function options(select, values, placeholder) {
    const value = select.value;
    const list = placeholder === undefined ? [] : [['', placeholder]];
    list.push(...values);
    // Keep the current selection visible, but do not silently select another project/bot.
    if (value && !list.some(([id]) => id === value)) list.push([value, '当前选择已不可用']);
    const signature = JSON.stringify(list);
    if (select.dataset.choices === signature) return;
    select.dataset.choices = signature;
    select.replaceChildren(...list.map(([id, title]) => { const item = node('option', title); item.value = id; return item; }));
    select.value = value || list[0]?.[0] || '';
  }
  function button(parent, title, callback) {
    const el = node('button', title, 'secondary'); el.type = 'button';
    el.addEventListener('click', callback); parent.append(el); return el;
  }
  const name = field(form, 'name', '机器人名称', 'input', true);
  const scope = field(form, 'scope', '工作范围', 'select', true);
  options(scope, [['unmarked', '未标记'], ['global', '全局'], ['project', '项目'], ['task', '待办']]);
  const project = field(form, 'projectId', '所属项目', 'select');
  const todo = field(form, 'todoId', '所属待办', 'select');
  const confirmation = field(form, 'requireConfirmation', '处理前需要人工确认'); confirmation.type = 'checkbox'; confirmation.checked = true;
  const direct = field(form, 'ownerDirectReply', '主机器人直接处理已配对主人的私聊'); direct.type = 'checkbox'; direct.parentElement.classList.add('checkbox');
  const readSettings = node('div', undefined, 'stack');
  const decisionNudge = field(readSettings, 'decisionNudgeMinutes', '待决定提醒等待时长', 'select');
  function setDecisionNudge(minutes = 60) {
    const choices = [...new Set([0, 15, 30, 60, 120, 240, 480, minutes])].sort((a, b) => a - b);
    decisionNudge.value = '';
    options(decisionNudge, choices.map(n => [String(n), n === 0 ? '关闭' : n % 60 === 0 ? (n / 60) + ' 小时' : n + ' 分钟']));
    decisionNudge.value = String(minutes);
  }
  setDecisionNudge();
  readSettings.append(node('p', '全局机器人私聊发出的提问卡，如果主人尚未作答，会在原卡下提醒一次。', 'muted'));
  const readGroup = field(readSettings, 'readGroup', '允许已配对主人在群内读群');
  readGroup.type = 'checkbox'; readGroup.parentElement.classList.add('checkbox');
  readSettings.append(node('p', '在机器人所在群明确 @ 本机器人，发送「/读群 总结本群的待办」或「/read」。结果回复在原消息下，群成员可见。此开关适用于机器人所在的所有群。', 'muted'));
  const reportDelay = field(readSettings, 'groupTaskReportDelayMinutes', '群任务回报预览时长（分钟）');
  reportDelay.type = 'number'; reportDelay.min = '0'; reportDelay.max = '60'; reportDelay.step = '1';
  reportDelay.defaultValue = '10'; reportDelay.required = true;
  readSettings.append(node('p', '群内 /ai 任务有结果后，预览期结束才向原群回报。默认 10 分钟，可设为 0 至 60 分钟。设为 0 将立即回报。', 'muted'));
  form.append(readSettings);
  const enabled = field(form, 'enabled', '启用连接'); enabled.type = 'checkbox';
  confirmation.parentElement.classList.add('checkbox'); enabled.parentElement.classList.add('checkbox');
  const appId = field(form, 'appId', '应用标识（手动接入）'); appId.autocomplete = 'off';
  const secret = field(form, 'appSecret', '应用密钥（编辑时留空保留原值）'); secret.type = 'password'; secret.autocomplete = 'new-password';
  const executor = field(form, 'executorId', '绑定执行者（可选）', 'select');
  form.append(node('p', '机器人只是渠道身份，无机器人也能执行。绑定仅保存配置，实际派发约束由后端接入。', 'muted'));
  const advanced = node('details'); advanced.append(node('summary', '群协作（默认关闭）'));
  advanced.append(node('p', '显式添加群后才开启。须先私聊配对，并在飞书配置群接收权限；此处保存配置不代表授权或收发验证通过。', 'muted'));
  const groups = node('div', undefined, 'stack'); advanced.append(groups);
  function addGroup(value = { chatId: '', mentionOnly: true, allowedSenderIds: [] }) {
    const row = node('div', undefined, 'stack card');
    field(row, 'chatId', '群 chatId', 'input', true).value = value.chatId;
    const mention = field(row, 'mentionOnly', '仅被提及时接收'); mention.type = 'checkbox'; mention.checked = value.mentionOnly;
    mention.parentElement.classList.add('checkbox');
    const members = field(row, 'allowedSenderIds', '成员 openId 白名单（逗号或换行）', 'textarea');
    members.rows = 3; members.value = value.allowedSenderIds.join('\n');
    row.append(node('p', '白名单为空时，仅允许已私聊验证的主人。', 'muted'));
    button(row, '删除此群', () => row.remove()); groups.append(row); sync();
  }
  button(advanced, '添加群', () => addGroup());
  const peers = field(advanced, 'peerBotIds', '允许协作的机器人（可多选）', 'select'); peers.multiple = true;
  advanced.append(node('p', '按机器人名称选择；只有双方都允许对方，才可发起 Agent 协作。', 'muted'));
  form.append(advanced, node('p', '扫码仅创建基础连接。机器人创建完成后，请点编辑配置执行者、群和协作对象。', 'muted'));
  const save = node('button', '保存手动接入'); save.type = 'submit'; form.append(save);
  const qrStart = button(form, '扫码添加机器人', () => submitBot(true)); qrStart.hidden = !registrationEnabled;
  const newBot = button(form, '取消编辑 / 新建', () => clearBotForm());
  const registrationView = node('div', undefined, 'stack bot-registration');
  root.append(botList, form, registrationView);

  root.append(node('h3', '事件信箱'));
  const filters = node('form', undefined, 'form-grid mailbox-filters');
  const direction = field(filters, 'direction', '收发方向', 'select'); options(direction, [['inbox', '收件'], ['outbox', '发件']]);
  const filterScope = field(filters, 'scope', '信件范围', 'select');
  options(filterScope, [['all', '全部'], ['global', '全局'], ['unmarked', '未标记'], ['project', '项目'], ['task', '待办']]);
  const filterProject = field(filters, 'projectId', '筛选项目', 'select');
  const filterBot = field(filters, 'botId', '筛选机器人', 'select');
  const status = field(filters, 'status', '信件状态', 'select');
  const statuses = { pending: '待确认', ready: '待处理', processing: '处理中', completed: '已完成', rejected: '已拒绝', failed: '失败', unknown: '结果未知' };
  options(status, Object.entries(statuses), '全部状态');
  filters.addEventListener('submit', event => event.preventDefault());
  filters.addEventListener('change', () => { if (!busy) void loadEntries(); });
  const draft = node('form', undefined, 'form-grid mailbox-draft'); draft.append(node('h3', '新建待发草稿'));
  const draftBot = field(draft, 'botId', '发送机器人', 'select', true);
  const inheritedScope = node('p', '工作范围继承所选机器人。', 'muted'); draft.append(inheritedScope);
  const target = field(draft, 'target', '接收会话', 'select', true);
  const title = field(draft, 'title', '信件标题', 'input', true);
  const text = field(draft, 'text', '完整消息', 'textarea', true); text.rows = 5;
  draft.append(node('p', '保存后状态为待确认，不会自动发送。', 'muted'));
  const createDraft = node('button', '保存待发草稿'); createDraft.type = 'submit'; draft.append(createDraft);
  const entriesView = node('div', undefined, 'stack mailbox-list'); root.append(filters, draft, entriesView); element.append(root);

  const relay = node('form', undefined, 'form-grid bot-relay'); relay.append(node('h3', 'Agent协作'));
  const relaySource = field(relay, 'sourceBotId', '来源机器人', 'select', true);
  const relayTarget = field(relay, 'targetBotId', '目标协作机器人', 'select', true);
  const relayChat = field(relay, 'relayChatId', '共同配置群（可选）', 'select');
  const relayText = field(relay, 'relayText', '完整请求文本', 'textarea', true); relayText.rows = 5;
  relay.append(node('p', '空群表示仅内部协作。后端仍会核验范围与权限；请求进入信箱不代表飞书发送成功。', 'muted'));
  const relaySubmit = node('button', '提交协作请求'); relaySubmit.type = 'submit'; relay.append(relaySubmit);
  const relayNotice = node('p'); relayNotice.setAttribute('role', 'status'); relay.append(relayNotice);
  button(relay, '只读刷新信箱核对', () => { focusRelayInbox(relayRequest?.body.targetBotId || relayTarget.value); void loadEntries(); });
  root.insertBefore(relay, entriesView);
  // An uncertain request keeps its immutable key and payload; refreshes never replay it.
  let relayRequest = null, relayLocked = false;
  let snapshot = getState?.() || {}, bots = [], entries = [], editingId = null;
  let renderedEntries = '';
  let epoch = 0, botRead = 0, entryRead = 0, busy = false, opened = false;
  let registration = null, timer, pollRead = 0, polls = 0;
  const projects = () => (snapshot.projects || []).filter(item => !item.archivedAt);
  const todos = () => (snapshot.todos || []).filter(item => !item.completedAt && (!project.value || item.projectId === project.value));
  const pathId = id => encodeURIComponent(id);
  const scopeText = value => {
    if (value?.kind === 'project') return `项目：${snapshot.projects?.find(p => p.id === value.projectId)?.name || '项目已不可用'}`;
    if (value?.kind === 'task') return `待办：${snapshot.todos?.find(t => t.id === value.todoId)?.title || '待办已不可用'}`;
    return value?.kind === 'global' ? '全局' : '未标记';
  };
  function sync() {
    for (const el of root.querySelectorAll('button, input, textarea, select')) el.disabled = busy || el.dataset.blocked === 'true';
    relaySubmit.disabled = busy || relayLocked;
    for (const input of [relaySource, relayTarget, relayChat, relayText]) input.disabled = busy || relayLocked;
    qrStart.disabled = busy || !!registration || !!editingId;
    newBot.disabled = busy || !!registration;
    save.disabled = busy || !!registration;
    // The metadata used to start onboarding remains fixed until cancellation or completion.
    if (registration) for (const el of form.querySelectorAll('input, select, textarea, button')) el.disabled = true;
  }
  function scopeFields() {
    readSettings.hidden = scope.value !== 'global';
    reportDelay.dataset.blocked = String(readSettings.hidden);
    reportDelay.disabled = readSettings.hidden || busy || !!registration;
    project.parentElement.hidden = !['project', 'task'].includes(scope.value);
    project.required = scope.value === 'project';
    todo.parentElement.hidden = scope.value !== 'task'; todo.required = scope.value === 'task';
  }
  function render(state) {
    snapshot = state || getState?.() || snapshot;
    options(project, projects().map(p => [p.id, p.name]), '请选择项目');
    options(todo, todos().map(t => [t.id, t.title]), '请选择待办');
    options(filterProject, projects().map(p => [p.id, p.name]), '全部项目');
    const choices = bots.map(b => [b.id, `${b.name}${b.enabled ? '' : '（已停用）'}`]);
    options(filterBot, choices, '全部机器人'); options(draftBot, choices, '请选择机器人');
    options(executor, (snapshot.executors || []).map(item => {
      const machine = snapshot.machines?.find(m => m.id === item.machineId);
      return [item.id, `${item.name} · ${machine?.name || '机器未知'} · ${machine?.online === false ? '离线' : !item.available ? '不可用' : machine?.online ? '在线' : '连接状态未知'}`];
    }), '不绑定执行者');
    syncPeers(); syncTargets(); syncRelay();
    inheritedScope.textContent = draftBot.value ? `工作范围：${scopeText(bots.find(b => b.id === draftBot.value)?.scope)}（继承机器人）` : '工作范围继承所选机器人。';
    scopeFields(); renderBots(); renderEntries(); sync();
  }
  scope.addEventListener('change', scopeFields);
  project.addEventListener('change', () => { todo.value = ''; options(todo, todos().map(t => [t.id, t.title]), '请选择待办'); });
  function syncPeers(selected = [...peers.selectedOptions].map(item => item.value)) {
    const choices = bots.filter(bot => bot.id !== editingId).map(bot => [bot.id, bot.name]);
    for (const id of selected) if (id !== editingId && !choices.some(([value]) => value === id)) choices.push([id, '原协作对象已不可用（可取消选择）']);
    const signature = JSON.stringify(choices);
    if (peers.dataset.choices !== signature) {
      peers.dataset.choices = signature;
      peers.replaceChildren(...choices.map(([id, title]) => { const option = node('option', title); option.value = id; return option; }));
    }
    for (const option of peers.options) option.selected = selected.includes(option.value);
  }
  const chatChoices = bot => [
    ...(bot?.replyTarget ? [[bot.replyTarget, `${bot.name}的已配对私聊`]] : []),
    ...(bot?.groupChats || []).map((group, index) => [group.chatId, `${bot.name}的配置群 ${index + 1}`]),
  ];
  function syncTargets() {
    const choices = chatChoices(bots.find(bot => bot.id === draftBot.value));
    if (!choices.some(([id]) => id === target.value)) target.value = '';
    options(target, choices, '请选择已配对私聊或配置群');
  }
  function mutualPeers(id) {
    const source = bots.find(bot => bot.id === id);
    return bots.filter(bot => bot.id !== id && source?.collaboration?.peerBotIds.includes(bot.id) && bot.collaboration?.peerBotIds.includes(id));
  }
  function commonGroups() {
    const source = bots.find(bot => bot.id === relaySource.value), targetBot = bots.find(bot => bot.id === relayTarget.value);
    return (source?.groupChats || []).filter(group => targetBot?.groupChats?.some(other => other.chatId === group.chatId));
  }
  function syncRelay() {
    if (relayLocked) return;
    if (!bots.some(bot => bot.id === relaySource.value)) relaySource.value = '';
    options(relaySource, bots.map(bot => [bot.id, bot.name]), '请选择来源机器人');
    const peers = mutualPeers(relaySource.value);
    if (!peers.some(bot => bot.id === relayTarget.value)) relayTarget.value = '';
    options(relayTarget, peers.map(bot => [bot.id, bot.name]), '请选择双向授权对象');
    const groups = commonGroups();
    if (!groups.some(group => group.chatId === relayChat.value)) relayChat.value = '';
    options(relayChat, groups.map((group, index) => [group.chatId, `共同配置群 ${index + 1}`]), '仅内部协作');
  }
  relaySource.addEventListener('change', () => { relayTarget.value = ''; relayChat.value = ''; syncRelay(); });
  relayTarget.addEventListener('change', () => { relayChat.value = ''; syncRelay(); });
  draftBot.addEventListener('change', () => { target.value = ''; render(); });
  function clearBotForm() {
    editingId = null; form.reset(); setDecisionNudge(); secret.value = ''; confirmation.checked = true;
    executor.value = ''; groups.replaceChildren(); syncPeers([]); advanced.open = false;
    formTitle.textContent = '添加机器人'; scopeFields(); sync();
  }
  function editBot(bot) {
    if (busy || registration) return;
    editingId = bot.id; syncPeers(bot.collaboration?.peerBotIds || []); groups.replaceChildren();
    for (const group of bot.groupChats || []) addGroup(group);
    advanced.open = !!bot.groupChats?.length || !!bot.collaboration?.peerBotIds.length;
    executor.value = ''; options(executor, [[bot.executorId || '', '原绑定执行者已不可用']], '不绑定执行者'); executor.value = bot.executorId || '';
    name.value = bot.name; scope.value = bot.scope.kind; setDecisionNudge(bot.decisionNudgeMinutes);
    project.value = bot.scope.projectId || ''; render(); todo.value = bot.scope.todoId || '';
    appId.value = bot.appId; secret.value = ''; confirmation.checked = bot.requireConfirmation; direct.checked = !!bot.ownerDirectReply; readGroup.checked = bot.readGroup === true; reportDelay.value = String(bot.groupTaskReportDelayMinutes ?? 10); enabled.checked = bot.enabled;
    formTitle.textContent = `编辑机器人：${bot.name}`; form.scrollIntoView({ block: 'nearest' }); sync();
  }
  const human = value => String(value || '').replace(/WebSocket/gi, '实时连接').replace(/Herdr|SSH|hook/gi, '连接服务').replace(/\bID\b|appId|botId|projectId/gi, '标识').replace(/cli_[\w]+|ou_[\w]+|oc_[\w]+/g, '（已隐藏）').replace(/知识/g, '记忆').replace(/执行机/g, '电脑').replace(/事项/g, '待办');
  function renderBots() {
    botList.replaceChildren();
    if (!bots.length) botList.append(node('p', '尚无独立机器人。可以手动接入或扫码添加。', 'muted'));
    for (const bot of bots) {
      const card = node('article', undefined, 'card bot-card'); card.dataset.botId = bot.id;
      const head = node('div', undefined, 'bot-card__head');
      const badges = node('div', undefined, 'bot-card__badges');
      badges.append(
        node('span', bot.enabled ? '已启用' : '已停用', `pill ${bot.enabled ? 'pill--ok' : ''}`),
        node('span', bot.connected ? '已连接' : '未连接', `pill ${bot.connected ? 'pill--ok' : 'pill--warn'}`),
        node('span', bot.paired ? '已配对' : '未配对', `pill ${bot.paired ? 'pill--info' : ''}`),
        node('span', scopeText(bot.scope), 'pill'),
      );
      head.append(node('h3', bot.name), badges);
      const bound = snapshot.executors?.find(item => item.id === bot.executorId);
      card.append(
        head,
        node('p', `状态：${bot.enabled ? '已启用' : '已停用'}；${bot.configured ? '凭证已配置' : '缺少凭证'}；${bot.connected ? '已连接' : '未连接'}；${bot.paired ? '已配对' : '未配对'}`),
        node('p', `工作范围：${scopeText(bot.scope)}；人工确认：${bot.requireConfirmation ? '需要' : '不需要'}`),
        node('p', `绑定执行者：${bot.executorId ? bound?.name || '原绑定已不可用（保留）' : '未绑定'}；已配置群：${bot.groupChats?.length || 0}；协作对象：${bot.collaboration?.peerBotIds.length || 0}`),
        node('p', '机器人仅为渠道身份。配置计数不代表飞书收发已通过；绑定约束直接派发与计划，协作须双方允许。', 'muted'),
      );
      if (bot.pairingCode) card.append(node('p', `配对码：${bot.pairingCode}`));
      if (bot.reason) card.append(node('p', `连接说明：${human(bot.reason)}`));
      const actions = node('div', undefined, 'bot-card__actions');
      const current = epoch;
      button(actions, '编辑', () => { if (current === epoch) editBot(bot); });
      button(actions, bot.enabled ? '停用机器人' : '启用机器人', () => { if (current === epoch) void write(`/feishu/bots/${pathId(bot.id)}`, 'PATCH', { enabled: !bot.enabled }, '已更新连接开关。'); });
      button(actions, '归档机器人', () => {
        if (current !== epoch || busy || !window.confirm(`归档机器人“${bot.name}”？此操作将移除该连接，保留信箱记录。`)) return;
        void write(`/feishu/bots/${pathId(bot.id)}`, 'DELETE', undefined, '已归档机器人。', () => { if (editingId === bot.id) clearBotForm(); });
      });
      card.append(actions);
      botList.append(card);
    }
  }
  async function loadBots(current = epoch) {
    const request = ++botRead;
    try {
      const result = await api('/feishu/bots');
      if (current !== epoch || request !== botRead) return;
      bots = result; render();
    } catch (cause) { if (current === epoch && request === botRead) error.textContent = `读取机器人失败：${human(cause.message || cause)}`; }
  }
  async function loadEntries(current = epoch) {
    const request = ++entryRead;
    const query = new URLSearchParams({ direction: direction.value, scope: filterScope.value });
    for (const [key, input] of [['projectId', filterProject], ['botId', filterBot], ['status', status]]) if (input.value) query.set(key, input.value);
    try {
      const result = await api(`/mailboxes?${query}`);
      if (current !== epoch || request !== entryRead) return;
      entries = result; renderEntries(); sync();
    } catch (cause) { if (current === epoch && request === entryRead) error.textContent = `读取信箱失败：${human(cause.message || cause)}`; }
  }
  async function load(current = epoch) { await Promise.all([loadBots(current), loadEntries(current)]); }
  async function write(path, method, body, message, success) {
    if (busy) return;
    const current = epoch; busy = true; ++botRead; ++entryRead; error.textContent = ''; notice.textContent = '正在处理…'; sync();
    try {
      const result = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (current !== epoch) return;
      success?.(result); notice.textContent = message;
      await load(current);
      if (current === epoch) {
        try { await onChanged?.(); } catch { if (current === epoch) error.textContent = '操作已接收，页面暂未同步，请检查连接状态。'; }
      }
    } catch (cause) {
      if (current === epoch) { error.textContent = `操作失败：${human(cause.message || cause)}。结果未知，未自动重试，请先核查当前状态。`; notice.textContent = ''; }
    } finally { if (current === epoch) { busy = false; sync(); } }
  }
  function submitBot(qr) {
    if (busy || registration || (qr && editingId)) return;
    if (!name.reportValidity() || !project.reportValidity() || !todo.reportValidity() || (!qr && !form.reportValidity())) return;
    const value = { kind: scope.value };
    if (scope.value === 'project' || (scope.value === 'task' && project.value)) value.projectId = project.value;
    if (scope.value === 'task') value.todoId = todo.value;
    const body = { name: name.value.trim(), scope: value, requireConfirmation: confirmation.checked, ownerDirectReply: value.kind === 'global' && direct.checked, enabled: enabled.checked };
    body.readGroup = value.kind === 'global' && readGroup.checked;
    if (!body.name) { error.textContent = '请填写机器人名称。'; return; }
    if (qr) {
      secret.value = '';
      void write('/feishu/registrations', 'POST', { name: body.name, scope: body.scope, requireConfirmation: body.requireConfirmation }, '已创建扫码接入，请完成页面提示。', result => {
        registration = result; polls = 0; showRegistration(); schedulePoll();
      }); return;
    }
    if (value.kind === 'global') {
      const minutes = reportDelay.valueAsNumber;
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) { error.textContent = '群任务回报预览时长须为 0 至 60 的整数分钟。'; return; }
      body.groupTaskReportDelayMinutes = minutes;
      body.decisionNudgeMinutes = Number(decisionNudge.value);
    }
    if (!appId.value.trim() || (!editingId && !secret.value.trim())) { error.textContent = '手动接入需要应用标识和应用密钥。'; return; }
    body.executorId = executor.value;
    body.groupChats = [...groups.children].map(row => ({
      chatId: row.querySelector('[name=chatId]').value.trim(),
      mentionOnly: row.querySelector('[name=mentionOnly]').checked,
      allowedSenderIds: [...new Set(row.querySelector('[name=allowedSenderIds]').value.split(/[,，\n]+/).map(id => id.trim()).filter(Boolean))],
    }));
    if (body.groupChats.some(group => !group.chatId)) { error.textContent = '请填写群 chatId，或删除空群。'; return; }
    body.collaboration = { peerBotIds: [...peers.selectedOptions].map(item => item.value) };
    body.appId = appId.value.trim(); if (secret.value) body.appSecret = secret.value;
    const id = editingId; secret.value = '';
    void write(id ? `/feishu/bots/${pathId(id)}` : '/feishu/bots', id ? 'PATCH' : 'POST', body, '机器人配置已保存，尚不代表飞书收发验证通过。', clearBotForm);
  }
  form.addEventListener('submit', event => { event.preventDefault(); submitBot(false); });
  draft.addEventListener('submit', event => {
    event.preventDefault(); if (!draft.reportValidity()) return;
    if (!chatChoices(bots.find(b => b.id === draftBot.value)).some(([id]) => id === target.value)) { error.textContent = '请选择此机器人的已配对私聊或明确配置群。'; return; }
    if (!bots.some(b => b.id === draftBot.value)) { error.textContent = '请选择可用的机器人记录。'; return; }
    void write('/mailboxes', 'POST', { direction: 'outbox', botId: draftBot.value, target: target.value.trim(), title: title.value.trim(), text: text.value, requiresConfirmation: true }, '草稿已保存，等待人工确认。', () => { draft.reset(); });
  });
  function focusRelayInbox(botId) {
    direction.value = 'inbox'; filterBot.value = botId; status.value = ''; filterScope.value = 'all'; filterProject.value = '';
  }
  relay.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || relayLocked || !relay.reportValidity()) return;
    if (!relayText.value.trim() || !mutualPeers(relaySource.value).some(bot => bot.id === relayTarget.value) || (relayChat.value && !commonGroups().some(group => group.chatId === relayChat.value))) {
      relayNotice.textContent = '请核对双向授权对象、共同群和请求文本。'; return;
    }
    const current = epoch;
    relayRequest = { sourceId: relaySource.value, body: { targetBotId: relayTarget.value, text: relayText.value, key: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join(''), ...(relayChat.value ? { chatId: relayChat.value } : {}) } };
    relayLocked = true; sync(); relayNotice.textContent = '正在提交协作请求…';
    try {
      const result = await api(`/feishu/bots/${pathId(relayRequest.sourceId)}/relay`, { method: 'POST', body: JSON.stringify(relayRequest.body) });
      if (current !== epoch) return;
      if (result?.status === 'unknown') { relayNotice.textContent = 'unknown：协作请求结果未知，已锁定重复提交。请只读刷新信箱核对。'; return; }
      relayNotice.textContent = '协作请求已进入目标信箱';
      relayLocked = false; relayRequest = null; relayText.value = '';
      focusRelayInbox(relayTarget.value);
      await loadEntries(current);
    } catch (cause) {
      if (current !== epoch) return;
      // The shared API may omit HTTP status. Treat those failures as uncertain too.
      if (!cause.status || cause.status >= 500 || cause.status === 408) relayNotice.textContent = 'unknown：协作请求结果未知，已锁定重复提交。请只读刷新信箱核对。';
      else { relayLocked = false; relayRequest = null; relayNotice.textContent = `协作请求未接收：${human(cause.message || cause)}`; }
    } finally { if (current === epoch) sync(); }
  });
  function renderEntries() {
    // Unchanged snapshots must not replace focused assignment forms.
    const signature = JSON.stringify([entries, snapshot.projects, snapshot.todos, bots.map(bot => [bot.id, bot.name])]);
    if (renderedEntries === signature) return;
    renderedEntries = signature;
    const assignments = new Map([...entriesView.querySelectorAll('article[data-entry-id]')].map(card => [card.dataset.entryId, { project: card.querySelector('[name=projectId]')?.value, todo: card.querySelector('[name=todoId]')?.value }]));
    entriesView.replaceChildren();
    if (!entries.length) entriesView.append(node('p', '当前筛选条件下没有信件。', 'muted'));
    for (const entry of entries) {
      const card = node('article', undefined, 'card'); card.dataset.entryId = entry.id;
      card.append(node('h3', entry.title || '未命名信件'), node('p', `${entry.direction === 'outbox' ? '发件' : '收件'} · ${bots.find(b => b.id === entry.botId)?.name || '原机器人已不可用'}`), node('p', `状态：${statuses[entry.status] || '待核查'}；版本：${entry.version}`), node('p', `工作范围：${scopeText(entry.scope)}；人工确认：${entry.requiresConfirmation ? '需要' : '不需要'}`));
      if (entry.target) card.append(node('p', '接收目标：已配对私聊或已配置群（以信件记录为准）'));
      card.append(node('p', entry.text));
      if (entry.error) card.append(node('p', `处理说明：${human(entry.error)}`));
      if (entry.resultId) card.append(node('p', '已产生处理记录'));
      const current = epoch;
      if (['pending', 'ready'].includes(entry.status)) {
        button(card, '确认此版本', () => { if (current === epoch) void write(`/mailboxes/${pathId(entry.id)}/confirm`, 'POST', { version: entry.version }, '已确认此版本，请以信件状态判断处理结果。'); });
        button(card, '拒绝此版本', () => { if (current === epoch) void write(`/mailboxes/${pathId(entry.id)}/reject`, 'POST', { version: entry.version }, '已拒绝此版本。'); });
        if (entry.scope.kind === 'unmarked') {
          button(card, '归入全局', () => { if (current === epoch) void write(`/mailboxes/${pathId(entry.id)}`, 'PATCH', { version: entry.version, scope: { kind: 'global' } }, '已归入全局，仍需确认后处理。'); });
          const assignment = node('form', undefined, 'form-grid');
          const selected = field(assignment, 'projectId', '将未标记信件归入项目', 'select', true);
          options(selected, projects().map(p => [p.id, p.name]), '请选择项目');
          if (assignments.get(entry.id)?.project) selected.value = assignments.get(entry.id).project;
          const assign = node('button', '归入项目'); assign.type = 'submit'; assignment.append(assign);
          assignment.addEventListener('submit', event => {
            event.preventDefault(); if (current !== epoch || !assignment.reportValidity()) return;
            void write(`/mailboxes/${pathId(entry.id)}`, 'PATCH', { version: entry.version, scope: { kind: 'project', projectId: selected.value } }, '已更新信件范围。');
          }); card.append(assignment);
          const taskAssignment = node('form', undefined, 'form-grid');
          const selectedTask = field(taskAssignment, 'todoId', '将未标记信件归入待办', 'select', true);
          options(selectedTask, (snapshot.todos || []).filter(item => !item.completedAt).map(item => [item.id, item.title]), '请选择待办');
          if (assignments.get(entry.id)?.todo) selectedTask.value = assignments.get(entry.id).todo;
          const assignTask = node('button', '归入待办'); assignTask.type = 'submit'; taskAssignment.append(assignTask);
          taskAssignment.addEventListener('submit', event => {
            event.preventDefault(); if (current !== epoch || !taskAssignment.reportValidity()) return;
            void write(`/mailboxes/${pathId(entry.id)}`, 'PATCH', { version: entry.version, scope: { kind: 'task', todoId: selectedTask.value } }, '已归入待办，仍需确认后处理。');
          }); card.append(taskAssignment);
        }
      }
      entriesView.append(card);
    }
  }
  const terminal = status => ['completed', 'needs_configuration', 'cancelled', 'canceled', 'failed', 'expired', 'unknown'].includes(status);
  function safeUrl(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
  function showRegistration() {
    registrationView.replaceChildren(); if (!registration) return;
    registrationView.append(node('p', '机器人创建完成后，请点编辑配置执行者、群和协作对象。', 'muted'));
    registrationView.append(node('h3', '扫码接入进度'), node('p', `状态：${({ queued: '准备中', waiting_for_scan: '等待扫码', creating_app: '创建中', configuring: '配置中', publishing: '发布中', verifying: '核验中', completed: '已创建', needs_configuration: '需要配置', cancelled: '已取消', failed: '失败', expired: '已过期', unknown: '结果未知' })[registration.status] || '等待处理'}`));
    if (registration.progress) registrationView.append(node('p', human(registration.progress)));
    if (registration.expiresAt) registrationView.append(node('p', `有效期至：${registration.expiresAt}`));
    if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(registration.qrDataUrl || '')) {
      const img = node('img'); img.src = registration.qrDataUrl; img.alt = '飞书接入二维码'; img.style.maxWidth = '100%'; registrationView.append(img);
    }
    if (registration.missingSteps?.length) for (const step of registration.missingSteps) {
      const description = node('p', human(typeof step === 'string' ? step : step.message || step.title || step.description || step.name || '请检查飞书配置'));
      const url = typeof step === 'object' && safeUrl(step.url);
      if (url) { const link = node('a', '打开配置页面（新窗口）'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; description.append(' ', link); }
      registrationView.append(description);
    }
    if (!terminal(registration.status)) {
      const id = registration.id, current = epoch;
      button(registrationView, '取消扫码接入', () => {
        if (current !== epoch) return;
        ++pollRead; clearTimeout(timer);
        void write(`/feishu/registrations/${pathId(id)}/cancel`, 'POST', {}, '已取消扫码接入。', () => { registration = null; showRegistration(); });
      });
      if (polls >= 60) registrationView.append(node('p', '已停止自动查询。可取消本次接入后重新开始。'));
    } else button(registrationView, '结束接入向导', () => { if (!busy) { registration = null; showRegistration(); sync(); } });
    sync();
  }
  function active() { return opened && !document.hidden && ['#settings', '#channels'].includes(location.hash); }
  function schedulePoll() {
    clearTimeout(timer);
    if (!registration || terminal(registration.status) || polls >= 60 || !active()) return;
    const current = epoch, id = registration.id, request = ++pollRead;
    timer = setTimeout(async () => {
      if (current !== epoch || request !== pollRead || !active() || registration?.id !== id) return;
      polls++;
      try {
        const result = await api(`/feishu/registrations/${pathId(id)}`);
        if (current !== epoch || request !== pollRead || !active() || registration?.id !== id) return;
        registration = result; showRegistration();
        if (terminal(result.status)) { await load(current); if (current === epoch) await onChanged?.(); }
      } catch (cause) { if (current === epoch && request === pollRead) error.textContent = `查询扫码进度失败：${human(cause.message || cause)}`; }
      if (current === epoch && request === pollRead) { showRegistration(); schedulePoll(); }
    }, 2000);
  }
  function activityChanged() { ++pollRead; clearTimeout(timer); if (active()) schedulePoll(); }
  async function restoreRegistration() {
    if (!registrationEnabled || registration || busy) return;
    const current = epoch;
    try {
      const jobs = await api('/feishu/registrations');
      if (current !== epoch || registration || busy || !active()) return;
      registration = jobs.find(job => !terminal(job.status)) || null;
      if (registration) { polls = 0; showRegistration(); schedulePoll(); }
    } catch (cause) { if (current === epoch) error.textContent = `读取扫码进度失败：${human(cause.message || cause)}`; }
  }
  window.addEventListener('hashchange', activityChanged); document.addEventListener('visibilitychange', activityChanged);
  render();
  return {
    open() { opened = true; render(); if (!busy) { void load(); void restoreRegistration(); } schedulePoll(); },
    update(state) { render(state); if (active() && !busy) void load(); },
    openProject(id) {
      opened = true; render();
      if (!projects().some(item => item.id === id)) return;
      filterScope.value = 'project'; filterProject.value = id;
      if (!busy && !editingId && !registration) { scope.value = 'project'; project.value = id; scopeFields(); }
      if (!busy) void load();
      root.scrollIntoView({ block: 'start' });
    },
    render,
    reset() {
      epoch++; botRead++; entryRead++; pollRead++; clearTimeout(timer);
      opened = false; busy = false; registration = null; bots = []; entries = []; snapshot = {}; renderedEntries = '';
      relayLocked = false; relayRequest = null; relay.reset(); relayNotice.textContent = '';
      for (const select of [relaySource, relayTarget, relayChat, target]) { select.replaceChildren(); delete select.dataset.choices; }
      clearBotForm(); draft.reset(); filters.reset(); registrationView.replaceChildren(); botList.replaceChildren(); entriesView.replaceChildren();
      for (const select of [project, todo, filterProject, filterBot, draftBot]) select.replaceChildren();
      error.textContent = ''; notice.textContent = ''; sync();
    },
  };
}
