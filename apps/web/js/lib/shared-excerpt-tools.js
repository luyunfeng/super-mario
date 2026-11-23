// Both the owner's preview and the public reader render the frozen, server-approved strings.
export function renderSharedTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const section=document.createElement('section');
  section.setAttribute('aria-label','工具记录');
  const labels={succeeded:'成功',failed:'失败',returned:'已返回结果'};
  for (const tool of tools) {
    if (typeof tool?.name!=='string' || !tool.name) continue;
    const label=tool.name+' · '+(Object.hasOwn(labels,tool.status)?labels[tool.status]:'状态未知');
    if (!tool.args && !tool.result) {
      const line=document.createElement('div');
      line.textContent=label;
      section.append(line);
      continue;
    }
    const details=document.createElement('details');
    const summary=document.createElement('summary');
    summary.textContent=label;
    details.append(summary);
    for (const [key,label] of [['args','工具参数'],['result','工具结果']]) {
      if (typeof tool[key]!=='string' || !tool[key]) continue;
      const heading=document.createElement('strong');
      heading.textContent=label;
      const body=document.createElement('pre');
      body.className='mailbox-content';
      body.textContent=tool[key];
      details.append(heading,body);
    }
    section.append(details);
  }
  return section.childElementCount ? section : null;
}
