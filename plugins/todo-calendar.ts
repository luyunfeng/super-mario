import type { Extension } from '../packages/plugin-sdk/src/index.ts';

export const todoCalendar: Extension = {
  id: 'todo-calendar', name: '待办日历', capabilities: ['todos.calendar'],
  navigation: [{ id: 'calendar', label: '待办日历', route: '#projects/all/todos/month' }],
  activate() {},
};
