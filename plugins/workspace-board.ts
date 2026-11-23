import {readBoardActivity,recordBoardActivity} from './workspace-board-activity.ts';
import { randomUUID } from 'node:crypto';
import type { Extension, Json, JsonObject, Store } from '../packages/plugin-sdk/src/index.ts';
import type { Project } from '../packages/protocol/src/index.ts';

type Column = { id: string; title: string };
type Card = { id: string; projectId: string; columnId: string; pinned: boolean; archived: boolean };
type Board = { revision: number; columns: Column[]; cards: Card[] };

const fields = {
  list: [], add_card: ['projectId','columnId'], batch_cards: ['changes'], add_column: ['title'],
  rename_column: ['id','title'], move_column: ['id','beforeId'], remove_column: ['id','moveTo'],
};
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), {status});
}
function object(raw: Json | undefined): JsonObject {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) fail(400,'看板请求格式无效');
  return raw;
}
function keys(input: JsonObject, names: string[]) {
  if (Object.keys(input).some(key=>!names.includes(key))) fail(400,'看板请求包含未知字段');
}
function id(value: Json | undefined) {
  if (typeof value!=='string' || !value.trim() || value.length>256 || /[\p{Cc}\p{Cs}]/u.test(value)) fail(400,'看板 ID 无效');
  return value;
}
function title(value: Json | undefined) {
  if (typeof value!=='string') fail(400,'请输入列名');
  const name=value.trim();
  if (!name || Array.from(name).length>200 || /[\p{Cc}\p{Cs}]/u.test(name)) fail(400,'列名须为 1 至 200 个字符的单行文字');
  return name;
}
function load(store: Store): Board {
  return store.get<Board>('workspace-board','board') ?? {revision:0, columns:[
    {id:'todo',title:'待办'},{id:'doing',title:'进行中'},{id:'review',title:'待审查'},{id:'done',title:'已完成'},
  ], cards:[]};
}
function column(board: Board, value: Json | undefined) {
  const columnId=id(value);
  return board.columns.find(c=>c.id===columnId) ?? fail(404,'看板列不存在');
}
function view(store: Store, board: Board) {
  return {...board, cards:board.cards.map(card=>({
    ...card,title:store.get<Project>('projects',card.projectId)?.name ?? '项目已移除',
  }))};
}
function batchCards(board: Board, raw: Json | undefined) {
  if (!Array.isArray(raw) || !raw.length || raw.length>1000) fail(400,'每批须提交 1 至 1000 张卡片');
  const cards=new Map(board.cards.map(c=>[c.id,c]));
  const changed=new Set<string>();
  for (const entry of raw) {
    const patch=object(entry);
    keys(patch,['id','columnId','beforeId','pinned','archived']);
    if (patch.beforeId !== undefined && patch.columnId === undefined) fail(400,'指定卡片位置时须提供目标列');
    const cardId=id(patch.id);
    if (changed.has(cardId) || Object.keys(patch).length===1) fail(400,'卡片重复或缺少变更字段');
    changed.add(cardId);
    const card=cards.get(cardId) ?? fail(404,'看板卡片不存在');
    for (const field of ['pinned','archived'] as const) {
      const value=patch[field];
      if (value===undefined) continue;
      if (typeof value!=='boolean') fail(400,'卡片置顶和归档必须使用布尔值');
      card[field]=value;
    }
    if (patch.columnId!==undefined) {
      const destination = column(board, patch.columnId);
      const anchor = patch.beforeId === undefined ? undefined : cards.get(id(patch.beforeId));
      // Earlier moves in this batch may already have restored the anchor to its original column.
      if (patch.beforeId !== undefined && (!anchor || anchor === card || anchor.columnId !== destination.id))
        fail(400,'定位卡片必须是目标列中的另一张卡片');
      board.cards.splice(board.cards.indexOf(card), 1);
      card.columnId = destination.id;
      board.cards.splice(anchor ? board.cards.indexOf(anchor) : board.cards.length, 0, card);
    }
  }
}
function update(store: Store, board: Board, action: keyof typeof fields, input: JsonObject) {
  switch(action) {
    case 'add_card': {
      const projectId=id(input.projectId), dest=column(board,input.columnId);
      const project=store.get<Project>('projects',projectId);
      if (!project || project.id!==projectId) fail(404,'项目不存在');
      if (project.archivedAt) fail(409,'项目已归档');
      if (board.cards.some(c=>c.projectId===projectId)) fail(409,'该项目已有看板卡片');
      if (board.cards.length>=1000) fail(400,'看板最多容纳 1000 张卡片');
      board.cards.push({id:randomUUID(),projectId,columnId:dest.id,pinned:false,archived:false});
      return;
    }
    case 'batch_cards': return batchCards(board,input.changes);
    case 'add_column':
      if (board.columns.length>=32) fail(400,'看板最多容纳 32 列');
      board.columns.push({id:randomUUID(),title:title(input.title)});
      return;
    case 'rename_column':
      column(board,input.id).title=title(input.title);
      return;
    case 'move_column': {
      const moving=column(board,input.id);
      const before=input.beforeId===undefined ? undefined : column(board,input.beforeId);
      if (moving===before) return;
      board.columns=board.columns.filter(c=>c!==moving);
      board.columns.splice(before ? board.columns.indexOf(before) : board.columns.length,0,moving);
      return;
    }
    case 'remove_column': {
      const removed=column(board,input.id);
      if (board.columns.length===1) fail(409,'看板至少保留一列');
      const dest=input.moveTo===undefined ? undefined : column(board,input.moveTo);
      if (dest===removed) fail(400,'请选择不同的迁移列');
      const moving=board.cards.filter(c=>c.columnId===removed.id);
      if (moving.length && !dest) fail(409,'该列仍有卡片，请指定迁移列');
      if (dest) board.cards=[...board.cards.filter(c=>c.columnId!==removed.id),...moving.map(c=>({...c,columnId:dest.id}))];
      board.columns=board.columns.filter(c=>c!==removed);
    }
  }
}

