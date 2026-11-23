type ScheduledWorkTemplate = { id: string; title: string; prompt: string; doneWhen: string }
  & ({ days: number[]; time: string } | { everyMinutes: number });

// The user supplies the executor and timezone. Templates grant no access to external accounts.
export const scheduledWorkTemplates: ScheduledWorkTemplate[] = [
  {
    id: 'meeting', title: '会前准备', days: [1, 2, 3, 4, 5], time: '08:45',
    prompt: '查看今天已接入的飞书日程。对需要准备的会议，核对议程、上次纪要和相关文档，列出未决问题、发言要点和来源。按会议给出提前十分钟的准备时间。只有具备提醒工具且在本次授权范围内时才安排提醒，按回执报告。无法读取日程时说明缺少的连接。',
    doneWhen: '逐场列出会议时间、准备事项和提醒状态。当天没有会议时说明已核对的范围。',
  },
  {
    id: 'weekly', title: '周报草稿', days: [5], time: '17:00',
    prompt: '根据本周可读取的日程、纪要、消息和执行记录起草周报。按事项归纳进展、已交付结果、阻碍和下周计划，关键结论附来源。区分执行结束和待办已验收。资料缺失处标明待补，只将草稿交给用户审阅。',
    doneWhen: '交付一份可编辑的周报草稿，列明证据和待核对事项，等待用户修改。',
  },
  {
    id: 'patrol', title: '执行巡检', everyMinutes: 30,
    prompt: '核对已连接电脑上的执行记录、待审批动作和验收状态。列出等待用户决定、执行失败、进度异常或已交付待验收的事项，每项注明电脑、记录和需要处理的动作。无法判断进度时标明原因，只汇报，不重启任务。',
    doneWhen: '按电脑列出需要处理的事项，区分未连接、结果未知和已核对且无需处理。',
  },
  {
    id: 'wrapup', title: '下班前盘点', days: [1, 2, 3, 4, 5], time: '18:30',
    prompt: '从当前范围的消息、待办、执行记录和明早的飞书日程中，核对仍待回复、已承诺未完成、执行中和需要会前准备的事项。按紧急程度排列，注明依据和缺失来源。最后询问哪些事项需要提醒。',
    doneWhen: '交付当日盘点和明早准备清单，由用户选定需要提醒的事项。',
  },
];
