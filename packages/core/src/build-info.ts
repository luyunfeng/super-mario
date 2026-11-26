import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Which commit a build was made from. Written by the build, never guessed at run time. */
export interface BuildInfo {
  /** The full commit the build was made from, or "unknown" outside a build. */
  commit: string;
  /** When the build ran, as an ISO time, or "unknown". */
  builtAt: string;
  /** The build was made with uncommitted changes, so it matches no commit exactly. */
  dirty: boolean;
}

const unknown: BuildInfo = { commit: 'unknown', builtAt: 'unknown', dirty: false };

/**
 * Reads one build record. Anything that is not a well-formed record reads as unknown: a
 * commit must be a full hash or the word unknown, and the time must be a real instant.
 */
export function parseBuildRecord(text: string): BuildInfo {
  let value: Partial<BuildInfo>;
  try { value = JSON.parse(text) as Partial<BuildInfo>; } catch { return unknown; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const { commit, builtAt, dirty } = value;
  if (commit === 'unknown') return unknown;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return unknown;
  if (typeof builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(builtAt) || Number.isNaN(Date.parse(builtAt))) return unknown;
  // A flag that is not a flag must not read as clean: that would understate what the build is.
  if (dirty !== undefined && typeof dirty !== 'boolean') return unknown;
  return { commit, builtAt: new Date(builtAt).toISOString(), dirty: dirty === true };
}

/**
 * The build writes build-info.json into the output directory beside the compiled modules.
 * After compilation this file is three directories below it (dist/packages/core/src), and in
 * development it is three below it beside the sources (packages/core/src). Reading is
 * attempted from both places, so a missing file is the only failure.
 */
let cached: BuildInfo | undefined;
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of [resolve(here, '../../../build-info.json'), resolve(here, '../../../dist/build-info.json')]) {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    const parsed = parseBuildRecord(raw);
    // A record that reads as unknown in one place may be a valid one in the other, so the
    // first well-formed record wins and an unknown answer does not stop the search.
    if (parsed.commit !== 'unknown') { cached = parsed; return cached; }
  }
  cached = unknown;
  return cached;
}

/** The commit as it is shown to a person: short, and marked when it matches no commit exactly. */
export function buildLabel(info: BuildInfo = buildInfo()): string {
  if (info.commit === 'unknown') return '未构建';
  return info.commit.slice(0, 10) + (info.dirty ? '（含未提交改动）' : '');
}
