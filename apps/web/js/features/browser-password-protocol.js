export function validBrowserPassword(value){
  return !!value.trim() && Array.from(value).length>=8 && new TextEncoder().encode(value).length<=256;
}

export async function passwordExchange({mode,password,start,finish,signal,current}){
  const worker=new Worker('/js/browser-password-worker.js',{type:'module'});
  function check(){
    signal.throwIfAborted();
    if(!current())throw new DOMException('登录身份已变化','AbortError');
  }
  function run(data){
    check();
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(new DOMException('操作已取消','AbortError'));
      function done(fn,value){
        signal.removeEventListener('abort',abort);worker.onmessage=null;worker.onerror=null;fn(value);
      }
      signal.addEventListener('abort',abort,{once:true});
      worker.onmessage=({data:reply})=>reply?.message?done(resolve,reply.message):done(reject,Error(reply?.error || '浏览器密码验证失败。'));
      worker.onerror=()=>done(reject,Error('无法加载浏览器密码验证组件。'));
      worker.postMessage(data);
    });
  }
  try{
    const pending=run({step:'start',mode,password});password='';
    const initial=await pending;check();
    const challenge=await start(initial);check();
    const final=await run({step:'finish',message:challenge.message});check();
    return await finish(challenge.session,final);
  }finally{worker.terminate();}
}
