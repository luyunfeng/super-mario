import { existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { tmpdir } from 'node:os';

const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const piPackage = /^@(?:earendil-works|mariozechner)\/pi(?:-|\/|$)/;
function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : entry.isFile() && sourcePattern.test(entry.name) ? [path] : [];
  });
}

/** Apply one policy to every plugin, including builtins and nested examples. */
export function checkPluginBoundaries(root = process.cwd()) {
  root = resolve(root);
  const files = filesIn(root);
  const violations = [];
  let pluginFiles = 0;
  // TS 7 exposes parsing through its native API; use a temporary project so the
  // same file list is checked even when --root has no tsconfig of its own.
  const directory = mkdtempSync(resolve(tmpdir(), 'mario-boundary-parser-'));
  const config = resolve(directory, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ files, compilerOptions: { allowJs: true, noResolve: true, noLib: true } }));
  const api = new API();
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config).program;
    for (const file of files) {
      const path = relative(root, file).replaceAll('\\', '/');
      const plugin = path.startsWith('plugins/');
      if (plugin) pluginFiles++;
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`Cannot parse ${file}`);
      const report = (node, specifier, reason) => violations.push({ path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, specifier, reason });
      let controlledEffects = false;
      function detectEffects(node) { if (ts.isPropertyAssignment(node) && node.name.getText(source).replaceAll("'",'').replaceAll('"','') === 'effects' && ts.isStringLiteral(node.initializer) && ['none','ledger'].includes(node.initializer.text)) controlledEffects = true; node.forEachChild(detectEffects); }
      if (plugin) detectEffects(source);
      const inspect = (node, argument) => {
        if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
          if (plugin) report(node, argument?.getText(source) ?? '<missing>', 'non-literal import cannot be checked');
          return;
        }
        const specifier = argument.text;
        if (plugin && controlledEffects && /^(?:node:)?(?:net|https?|dns|child_process|fs)(?:\/|$)/.test(specifier)) report(node,specifier,'ledger/none event handlers cannot import direct I/O; declare direct');
        if (piPackage.test(specifier) && !path.startsWith('tests/') && !path.startsWith('packages/core/src/agent-runtime/')) {
          report(node, specifier, 'pi SDK is private to core/agent-runtime');
          return;
        }
        if (!plugin) return;
        // Resolve relative paths before checking: nested examples get no special exemption.
        if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file:')) {
          let target;
          try { target = specifier.startsWith('file:') ? fileURLToPath(specifier) : resolve(dirname(file), specifier); }
          catch { report(node, specifier, 'invalid file import'); return; }
          const local = relative(root, target).replaceAll('\\', '/');
          if (local.startsWith('plugins/')) return;
          if (/^packages\/(plugin-sdk|protocol)\/src\/index\.(ts|js)$/.test(local)) return;
          report(node, specifier, 'plugins may only import local plugins or public SDK/protocol entries');
          return;
        }
        if (['@super-mario/plugin-sdk', '@super-mario/protocol', 'super-mario/plugin-sdk', 'super-mario/protocol'].includes(specifier)) return;
        if (/^(?:@super-mario\/|super-mario(?:\/|$))/.test(specifier) || specifier.startsWith('#') || /(?:^|\/)agent-runtime(?:\/|$)/.test(specifier)) {
          report(node, specifier, 'private project import');
        }
      };
      const visit = node => {
        if (plugin && controlledEffects && ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text==='fetch' || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text==='fetch')) report(node,'fetch','ledger/none event handlers cannot call fetch; use host services');
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier) inspect(node, node.moduleSpecifier);
        } else if (ts.isImportTypeNode(node)) {
          inspect(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          inspect(node, node.arguments[0]);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          inspect(node, node.moduleReference.expression);
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
    return { pluginFiles, violations };
  } finally {
    snapshot?.dispose();
    api.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Return the exit status explicitly so callers can verify the same CI gate. */
export function runCli(args = [], log = console.log, error = console.error) {
  if (args.length && (args.length !== 2 || args[0] !== '--root')) {
    error('Usage: node scripts/check-plugin-boundaries.mjs [--root <directory>]');
    return 1;
  }
  const result = checkPluginBoundaries(args[1]);
  for (const issue of result.violations) error(`${issue.path}:${issue.line}: forbidden import ${JSON.stringify(issue.specifier)} (${issue.reason})`);
  if (result.violations.length) return 1;
  log(`Plugin boundaries OK (${result.pluginFiles} plugin files checked).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
