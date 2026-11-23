import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, type BigIntStats } from 'node:fs';
import { lstat, link, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ZipStream from 'zip-stream';
import { BackupError, MAX_ENTRIES, MAX_MANIFEST_BYTES, safeBackupPath } from './format.ts';

type Snapshot = { path:string; stat:BigIntStats; children?:Snapshot[] };
type ManifestFile = { path:string; size:number; sha256:string };
const dirFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const fileFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
const descriptor=(h:FileHandle)=>'/proc/self/fd/'+h.fd;
function fail(message:string):never {throw new BackupError(message);}
function unchanged(expected:BigIntStats,actual:BigIntStats) {
  if (actual.dev!==expected.dev || actual.ino!==expected.ino || actual.mode!==expected.mode ||
      actual.size!==expected.size || actual.mtimeNs!==expected.mtimeNs || actual.ctimeNs!==expected.ctimeNs)
    fail('数据目录在备份期间发生变化，请停止写入后重试。');
}

export async function createBackup(dataDir:string,output:string):Promise<{files:number;bytes:number}> {
  let root:FileHandle|undefined, dest:FileHandle|undefined, temporary:FileHandle|undefined;
  let temporaryPath:string|undefined;
  try {
    if (process.platform!=='linux') fail('当前离线备份需要 Linux 目录文件描述符。');
    if (!dataDir || !output) fail('请指定已有数据目录和新的备份文件。');
    root=await open(resolve(dataDir),dirFlags);
    const outputPath=resolve(output);
    dest=await open(await realpath(dirname(outputPath)),dirFlags);
    const canonicalRoot=await realpath(descriptor(root)), canonicalDest=await realpath(descriptor(dest));
    const relativeDest=relative(canonicalRoot,canonicalDest);
    if (!relativeDest || (relativeDest!=='..' && !relativeDest.startsWith('..'+sep))) fail('备份输出必须位于数据目录以外。');
    const target=join(descriptor(dest),basename(outputPath));
    try { await lstat(target);fail('备份输出已存在。'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
    }
    const destStat=await dest.stat({bigint:true});
    const dirs=new Set<string>();
    let count=0;
    // Pin each traversed parent, so replacing an intermediate path with a link cannot redirect a read.
    async function walk(dir:FileHandle,folder:Snapshot,visit?:(path:string,entry:Snapshot)=>Promise<void>) {
      const path=descriptor(dir);
      unchanged(folder.stat,await dir.stat({bigint:true}));
      if (folder.children===undefined) {
        const key=folder.stat.dev+':'+folder.stat.ino;
        if (destStat.dev===folder.stat.dev && destStat.ino===folder.stat.ino) fail('备份输出目录与数据目录重叠。');
        if (dirs.has(key)) fail('数据目录包含重复挂载的目录。');
        dirs.add(key);
        // Preserve only unambiguous UTF-8 names. Node's string decoder otherwise silently replaces invalid bytes.
        const names=await readdir(path,{encoding:'buffer'});
        folder.children=[];
        for (const bytes of names.sort(Buffer.compare)) {
          const name=bytes.toString('utf8'), childPath=folder.path ? folder.path+'/'+name : name;
          if (!Buffer.from(name).equals(bytes) || !safeBackupPath(childPath)) fail('数据目录包含无法归档的路径。');
          if (++count>MAX_ENTRIES) fail('文件和目录数超过备份上限。');
          const stat=await lstat(join(path,name),{bigint:true});
          if (!stat.isFile() && !stat.isDirectory()) fail('数据目录包含符号链接或特殊文件。');
          folder.children.push({path:childPath,stat});
        }
      }
      for (const child of folder.children) {
        const childPath=join(path,basename(child.path));
        unchanged(child.stat,await lstat(childPath,{bigint:true}));
        if (visit) await visit(childPath,child);
        if (child.stat.isDirectory()) {
          const handle=await open(childPath,dirFlags);
          try { await walk(handle,child,visit); } finally {await handle.close();}
        }
      }
      unchanged(folder.stat,await dir.stat({bigint:true}));
    }
    const tree:Snapshot={path:'',stat:await root.stat({bigint:true})};
    await walk(root,tree);
    if (!tree.children?.some(entry=>entry.path==='workbench.sqlite' && entry.stat.isFile())) fail('数据目录缺少 workbench.sqlite。');
    const tempName=join(descriptor(dest),'.super-mario-backup-'+randomUUID()+'.tmp');
    temporary=await open(tempName,'wx',0o600);
    temporaryPath=tempName;
    const zip=new ZipStream({zlib:{level:6}});
    const sink=createWriteStream(tempName,{fd:temporary.fd,autoClose:false});
    const writing=pipeline(zip,sink);
    // Pipeline failure can precede the next entry callback (e.g. ENOSPC).
    void writing.catch(()=>{});
    function append(content:Buffer|Readable,name:string,directory=false,executable=false) {
      return new Promise<void>((resolveEntry,reject)=>{
        const closed=()=>done(new Error('归档流已关闭'));
        const done=(error?:Error|null)=>{
          zip.off('close',closed);
          zip.off('error',done);
          if (error) reject(error); else resolveEntry();
        };
        if (zip.destroyed) return closed();
        zip.once('close',closed);
        zip.once('error',done);
        zip.entry(content,{name,type:directory?'directory':'file',mode:directory || executable ? 0o700 : 0o600},done);
      });
    }
    const files:ManifestFile[]=[];
    let total=0, manifestBytes=Buffer.byteLength('{"format":"super-mario-backup","version":1,"files":[]}');
    try {
      await walk(root,tree,async(path,entry)=>{
        if (entry.stat.isDirectory()) {
          await append(Buffer.alloc(0),'data/'+entry.path+'/',true);
          return;
        }
        const handle=await open(path,fileFlags);
        try {
          unchanged(entry.stat,await handle.stat({bigint:true}));
          const size=Number(entry.stat.size);
          if (!Number.isSafeInteger(size+total)) fail('数据大小超过备份上限。');
          if (entry.path==='workbench.sqlite') {
            const header=Buffer.alloc(16);
            const result=await handle.read(header,0,16,0);
            if (result.bytesRead!==header.length || !header.equals(Buffer.from('SQLite format 3\0'))) fail('workbench.sqlite 不是有效的 SQLite 数据文件。');
          }
          const hash=createHash('sha256');
          async function* chunks() {
            let offset=0;
            while (offset<size) {
              const buffer=Buffer.allocUnsafe(Math.min(128*1024,size-offset));
              const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
              if (!bytesRead) fail('文件在备份期间发生变化。');
              const part=buffer.subarray(0,bytesRead);
              hash.update(part);offset+=bytesRead;
              yield part;
            }
          }
          const stream=Readable.from(chunks(),{objectMode:false});
          try {await append(stream,'data/'+entry.path,false,Boolean(entry.stat.mode & 0o100n));} finally {stream.destroy();}
          unchanged(entry.stat,await handle.stat({bigint:true}));
          const file={path:entry.path,size,sha256:hash.digest('hex')};
          manifestBytes+=Buffer.byteLength(JSON.stringify(file))+(files.length?1:0);
          if (manifestBytes>MAX_MANIFEST_BYTES) fail('备份清单超过大小上限。');
          files.push(file);
          total+=size;
        } finally {await handle.close();}
      });
      await append(Buffer.from(JSON.stringify({format:'super-mario-backup',version:1,files})),'manifest.json');
      zip.finalize();
      await writing;
    } catch (error) {zip.destroy();sink.destroy();await writing.catch(()=>{});throw error;}
    await temporary.sync();
    // Recheck earlier files as well as the source/destination bindings before publishing.
    await walk(root,tree);
    unchanged(tree.stat,await lstat(resolve(dataDir),{bigint:true}));
    if (await realpath(dirname(outputPath))!==await realpath(descriptor(dest))) fail('备份输出目录已变化。');
    unchanged(await temporary.stat({bigint:true}),await lstat(tempName,{bigint:true}));
    await link(tempName,target); // EEXIST even if another writer raced the initial check.
    try { await dest.sync(); } catch { fail('备份文件已发布，但无法确认已同步到磁盘。请检查现有备份。'); }
    return {files:files.length,bytes:total};
  } catch (error) {
    if (error instanceof BackupError) throw error;
    if ((error as NodeJS.ErrnoException).code==='EEXIST') fail('备份输出已存在。');
    return fail('无法创建备份，请检查数据目录、文件权限、剩余空间和写入状态。');
  } finally {
    // Avoid exposing private paths through an OS cleanup exception.
    if (temporaryPath) await unlink(temporaryPath).catch(()=>{});
    await Promise.all([temporary?.close(),dest?.close(),root?.close()].map(p=>p?.catch(()=>{})));
  }
}
