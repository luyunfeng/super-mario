/** Protected sources are untrusted reference material, never agent instructions. */
export interface KnowledgeSourceResult {
  source: string;
  title: string;
  text: string;
  format: 'markdown' | 'text';
  trust: 'untrusted';
  references: Array<{ url: string; title: string; type: 'docx' | 'file'; token: string }>;
}

export type KnowledgeSourceErrorCode =
  | 'MISSING_PROFILE' | 'INVALID_CONFIG' | 'INVALID_URL' | 'UNTRUSTED_HOST'
  | 'CROSS_ORIGIN' | 'UNAUTHORIZED' | 'CLI_UNAVAILABLE' | 'CLI_FAILED'
  | 'INVALID_RESPONSE' | 'UNSUPPORTED' | 'EMPTY_SOURCE' | 'LIMIT_EXCEEDED'
  | 'CANCELLED' | 'TIMEOUT' | 'UNSAFE_FILE';

/** Trusted dependency injection for tests/hosts only. Never accept this from model arguments.
 * Must honor signal/timeout/output bounds and settle only after its child stops writing.
 */
export type KnowledgeSourceRunCLI = (
  argv: readonly string[],
  options: { cwd: string; signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

export interface KnowledgeSourceReaderOptions {
  /** Explicit user-selected profile. No environment/default-profile fallback. */
  profile?: string;
  /** Exact additional hostnames, supplied by trusted product configuration only. No wildcards. */
  trustedHosts?: readonly string[];
  runCLI?: KnowledgeSourceRunCLI;
}

export interface KnowledgeSourceReader {
  /** Configuration state only; does not probe authorization or CLI availability. */
  status(): { state: 'missing_config' | 'configured'; authorization: 'unchecked' };
  /** Host classification only, including invalid schemes/ports on protected hosts. */
  handles(url: string): boolean;
  read(url: string, options?: { signal?: AbortSignal }): Promise<KnowledgeSourceResult>;
}

/** HTML outside explicit Markdown code is not a normalized document. Fenced,
 * indented and inline examples remain source data, including complete HTML pages.
 */
export function hasKnowledgeSourceHTML(text: string): boolean {
  if (/^\s*<\s*(?:!doctype\s+html|html|head|body|script|form)\b/i.test(text)) return true;
  let fence: { char: string; length: number } | undefined;
  const prose: string[] = [];
  let markdownProse = false;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (start && (start[1]![0] !== '`' || !start[2]!.includes('`'))) {
      fence = { char: start[1]![0]!, length: start[1]!.length }; continue;
    }
    if (markdownProse && /^(?: {4}|\t)/.test(line)) continue;
    prose.push(line);
    if (line.trim() && !/^\s*</.test(line)) markdownProse = true;
  }
  const outsideCode = prose.join('\n').replace(/(`+)([^`]|(?!\1)`)*?\1(?!`)/g, '');
  return /<\s*(?:!doctype\s+html|html|head|body|script|form)\b/i.test(outsideCode);
}
