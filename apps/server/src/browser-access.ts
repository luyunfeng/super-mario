import QRCode from 'qrcode';
import type {IncomingMessage} from 'node:http';

export type BrowserAccess={kind:'root'|'local'}|{kind:'device';id:string;token:string};
export function createBrowserAccess(rootToken:string|undefined,authenticate:(token:string)=>string|undefined) {
  const live=new Map<string,Set<()=>void>>();
  function access(req:IncomingMessage,url:URL):BrowserAccess|undefined {
    const header=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const query=url.searchParams.get('token');
    // Root URLs and existing node clients retain their original authentication path.
    if(rootToken && (header===rootToken || query===rootToken))return {kind:'root'};
    if(!rootToken)return [header,query].some(value=>value?.startsWith('smbd_') || value?.startsWith('smmc_')) ? undefined:{kind:'local'};
    const token=header??query;
    if(!token?.startsWith('smbd_'))return;
    const id=authenticate(token);
    if(id)return {kind:'device',id,token};
  }
  function track(id:string,disconnect:()=>void) {
    const set=live.get(id)??new Set<()=>void>();
    live.set(id,set);set.add(disconnect);
    return ()=>{
      set.delete(disconnect);
      if(!set.size && live.get(id)===set)live.delete(id);
    };
  }
  function invalidate(id?:string){
    for(const key of id===undefined?[...live.keys()]:[id]){
      const clients=live.get(key);live.delete(key);
      for(const disconnect of clients??[])disconnect();
    }
  }
  return {access,track,invalidate};
}

// A browser supplies its external origin even behind a reverse proxy. Encode the same
// fragment-only link as the copy button; credentials never go to a QR service.
export async function pairingQR(origin:string|undefined,code:string) {
  if(!origin || origin.length>512)return {};
  let url:URL;
  try{url=new URL(origin);}catch{return {};}
  if(url.origin!==origin || !['https:','http:'].includes(url.protocol))return {};
  url.hash='home?'+new URLSearchParams({browserPair:code});
  return {qrOrigin:origin,qrDataUrl:await QRCode.toDataURL(url.href,{width:240,margin:4,errorCorrectionLevel:'M'})};
}
