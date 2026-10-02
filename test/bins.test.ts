import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { resolveClaude } from '../src/bins.ts';
import { IS_WIN, which } from '../src/platform.ts';

const tmp = mkdtempSync(join(tmpdir(), 'duo-bins-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Run with only `dir` on PATH and an empty home, so no real CLI is found instead. */
function isolated<T>(dir: string, fn: () => T): T {
  const saved = { PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, DUO_CLAUDE_BIN: process.env.DUO_CLAUDE_BIN };
  Object.assign(process.env, { PATH: dir, USERPROFILE: join(tmp, 'home'), APPDATA: join(tmp, 'appdata') });
  delete process.env.DUO_CLAUDE_BIN;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('an npm-installed Claude Code is found through its .cmd wrapper and started as its native .exe', { skip: !IS_WIN && 'Windows only' }, () => {
  // What `npm install -g @anthropic-ai/claude-code` writes into the global npm folder.
  const npm = join(tmp, 'npm');
  const exe = write(join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), '');
  write(join(npm, 'claude'), '#!/bin/sh\nexec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"\n');
  const cmd = write(join(npm, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  isolated(npm, () => {
    assert.equal(which('claude'), cmd, 'the Git Bash script is not a Windows program');
    const bin = resolveClaude();
    assert.equal(bin.command, exe);
    assert.deepEqual(bin.args, []);
  });
});

test('a script wrapper still runs its script with node, not the node.exe it mentions', { skip: !IS_WIN && 'Windows only' }, () => {
  const npm = join(tmp, 'npm-js');
  const script = write(join(npm, 'node_modules', 'claude-js', 'cli.js'), '');
  const cmd = write(join(npm, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\claude-js\\cli.js" %*\r\n');
  isolated(npm, () => {
    const bin = resolveClaude({ claudeBin: cmd });
    assert.equal(bin.command, process.execPath);
    assert.deepEqual(bin.args, [script]);
  });
});
