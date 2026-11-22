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

export function searchRuns(query, snapshot, now = Date.now()) {
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
  return (snapshot.runs ?? []).filter(run => {
    if (since !== undefined && !(Date.parse(run.updatedAt) >= since)) return false;
    const fields = {
      machine: lower(run.machineId, machines.get(run.machineId)),
      project: lower(run.projectId, projects.get(run.projectId), run.cwd),
      agent: lower(run.executorId, executors.get(run.executorId)),
      state: run.status,
    };
    for (const [field, values] of filters) {
      if (!values.some(value => field === 'state' ? fields.state === value : fields[field].includes(value))) return false;
    }
    if (!terms.length) return true;
    const text = lower(run.prompt, run.output, run.error, run.nativeSessionId, run.sessionId, ...Object.values(fields));
    return terms.every(term => text.includes(term));
  });
}
