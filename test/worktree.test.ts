import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-worktree-'));
process.env.DUO_HOME = join(tmp, 'home');
const { prepareWorkspace, discardWorkspace, runCheck, workspaceDiff } = await import('../src/worktree.ts');
const { buildTarget } = await import('../src/protocols/review.ts');
const { deleteRun } = await import('../src/store.ts');
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'example.txt'), 'example\n');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'add', '-A']);
execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a selected subfolder stays at the same relative path inside its worktree', () => {
  const ws = prepareWorkspace(join(repo, 'src'), 'nested', 'nested folder', 'worktree');
  try {
    assert.equal(relative(ws.path, ws.cwd), 'src');
    assert.equal(realpathSync.native(ws.repo!), realpathSync.native(repo));
  } finally {
    discardWorkspace(ws);
  }
});

test('a directory alias resolves into the worktree instead of escaping to the original folder', () => {
  const alias = join(tmp, 'alias');
  // Junctions need no elevated symlink permission on Windows.
  symlinkSync(realpathSync.native(repo), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const ws = prepareWorkspace(join(alias, 'src'), 'alias', 'aliased folder', 'worktree');
  try {
    assert.equal(relative(ws.path, ws.cwd), 'src');
    assert.notEqual(realpathSync.native(ws.cwd), realpathSync.native(join(repo, 'src')));
  } finally {
    discardWorkspace(ws);
  }
});

test('a writer that replaces the worktree .git link cannot make duo run git with its own config', () => {
  const marker = join(tmp, 'fsmonitor-ran');
  for (const how of ['init', 'gitdir'] as const) {
    const ws = prepareWorkspace(repo, `hijack-${how}`, 'hijack', 'worktree');
    try {
      rmSync(join(ws.path, '.git'), { recursive: true, force: true });
      const fake = how === 'init' ? ws.path : join(tmp, `fake-${how}`);
      execFileSync('git', ['init', '-q', fake]);
      execFileSync('git', ['-C', fake, 'config', 'core.fsmonitor', `touch '${marker}'; false`]);
      if (how === 'gitdir') writeFileSync(join(ws.path, '.git'), `gitdir: ${join(fake, '.git')}\n`);
      assert.throws(() => workspaceDiff(ws), /no longer points into/);
      assert.ok(!existsSync(marker), 'git never ran with the writer\'s config');
    } finally {
      discardWorkspace(ws);
    }
  }
});

test('a check that runs past its timeout, or is cancelled, is stopped with everything it started', { timeout: 60_000 }, async () => {
  // A child that keeps the output pipes open, the way test-runner workers and dev servers do.
  const script = join(tmp, 'hang.cjs');
  writeFileSync(script, "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });\nsetTimeout(() => {}, 60000);\n");
  const command = `"${process.execPath}" "${script}"`;
  const late = await runCheck(command, tmp, 500);
  assert.equal(late.timedOut, true);
  assert.ok(late.durationMs < 15_000, `stopped after ${late.durationMs} ms`);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const cancelled = await runCheck(command, tmp, 60_000, stop.signal);
  assert.equal(cancelled.timedOut, false);
  assert.ok(cancelled.durationMs < 15_000, `stopped after ${cancelled.durationMs} ms`);
});

test('a worktree holds paths past the 260-character limit of Windows', () => {
  // The repository's own git calls allow long paths; duo's worktree folder adds the rest.
  const long = join(tmp, 'long');
  const rel = join('src', ...['a', 'b', 'c', 'd'].map((c) => c.repeat(55)), 'file.txt');
  mkdirSync(join(long, rel, '..'), { recursive: true });
  writeFileSync(join(long, rel), 'one\n');
  execFileSync('git', ['init', '-q', long]);
  const g = (...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', long, ...args]);
  g('add', '-A');
  g('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  const ws = prepareWorkspace(long, 'long-paths', 'long paths', 'worktree');
  try {
    const file = join(ws.path, rel);
    assert.ok(file.length > 260, `the path is only ${file.length} characters`);
    writeFileSync(file, 'two\n');
    assert.deepEqual(workspaceDiff(ws).files.map((f) => f.path), [rel.replaceAll('\\', '/')]);
  } finally {
    discardWorkspace(ws);
  }
});

test('a review revision can never be read by git as an option', () => {
  const out = join(tmp, 'written-by-git');
  for (const kind of ['commit', 'base'] as const) {
    assert.throws(() => buildTarget(repo, { kind, value: `--output=${out}` }, 10_000), /bad (commit|base)/);
  }
  assert.ok(!existsSync(out) && !existsSync(`${out}...HEAD`), 'git wrote nothing');
  assert.match(buildTarget(repo, { kind: 'commit', value: 'HEAD' }, 10_000).text, /init/);
});

test('deleting a run never touches a folder outside the runs folder', () => {
  const elsewhere = join(tmp, 'project-with-a-run-json');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'run.json'), '{}\n');
  assert.throws(() => deleteRun(elsewhere), /not in duo's runs folder/);
  assert.ok(existsSync(join(elsewhere, 'run.json')));
});
