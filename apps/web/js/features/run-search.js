// Search current execution facts. A query definition contains no cached results.
const dimensions = new Map([
  ['machine', 'machine'], ['host', 'machine'],
  ['project', 'project'], ['repo', 'project'], ['cwd', 'project'], ['path', 'project'],
  ['agent', 'agent'], ['harness', 'agent'], ['launcher', 'agent'],
  ['state', 'state'], ['status', 'state'],
]);
const windows = new Map([['24h', 1], ['7d', 7], ['30d', 30]]);
const states = new Set(['queued', 'running', 'completed', 'failed', 'unknown', 'cancelled']);
const lower = (...parts) => parts.filter(Boolean).join('\n').toLowerCase();

export function searchRunHits(query, snapshot, now = Date.now()) {
  const terms = [];
  const filters = new Map();
  let since;
  for (const word of query.trim().toLowerCase().split(/\s+/)) {
    const colon = word.indexOf(':');
    const key = word.slice(0, colon);
    const value = word.slice(colon + 1);
    const field = dimensions.get(key);
    if (colon > 0 && ['since', 'after', 'updated'].includes(key) && windows.has(value)) {
      since = now - windows.get(value) * 86400000;
    } else if (colon > 0 && field && value && (field !== 'state' || states.has(value) || value === 'working')) {
      if (!filters.has(field)) filters.set(field, []);
      filters.get(field).push(field === 'state' && value === 'working' ? 'running' : value);
    } else if (word) terms.push(word);
  }
  const names = items => new Map((items ?? []).map(item => [item.id, item.name]));
  const machines = names(snapshot.machines);
  const projects = names(snapshot.projects);
  const executors = names(snapshot.executors);
  const phrase = terms.join(' ');
  const conditions = [...filters];
  const patterns = terms.map(term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));
  const hits = [];
  for (const run of snapshot.runs ?? []) {
    if (since !== undefined && !(Date.parse(run.updatedAt) >= since)) continue;
    const fields = {
      machine: lower(run.machineId, machines.get(run.machineId)),
      project: lower(run.projectId, projects.get(run.projectId), run.cwd),
      agent: lower(run.executorId, executors.get(run.executorId)),
      state: run.status,
    };
    const accepts = ([field, values]) => values.some(value => field === 'state' ? fields.state === value : fields[field].includes(value));
    if (!conditions.every(accepts)) continue;
    let score = 0, excerpt = '';
    if (terms.length) {
      const title = lower(run.prompt);
      const place = lower(title, fields.machine, fields.project);
      if (title.startsWith(phrase)) score = 4;
      else if (title.includes(phrase)) score = 3;
      else if (terms.every(term => place.includes(term))) score = 2;
      else {
        const sources = [['分支', run.worktree?.branch], ['错误', run.error], ['输出', run.output],
          ['执行 ID', run.id], ['原生会话', run.nativeSessionId], ['会话', run.sessionId], ['执行器', fields.agent], ['状态', fields.state]];
        const missing = patterns.filter((_pattern, i) => !place.includes(terms[i]));
        let matched = true;
        for (const pattern of missing) {
          const source = sources.find(([, value]) => value && pattern.test(value));
          if (!source) { matched = false; break; }
          if (excerpt) continue;
          const [label, value] = source;
          const match = pattern.exec(value);
          const start = match.index, end = start + match[0].length;
          excerpt = label + ' · ' + (start > 18 ? '…' : '') + value.slice(Math.max(0, start - 18), end + 32) + (end + 32 < value.length ? '…' : '');
        }
        if (!matched) continue;
        score = 1;
      }
    }
    hits.push({ run, score, excerpt });
  }
  // Snapshot order is newest first. Preserve it within each relevance tier.
  return hits.sort((a, b) => b.score - a.score);
}
