import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Block } from '../src/live.ts';
import { activity, addressee, memberName, teamInput, teamRules, unseen, type ChatMember, type TeamTurn } from '../src/server/team.ts';

const members = [{ name: 'Astra' }, { name: 'Opus' }];
const text = (t: string): Block[] => [{ id: 't', kind: 'text', text: t, phase: 'final', status: 'done' }];
const tool = (name: string, input: unknown, extra: Partial<Block> = {}): Block => ({ id: name, kind: 'tool', name, input: JSON.stringify(input), status: 'done', ...extra });

test('members are named after their model family', () => {
  assert.equal(memberName('codex', 'gpt-6-astra'), 'Astra');
  assert.equal(memberName('codex', 'gpt-6.1-sol'), 'Sol');
  assert.equal(memberName('claude', 'opus'), 'Opus');
  assert.equal(memberName('claude', 'claude-opus-5-5'), 'Opus');
  assert.equal(memberName('claude', 'opus[1m]'), 'Opus');
  assert.equal(memberName('codex', 'gpt-5.5'), 'Codex');
});

test('a message is for the member named at its start, or the user', () => {
  assert.equal(addressee('@Opus build the loader', members), 'Opus');
  assert.equal(addressee('  @opus: build it', members), 'Opus');
  assert.equal(addressee('@you it is done', members, 'Astra'), 'you');
  assert.equal(addressee('Done. @Opus next', members), undefined, 'only at the start');
  assert.equal(addressee('@Astra talking to myself', members, 'Astra'), undefined, 'never itself');
  assert.equal(addressee('@Nobody hello', members), undefined);
});

test('what the worker did is listed from its tool calls, with the lines it read and full paths outside the project', () => {
  const cwd = join('C:', 'GoonZuProject');
  const did = activity([
    tool('Read', { file_path: join(cwd, 'docs', 'PLAN.md') }),
    tool('Read', { file_path: join(cwd, 'src', 'a.cpp'), offset: 100, limit: 50 }),
    tool('Read', { file_path: join('C:', 'GoonZu', 'x86', 'Item.txt') }),
    tool('Bash', { command: 'cmake --build build\n  --target sim' }, { status: 'error' }),
    tool('shell', 'ctest -R sim', { exitCode: 0 }),
    tool('Edit', { file_path: join(cwd, 'src', 'a.cpp') }),
    tool('Grep', { pattern: 'Admit', path: join(cwd, 'src') }),
    tool('mcp__duo__ask_lead', { question: 'which catalog?' }),
    { id: 'p', kind: 'patch', text: 'update src/b.cpp\nadd src/c.cpp', status: 'done' },
  ], cwd);
  assert.deepEqual(did, [
    'read docs/PLAN.md (from the start, at most 2000 lines)',
    'read src/a.cpp (lines 100-149)',
    `read ${join('C:', 'GoonZu', 'x86', 'Item.txt')} (from the start, at most 2000 lines)`,
    'ran `cmake --build build --target sim` (failed)',
    'ran `ctest -R sim` (exit 0)',
    'edited src/a.cpp',
    'searched for "Admit" in src',
    'changed (update) src/b.cpp',
    'changed (add) src/c.cpp',
  ]);
});

test('a member catches up on what it missed, without what it saw or will get next', () => {
  const turns: TeamTurn[] = [
    { user: 'plan it', from: 'you', speaker: 'Astra', to: 'Opus', blocks: text('@Opus build the loader'), status: 'done' },
    { user: '@Opus build the loader', from: 'Astra', speaker: 'Opus', to: 'Astra', blocks: text('Built it.'), status: 'done' },
    { user: 'which catalog?', from: 'Opus', speaker: 'Astra', to: 'Opus', question: true, blocks: text('korea-debug'), status: 'done' },
    { user: 'Built it.', from: 'Opus', speaker: 'Astra', to: 'you', blocks: text('@you done'), status: 'done' },
    { user: '@Opus also add a test', from: 'you', speaker: 'Opus', to: 'Astra', blocks: text('Added the test.'), status: 'done' },
  ];
  // Opus's next turn comes after turn 4; it last spoke in turn 1 and was not at turn 3.
  assert.deepEqual(unseen(turns, 2, 4, 'Opus'), ['Astra to the user: @you done']);
  // Astra, answering Opus's report in a new turn 5: the user's direct message to Opus is news to it.
  assert.deepEqual(unseen(turns, 4, 5, 'Astra'), ['The user to Opus: @Opus also add a test']);
  // Asked mid-task, the lead does not get the worker's unfinished turn as if it were an answer.
  const asking: TeamTurn[] = [turns[0], { ...turns[1], status: 'running', to: undefined, blocks: text('Looking at the cat') }];
  assert.deepEqual(unseen(asking, 1, 2, 'Astra'), []);
  // A reply addressed to `me` that it never got (the run stopped) is not lost.
  assert.deepEqual(unseen([...turns.slice(0, 1), { ...turns[1], status: 'stopped', blocks: [] }], 1, 2, 'Astra'), ["Opus's turn ended without an answer (stopped)."]);
});

test('the lead gets the worker report together with what the worker actually did', () => {
  const input = teamInput({ missed: ['The user to Opus: hurry'], from: 'Opus', text: 'All done, read the whole plan.', did: ['read docs/PLAN.md (lines 1-40)'], worker: 'Opus' });
  assert.equal(input, 'Since your last message:\n- The user to Opus: hurry\n\nOpus: All done, read the whole plan.\n\nWhat Opus actually did (its tool calls):\n- read docs/PLAN.md (lines 1-40)');
  assert.match(teamInput({ missed: [], from: 'Opus', text: 'Done.', did: [], worker: 'Opus' }), /its tool calls: none\)/);
});

test('each member knows its role, how to address the other, and the worker how to ask', () => {
  const lead: ChatMember = { name: 'Astra', role: 'lead', engine: 'codex', spec: 'codex:gpt-6-astra@max', access: 'workspace' };
  const worker: ChatMember = { name: 'Opus', role: 'worker', engine: 'claude', spec: 'claude:opus@max', access: 'full' };
  const l = teamRules(lead, worker, { askTool: false });
  assert.match(l, /You are Astra, the lead/);
  assert.match(l, /@Opus/);
  assert.match(l, /@you/);
  const w = teamRules(worker, lead, { askTool: true });
  assert.match(w, /You are Opus, working in a team chat with Astra \(Codex, codex:gpt-6-astra@max\), who leads/);
  assert.match(w, /ask_lead tool/);
  assert.doesNotMatch(teamRules(worker, lead, { askTool: false }), /ask_lead/);
});
