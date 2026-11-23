// One worker holds the password and ephemeral client state for exactly one OPAQUE exchange.
// Only protocol messages cross back into the UI; export keys and session keys are never posted.
let saved,opaque;
self.onmessage=async({data})=>{
  try{
    if(data.step==='start' && !saved){
      const {mode,password}=data;
      opaque=await import('/vendor/opaque.js');await opaque.ready;
      if(mode==='register'){
        const {clientRegistrationState,registrationRequest}=opaque.client.startRegistration({password});
        saved={mode,password,state:clientRegistrationState};self.postMessage({message:registrationRequest});
      }else if(mode==='login'){
        const {clientLoginState,startLoginRequest}=opaque.client.startLogin({password});
        saved={mode,password,state:clientLoginState};self.postMessage({message:startLoginRequest});
      }else throw Error();
      return;
    }
    if(data.step!=='finish' || !saved)throw Error();
    const {password,mode,state}=saved;saved=undefined;
    const opts={password,keyStretching:'memory-constrained'};
    const message=mode==='register'?
      opaque.client.finishRegistration({...opts,clientRegistrationState:state,registrationResponse:data.message}).registrationRecord:
      opaque.client.finishLogin({...opts,clientLoginState:state,loginResponse:data.message})?.finishLoginRequest;
    if(typeof message!=='string' || !message)throw Error();
    self.postMessage({message});
  }catch{saved=undefined;self.postMessage({error:data.step==='finish'?'密码或验证响应无效。':'无法初始化浏览器密码验证。'});}
};
