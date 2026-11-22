// This cache handles ordinary Excel expressions only. Unsupported syntax, cycles, and work beyond the
// shared budget keep the original formula without a cached result. They are not Excel errors for IFERROR.
import type { Cell, CellErrorValue, Workbook, Worksheet } from 'exceljs';

type Scalar = number | string | boolean | null;
type Fault = CellErrorValue['error'];
type Point = { row: number; col: number };
type Ref = { kind: 'ref'; sheet?: string; start: Point; end?: Point };
type Expr = Ref | { kind: 'literal'; value: Scalar } | { kind: 'fault'; error: Fault }
  | { kind: 'unary'; op: string; arg: Expr } | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'call'; name: string; args: Expr[] };

const uncached = Symbol('not evaluated');
class FormulaError {
  readonly error: Fault;
  constructor(error: Fault) { this.error = error; }
}
const fail = (code: Fault): never => { throw new FormulaError(code); };
const precedence = new Map(Object.entries({ '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1,
  '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }));
const numericText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function point(word: string): Point {
  const match = /^\$?([a-z]{1,3})\$?([1-9]\d{0,6})$/i.exec(word);
  if (!match) throw uncached;
  const col = [...match[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const row = Number(match[2]);
  if (row > 1048576 || col > 16384) throw uncached;
  return { row, col };
}

function parse(source: string): Expr {
  const scan = /\s+|"(?:[^"]|"")*"|'(?:[^']|'')*'|#(?:DIV\/0!|VALUE!|REF!|NUM!|NAME\?|NULL!|N\/A)|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[\p{L}_$][\p{L}\p{N}\p{M}_.$]*|<>|<=|>=|[+*/^%&=<>(),:!-]/iyu;
  const tokens: string[] = [];
  while (scan.lastIndex < source.length) {
    const token = scan.exec(source)?.[0];
    if (!token || tokens.length > 512) throw uncached;
    if (token.trim()) tokens.push(token);
  }
  let at = 0;
  const take = () => tokens[at++] ?? '';
  function eat(token: string) {
    if (tokens[at] !== token) return false;
    at++;
    return true;
  }
  function expression(min: number, depth: number): Expr {
    if (depth > 64) throw uncached;
    const word = take();
    if (!word) throw uncached;
    let left: Expr;
    if (word === '+' || word === '-') {
      left = { kind: 'unary', op: word, arg: expression(6, depth + 1) };
    } else if (word === '(') {
      left = expression(0, depth + 1);
      if (!eat(')')) throw uncached;
    } else if (eat('!')) {
      if (!word.startsWith("'") && !/^[\p{L}\p{N}_.]+$/u.test(word)) throw uncached;
      const sheet = word.startsWith("'") ? word.slice(1, -1).replaceAll("''", "'") : word;
      left = { kind: 'ref', sheet, start: point(take()), end: eat(':') ? point(take()) : undefined };
    } else if (/^[A-Za-z_][A-Za-z_0-9.]*$/.test(word) && eat('(')) {
      const args: Expr[] = [];
      if (!eat(')')) {
        do { args.push(expression(0, depth + 1)); } while (eat(','));
        if (!eat(')')) throw uncached;
      }
      left = { kind: 'call', name: word.toUpperCase(), args };
    } else if (word.startsWith('"')) {
      left = { kind: 'literal', value: word.slice(1, -1).replaceAll('""', '"') };
    } else if (numericText.test(word)) {
      const n = Number(word);
      if (!Number.isFinite(n)) throw uncached;
      left = { kind: 'literal', value: n };
    } else if (/^(true|false)$/i.test(word)) {
      left = { kind: 'literal', value: word.toUpperCase() === 'TRUE' };
    } else if (word.startsWith('#')) {
      left = { kind: 'fault', error: word.toUpperCase() as Fault };
    } else {
      left = { kind: 'ref', start: point(word), end: eat(':') ? point(take()) : undefined };
    }
    while (eat('%')) left = { kind: 'unary', op: '%', arg: left };
    // Excel evaluates operators of equal precedence left to right, including exponentiation.
    while (at < tokens.length) {
      const p = precedence.get(tokens[at]);
      if (p === undefined || p < min) break;
      const op = take();
      left = { kind: 'binary', op, left, right: expression(p + 1, depth + 1) };
    }
    return left;
  }
  const tree = expression(0, 0);
  if (at !== tokens.length) throw uncached;
  return tree;
}

function number(value: Scalar): number {
  if (typeof value === 'string' && !numericText.test(value.trim())) fail('#VALUE!');
  const result = Number(value);
  return Number.isFinite(result) ? result : fail('#VALUE!');
}
function finite(value: number) { return Number.isFinite(value) ? value : fail('#NUM!'); }
function text(value: Scalar) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(Number(value.toPrecision(15)));
  return value ?? '';
}
function comparison(left: Scalar, right: Scalar): number {
  if (left === null) left = typeof right === 'string' ? '' : typeof right === 'boolean' ? false : 0;
  if (right === null) right = typeof left === 'string' ? '' : typeof left === 'boolean' ? false : 0;
  const rank = (x: Scalar) => typeof x === 'string' ? 1 : typeof x === 'boolean' ? 2 : 0;
  if (typeof left !== typeof right) return rank(left) - rank(right);
  if (typeof left === 'string' && typeof right === 'string') {
    left = left.toLowerCase(); right = right.toLowerCase();
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return Number(left) - Number(right);
}

function binary(op: string, a: Scalar, b: Scalar): Scalar {
  if (op === '&') {
    const joined = text(a) + text(b);
    return joined.length <= 32767 ? joined : fail('#VALUE!');
  }
  if (precedence.get(op) === 1) {
    const c = comparison(a, b);
    switch (op) {
      case '=': return c === 0;
      case '<>': return c !== 0;
      case '>': return c > 0;
      case '<': return c < 0;
      case '>=': return c >= 0;
      case '<=': return c <= 0;
    }
  }
  const x = number(a), y = number(b);
  switch (op) {
    case '+': return finite(x + y);
    case '-': return finite(x - y);
    case '*': return finite(x * y);
    case '/': return y === 0 ? fail('#DIV/0!') : finite(x / y);
    case '^': return finite(x ** y);
  }
  throw uncached;
}

function round(value: number, digits: number) {
  const places = Math.trunc(digits);
  if (places > 323) return value;
  if (places < -308) return 0;
  // Excel rounds halves away from zero at 15 significant digits. Split scaling for subnormal numbers.
  const scale = 10 ** Math.min(places, 308), extra = 10 ** Math.max(places - 308, 0);
  const scaled = Number((Math.abs(value) * scale * extra).toPrecision(15));
  if (!Number.isFinite(scaled)) return value;
  return finite(Math.sign(value) * Math.round(scaled) / scale / extra);
}

export function cacheFormulas(book: Workbook) {
  const sheets = new Map(book.worksheets.map(sheet => [sheet.name.toLowerCase(), sheet]));
  const memo = new Map<Cell, Scalar | FormulaError | typeof uncached>();
  let rangeBudget = 262144, expressionBudget = 500000, textBudget = 2 * 1024 * 1024;
  function chargeText(value: Scalar): Scalar {
    if (typeof value === 'string' && (textBudget -= value.length) < 0) throw uncached;
    return value;
  }
  function read(cell: Cell | undefined, depth: number): Scalar {
    if (!cell) return null;
    if (!cell.formula) {
      const value = cell.value;
      if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return chargeText(value ?? null);
      throw uncached;
    }
    if (memo.has(cell)) {
      const result = memo.get(cell)!;
      if (result === uncached || result instanceof FormulaError) throw result;
      return chargeText(result);
    }
    if (depth > 64 || expressionBudget < 1) throw uncached;
    memo.set(cell, uncached); // A reference back to this in-progress expression is a cycle.
    try {
      const result = evaluate(parse(cell.formula), cell.worksheet, depth) ?? 0;
      chargeText(result);
      cell.value = { formula: cell.formula, result };
      memo.set(cell, result);
      return result;
    } catch (error) {
      if (error instanceof FormulaError) {
        cell.value = { formula: cell.formula, result: { error: error.error } };
        memo.set(cell, error);
      }
      throw error;
    }
  }
  function target(ref: Ref, sheet: Worksheet) {
    return ref.sheet === undefined ? sheet : sheets.get(ref.sheet.toLowerCase()) ?? fail('#REF!');
  }
  function evaluate(expr: Expr, sheet: Worksheet, depth: number): Scalar {
    if (depth > 96 || --expressionBudget < 0) throw uncached;
    const evalArg = (arg: Expr) => evaluate(arg, sheet, depth + 1);
    switch (expr.kind) {
      case 'literal': return expr.value;
      case 'fault': return fail(expr.error);
      case 'binary': return chargeText(binary(expr.op, evalArg(expr.left), evalArg(expr.right)));
      case 'unary': {
        const n = number(evalArg(expr.arg));
        return expr.op === '-' ? -n : expr.op === '%' ? n / 100 : n;
      }
      case 'ref': {
        if (expr.end) throw uncached; // Array formulas are calculated by Excel.
        return read(target(expr, sheet).findRow(expr.start.row)?.findCell(expr.start.col), depth + 1);
      }
    }
    const { name, args } = expr;
    const arity = (min: number, max = min) => {
      if (args.length < min || args.length > max) fail('#VALUE!');
    };
    switch (name) {
      case 'IF':
        arity(2, 3);
        return number(evalArg(args[0])) ? evalArg(args[1]) : args[2] ? evalArg(args[2]) : false;
      case 'IFERROR':
        arity(2);
        try { return evalArg(args[0]); }
        catch (error) { if (error instanceof FormulaError) return evalArg(args[1]); throw error; }
      case 'ROUND': arity(2); return round(number(evalArg(args[0])), number(evalArg(args[1])));
      case 'ABS': arity(1); return Math.abs(number(evalArg(args[0])));
      case 'NOT': arity(1); return !number(evalArg(args[0]));
      case 'TRUE': case 'FALSE': arity(0); return name === 'TRUE';
      case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': case 'COUNT': case 'COUNTA': case 'AND': case 'OR': break;
      default: throw uncached;
    }
    let count = 0, sum = 0, low = Infinity, high = -Infinity, truth = name === 'AND';
    function consume(value: Scalar, ref: boolean) {
      if (name === 'COUNTA') { if (value !== null) count++; return; }
      if (name === 'COUNT') {
        const typedNumber = !ref && typeof value === 'string' && numericText.test(value.trim()) && Number.isFinite(Number(value));
        if (typeof value === 'number' || (!ref && typeof value === 'boolean') || typedNumber) count++;
        return;
      }
      if (name === 'AND' || name === 'OR') {
        if (ref && (value === null || typeof value === 'string')) return;
        const next = number(value) !== 0;
        truth = name === 'AND' ? truth && next : truth || next;
        count++;
        return;
      }
      if (value === null || (ref && typeof value !== 'number')) return;
      const n = number(value);
      count++; sum += n; low = Math.min(low, n); high = Math.max(high, n);
    }
    function sample(get: () => Scalar, ref: boolean) {
      try { consume(get(), ref); }
      catch (error) {
        if (!(error instanceof FormulaError) || (name !== 'COUNT' && name !== 'COUNTA')) throw error;
        if (name === 'COUNTA') count++;
      }
    }
    for (const arg of args) {
      if (arg.kind !== 'ref' || !arg.end) {
        sample(() => evalArg(arg), arg.kind === 'ref');
        continue;
      }
      const source = arg.sheet === undefined ? sheet : sheets.get(arg.sheet.toLowerCase());
      if (!source) {
        sample(() => fail('#REF!'), true);
        continue;
      }
      const rows = Math.abs(arg.start.row - arg.end.row) + 1, cols = Math.abs(arg.start.col - arg.end.col) + 1;
      const size = rows * cols;
      if (size > 65536 || size > rangeBudget) throw uncached;
      rangeBudget -= size;
      const top = Math.min(arg.start.row, arg.end.row), left = Math.min(arg.start.col, arg.end.col);
      for (let r = top; r < top + rows; r++) {
        const row = source.findRow(r);
        for (let c = left; c < left + cols; c++) sample(() => read(row?.findCell(c), depth + 1), true);
      }
    }
    switch (name) {
      case 'COUNT': case 'COUNTA': return count;
      case 'MIN': return count ? low : 0;
      case 'MAX': return count ? high : 0;
      case 'SUM': return finite(sum);
      case 'AVERAGE': return count ? finite(sum / count) : fail('#DIV/0!');
      default: return count ? truth : fail('#VALUE!');
    }
  }
  book.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
    if (!cell.formula) return;
    try { read(cell, 0); }
    catch (error) { if (error !== uncached && !(error instanceof FormulaError)) throw error; }
  })));
}
