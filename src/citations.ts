/**
 * Mechanical citation checks. A claim that cites `path:line` with a quote is verified against the
 * file on disk; failures are fed back to every participant the next round, which pushes models
 * toward grounded claims and exposes invented ones.
 */
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Evidence } from './schemas.ts';

/** Plenty for any source file. A model picks the path, so a huge file must not be read whole. */
const MAX_BYTES = 8 * 1024 * 1024;

function within(root: string, p: string): boolean {
  const r = relative(root, p);
  return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

/** Reads at most `max` bytes: /proc files report size 0 and some never end. */
function readUpTo(path: string, max: number): string {
  const fd = openSync(path, 'r');
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let total = 0, n = 0; total < max && (n = readSync(fd, buf, 0, Math.min(buf.length, max - total), null)) > 0; total += n) chunks.push(Buffer.from(buf.subarray(0, n)));
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export type CitationStatus = 'verified' | 'wrong_lines' | 'quote_not_found' | 'file_missing' | 'bad_ref' | 'not_checked';

export interface CitationResult {
  ref: string;
  status: CitationStatus;
  detail?: string;
}

// path[:start[-end]] or path#Lstart[-Lend]; the path may contain spaces and, on Windows, a drive colon.
const REF = /^(?<path>.+?)(?:(?::|#L?)(?<start>\d+)(?:[-–:]L?(?<end>\d+))?)?(?::\d+)?$/;

export function parseRef(ref: string): { path: string; start?: number; end?: number } | undefined {
  const cleaned = ref.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/^file:\/\//, '').trim();
  if (!cleaned || /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) return undefined;
  const m = REF.exec(cleaned);
  if (!m?.groups) return undefined;
  const path = m.groups.path.trim();
  if (!path || /[\n\t]/.test(path)) return undefined;
  const start = m.groups.start ? Number(m.groups.start) : undefined;
  const end = m.groups.end ? Number(m.groups.end) : start;
  return { path, start, end: end !== undefined && start !== undefined && end < start ? start : end };
}

function norm(s: string): string {
  return s.replace(/[`“”"']/g, '').replace(/\s+/g, ' ').trim();
}

/** Quotes are often abbreviated with "..."; every fragment has to be present. */
function fragments(quote: string): string[] {
  return quote
    .split(/\.\.\.|…/)
    .map(norm)
    .filter((f) => f.length >= 3);
}

function findLine(lines: string[], frag: string): number | undefined {
  // Search windows of up to 3 joined lines so quotes that wrap still match.
  for (let i = 0; i < lines.length; i++) {
    const w = norm(lines.slice(i, i + 3).join(' '));
    if (w.includes(frag)) return i + 1;
  }
  return undefined;
}

export function checkEvidence(ev: Evidence, cwd: string, slackLines = 3): CitationResult {
  if (ev.type !== 'file') return { ref: ev.ref, status: 'not_checked' };
  const ref = parseRef(ev.ref);
  if (!ref) return { ref: ev.ref, status: 'bad_ref', detail: 'expected path:line or path:start-end' };
  if (/^(https?|ftp):/i.test(ref.path)) return { ref: ev.ref, status: 'not_checked' };
  const path = isAbsolute(ref.path) ? ref.path : normalize(join(cwd, ref.path));
  // Only the project is checked: the results go back to every seat, so a model must not learn about
  // files elsewhere (other folders, /proc) through them. Not a failure either.
  const outside = { ref: ev.ref, status: 'not_checked' as const, detail: 'outside the project folder' };
  if (!within(cwd, path)) return outside;
  if (!existsSync(path) || !statSync(path).isFile()) return { ref: ev.ref, status: 'file_missing', detail: `${ref.path} does not exist` };
  if (!within(realpathSync.native(cwd), realpathSync.native(path))) return outside;
  if (statSync(path).size > MAX_BYTES) return { ref: ev.ref, status: 'not_checked', detail: 'file too large to check' };
  const lines = readUpTo(path, MAX_BYTES).split('\n');
  const frags = ev.quote ? fragments(ev.quote) : [];

  if (ref.start !== undefined) {
    if (ref.start > lines.length) return { ref: ev.ref, status: 'wrong_lines', detail: `file has ${lines.length} lines` };
    if (!frags.length) return { ref: ev.ref, status: 'verified', detail: 'line range exists (no quote to check)' };
    const lo = Math.max(0, ref.start - 1 - slackLines);
    const hi = Math.min(lines.length, (ref.end ?? ref.start) + slackLines);
    const window = norm(lines.slice(lo, hi).join(' '));
    if (frags.every((f) => window.includes(f))) return { ref: ev.ref, status: 'verified' };
    const at = findLine(lines, frags[0]);
    return at
      ? { ref: ev.ref, status: 'wrong_lines', detail: `quote found at line ${at}, not ${ref.start}${ref.end && ref.end !== ref.start ? '-' + ref.end : ''}` }
      : { ref: ev.ref, status: 'quote_not_found', detail: 'quote not found anywhere in the file' };
  }
  if (!frags.length) return { ref: ev.ref, status: 'verified', detail: 'file exists (no line or quote to check)' };
  const at = findLine(lines, frags[0]);
  return at ? { ref: ev.ref, status: 'verified', detail: `quote found at line ${at}` } : { ref: ev.ref, status: 'quote_not_found', detail: 'quote not found in the file' };
}

export function isFailure(r: CitationResult): boolean {
  return r.status !== 'verified' && r.status !== 'not_checked';
}
