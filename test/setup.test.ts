import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-setup-'));
// Everything setup writes lands in here.
Object.assign(process.env, { APPDATA: join(tmp, 'appdata'), USERPROFILE: tmp, HOME: tmp, CLAUDE_CONFIG_DIR: join(tmp, 'claude'), CODEX_HOME: join(tmp, 'codex') });
const { install, uninstall } = await import('../src/setup.ts');
const { IS_WIN } = await import('../src/platform.ts');
after(() => rmSync(tmp, { recursive: true, force: true }));

const npmBin = join(tmp, 'appdata', 'npm');
const version = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;

/** Git Bash, which Claude Code runs its shell commands in on Windows. */
function gitBash(): string | undefined {
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const bash = resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
    return existsSync(bash) ? bash : undefined;
  } catch {
    return undefined;
  }
}

test('on Windows, setup writes duo commands that cmd, PowerShell and Git Bash can all run', { skip: !IS_WIN && 'Windows only' }, () => {
  install(() => undefined, { launcher: false });
  for (const name of ['duo', 'duo-safe']) {
    assert.ok(existsSync(join(npmBin, `${name}.cmd`)), `${name}.cmd`);
    assert.match(readFileSync(join(npmBin, name), 'utf8'), /^#!\/bin\/sh\n/, `${name} for Git Bash`);
  }
  const bash = gitBash();
  if (bash) {
    const out = execFileSync(bash, ['-c', 'PATH="$(cygpath -u "$DUO_TEST_BIN"):$PATH"; duo --version && duo-safe --version'], { encoding: 'utf8', env: { ...process.env, DUO_TEST_BIN: npmBin } });
    assert.deepEqual(out.trim().split(/\r?\n/), [version, version]);
  }
  uninstall(() => undefined);
  for (const name of ['duo', 'duo-safe']) assert.ok(!existsSync(join(npmBin, name)) && !existsSync(join(npmBin, `${name}.cmd`)), `${name} removed`);
});

test('on Windows, setup refuses to replace a duo command that another package installed', { skip: !IS_WIN && 'Windows only' }, () => {
  const other = '#!/bin/sh\nexec node "$basedir/node_modules/duo/bin/duo" "$@"\n';
  writeFileSync(join(npmBin, 'duo'), other);
  assert.throws(() => install(() => undefined, { launcher: false }), /not written by duo setup/);
  assert.equal(readFileSync(join(npmBin, 'duo'), 'utf8'), other);
  uninstall(() => undefined);
  assert.equal(readFileSync(join(npmBin, 'duo'), 'utf8'), other, 'uninstall leaves it alone too');
});
