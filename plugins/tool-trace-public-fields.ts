export const phaseLabels:Record<string,string>={no_records:'暂无会话记录',idle:'当前无待处理回合',working:'正在处理',waiting:'等待决定',failed:'处理失败',unknown:'状态尚未核实'};

export function record(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}
export function traceObject(raw:unknown,max:number) {
  if (typeof raw!=='string' || raw.length>max) return;
  try { const value:unknown=JSON.parse(raw); if (record(value)) return value; } catch { /* partial trace */ }
}

export function checkedResult(call:{isError?:unknown;result?:unknown}) {
  if (call.isError!==false) return;
  const wrapper=traceObject(call.result,65536);
  if (!wrapper || !record(wrapper.details) || !Array.isArray(wrapper.content) || wrapper.content.length!==1) return;
  const block=wrapper.content[0];
  // The tool bridge emits the same structured value as details and as one
  // JSON text block. Ignore error text, other block types and partial traces.
  if (record(block) && block.type==='text' && block.text===JSON.stringify(wrapper.details)) return wrapper.details;
}
