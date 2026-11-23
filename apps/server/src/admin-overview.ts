import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import type {AddressInfo} from 'node:net';
import type {Store} from '../../../packages/plugin-sdk/src/index.ts';
import {adminEndpoints} from './admin-endpoints.ts';

type Options={
  store:Store; version:string; startedAt:string; demo:boolean;
  address:()=>AddressInfo|string|null;
  machines:()=>{online:boolean}[];
  plugins:()=>{id:string;status:string}[];
  devices:()=>{id:string}[];
};
type Status='ok'|'warning'|'error';
type Check={label:string;status:Status;detail:string};
const collection='core.admin-auth.instance';

export function createAdminOverview(options:Options) {
  const {store}=options;
  const instanceId=store.transaction(()=>{
    const existing=store.get<string>(collection,'id');
    if(existing)return existing;
    const id=randomUUID();
    store.put(collection,'id',id);
    return id;
  });
  const host=hostname().split('.')[0]?.trim();
  const defaultName=host && host!=='localhost' && !/^[a-f0-9]{12,64}$/i.test(host) ? host : 'super-mario-'+instanceId.slice(0,6);
  function read(){
    const name=store.get<string>(collection,'name')??defaultName;
    const address=options.address();
    const listen=!address?'':typeof address==='string'?address:
      (address.family==='IPv6'?'['+address.address+']':address.address)+':'+address.port;
    const machines=options.machines();
    const devices=options.plugins().some(p=>p.id==='browser-devices'&&p.status==='active')?options.devices().length:null;
    return {version:options.version,name,defaultName,instanceId,platform:process.platform,arch:process.arch,startedAt:options.startedAt,
      listen,endpoints:adminEndpoints(address),mode:options.demo?'demo' as const:'live' as const,
      machines:{online:machines.filter(m=>m.online).length,total:machines.length},devices};
  }
  function rename(value:unknown){
    if(typeof value!=='string'||/[\p{Cc}\p{Cs}]/u.test(value)||Array.from(value.trim()).length>64)
      throw Object.assign(new Error('实例名称最多 64 个字符，请使用单行文字'),{status:400});
    const name=value.trim();
    if(name)store.put(collection,'name',name);
    else store.remove(collection,'name');
    return read();
  }
  function doctor(){
    const checkedAt=new Date().toISOString(),checks:Check[]=[];
    function check(label:string,run:()=>Omit<Check,'label'>){
      try{checks.push({label,...run()});}
      catch{checks.push({label,status:'error',detail:'无法读取当前状态'});}
    }
    check('本地存储',()=>store.get<string>(collection,'id')===instanceId
      ? {status:'ok',detail:'SQLite 已读回本实例标识'}:{status:'error',detail:'未读到匹配的实例标识'});
    check('HTTP 服务',()=>options.address()?{status:'ok',detail:'服务已监听'}:{status:'error',detail:'服务尚未监听'});
    check('执行机',()=>{
      const machines=options.machines(),online=machines.filter(m=>m.online).length;
      return {status:machines.length>0 && online===machines.length?'ok':'warning',detail:'已登记 '+machines.length+' 台，当前在线 '+online+' 台'};
    });
    check('插件',()=>{
      const plugins=options.plugins(),active=plugins.filter(p=>p.status==='active').length;
      const failed=plugins.filter(p=>p.status==='failed'),waiting=plugins.filter(p=>p.status==='waiting');
      const affected=[...failed,...waiting].map(p=>p.id).filter(id=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)).slice(0,5);
      const counts='运行 '+active+' 个，等待 '+waiting.length+' 个，失败 '+failed.length+' 个，停用 '+plugins.filter(p=>p.status==='disabled').length+' 个';
      return {status:failed.length?'error':waiting.length?'warning':'ok',detail:affected.length?counts+'。请检查 '+affected.join('、'):counts};
    });
    return {checkedAt,checks};
  }
  return {read,rename,doctor};
}
