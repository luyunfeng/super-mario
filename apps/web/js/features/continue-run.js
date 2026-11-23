import { h } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openSessionResume } from './session-resume.js';

function targetFor(run, snapshot) {
  if (run?.status !== 'completed' || !run.id || !run.machineId || !run.cwd) return;
  const nativeSessionId=run.nativeSessionId ?? run.nativeResume?.nativeSessionId;
  if (!nativeSessionId || (run.nativeResume && run.nativeSessionId && run.nativeResume.nativeSessionId !== run.nativeSessionId)) return;
  if (run.nativeResume?.executorId && run.machineId+'/'+run.nativeResume.executorId!==run.executorId) return;
  const machine = snapshot.machines?.find(row => row.id === run.machineId);
  const executor = snapshot.executors?.find(row => row.id === run.executorId && row.machineId === run.machineId);
  if (!machine?.online || !['agents.sessions', 'agents.session', 'executor.resume'].every(cap => machine.capabilities?.includes(cap)) ||
      !executor?.available || executor.mode !== 'real' || !executor.nativeResultSources?.length) return;
  if (run.projectId && !snapshot.projects?.some(project => project.id === run.projectId && !project.archivedAt)) return;
  if (run.todoId && !snapshot.todos?.some(todo => todo.id === run.todoId && todo.projectId === run.projectId && !todo.completedAt)) return;
  if (snapshot.runs?.some(row => ['queued', 'running'].includes(row.status) && row.machineId === run.machineId &&
    row.executorId === run.executorId && (row.nativeSessionId ?? row.nativeResume?.nativeSessionId) === nativeSessionId)) return;
  return {runId:run.id, machineId:run.machineId, executorId:run.executorId, nativeSessionId,
    cwd:run.cwd, projectId:run.projectId, todoId:run.todoId};
}

export function createContinueRun({api,store,router,scope}) {
  let attempt=0;
  const owner=()=>api.draftOwner();
  function target(runId) {
    const {snapshot,snapshotOwner,connection,unauthorized}=store.view;
    if (!snapshot || !owner() || snapshotOwner!==owner() || connection!=='online' || unauthorized) return;
    return targetFor(snapshot.runs?.find(run=>run.id===runId),snapshot);
  }
  function button(frozen,{visible=()=>true,beforeOpen}={}) {
    if (!frozen) return;
    const key=JSON.stringify(frozen), actor=owner(), page=router.current.page, projectScope=scope.get();
    const notice=h('span',{role:'alert',class:'small',hidden:true});
    const control=Button({label:'继续交办',size:'sm',onClick:async()=>{
      const container=control.closest('dialog, section.page');
      const seq=++attempt;
      const current=()=>seq===attempt && visible() && actor===owner() && page===router.current.page &&
        projectScope===scope.get() && JSON.stringify(target(frozen.runId))===key;
      if (!current()) return;
      notice.hidden=true;
      // A switch away and back while discovery is pending also invalidates the original click.
      const changed=()=>{if(seq===attempt && !current())attempt++;};
      const cleanups=[store.subscribe(changed),router.subscribe(changed),scope.subscribe(changed)];
      try {
        const {machineId,projectId,todoId}=frozen;
        const query=new URLSearchParams({machineId,...(projectId && {projectId}),...(todoId && {todoId})});
        const result=await api.get('/agents/sessions?'+query);
        if (!current()) return;
        const machine=result.machines?.find(row=>row.machineId===machineId && row.online && row.available);
        const matches=machine?.sessions?.filter(row=>row.machineId===machineId && row.resumable &&
          row.remoteExecutorId===frozen.executorId && machineId+'/'+row.executorId===frozen.executorId &&
          row.nativeSessionId===frozen.nativeSessionId && row.cwd===frozen.cwd && row.relatedRunIds?.includes(frozen.runId));
        if(matches?.length!==1)throw new Error('未能核对原执行的可恢复会话与目录，请在执行详情检查原记录。');
        openSessionResume({api,store,router,machine,session:matches[0],projectId,todoId});
        beforeOpen?.();
      } catch(error) {
        if(current()){
          const alert=notice.isConnected?notice:container?.querySelector('[data-continue-run="'+CSS.escape(frozen.runId)+'"] [role="alert"]');
          if(!alert)throw error;
          alert.textContent=error.message || '读取原执行会话失败，请重试。';
          alert.hidden=false;
        }
      } finally { for(const off of cleanups)off(); }
    }});
    return h('span',{class:'row row--wrap',dataset:{continueRun:frozen.runId}},control,notice);
  }
  return {target,button};
}
