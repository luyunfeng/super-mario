import {runPersonalCLI,type PersonalCLI,personalProblem} from './feishu-personal.ts';
import {CommentWriteError} from './knowledge-document-comments.ts';

type CommentPerson = {openId:string;name:string;department?:string};

export async function searchKnowledgeCommentPeople(profile:string,query:string,signal:AbortSignal,run:PersonalCLI=runPersonalCLI):Promise<{people:CommentPerson[];truncated:boolean}> {
  if (typeof profile!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile)) throw new CommentWriteError(400,'请先配置飞书读取账号');
  if (typeof query!=='string' || !query.trim() || Array.from(query.trim()).length>50 || /[\p{Cc}\p{Cs}]/u.test(query)) throw new CommentWriteError(400,'请输入 1 至 50 个字符的搜索词');
  signal.throwIfAborted();
  let envelope;
  try {
    envelope=await run(['contact','+search-user','--query',query.trim(),'--page-size','20','--as','user','--profile',profile,'--format','json'],{signal});
  } catch(error) {
    signal.throwIfAborted();
    const kind=personalProblem(error)?.kind;
    if (kind==='permissions' || kind==='expired' || kind==='denied') throw new CommentWriteError(403,'当前飞书账号未获通讯录搜索权限或授权已过期');
    if (kind==='rate_limited') throw new CommentWriteError(429,'飞书暂时限制了通讯录搜索频率');
    throw new CommentWriteError(503,'无法读取当前飞书账号的联系人搜索结果');
  }
  signal.throwIfAborted();
  const data=envelope?.data;
  if (envelope?.ok!==true || envelope.identity!==undefined && envelope.identity!=='user' || !Array.isArray(data?.users) ||
      (data.has_more!==undefined && typeof data.has_more!=='boolean')) throw new CommentWriteError(502,'飞书联系人搜索回执无效');
  const people:CommentPerson[]=[],seen=new Set<string>();
  for (const row of data.users.slice(0,20)) {
    const openId=row?.open_id,name=row?.localized_name;
    if (typeof openId!=='string' || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(openId) || typeof name!=='string' || !name ||
        name!==name.trim() || Array.from(name).length>128 || /[\p{Cc}\p{Cs}]/u.test(name)) throw new CommentWriteError(502,'飞书联系人搜索回执无效');
    if (seen.has(openId)) continue;
    seen.add(openId);
    const department=typeof row.department==='string' ? row.department.trim() : '';
    people.push({openId,name,...(department && !/[\p{Cc}\p{Cs}]/u.test(department) && {department:Array.from(department).slice(0,128).join('')})});
  }
  return {people,truncated:data.has_more===true || data.users.length>20};
}
