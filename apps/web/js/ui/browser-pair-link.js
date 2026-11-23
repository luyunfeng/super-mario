import {h} from '../lib/dom.js';
import {copyText} from '../lib/clipboard.js';
import {Button} from './kit.js';

// Both the administrator and workspace must issue the same fragment-only, same-origin link.
export function browserPairLink(data,deviceName,onCopy) {
  const url=new URL('/',location.origin);
  url.hash='home?'+new URLSearchParams({browserPair:data.code});
  const output=h('input',{class:'input',readOnly:true,value:url.href,'aria-label':'一次性配对链接'});
  const qr=data.qrOrigin===location.origin && data.qrDataUrl?.startsWith('data:image/png;base64,')
    && h('img',{src:data.qrDataUrl,width:240,height:240,alt:'浏览器配对二维码'});
  return h('div',{class:'stack'},h('strong',{},deviceName+' 的一次性配对链接'),
    h('p',{},'请在要连接的浏览器中打开，仅可使用一次。'),qr,output,
    h('small',{},'有效至 '+new Date(data.expiresAt).toLocaleString('zh-CN')),
    Button({label:'复制配对链接',onClick:async()=>{await copyText(output.value);onCopy?.();}}));
}
