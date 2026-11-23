import type { Todo } from '../../protocol/src/index.ts';

export function actionTodoLink(todo: Todo) {
  const webPath = '#projects/' + encodeURIComponent(todo.projectId ?? 'all') + '/todos/detail/' + encodeURIComponent(todo.id);
  return { webPath, webCitation: '[查看待办](' + webPath + ')' };
}
