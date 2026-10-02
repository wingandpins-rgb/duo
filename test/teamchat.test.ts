/**
 * Team chats end to end through the chat engine and claw, with the fake CLIs following FAKE_SCRIPT
 * (test/fakes/common.mjs): Codex is the lead, Claude the worker.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'duo-teamchat-')));
const LOG = join(tmp, 'calls.jsonl');
Object.assign(process.env, {
  DUO_HOME: join(tmp, 'home'),
  DUO_CONFIG: join(tmp, 'config.json'),
  CODEX_HOME: join(tmp, 'codex-home'),
  CLAUDE_CONFIG_DIR: join(tmp, 'claude-home'),
  DUO_CODEX_BIN: join(import.meta.dirname, 'fakes', 'codex.mjs'),
  DUO_CLAUDE_BIN: join(import.meta.dirname, 'fakes', 'claude.mjs'),
  FAKE_LOG: LOG,
});
delete process.env.DUO_DEPTH;

const { loadConfig, resolveClaudeBin, resolveCodexBin } = await import('../src/config.ts');
const { ChatManager } = await import('../src/server/chats.ts');
const { PermissionBroker } = await import('../src/server/permissions.ts');
const { MAX_HOPS } = await import('../src/server/team.ts');
type Bus = import('../src/server/bus.ts').Bus;

const cfg = loadConfig();
const bus = { emit: () => undefined } as unknown as Bus;
const chats = new ChatManager(bus, cfg, { codex: resolveCodexBin(cfg), claude: resolveClaudeBin(cfg) }, new PermissionBroker(bus), { url: 'http://127.0.0.1:9' }, join(import.meta.dirname, '..', 'src', 'server', 'permission-mcp.ts'));
after(async () => {
  await chats.close();
  rmSync(tmp, { recursive: true, force: true });
});

const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function team() {
  return chats.create({ team: true, cwd: tmp, lead: { spec: 'codex:gpt-6-astra@high', access: 'read-only' }, worker: { spec: 'claude:opus@high', access: 'full' } });
}

/** Wait until the chat's exchange is over. */
async function settled(id: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = chats.get(id);
    if (!chats.summary(s).running && s.turns.every((t) => t.status !== 'running')) return;
    await sleep(50);
  }
  throw new Error('the team chat did not settle');
}

function script(steps: { match: string; reply: string; tools?: { name: string; input: unknown }[]; delayMs?: number }[]): void {
  process.env.FAKE_SCRIPT = JSON.stringify(steps);
}

after(() => {
  delete process.env.FAKE_SCRIPT;
});

test('the lead hands a task to the worker, gets its report with what it actually did, and hands back to the user', { timeout: 60_000 }, async () => {
  rmSync(LOG, { force: true });
  script([
    { match: 'STEP-B', reply: '@you Finished; STEP-C reviewed.' },
    { match: 'STEP-A', reply: 'Done STEP-B. I read the whole plan.', tools: [{ name: 'Read', input: { file_path: join(tmp, 'docs', 'PLAN.md'), offset: 1, limit: 40 } }, { name: 'Bash', input: { command: 'npm test' } }] },
    { match: 'TASK-1', reply: '@Opus Do STEP-A in src/loader.ts.' },
  ]);
  const s = team();
  assert.deepEqual(s.members!.map((m) => [m.name, m.role]), [['Astra', 'lead'], ['Opus', 'worker']]);
  chats.send(s.id, 'Please handle TASK-1');
  await settled(s.id);
  const turns = chats.get(s.id).turns;
  assert.deepEqual(turns.map((t) => [t.speaker, t.from, t.to, t.status]), [
    ['Astra', 'you', 'Opus', 'done'],
    ['Opus', 'Astra', 'Astra', 'done'],
    ['Astra', 'Opus', 'you', 'done'],
  ]);
  const codex = calls().filter((c) => c.cli === 'codex' && c.prompt);
  assert.match(codex[0].prompt, /You are Astra, the lead/, 'the lead gets its rules on its first message');
  const report = codex[1].prompt;
  assert.match(report, /Opus: Done STEP-B\. I read the whole plan\./);
  assert.match(report, /What Opus actually did \(its tool calls\):\n- read docs\/PLAN\.md \(lines 1-40\)\n- ran `npm test`/, 'the claim and the record side by side');
  const worker = calls().find((c) => c.cli === 'claude' && c.args);
  const flag = (f: string) => worker.args[worker.args.indexOf(f) + 1];
  assert.match(flag('--append-system-prompt'), /You are Opus, working in a team chat with Astra/);
  assert.match(flag('--allowed-tools'), /mcp__duo__ask_lead/);
  const mcp = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.duo;
  assert.equal(mcp.env.DUO_TEAM_LEAD, 'Astra');
  assert.equal(mcp.env.DUO_API_TOKEN === undefined, false);
});

