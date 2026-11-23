import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';
import { imageSize } from 'image-size';
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';
import { SaxesParser } from 'saxes';
import type { ChatFilePreview } from '../packages/protocol/src/index.ts';

const MiB = 1024 * 1024;
const side = 720;
const maxThumb = 3 * MiB;
const require = createRequire(import.meta.url);
const pdfRequire = createRequire(require.resolve('pdf-parse'));
// Some native canvas loaders probe libc by spawning ldd. This worker never needs a subprocess.
for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const)
  Object.defineProperty(childProcess,method,{value:()=>{ throw Error('subprocess unavailable'); }});
syncBuiltinESMExports();
// All renderer assets are supplied by the installed dependency. Never fetch a document URL.
globalThis.fetch = async () => { throw Error('network unavailable'); };

async function pdfPage(bytes:Uint8Array):Promise<ChatFilePreview> {
  if (!Buffer.from(bytes.subarray(0,5)).equals(Buffer.from('%PDF-'))) throw Error();
  const {PDFParse} = await import('pdf-parse');
  const root = dirname(pdfRequire.resolve('pdfjs-dist/package.json'));
  PDFParse.setWorker(pathToFileURL(join(root,'legacy/build/pdf.worker.mjs')).href);
  const parser = new PDFParse({data:bytes,useWorkerFetch:false,isEvalSupported:false,enableXfa:false,useSystemFonts:false,disableFontFace:true,
    disableAutoFetch:true,disableRange:true,disableStream:true,stopAtErrors:true,verbosity:0,maxImageSize:4_000_000,canvasMaxAreaInBytes:16*MiB,
    cMapUrl:join(root,'cmaps')+sep,cMapPacked:true,standardFontDataUrl:join(root,'standard_fonts')+sep,wasmUrl:join(root,'wasm')+sep});
  try {
    const info=await parser.getInfo({first:1,parsePageInfo:true});
    const page=info.pages[0];
    if (!page || info.total>5000 || ![page.width,page.height].every(n=>Number.isFinite(n)&&n>=1&&n<=100000)) throw Error();
    const scale=Math.min(1,side/Math.max(page.width,page.height));
    if (Math.min(page.width,page.height)*scale<1) throw Error();
    const shot=await parser.getScreenshot({first:1,scale,imageBuffer:true,imageDataUrl:false});
    const png=shot.pages[0]?.data;
    if (!png?.length || png.length>maxThumb || imageSize(png).type!=='png') throw Error();
    return {thumbnail:{mime:'image/png',data:Buffer.from(png).toString('base64')},note:'PDF 首页预览'};
  } finally { await parser.destroy(); }
}

async function readEntry(zip:ZipFile,entry:Entry,limit:number) {
  if (entry.uncompressedSize<=0 || entry.uncompressedSize>limit || entry.generalPurposeBitFlag&1) throw Error();
  const stream=await zip.openReadStreamPromise(entry);
  const chunks:Buffer[]=[]; let size=0;
  try {
    for await(const chunk of stream){
      size+=chunk.length;
      if(size>entry.uncompressedSize || size>limit) throw Error();
      chunks.push(chunk);
    }
    if(size!==entry.uncompressedSize) throw Error();
    return Buffer.concat(chunks,size);
  } finally {stream.destroy();}
}

async function safeThumbnail(bytes:Buffer,expected:'png'|'jpg'):Promise<ChatFilePreview> {
  const {width,height,type}=imageSize(bytes);
  if(type!==expected || !width || !height || width*height>4_000_000 || Math.max(width,height)>8192) throw Error();
  // Decode, scale and re-encode to discard metadata and trailing content; never hand a package member to the browser directly.
  const {createCanvas,loadImage}=pdfRequire('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const image=await loadImage(bytes);
  if (image.width!==width || image.height!==height) throw Error();
  const ratio=Math.min(1,side/Math.max(width,height));
  const canvas=createCanvas(Math.max(1,Math.round(width*ratio)),Math.max(1,Math.round(height*ratio)));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const png=canvas.toBuffer('image/png');
  if(png.length>maxThumb) throw Error();
  return {thumbnail:{mime:'image/png',data:png.toString('base64')},note:'文档内嵌预览'};
}

function iworkText(bytes:Buffer):ChatFilePreview|undefined {
  const parser=new SaxesParser({xmlns:true});
  let depth=0, chars=0, text='', truncated=false;
  parser.on('doctype',()=>{throw Error();});
  parser.on('opentag',tag=>{
    if (depth || (tag.local==='p' && tag.uri==='http://developer.apple.com/namespaces/sf')) depth++;
  });
  parser.on('text',part=>{
    if (!depth) return;
    if(chars+part.length>6000) truncated=true;
    text+=part.slice(0,Math.max(0,6000-chars)); chars+=part.length;
  });
  parser.on('closetag',()=>{if(depth && --depth===0 && chars<6000){text+='\n';chars++;}});
  parser.write(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).close();
  return text.trim() ? {text:text.trim(),truncated,note:'包内未取得预览图，以下为文档段落摘录。'} : undefined;
}

async function packagePage(bytes:Uint8Array,kind:string):Promise<ChatFilePreview> {
  const iwork = kind==='iwork';
  const wanted=iwork ? ['QuickLook/Thumbnail.jpg','QuickLook/Thumbnail.jpeg','QuickLook/Thumbnail.png','preview-web.jpg','preview.jpg','preview-micro.jpg','QuickLook/Preview.pdf','index.xml','index.apxl','index.xml.gz','index.apxl.gz']
    : ['docProps/thumbnail.jpeg','docProps/thumbnail.jpg','docProps/thumbnail.png'];
  const zip=await fromBufferPromise(Buffer.from(bytes),{lazyEntries:true});
  try {
    if(zip.entryCount>4096) throw Error();
    const parts=new Map<string,Entry>();
    const documentPart = ({'.docx':'word/document.xml','.xlsx':'xl/workbook.xml','.pptx':'ppt/presentation.xml'} as Record<string,string>)[kind];
    let main=false, types=false;
    for await(const entry of zip.eachEntry()) {
      if(entry.fileName==='[Content_Types].xml') types=true;
      if(iwork ? ['Index/Document.iwa','Index/Presentation.iwa','index.xml','index.apxl','index.xml.gz','index.apxl.gz'].includes(entry.fileName) : entry.fileName===documentPart) main=true;
      if(!wanted.includes(entry.fileName)) continue;
      if(parts.has(entry.fileName)) throw Error();
      parts.set(entry.fileName,entry);
    }
    if(!main || (!iwork && !types)) return {};
    for(const name of wanted){
      const entry=parts.get(name);
      if(!entry) continue;
      try {
        const xml=/\.(xml|apxl)(\.gz)?$/.test(name);
        const part=await readEntry(zip,entry,xml?MiB:maxThumb);
        if (xml) {
          const preview=iworkText(name.endsWith('.gz') ? gunzipSync(part,{maxOutputLength:MiB}) : part);
          if(preview)return preview;
        } else if(name.endsWith('.pdf')) {
          return {...await pdfPage(part),note:'文档内嵌 PDF 的首页预览'};
        } else return await safeThumbnail(part,name.endsWith('.png')?'png':'jpg');
      } catch { /* Try only the next known, local preview representation. */ }
    }
    return {};
  } finally {zip.close();}
}

if(parentPort){
  try {
    const {bytes,kind}=workerData;
    const result=kind==='pdf'?await pdfPage(bytes):await packagePage(bytes,kind);
    parentPort.postMessage(result);
  } catch {parentPort.postMessage({});}
  finally {parentPort.close();}
}
