import type { Todo } from '../../protocol/src/index.ts';

export function actionTodoLink(todo: Pick<Todo,'id'|'projectId'>) {
  const webPath = '#projects/' + encodeURIComponent(todo.projectId ?? 'all') + '/todos/detail/' + encodeURIComponent(todo.id);
  return { webPath, webCitation: '[查看待办](' + webPath + ')' };
}

export function ownerReviewLink(item:{todoId:string;projectId?:string;runId:string;version:number;evidenceVersion:string}) {
  const {webPath}=actionTodoLink({id:item.todoId,projectId:item.projectId});
  const query=new URLSearchParams({reviewRun:item.runId,reviewVersion:String(item.version),reviewEvidence:item.evidenceVersion});
  const href=webPath+'?'+query;
  return {href,label:'查看待验收交付'};
}