export const workspaceBoard: Extension = {
  id:'workspace-board',name:'工作区看板',capabilities:['workspace.board'],
  permissions:['store.read','store.write','events.publish','service.provide:workspace-board.manage','contribute:tools'],
  activate({store,provide,events,contribute}) {
    provide('workspace-board.manage',(raw,signal)=>{
      signal.throwIfAborted();
      const input=object(raw);
      if (input.action==='activity' || input.action==='activity_detail') {
        const {action,...query}=input;
        return readBoardActivity(store,query,action==='activity_detail');
      }
      if (typeof input.action!=='string' || !Object.hasOwn(fields,input.action)) fail(400,'未知的看板操作');
      const action=input.action as keyof typeof fields;
      keys(input,action==='list'?['action']:['action','revision',...fields[action]]);
      if (action==='list') return view(store,load(store));
      const revision=input.revision;
      if (typeof revision!=='number' || !Number.isSafeInteger(revision) || revision<0) fail(400,'看板版本无效');
      const result=store.transaction(()=>{
        const board=load(store);
        if (board.revision!==revision) fail(409,'看板已更新，请刷新后核对');
        const before=structuredClone(view(store,board));
        update(store,board,action,input);
        board.revision++;
        store.put('workspace-board','board',board);
        const after=view(store,board);
        recordBoardActivity(store,before,after);
        return after;
      });
      events.publish('workspace-board.changed',{revision:result.revision});
      return result;
    });
    contribute('tools','workspace_board_activity',{
      name:'workspace_board_activity',description:'只读查询工作区看板活动。可按卡片筛选，以 before 翻页；指定 revision 后以 offset 分页核对这次变更的前后元数据。看板变更不代表执行进度。',
      parameters:{type:'object',additionalProperties:false,properties:{cardId:{type:'string'},before:{type:'integer',minimum:1},
        revision:{type:'integer',minimum:1},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}}},
      async execute(input,signal) {
        signal.throwIfAborted();
        return readBoardActivity(store,input,input.revision!==undefined);
      },
    });
    contribute('tools','workspace_board_read',{
      name:'workspace_board_read',description:'只读查询主人的工作区看板。列是主人维护的项目阶段，卡片置顶、归档或移列不代表项目执行结果。默认列出未归档卡片，使用 nextOffset 翻页。',
      parameters:{type:'object',additionalProperties:false,properties:{columnId:{type:'string'},archived:{type:'boolean'},offset:{type:'integer',minimum:0}}},
      async execute(input,signal) {
        signal.throwIfAborted();
        keys(input,['columnId','archived','offset']);
        const board=load(store), offset=input.offset===undefined ? 0 : input.offset;
        if (typeof offset!=='number' || !Number.isSafeInteger(offset) || offset<0 ||
            (input.archived!==undefined && typeof input.archived!=='boolean')) fail(400,'看板筛选或分页参数无效');
        const selected=input.columnId===undefined ? undefined : column(board,input.columnId);
        const columns=new Map(board.columns.map((c,i)=>[c.id,i]));
        const cards=board.cards.filter(c=>(!selected || selected.id===c.columnId) && c.archived===(input.archived??false))
          .sort((a,b)=>columns.get(a.columnId)!-columns.get(b.columnId)! || Number(b.pinned)-Number(a.pinned));
        return {...view(store,{...board,cards:cards.slice(offset,offset+25)}),nextOffset:offset+25<cards.length ? offset+25 : null};
      },
    });
  },
};
