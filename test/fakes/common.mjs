// Shared by the fake CLIs: a minimal instance of a JSON schema (first enum value, empty arrays).
import { appendFileSync } from 'node:fs';

export function instance(schema, overrides = {}) {
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  if (schema.enum) return schema.enum[0];
  if (t === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) o[k] = k in overrides ? overrides[k] : instance(v);
    return o;
  }
  if (t === 'array') return [];
  if (t === 'number' || t === 'integer') return 0.5;
  if (t === 'boolean') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return null;
  return 'fake';
}

export function record(entry) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n');
}

/**
 * Team-chat tests: FAKE_SCRIPT is a JSON list of { match, reply, tools?, delayMs? }. The first entry
 * whose `match` is in the prompt answers it, after `delayMs`, using `tools` (Claude) first.
 */
export function scripted(prompt) {
  for (const e of process.env.FAKE_SCRIPT ? JSON.parse(process.env.FAKE_SCRIPT) : []) if (prompt.includes(e.match)) return e;
  return undefined;
}

export function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