test('a message to the worker goes to it directly, and the lead still learns of it', { timeout: 60_000 }, async () => {
  rmSync(LOG, { force: true });
  script([
    { match: 'REPORT-2', reply: '@you Noted.' },
    { match: 'DIRECT-1', reply: 'REPORT-2: renamed it.' },
  ]);
  const s = team();
  chats.send(s.id, '@Opus DIRECT-1 rename the loader');
  await settled(s.id);
  assert.deepEqual(chats.get(s.id).turns.map((t) => [t.speaker, t.from, t.to]), [['Opus', 'you', 'Astra'], ['Astra', 'Opus', 'you']]);
  const lead = calls().filter((c) => c.cli === 'codex' && c.prompt).pop();
  assert.match(lead.prompt, /Since your last message:\n- The user to Opus: @Opus DIRECT-1 rename the loader/);
});

test('members passing messages forever are paused for the user', { timeout: 120_000 }, async () => {
  script([
    { match: 'Astra: @Opus ping', reply: '@Astra pong' },
    { match: 'pong', reply: '@Opus ping' },
    { match: 'START', reply: '@Opus ping' },
  ]);
  const s = team();
  chats.send(s.id, 'START');
  await settled(s.id, 110_000);
  const turns = chats.get(s.id).turns;
  assert.equal(turns.length, MAX_HOPS);
  assert.match(String(turns[turns.length - 1].blocks.find((b) => b.kind === 'note')?.text), new RegExp(`Paused after ${MAX_HOPS} messages between Astra and Opus`));
});

test('Stop ends the exchange, whoever is working', { timeout: 60_000 }, async () => {
  script([
    { match: 'SLOW-1', reply: 'done', delayMs: 20_000 },
    { match: 'GO-1', reply: '@Opus SLOW-1' },
  ]);
  const s = team();
  chats.send(s.id, 'GO-1');
  const end = Date.now() + 30_000;
  while (Date.now() < end && !chats.get(s.id).turns.some((t) => t.speaker === 'Opus')) await sleep(50);
  await sleep(500);
  assert.equal(chats.stop(s.id), true);
  await settled(s.id, 20_000);
  const turns = chats.get(s.id).turns;
  assert.deepEqual(turns.map((t) => [t.speaker, t.status]), [['Astra', 'done'], ['Opus', 'stopped']]);
});

test('the worker asks the lead mid-task and gets its answer; the question is in the conversation', { timeout: 60_000 }, async () => {
  rmSync(LOG, { force: true });
  script([
    { match: 'QUESTION-1', reply: 'Use korea-debug, never x86.' },
    { match: 'REPORT-3', reply: '@you Good.' },
    { match: 'WORK-3', reply: 'REPORT-3 imported.', tools: [{ name: 'Read', input: { file_path: join(tmp, 'Item.txt') } }], delayMs: 4000 },
    { match: 'BEGIN-3', reply: '@Opus WORK-3 import the items' },
  ]);
  const s = team();
  assert.match(await chats.askLead(s.id, 'Which catalog?'), /not running/);
  chats.send(s.id, 'BEGIN-3');
  const end = Date.now() + 30_000;
  while (Date.now() < end && !chats.get(s.id).turns.some((t) => t.speaker === 'Opus')) await sleep(50);
  await sleep(300);
  assert.equal(await chats.askLead(s.id, 'QUESTION-1: which catalog?'), 'Use korea-debug, never x86.');
  await settled(s.id);
  const turns = chats.get(s.id).turns;
  assert.deepEqual(turns.map((t) => [t.speaker, t.from, t.to, !!t.question]), [
    ['Astra', 'you', 'Opus', false],
    ['Opus', 'Astra', 'Astra', false],
    ['Astra', 'Opus', 'Opus', true],
    ['Astra', 'Opus', 'you', false],
  ]);
  const prompts = calls().filter((c) => c.cli === 'codex' && c.prompt).map((c) => c.prompt);
  assert.match(prompts[1], /Opus: QUESTION-1: which catalog\?[\s\S]*asks this in the middle of its work/);
  // The report that follows lists the worker's whole turn, and does not repeat the question as news.
  assert.match(prompts[2], /What Opus actually did \(its tool calls\):\n- read Item\.txt/);
  assert.doesNotMatch(prompts[2], /Since your last message/);
});

test('a plain chat still answers on its own', { timeout: 60_000 }, async () => {
  delete process.env.FAKE_SCRIPT;
  const s = chats.create({ engine: 'claude', cwd: tmp, spec: 'claude:sonnet@low', access: 'full' });
  chats.send(s.id, 'hello');
  await settled(s.id);
  const t = chats.get(s.id).turns[0];
  assert.equal(t.status, 'done');
  assert.equal(t.speaker, undefined);
  assert.match(String(t.blocks.find((b) => b.kind === 'text')?.text), /claude answer 1/);
});
