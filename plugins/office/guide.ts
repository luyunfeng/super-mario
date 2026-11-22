export const officeWorkerGuide = [
  '仅当这次任务需要生成办公文件时，使用执行机本地的 super-mario office。',
  'Word 或 PowerPoint 先将内容写入 Markdown，Excel 使用 CSV 或包含 sheets 的 JSON。JSON 可为每张表提供 name、header、rows、formats 和 widths。',
  '按独立参数执行 super-mario office <docx|pptx|xlsx> <源文件> -o <同格式的新文件> --title <标题>。参考已有材料时保留来源。配图可放在源文件目录内，通过 Markdown 相对路径引用，也可使用内嵌图片。远程图片只保留说明。',
  '先核验命令回执中的路径、字节数和内容摘要。可用 super-mario office check <办公文件> 复核文档结构，再汇报实际产物。生成失败时报告原因。已有文件需要另选输出名，发送附件须按本轮授权处理。',
].join('\n');

export const officeGuide = {
  name: 'workbench.office', description: '生成可下载的 Word 文档、PowerPoint 演示和 Excel 工作簿。',
  files: new Map([['SKILL.md', [
    '# 生成办公文件',
    '用户只要求解释或草拟内容时直接回复。用户要求文件时，先确定受众、已有材料和交付格式。缺少数据的地方写明，保留原始数字和来源。',
    '用 office_create 的 title、format、source 生成文件。Word 用 Markdown 标题和段落组织报告。PPT 每页一个主题，用独立的 --- 拆页；宁可拆页也不要塞满文字。Excel 用 CSV 表达平表，多表和公式用 JSON；合计、差额、占比应引用数据单元格。',
    '例如工作簿源内容为 {"sheets":[{"name":"交付","header":["计划","完成","剩余"],"rows":[[12,9,"=A2-B2"]]}]}。',
    '根据工具成功回执说明生成的文件名和内容摘要。用户可在 Web 主对话的「办公文件」下载。请求来自飞书时，单独说明下载位置。只有拿到渠道实际发送回执才能说附件已经送达。',
  ].join('\n')]]),
};
