import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { renderXlsx } from '../plugins/office/xlsx.ts';

async function read(source: string) {
  const { bytes, summary } = await renderXlsx(source, '季度汇总');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  return { workbook, summary };
}

test('读取生成的多表工作簿可还原日期、样式、显式列宽和公式缓存', async () => {
  const { workbook, summary } = await read(JSON.stringify({ sheets: [
    { name: '销售', header: ['月份', '收入', '成本', '利润', '日期'],
      rows: [['一月', 1200.5, 800, '=B2-C2', '2026-01-31'], ['二月', 1350, 900, '=B3-C3', '2026-02-28'],
        ['合计', '=SUM(B2:B3)', '=SUM(C2:C3)', '=SUM(D2:D3)', null]],
      formats: ['', '#,##0.00', '#,##0.00', '#,##0.00', 'yyyy-mm-dd'], widths: [8, 15, 12, 12, 12] },
    { name: '对照', header: ['已审核', '引用'], freeze: false, rows: [[true, "='销售'!B2"]] },
  ] }));
  assert.equal(workbook.title, '季度汇总');
  assert.equal(summary, '2 个工作表，6 行');
  assert.deepEqual(workbook.worksheets.map(s => s.name), ['销售', '对照']);
  const sheet = workbook.getWorksheet('销售')!;
  assert.equal(sheet.views[0]?.state, 'frozen');
  assert.equal(sheet.getCell('A1').font.bold, true);
  assert.equal(sheet.getColumn(2).width, 15);
  assert.equal(sheet.getCell('B2').numFmt, '#,##0.00');
  assert.equal(sheet.getCell('B2').value, 1200.5);
  assert.equal((sheet.getCell('E3').value as Date).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.deepEqual(sheet.getCell('D2').value, { formula: 'B2-C2', result: 400.5 });
  assert.deepEqual(sheet.getCell('D4').value, { formula: 'SUM(D2:D3)', result: 850.5 });
  const other = workbook.getWorksheet('对照')!;
  assert.equal(other.getCell('A2').value, true);
  assert.deepEqual(other.getCell('B2').value, { formula: "'销售'!B2", result: 1200.5 });
  assert.ok(!other.views?.some(view => view.state === 'frozen'));
});

test('CSV 引号、换行、编号和等号均可还原，公式样式的字段保留为文本', async () => {
  const { workbook } = await read('\uFEFF编号,金额,说明,=标题\r\n007,12.5,"第一行,含逗号\n第二行",=B2*2\r\n12345678901234567,-3.5,,\r\n');
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell('A2').value, '007');
  assert.equal(sheet.getCell('A3').value, '12345678901234567');
  assert.equal(sheet.getCell('B2').value, 12.5);
  assert.equal(sheet.getCell('C2').value, '第一行,含逗号\n第二行');
  assert.equal(sheet.getCell('D1').value, '=标题');
  assert.equal(sheet.getCell('D2').value, '=B2*2');
});

test('循环或超出缓存范围的公式保留为公式，工作表名称合法且唯一', async () => {
  const { workbook } = await read(JSON.stringify({ sheets: [
    { name: 'A/B', rows: [['=B1', '=A1', '=IFERROR(A1,7)', '=IFERROR(VLOOKUP(1,A1:B1,2),7)']] }, { name: 'a/b' },
  ] }));
  assert.deepEqual(workbook.worksheets.map(s => s.name), ['A_B', 'a_b (2)']);
  const sheet = workbook.worksheets[0];
  for (const [i, formula] of ['B1', 'A1', 'IFERROR(A1,7)', 'IFERROR(VLOOKUP(1,A1:B1,2),7)'].entries()) {
    assert.equal(sheet.getCell(1, i + 1).formula, formula);
    assert.equal(sheet.getCell(1, i + 1).result, undefined);
  }
});

test('非法表结构、超长单元格、超限行列或畸形 CSV 都会拒绝', async () => {
  for (const source of [
    '{broken', '{}', '{"sheets":[{"rows":"bad"}]}', '{"sheets":[{"rows":[[{}]]}]}', 'A,B\n"未闭合,1',
    JSON.stringify({ sheets: [{ rows: [['文'.repeat(32768)]] }] }),
    JSON.stringify({ sheets: [{ rows: [['=' + 'A'.repeat(8193)]] }] }),
    JSON.stringify({ sheets: [{ rows: [Array(257).fill(null)] }] }),
    JSON.stringify({ sheets: [{ rows: Array(20001).fill([]) }] }),
    JSON.stringify({ sheets: Array(33).fill({}) }),
  ]) await assert.rejects(renderXlsx(source, '合成工作簿'));
});

