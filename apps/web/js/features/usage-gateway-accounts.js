import {h,replace} from '../lib/dom.js';
import {Button} from '../ui/kit.js';
import {openDrawer} from '../ui/overlay.js';

const showTime=value=>new Date(value).toLocaleString('zh-CN');
const statuses={disabled:'已禁用',enabled:'已启用',active:'有效',cooldown:'冷却中'};
const quotaNumber=value=>Number.isFinite(value)?String(value):'未提供';
function accountRow(account){
  const title=account.name || account.accountId;
  return h('article',{class:'usage-panel stack','aria-label':title},
    h('strong',{},title),h('small',{},[account.provider,account.accountId].filter(Boolean).join(' · ')),
    h('span',{},[statuses[account.status] || account.status,
      account.schedulable===true?'可调度':account.schedulable===false?'不可调度':'调度状态未提供',
      account.reason,account.stale?'数据已过期':'',account.cached?'缓存数据':''].filter(Boolean).join(' · ')),
    account.cooldownUntil && h('small',{},'冷却至 '+showTime(account.cooldownUntil)),
    [account.planDisplayName,account.plan,account.planRaw].some(Boolean) && h('small',{},
      '套餐 '+[...new Set([account.planDisplayName,account.plan,account.planRaw].filter(Boolean))].join(' · ')),
    account.checkedAt && h('small',{},'核对时间 '+showTime(account.checkedAt)),
    account.windows.length?account.windows.map(w=>h('section',{class:'stack','aria-label':w.kind},
      h('strong',{},[w.kind,w.scope,w.scopedModel].filter(Boolean).join(' · ')),
      h('span',{},'剩余 '+quotaNumber(w.remaining)+' / 限额 '+quotaNumber(w.limit)),
      Number.isFinite(w.usedRatio) && h('small',{},'已用 '+new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:2}).format(w.usedRatio)),
      w.resetsAt && h('small',{},'重置于 '+showTime(w.resetsAt)))):h('small',{},'未取得该账户的额度窗口。'));
}

export function openGatewayAccounts(api,store,initialSources){
  const status=h('div',{class:'stack',role:'status'}),list=h('div'),controls=h('div',{class:'usage-controls'});
  const picker=h('select',{'aria-label':'网关来源'}),body=h('div',{class:'usage-board'},picker,status,list,controls);
  let request,sourceId=initialSources[0]?.id ?? '',offset=0,change=store.view.usageSourcesChange;
  const drawer=openDrawer({title:'网关账户清单',body,wide:true,onClose:()=>{request?.abort();off();}});
  drawer.el.classList.add('usage-drawer');
  const off=store.subscribe(view=>{
    if(view.usageSourcesChange!==change){change=view.usageSourcesChange;void load(offset);}
  });
  picker.onchange=()=>{sourceId=picker.value;void load(0);};
  async function load(start){
    request?.abort();request=new AbortController();const signal=request.signal;
    offset=start;replace(list);replace(controls);status.textContent='正在读取网关清单…';
    try{
      const query=new URLSearchParams({offset:String(start),limit:'25'});
      if(sourceId)query.set('sourceId',sourceId);
      const page=await api('/usage/gateway-accounts?'+query,{signal});
      if(signal.aborted || !drawer.el.open)return;
      const source=page.sources.find(s=>s.id===sourceId);
      if(sourceId && !source){sourceId='';return load(0);}
      if(!source && page.sources.length){sourceId=page.sources[0].id;return load(0);}
      replace(picker,page.sources.map(s=>h('option',{value:s.id,selected:s.id===sourceId},s.name)));
      if(!source){status.textContent='暂无已启用的账户池来源。';return;}
      if(start>0 && start>=page.total)return load(Math.max(0,Math.floor((page.total-1)/25)*25));
      const state=source.error==='pending'?'等待首次采样。':
        source.error?'读取失败：'+source.error:!source.complete?'部分清单，网关账户尚未全部读完。':
        page.total?'已完整读取网关账户清单。':'该网关账户清单为空。';
      replace(status,h('p',{},state),source.checkedAt && h('small',{},'最近检查 '+showTime(source.checkedAt)),
        page.total>0 && h('small',{},'显示第 '+(start+1)+' 至 '+(start+page.accounts.length)+' 个账户，共 '+page.total+' 个。'));
      replace(list,page.accounts.map(accountRow));
      replace(controls,start>0 && Button({label:'上一页账户',onClick:()=>load(Math.max(0,start-25))}),
        Number.isInteger(page.nextOffset) && Button({label:'下一页账户',onClick:()=>load(page.nextOffset)}),
        Button({label:'刷新清单',onClick:()=>load(0)}));
    }catch(error){
      if(signal.aborted || !drawer.el.open)return;
      status.textContent='无法读取网关账户清单：'+error.message;
      replace(controls,Button({label:'重新读取清单',onClick:()=>load(offset)}));
    }
  }
  void load(0);return drawer;
}
