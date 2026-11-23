import assert from 'node:assert/strict';
import test from 'node:test';
import {adminEndpoints} from '../apps/server/src/admin-endpoints.ts';

test('管理概览只列出当前监听地址族的直连入口',()=>{
  const interfaces=()=>({test:[
    {address:'192.0.2.5',family:'IPv4' as const,internal:false,mac:'',netmask:'',cidr:null},
    {address:'2001:db8::5',family:'IPv6' as const,internal:false,mac:'',netmask:'',cidr:null,scopeid:0},
    {address:'fe80::1',family:'IPv6' as const,internal:false,mac:'',netmask:'',cidr:null,scopeid:1},
  ]});
  const ipv4={address:'127.0.0.1',family:'IPv4',port:54321};
  assert.deepEqual(adminEndpoints(ipv4,interfaces),[{url:'http://127.0.0.1:54321',kind:'local'}]);
  assert.deepEqual(adminEndpoints({...ipv4,address:'0.0.0.0'},interfaces).map(x=>x.url),['http://127.0.0.1:54321','http://192.0.2.5:54321']);
  assert.deepEqual(adminEndpoints({...ipv4,address:'::',family:'IPv6'},interfaces).map(x=>x.url),['http://[::1]:54321','http://[2001:db8::5]:54321']);
  assert.deepEqual(adminEndpoints(null,interfaces),[]);
});
