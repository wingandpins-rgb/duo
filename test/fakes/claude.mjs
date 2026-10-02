#!/usr/bin/env node
// Stand-in for Claude Code's `-p --input-format stream-json --output-format stream-json` in tests.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { instance, record, scripted, valueOf } from './common.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.999 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' }));
  process.exit(0);
}
const sid = valueOf(args, '--session-id') ?? valueOf(args, '--resume') ?? 'fake-session';
const schema = valueOf(args, '--json-schema');
const mode = process.env.FAKE_CLAUDE_MODE ?? '';
record({ cli: 'claude', args, cwd: process.cwd() });
// Asked for a sandbox it cannot start (Claude Code on Windows, for now): it says so on stderr and goes on.
if (mode === 'no-sandbox' && args.some((a, i) => args[i - 1] === '--settings' && a.includes('"sandbox"'))) {
  process.stderr.write('\n⚠ Sandbox disabled: sandbox is enabled but the Windows sandbox is not active on this session (feature gate off)\n  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n\n');
}
// A CLI that cannot start at all (expired install, broken update).
if (mode === 'no-start') process.exit(1);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-fake' });

let turns = 0;
let cost = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type !== 'user') continue;
  turns++;
  const prompt = (msg.message?.content ?? []).map((c) => c.text ?? '').join('');
  record({ cli: 'claude', turn: turns, session: sid, prompt });
  // A tool call that started something which outlives the turn (a dev server, a watcher). Unref'd, so
  // the fake still exits as soon as its stdin closes and leaves the child behind. On Windows, Node
  // ties a child it starts to its own lifetime unless it is detached; Claude Code does not, so the
  // fake detaches there. (On Unix the child stays in the fake's process group, as Claude's do.)
  if (mode === 'child' && turns === 1) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true });
    child.unref();
    record({ cli: 'claude', child: child.pid });
  }
  if (mode === 'old') {
    out({ type: 'result', subtype: 'success', is_error: true, result: "API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.", session_id: sid, user_message_uuids: [msg.uuid], usage: {}, total_cost_usd: 0 });
    continue;
  }
  const step = scripted(prompt);
  if (step?.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
  (step?.tools ?? []).forEach((t, i) => {
    const id = `tu${turns}-${i}`;
    out({ type: 'assistant', message: { id: `m${turns}t${i}`, content: [{ type: 'tool_use', id, name: t.name, input: t.input }] }, session_id: sid });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: !!t.error }] }, session_id: sid });
  });
  const text = step?.reply ?? `claude answer ${turns}: ${prompt.length} chars`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: `m${turns}` } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { id: `m${turns}`, content: [{ type: 'text', text }] }, session_id: sid });
  cost += 0.01;
  const structured = schema ? instance(JSON.parse(schema), { answer: text }) : undefined;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: structured ? JSON.stringify(structured) : text, structured_output: structured, session_id: sid, user_message_uuids: [msg.uuid], usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 20 }, total_cost_usd: cost });
  // Simulate a CLI that goes away between turns (crash, update, laptop sleep).
  if (mode === 'die-after-1' && !args.includes('--resume')) process.exit(0);
}
