import {createHash} from 'node:crypto';
import {copyFile, lstat, mkdir, mkdtemp, open, rename, rm, rmdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {crc32} from 'node:zlib';
import {openPromise, type Entry, type ZipFile} from 'yauzl';
import {BackupError, MAX_ENTRIES, MAX_MANIFEST_BYTES, safeBackupPath} from './format.ts';

type FileDigest = {size:number;sha256:string};
function invalid():never {
  throw new BackupError('备份包结构或完整性校验失败。');
}
const occupied = () => new BackupError('恢复目标已存在，请指定全新目录。');

async function contents(zip:ZipFile, entry:Entry, consume:(chunk:Buffer)=>Promise<void>) {
  let size=0, crc=0;
  const stream=await zip.openReadStreamPromise(entry);
  for await (const chunk of stream) {
    size+=chunk.length;
    if (size>entry.uncompressedSize || !Number.isSafeInteger(size)) invalid();
    crc=crc32(chunk,crc);
    await consume(chunk);
  }
  if (size!==entry.uncompressedSize || crc!==entry.crc32) invalid();
}

function checkManifest(bytes:Buffer, actual:Map<string,FileDigest>) {
  let doc;
  try { doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { invalid(); }
  if (doc?.format!=='super-mario-backup' || doc.version!==1 || !Array.isArray(doc.files) ||
      doc.files.length!==actual.size || !actual.has('workbench.sqlite')) invalid();
  // Remove each verified path once. Equal counts alone do not rule out duplicates.
  const remaining=new Map(actual);
  for (const row of doc.files) {
    const match=remaining.get(row?.path);
    if (!match || match.size!==row.size || match.sha256!==row.sha256) invalid();
    remaining.delete(row.path);
  }
}

async function scan(archive:string, stage?:string) {
  const zip=await openPromise(archive,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true});
  let bytes=0, manifestSeen=false;
  const files=new Map<string,FileDigest>(), paths=new Set<string>();
  try {
    if (zip.entryCount>MAX_ENTRIES+1) invalid();
    for await (const entry of zip.eachEntry()) {
      const name=entry.fileName, directory=name.endsWith('/');
      const mode=entry.externalFileAttributes>>>16, type=mode&0o170000;
      if (manifestSeen || !entry.canDecodeFileData() || entry.isEncrypted() ||
          (type && type!==(directory?0o040000:0o100000)) ||
          (entry.externalFileAttributes&0x400) || ((entry.externalFileAttributes&0x10) && !directory) ||
          !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize<0) invalid();
      const local=await zip.readLocalFileHeaderPromise(entry);
      if (!local.fileName.equals(entry.fileNameRaw) || local.compressionMethod!==entry.compressionMethod ||
          local.generalPurposeBitFlag!==entry.generalPurposeBitFlag) invalid();
      if (name==='manifest.json') {
        if (entry.uncompressedSize>MAX_MANIFEST_BYTES) invalid();
        const chunks:Buffer[]=[];
        await contents(zip,entry,async chunk=>{chunks.push(chunk);});
        checkManifest(Buffer.concat(chunks),files);
        manifestSeen=true;
        continue;
      }
      if (!name.startsWith('data/')) invalid();
      const path=directory ? name.slice(5,-1) : name.slice(5);
      if (!safeBackupPath(path) || paths.has(path) || paths.size>=MAX_ENTRIES) invalid();
      paths.add(path);
      const target=stage && join(stage,path);
      if (directory) {
        if (entry.uncompressedSize!==0) invalid();
        await contents(zip,entry,async()=>{});
        if (target) await mkdir(target,{mode:0o700,recursive:true});
        continue;
      }
      if (target) await mkdir(dirname(target),{mode:0o700,recursive:true});
      const file=target ? await open(target,'wx',mode&0o111 ? 0o700 : 0o600) : undefined;
      const hash=createHash('sha256');
      try {
        await contents(zip,entry,async chunk=>{
          hash.update(chunk);
          if (file) await file.writeFile(chunk);
        });
      } finally { await file?.close(); }
      files.set(path,{size:entry.uncompressedSize,sha256:hash.digest('hex')});
      bytes+=entry.uncompressedSize;
      if (!Number.isSafeInteger(bytes)) invalid();
    }
    if (!manifestSeen) invalid();
    // Validation-only mode does not touch disk. Detect the same implicit directory
    // conflicts as extraction even when children preceded their parent in the ZIP.
    for (const path of paths) {
      for (let i=path.indexOf('/');i!==-1;i=path.indexOf('/',i+1)) {
        if (files.has(path.slice(0,i))) invalid();
      }
    }
    let knowledgeFiles=0, chatFiles=0;
    for (const path of files.keys()) {
      if (/^plugins\/knowledge-local\/(?:knowledge|raw)\/.+\.md$/u.test(path)) knowledgeFiles++;
      if (/^chat-files\/[0-9a-fA-F]{64}$/u.test(path)) chatFiles++;
    }
    return {files:files.size,bytes,coverage:{database:files.has('workbench.sqlite'),knowledgeFiles,chatFiles}};
  } finally {zip.close();}
}

// The final 16 bytes of a SQLite super-journal reference contain its pathname
// length, checksum and journal magic. Its coordinator may be outside staging.
async function checkSingleDatabaseJournal(path:string) {
  const file=await open(path,'r');
  try {
    const {size}=await file.stat();
    if (size<16) return;
    const tail=Buffer.alloc(16);
    if ((await file.read(tail,0,16,size-16)).bytesRead!==16) invalid();
    const length=tail.readUInt32BE(0);
    if (length>0 && length<=size-16 && tail.subarray(8).equals(Buffer.from('d9d505f920a163d7','hex')))
      throw new BackupError('恢复不支持引用跨数据库协调文件的 SQLite 日志。');
  } finally {await file.close();}
}

async function checkDatabase(stage:string) {
  // SQLite can checkpoint a WAL or roll back a hot journal when opening. Only
  // a private scratch copy may be modified, never the bytes verified above.
  const scratch=await mkdtemp(join(dirname(stage),'.super-mario-check-'));
  try {
    const dbName='workbench.sqlite';
    for (const suffix of ['', '-wal', '-journal']) {
      const source=join(stage,dbName+suffix);
      const stat=await statIfPresent(source);
      if (!stat && suffix) continue;
      if (!stat?.isFile()) invalid();
      if (suffix==='-journal') await checkSingleDatabaseJournal(source);
      await copyFile(source,join(scratch,dbName+suffix));
    }
    const db=new DatabaseSync(join(scratch,dbName),{allowExtension:false});
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
      const check=db.prepare('PRAGMA quick_check(1)').get();
      if (check?.quick_check!=='ok' || !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='documents'").get()) invalid();
    } finally {db.close();}
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('备份数据库未通过工作台完整性校验。');
  }
  finally {await rm(scratch,{recursive:true,force:true});}
}

async function statIfPresent(path:string) {
  try {return await lstat(path,{bigint:true});}
  catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error;}
}

