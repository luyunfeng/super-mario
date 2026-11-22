import ExcelJS from 'exceljs';
import { cacheFormulas } from './formula-cache.ts';
import { parse } from 'csv-parse/sync';
import { officeSourceLimit } from './render.ts';

const maxRows = 20_000, maxColumns = 256, maxCells = 120_000, maxSheets = 32;
const invalidXmlText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\p{Cs}]/u;
const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function invalid(reason: string): never {
  throw Object.assign(new Error(reason), { status: 400 });
}

function list(value: unknown, field: string, limit: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) invalid(`${field} 必须是最多 ${limit} 项的数组`);
  return value;
}

function label(name: unknown, index: number, used: Set<string>) {
  if (name !== undefined && typeof name !== 'string') invalid('工作表名称须为文本');
  if (typeof name === 'string' && invalidXmlText.test(name)) invalid('工作表名称含无效文本字符');
  const base = (name ?? '').trim().replace(/[\[\]:*?/\\\p{Cc}]/gu, '_').replace(/^'+|'+$/g, '') || 'Sheet' + index;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ' (' + n + ')';
    const cut = base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$|'$/g, '');
    const result = cut + suffix;
    if (result.toLowerCase() === 'history' || used.has(result.toLowerCase())) continue;
    used.add(result.toLowerCase());
    return result;
  }
}

function csvNumber(text: string) {
  if (!numberToken.test(text) || /^[+-]?0\d/.test(text)) return text;
  const number = Number(text);
  // Excel reliably stores 15 significant decimal digits. Keep identifiers and higher precision outside that range as text.
  const digits = text.split(/e/i)[0].replace(/[^0-9]/g, '').replace(/^0+|0+$/g, '');
  return Number.isFinite(number) && digits.length <= 15 && (number !== 0 || !digits) ? number : text;
}

function dateValue(text: string, format: string) {
  if (!/[dy]|mmm/i.test(format.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ''))) return;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(text);
  if (!match || match[1] < '1900-01-01') return;
  // Excel stores local wall time without a time zone, and reserves serial 60 for 1900-02-29.
  const iso = match[1] + 'T' + (match[2] ?? '00') + ':' + (match[3] ?? '00') + ':' + (match[4] ?? '00') + 'Z';
  const date = new Date(iso);
  if (Number.isFinite(date.valueOf()) && date.toISOString().startsWith(match[1])) {
    return (date.valueOf() - Date.UTC(1899, 11, 30)) / 86400000 - (match[1] < '1900-03-01' ? 1 : 0);
  }
}

export async function renderXlsx(source: string, title: string): Promise<{ bytes: Buffer; summary: string }> {
  const input = source.replace(/^\uFEFF/, '');
  if (!input.trim() || Buffer.byteLength(input) > officeSourceLimit) invalid('工作簿源内容为空或超过 512 KiB');
  const csv = !input.trimStart().startsWith('{');
  let sheets: unknown[];
  if (csv) {
    let fields = 0;
    const records: string[][] = parse(input, { relax_column_count: true, skip_empty_lines: true,
      on_record(record: string[], context: { records: number }) {
        fields += record.length;
        if (fields > maxCells || record.length > maxColumns || context.records > maxRows) invalid('CSV 行数、列数或单元格数量超限');
        return record;
      } });
    sheets = [{ header: records.shift(), rows: records }];
  } else {
    let spec;
    try { spec = JSON.parse(input); } catch { invalid('工作簿 JSON 无效'); }
    sheets = list(spec?.sheets, 'sheets', maxSheets);
    if (!sheets.length) invalid('工作簿至少需要一个工作表');
  }
  const book = new ExcelJS.Workbook();
  book.title = title;
  book.calcProperties.fullCalcOnLoad = true;
  const names = new Set<string>();
  let totalCells = 0, totalRows = 0;
  for (const item of sheets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('工作表须为对象');
    const spec = item as Record<string, unknown>;
    const header = list(spec.header, 'header', maxColumns), rows = list(spec.rows, 'rows', maxRows);
    const formats = list(spec.formats, 'formats', maxColumns), widths = list(spec.widths, 'widths', maxColumns);
    if (header.some(v => typeof v !== 'string')) invalid('表头须为文本');
    if (formats.some(v => typeof v !== 'string' || v.length > 255 || invalidXmlText.test(v))) invalid('数字格式须为不超过 255 字符的文本');
    if (widths.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 255)) invalid('列宽须在 0 至 255 之间');
    if (spec.freeze !== undefined && typeof spec.freeze !== 'boolean') invalid('freeze 须为布尔值');
    const data = header.length ? [header, ...rows] : rows;
    if (data.length > maxRows) invalid('工作表行数超限');
    totalRows += data.length;
    const sheet = book.addWorksheet(label(spec.name, names.size + 1, names));
    const columnWidths: number[] = [];
    if (spec.freeze ?? header.length > 0) sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const [r, row] of data.entries()) {
      if (!Array.isArray(row) || row.length > maxColumns) invalid('工作表的行须为数组，且不超过 256 列');
      totalCells += row.length;
      if (totalCells > maxCells) invalid('工作簿单元格超过 120000 个');
      const isHeader = r === 0 && !!header.length;
      for (const [c, raw] of row.entries()) {
        const cell = sheet.getCell(r + 1, c + 1);
        const format = isHeader ? '' : String(formats[c] ?? '');
        if (typeof raw === 'string') {
          if (invalidXmlText.test(raw)) invalid('单元格含无效文本字符');
          if (raw.length > 32767) invalid('单元格超过 32767 个字符');
          if (!csv && raw.startsWith('=') && raw.length > 1) {
            if (raw.length - 1 > 8192) invalid('公式超过 8192 个字符');
            cell.value = { formula: raw.slice(1) };
          } else cell.value = csv && !isHeader ? csvNumber(raw) : dateValue(raw, format) ?? raw;
        } else if (raw === null || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) cell.value = raw;
        else invalid('单元格须为空、文本、有限数字或布尔值');
        if (isHeader) {
          cell.font = { bold: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3EBF4' } };
        } else if (format) cell.numFmt = format;
        columnWidths[c] = Math.max(columnWidths[c] ?? 8, Math.min(60, String(raw ?? '').length + 2));
      }
    }
    for (const [c, width] of columnWidths.entries()) sheet.getColumn(c + 1).width = Number(widths[c]) || width;
  }
  cacheFormulas(book);
  return { bytes: Buffer.from(await book.xlsx.writeBuffer()), summary: `${sheets.length} 个工作表，${totalRows} 行` };
}
