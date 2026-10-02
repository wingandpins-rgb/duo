/**
 * CLIs that a crashed duo left running are stopped when the next session manager starts: claw's own
 * orphan cleanup, through duo's hook (which makes that cleanup work on Windows too).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'duo-orphans-')));
// claw records the pids of the CLIs it runs in ~/.openclaw; give it a home of its own.
Object.assign(process.env, { HOME: tmp, USERPROFILE: tmp, CLAWO_RUNS_DIR: join(tmp, 'claw', 'runs'), CLAWO_WF_DIR: join(tmp, 'claw', 'wf'), CLAWO_NO_EMBEDDED_SERVER: '1' });
const { claudeRoute } = await import('../src/hooks.ts');
const { IS_WIN, killTree } = await import('../src/platform.ts');
const { SessionManager, nullLogger } = await import('@enderfga/claw-orchestrator');
after(() => rmSync(tmp, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in for a Claude Code process (claw recognises ".../claude/..." in its command line) that has
// started something, the way a tool call does: in its process group on Unix, and detached on Windows,
// where Claude Code's children are not tied to it.
const cli = join(tmp, 'claude', 'cli.mjs');
mkdirSync(join(tmp, 'claude'), { recursive: true });
writeFileSync(cli, [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true });",
  'c.unref();',
  'writeFileSync(process.argv[2], String(c.pid));',
  'setTimeout(() => {}, 120000);',
].join('\n'));

async function startCli(name: string, viaLauncher: boolean): Promise<{ pid: number; child: number; parent: number }> {
  const pidFile = join(tmp, `${name}.child`);
  let pid: number;
  let parent: number;
  if (viaLauncher) {
    // Started by a process that then exits, as a crashed duo leaves its CLIs.
    const launcher = `const c = require('child_process').spawn(process.execPath, ${JSON.stringify([cli, pidFile])}, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid);`;
    const r = spawnSync(process.execPath, ['-e', launcher], { encoding: 'utf8' });
    pid = Number(r.stdout.trim());
    parent = r.pid!;
  } else {
    const p = spawn(process.execPath, [cli, pidFile], { stdio: 'ignore', windowsHide: true });
    p.unref();
    pid = p.pid!;
    parent = process.pid;
  }
  for (const end = Date.now() + 10_000; !existsSync(pidFile) && Date.now() < end; ) await sleep(50);
  return { pid, child: Number(readFileSync(pidFile, 'utf8')), parent };
}

/** What claw wrote for a CLI before its manager died: the pid, and the manager's (now dead) pid. */
function recordOrphan(pid: number, ownerPid: number): void {
  mkdirSync(join(tmp, '.openclaw'), { recursive: true });
  writeFileSync(join(tmp, '.openclaw', 'session-pids.json'), JSON.stringify({ 'duo-crashed-seat': { pid, ownerPid, since: Date.now() } }));
}

function startManager(): InstanceType<typeof SessionManager> {
  return new SessionManager({ claudeBin: claudeRoute('orphans', { command: process.execPath, args: [], env: {}, display: 'node' }) }, nullLogger);
}

test('a CLI left running by a crashed duo is stopped, with what it started, when duo starts again', { timeout: 60_000 }, async () => {
  const orphan = await startCli('orphan', true);
  assert.ok(alive(orphan.pid) && alive(orphan.child), 'the stand-in CLI and its child are running');
  assert.equal(alive(orphan.parent), false, 'its parent is gone');
  recordOrphan(orphan.pid, orphan.parent);
  const manager = startManager();
  try {
    for (const end = Date.now() + 10_000; (alive(orphan.pid) || alive(orphan.child)) && Date.now() < end; ) await sleep(100);
    assert.equal(alive(orphan.pid), false, 'the orphaned CLI was stopped');
    assert.equal(alive(orphan.child), false, 'and so was what it started');
  } finally {
    await manager.shutdown();
    for (const pid of [orphan.pid, orphan.child]) if (alive(pid)) process.kill(pid);
  }
});

test('a CLI whose parent still runs is never taken for a leftover, even on a reused pid', { skip: !IS_WIN && 'Windows only', timeout: 60_000 }, async () => {
  const running = await startCli('running', false);
  // A record that names this pid with a dead owner: what a pid Windows reused looks like.
  recordOrphan(running.pid, spawnSync(process.execPath, ['-e', '']).pid!);
  const manager = startManager();
  try {
    await sleep(1_000);
    assert.equal(alive(running.pid), true, 'a CLI that still has its parent keeps running');
  } finally {
    await manager.shutdown();
    killTree(running.pid);
    if (alive(running.child)) process.kill(running.child);
  }
});
