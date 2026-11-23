import {networkInterfaces} from 'node:os';
import {isIP,type AddressInfo} from 'node:net';

type Endpoint = {url:string;kind:'local'|'network'};

/** Describe the HTTP listener itself. A proxy's public authority need not be on this machine. */
export function adminEndpoints(listener:AddressInfo|string|null, interfaces=networkInterfaces):Endpoint[] {
  if (!listener || typeof listener==='string') return [];
  const {address,port}=listener;
  const wildcard=address==='0.0.0.0' || address==='::';
  let addresses=[address];
  if (wildcard) {
    // An IPv6 listener may be IPv6-only. Only advertise its confirmed address family.
    addresses=[address==='::'?'::1':'127.0.0.1'];
    try {
      for(const group of Object.values(interfaces())) {
        for(const entry of group??[]) if(entry.family===listener.family) addresses.push(entry.address);
      }
    } catch { /* Loopback still belongs to a wildcard listener when enumeration is unavailable. */ }
  }
  const result:Endpoint[]=[];
  for(const ip of new Set(addresses)) {
    const family=isIP(ip);
    // Scoped link-local IPv6 literals cannot form a portable browser URL.
    if (!family || ip.includes('%') || (family===6 && /^fe[89ab]/i.test(ip))) continue;
    const host=family===6?'['+ip+']':ip;
    result.push({url:'http://'+host+':'+port,kind:ip==='::1'||ip.startsWith('127.')?'local':'network'});
  }
  return result;
}
