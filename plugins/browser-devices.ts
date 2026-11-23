import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import type {Extension, Store} from '../packages/plugin-sdk/src/index.ts';

export interface BrowserDevice {id:string; name:string; createdAt:string; lastSeenAt?:string}
export type BrowserReplacement = {id:string; proof:string};
type StoredDevice = BrowserDevice & {digest:string;source?:'password'};
type Pairing = {digest:string; name:string; expires:number};

const devices = 'browser-devices.devices';
const credentials = 'browser-devices.credentials';
const pairings = 'browser-devices.pairings';
const lifetime = 5 * 60_000;
const digestOf = (value:string) => createHash('sha256').update(value).digest('hex');

const proofForDigest=(digest:string) => createHash('sha256').update('super-mario.browser-replace.v1:'+digest).digest();
export function proofForBrowserToken(token:string):string {
  return proofForDigest(digestOf(token)).toString('hex');
}

function fail(status:number,message:string):never {
  throw Object.assign(new Error(message), {status});
}
function metadata(device:StoredDevice):BrowserDevice {
  const {id,name,createdAt,lastSeenAt}=device;
  return {id,name,createdAt,...(lastSeenAt && {lastSeenAt})};
}
export function createBrowserDevices(store:Store,onInvalidate:(id?:string)=>void) {
  let active=false;
  function requireActive() {
    if (!active) fail(503,'浏览器设备插件未启用');
  }
  function cleanCodes(all:boolean) {
    const now=Date.now();
    for(const code of store.list<Pairing>(pairings)) {
      if(all || code.expires<=now) store.remove(pairings,code.digest);
    }
  }
  function list():BrowserDevice[] {
    requireActive();
    return store.list<StoredDevice>(devices).map(metadata).sort((a,b)=>b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  function validName(name:string) {
    if(typeof name!=='string' || !name.trim() || Array.from(name.trim()).length>80 || /[\p{Cc}\p{Cs}]/u.test(name))
      fail(400,'请输入 1 至 80 个字符的设备名称');
    return name.trim();
  }
  function issue(name:string) {
    requireActive();
    const normalized=validName(name);
    return store.transaction(()=>{
      cleanCodes(false);
      const code=randomBytes(24).toString('base64url'),digest=digestOf(code),expires=Date.now()+lifetime;
      store.put<Pairing>(pairings,digest,{digest,name:normalized,expires});
      return {code,expiresAt:new Date(expires).toISOString()};
    });
  }
  // Call only inside the transaction which owns the credential mutation.
  function removeDevice(device:StoredDevice) {
    store.remove(credentials,device.digest);
    return store.remove(devices,device.id);
  }
  function replaceDevice(replaces:BrowserReplacement|undefined) {
    if (!replaces || typeof replaces.id!=='string' || replaces.id.length!==36 ||
        typeof replaces.proof!=='string' || !/^[a-f0-9]{64}$/.test(replaces.proof)) return;
    const old=store.get<StoredDevice>(devices,replaces.id);
    if (!old || old.id!==replaces.id || !/^[a-f0-9]{64}$/.test(old.digest)) return;
    const expected=proofForDigest(old.digest);
    if (timingSafeEqual(expected,Buffer.from(replaces.proof,'hex')) && removeDevice(old)) return old.id;
  }
  function redeem(code:string,replaces?:BrowserReplacement) {
    requireActive();
    if(typeof code!=='string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) fail(401,'配对码无效或已过期');
    const digest=digestOf(code);
    const receipt=store.transaction(()=>{
      const pairing=store.get<Pairing>(pairings,digest);
      if(!pairing) return;
      // Consume even expired codes. Throw outside the transaction so expiry cleanup commits.
      if(!store.remove(pairings,digest) || pairing.expires<=Date.now()) return;
      const replaced=replaceDevice(replaces);
      return {replaced,...newDevice(pairing.name)};
    });
    if (!receipt) fail(401,'配对码无效或已过期');
    if (receipt.replaced) onInvalidate(receipt.replaced);
    const {replaced,...result}=receipt;
    return result;
  }
  // Every authentication method issues the same revocable browser credential.
  function newDevice(name:string,source?:'password') {
    const token='smbd_'+randomBytes(32).toString('base64url');
    const device:StoredDevice={id:randomUUID(),name,createdAt:new Date(Date.now()).toISOString(),digest:digestOf(token),source};
    store.put(devices,device.id,device);
    store.put(credentials,device.digest,device.id);
    return {token,device:metadata(device),replacementProof:proofForBrowserToken(token)};
  }
  function issuePassword(name:string) {
    requireActive();
    return store.transaction(()=>newDevice(validName(name),'password'));
  }
  // The password setting and its affected credentials must commit together. Disconnect after commit.
  function revokePasswordDevices() {
    requireActive();
    const removed:string[]=[];
    for(const device of store.list<StoredDevice>(devices)){
      if(device.source==='password' && removeDevice(device))removed.push(device.id);
    }
    return ()=>{for(const id of removed)onInvalidate(id);};
  }
  function authenticate(token:string):string|undefined {
    if(!active || typeof token!=='string' || !/^smbd_[A-Za-z0-9_-]{43}$/.test(token)) return;
    const digest=digestOf(token);
    return store.transaction(()=>{
      const id=store.get<string>(credentials,digest);
      const device=id && store.get<StoredDevice>(devices,id);
      if(!device || device.id!==id || device.digest!==digest) return;
      // Record activity at most once a minute, even when one page makes many requests.
      const now=Date.now();
      if(!device.lastSeenAt || now-Date.parse(device.lastSeenAt)>=60_000) {
        store.put(devices,id,{...device,lastSeenAt:new Date(now).toISOString()});
      }
      return id;
    });
  }
  function revoke(id:string) {
    requireActive();
    const removed=store.transaction(()=>{
      const device=store.get<StoredDevice>(devices,id);
      if(!device)return false;
      return removeDevice(device);
    });
    if(removed)onInvalidate(id);
    return removed;
  }
  const extension:Extension={
    id:'browser-devices',name:'浏览器设备',capabilities:['browser.devices'],
    navigation:[{id:'devices',label:'浏览器设备',route:'#agent?browserDevices=1'}],
    activate(ctx){
      // Pairing is temporary. A code left behind by a crashed host cannot cross activations.
      store.transaction(()=>cleanCodes(true));
      active=true;
      ctx.defer(()=>{
        active=false;
        try {store.transaction(()=>cleanCodes(true));} finally {onInvalidate();}
      });
    }
  };
  return {extension,list,issue,redeem,authenticate,revoke,issuePassword,revokePasswordDevices};
}