export function inspectBackup(archive:string) {
  return scan(archive);
}

export async function readBackup(archive:string,destination?:string):Promise<{files:number;bytes:number}> {
  if (destination===undefined) {
    const {files,bytes}=await scan(archive);
    return {files,bytes};
  }
  const target=resolve(destination);
  if (await statIfPresent(target)) throw occupied();
  const stage=await mkdtemp(join(dirname(target),'.super-mario-restore-'));
  let published=false;
  try {
    const {files,bytes}=await scan(archive,stage);
    await checkDatabase(stage);
    // Reserve the destination with an exclusive mkdir. A concurrent restore can
    // neither take this slot nor merge its files into a partially restored tree.
    try {await mkdir(target,{mode:0o700});}
    catch(error) {if ((error as NodeJS.ErrnoException).code==='EEXIST') throw occupied(); throw error;}
    const reservation=await lstat(target,{bigint:true});
    const ownsSlot=async()=>{
      const current=await statIfPresent(target);
      return current?.isDirectory() && current.dev===reservation.dev && current.ino===reservation.ino;
    };
    try {
      if (!await ownsSlot()) throw occupied();
      await rename(stage,target);
      published=true;
      return {files,bytes};
    } finally {
      if (!published && await ownsSlot()) await rmdir(target).catch(()=>{});
    }
  } finally {
    if (!published) await rm(stage,{recursive:true,force:true});
  }
}