test('公式缓存遵守运算优先级、Excel 取整、文本和布尔值的语义', async () => {
  const cases = [
    ['2+3*4', 14], ['(2+3)*4', 20], ['-2^2', 4], ['2^3^2', 64], ['20*15%', 3],
    ['(4/2>=1)&" / "&(5<>5)', 'TRUE / FALSE'], ['"净""额"&ROUND(2.345,2)', '净"额2.35'],
    ['ABS(-4.5)', 4.5], ['ROUND(-1.475,2)', -1.48], ['ROUND(626.3,-3)', 1000], ['ROUND(1e300,100)', 1e300],
    ['IF(AND(2>1,OR(FALSE,1),NOT(FALSE)),42,1/0)', 42], ['IF(0,1)', false],
    ['IFERROR(1/0,"未计算")', '未计算'], ['IFERROR(ROUND("NaN",2),7)', 7],
    ['1/0', { error: '#DIV/0!' }], ['ABS("非数字")', { error: '#VALUE!' }],
    ['(-1)^0.5', { error: '#NUM!' }], ['IF(FALSE,SUM("NaN"),1)', 1],
    ['"Alpha"="alpha"', true], ['1<"1"', true], ['SUM(" 2.5e1 ",TRUE)', 26],
  ] as const;
  const { workbook } = await read(JSON.stringify({ sheets: [{ rows: cases.map(([f]) => ['=' + f]) }] }));
  cases.forEach(([formula, result], i) => {
    const cell = workbook.worksheets[0].getCell(i + 1, 1);
    assert.equal(cell.formula, formula);
    assert.deepEqual(cell.result, result, formula);
  });
});

test('聚合区分引用和字面值，跨表范围、美元引用、空值及错误可重新读取', async () => {
  const ref = "'销 售''甲'!";
  const cases = [
    [`SUM(${ref}$A$1:B2)`, 8], [`AVERAGE(${ref}A1:B2)`, 4],
    [`MAX(${ref}B2:A1)`, 6], [`MIN(${ref}A1:B2)`, 2],
    [`COUNT(${ref}A1:D2,TRUE,"7","no")`, 4], [`COUNTA(${ref}A1:D2)`, 5],
    [`SUM(${ref}A1:D2)`, { error: '#N/A' }], [`IFERROR(${ref}D2,18)`, 18],
    [`AND(${ref}A1:C1)`, true], [`OR(${ref}C3:C4)`, { error: '#VALUE!' }],
    [`${ref}C2=""`, true], [`${ref}C2=0`, true], [`${ref}C2=FALSE`, true],
    [`${ref}C2`, 0], [`${ref}C2&"项"`, '项'],
    [`IFERROR('找不到的表'!A1,9)`, 9], ['B1+$B$1+B$1+$B1', 44], ['B2', '下一行'],
  ] as const;
  const { workbook } = await read(JSON.stringify({ sheets: [
    { name: '汇总', rows: cases.map(([f], i) => ['=' + f, i ? '下一行' : 11]) },
    { name: "销 售'甲", rows: [[2, '42', true, null], [6, null, null, '=#N/A']] },
  ] }));
  cases.forEach(([formula, result], i) => {
    const cell = workbook.worksheets[0].getCell(i + 1, 1);
    assert.equal(cell.formula, formula);
    assert.deepEqual(cell.result, result, formula);
  });
});

test('单个区域、全簿累计和嵌套深度均有上限，超限内容保留原公式', async () => {
  const formulas = [
    'IF(TRUE,7,SUM(B1:B1000000))', 'IFERROR(SUM(B1:B1000000),9)', 'SUM(B1:XFE2)',
    'IFERROR(' + '('.repeat(120) + '1' + ')'.repeat(120) + ',9)',
    ...Array(5).fill('SUM(B1:B65536)'), '2*3',
  ];
  const { workbook } = await read(JSON.stringify({ sheets: [{ rows: formulas.map(formula => ['=' + formula]) }] }));
  const sheet = workbook.worksheets[0];
  assert.deepEqual(formulas.map((_, i) => sheet.getCell(i + 1, 1).result), [7, undefined, undefined, undefined, 0, 0, 0, 0, undefined, 6]);
  formulas.forEach((formula, i) => assert.equal(sheet.getCell(i + 1, 1).formula, formula));
});

test('空单元格和返回空字符串的公式在 COUNTA 中有区别', async () => {
  const { workbook } = await read(JSON.stringify({ sheets: [
    { rows: [[null, '=IF(TRUE,"",8)', '=COUNTA(A1:B1)', '=COUNT(A1:B1)', '=B1&"后缀"']] },
  ] }));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell('B1').formula, 'IF(TRUE,"",8)');
  assert.equal(sheet.getCell('C1').result, 1);
  assert.equal(sheet.getCell('D1').result, 0);
  assert.equal(sheet.getCell('E1').result, '后缀');
});
