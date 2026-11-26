// What the main conversation is told of models by purpose: where the setting is, why a purpose
// may have stopped for the day, and what a fallback does and does not do.
export const modelRoutingGuidance = [
  '主人问为什么后台督办、项目经验提炼、回复翻译或收件箱整理今天没有工作，或问它们用的是什么型号时，先用 model_routing_read 读取当前设置。',
  '按用途分别回答：是否跟随主模型、当前型号、备用型号、今日已用次数和每日上限。',
  '回答达到上限时，说明是哪一个用途、用了多少次、上限多少，以及按主人时区到第二天恢复。',
  '主人要给某个用途换型号、设备用型号或每日上限时，说明在 Web 的「Agent → 更改模型 → 按用途分模型」里设置。这里只读，不替主人改设置。型号须在同一接入下。',
  '备用型号只在首选型号不存在时启用。调用中途的失败不会自动换型号重试，以免重复执行工具。最近发生过回退时，如实说明从哪个型号换到了哪个。',
  '主人问主对话本身的模型时，仍按模型清单的指引回答。',
].join('');
