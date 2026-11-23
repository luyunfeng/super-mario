import {h,replace} from './lib/dom.js';

export function createAdminNetwork({request,submit,csrf,current}){
  const life=new AbortController();
  const body=h('div',{class:'stack'}),feedback=h('p',{class:'small',role:'status'});
  const load=h('button',{type:'button',class:'btn btn--sm',onclick:()=>submit(async()=>{
    replace(body);feedback.textContent='正在读取网络设置…';
    try{
      const settings=await request('network',undefined,{},life.signal);
      if(active()){paint(settings);feedback.textContent='';}
    }catch(error){if(active()){feedback.textContent='网络设置读取失败。';throw error;}}
  })},'查看网络设置');
  const el=h('section',{class:'stack','aria-label':'网络设置'},h('h3',{},'网络设置'),load,body,feedback);
  const active=()=>current() && el.isConnected && !life.signal.aborted;
  function paint(data){
    load.textContent='刷新网络设置';
    const confirmation=h('div',{class:'stack'});
    const input=h('input',{type:'url',class:'input','aria-label':'公开访问地址',placeholder:location.origin,
      value:data.publicOrigin || '',autocomplete:'off',oninput:()=>{replace(confirmation);feedback.textContent='';}});
    async function save(publicOrigin){
      await submit(async()=>{
        if(!active())return;
        const result=await request('network',{publicOrigin},csrf,life.signal);
        if(!active())return;
        paint(result);
        feedback.textContent=result.publicOrigin?'已保存公开访问地址。':'已恢复使用当前浏览器地址。';
      });
    }
    const form=h('form',{class:'stack',onsubmit:event=>{
      event.preventDefault();replace(confirmation);feedback.textContent='';
      const target=input.value.trim();
      if(!target){void save('');return;}
      let url;
      try{url=new URL(target);}catch{/* Show the permitted format below. */}
      if(!/^https?:\/\/[^/@?#\\%\s]+\/?$/iu.test(target) || !url || !['http:','https:'].includes(url.protocol) || (url.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) || url.username || url.password || url.pathname!=='/' || url.search || url.hash){
        feedback.textContent='请输入 HTTPS 地址，仅回环地址可使用 HTTP。地址仅包含协议、主机和可选端口。';return;
      }
      replace(confirmation,h('p',{},'新签发的浏览器配对链接和二维码将指向以下地址。请确认它属于此工作台。'),
        h('code',{},url.origin),h('div',{class:'row'},h('button',{type:'button',class:'btn btn--sm',onclick:()=>replace(confirmation)},'取消'),
          h('button',{type:'button',class:'btn btn--sm',onclick:()=>save(target)},'确认保存公开地址')));
    }},h('label',{class:'field'},'公开访问地址',input),
      h('p',{class:'small muted'},'留空时使用当前浏览器地址。此设置仅指定配对目的地，不会配置 TLS、修改监听地址或探测外网连通性。'),
      h('button',{type:'submit',class:'btn btn--sm'},'保存公开地址'),confirmation);
    replace(body,h('p',{},'服务监听地址 '+data.listen),form);
  }
  return {el,close(){life.abort();replace(body);}};
}
