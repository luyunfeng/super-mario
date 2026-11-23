import {h,replace} from '../lib/dom.js';
import {Button,Field,Select} from '../ui/kit.js';

export function sourceComments(api,path,canRead) {
  const status=h('p',{class:'small',role:'status'});
  const threads=h('div',{class:'stack'});
  const refresh=Button({label:'刷新评论',size:'sm',onClick:load});
  const filter=Select({options:[['all','全部'],['open','未解决'],['resolved','已解决']],value:'all',onchange:render});
  const panel=h('details',{},h('summary',{},'查看飞书文档评论'),Field({label:'评论状态',control:filter}),status,threads,refresh);
  let active,result;
  function current(request) {
    return request===active && panel.isConnected && panel.open && canRead();
  }
  function render() {
    if (!result || !canRead()) return;
    const shown=result.threads.filter(thread=>filter.value==='all' || thread.resolved===(filter.value==='resolved'));
    replace(threads,shown.map(thread=>h('article',{class:'item stack'},
        h('strong',{},thread.resolved?'已解决':'未解决'),
        thread.quote && h('blockquote',{},thread.quote),
        thread.replies.map(reply=>h('p',{style:{whiteSpace:'pre-wrap'}},
          h('strong',{},reply.author || '未知作者'),'：',reply.text)))));
    status.textContent=(shown.length?'显示 '+shown.length+' 条评论。':result.threads.length?'没有符合筛选条件的评论。':'暂无评论。')+
        (result.truncated?'仅显示部分评论或回复。':'');
  }
  async function load() {
    if (!panel.open || !canRead()) return;
    active?.abort();
    const request=new AbortController();
    active=request;result=undefined;filter.disabled=true;
    refresh.disabled=true;status.textContent='正在读取评论…';threads.replaceChildren();
    try {
      const response=await api(path,{signal:request.signal});
      if (!current(request)) return;
      result=response;filter.disabled=false;render();
    } catch(error) {
      if (current(request)) status.textContent='读取评论失败：'+error.message;
    } finally {
      if (active===request) refresh.disabled=false;
    }
  }
  panel.addEventListener('toggle',()=>{
    if (panel.open) {void load();return;}
    active?.abort();active=undefined;result=undefined;threads.replaceChildren();status.textContent='';
  });
  return panel;
}
