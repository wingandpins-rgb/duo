/**
 * Operating-system specifics in one place: where duo keeps its files, how to find an executable,
 * how to run a Node script, how to stop a process tree, and how to show a folder. Everything else
 * stays platform-neutral.
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const home = homedir();

/** Per-user application data: XDG on Linux, Application Support on macOS, LocalAppData on Windows. */
export function dataHome(): string {
  if (IS_WIN) return process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  if (IS_MAC) return join(home, 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || join(home, '.local', 'share');
}

/** Per-user configuration: XDG on Linux; on macOS and Windows it sits next to the data. */
export function configHome(): string {
  if (IS_WIN) return process.env.APPDATA || join(home, 'AppData', 'Roaming');
  if (IS_MAC) return join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || join(home, '.config');
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isExecutable(p: string): boolean {
  if (!isFile(p)) return false;
  if (IS_WIN) return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH lookup that honours PATHEXT on Windows (claude.exe, codex.cmd, ...). There a file without one
 * of those extensions is not a program: npm puts an extensionless script for Git Bash next to every
 * `.cmd` it writes, and Windows cannot start it.
 */
export function which(name: string): string | undefined {
  const pathExts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const exts = !IS_WIN || pathExts.some((e) => name.toLowerCase().endsWith(e)) ? [''] : pathExts;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isExecutable(p)) return p;
    }
  }
  return undefined;
}

/**
 * How to run a Node script with the runtime duo itself runs on. Inside the desktop app that is
 * Electron's bundled Node, which acts as plain Node only with ELECTRON_RUN_AS_NODE set.
 */
export function nodeRunner(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/**
 * Windows: end a process and every process it started (`kill` ends only the one it is given). It runs
 * synchronously, bounded, so a caller can be sure the tree is gone before it goes on.
 */
export function killTree(pid: number): boolean {
  return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 }).status === 0;
}

/**
 * Windows: the command line of a process whose parent is gone, or undefined (no such process, or its
 * parent still runs). A live process at the parent's pid that started after the child is not its
 * parent: Windows reuses pids quickly.
 */
export function orphanCommandLine(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const ps = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'`,
    'if (-not $p) { exit 1 }',
    "$parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId)",
    'if ($parent -and $parent.CreationDate -le $p.CreationDate) { exit 2 }',
    '$p.CommandLine',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** Show a folder in the system file manager. */
export function openFolder(path: string): void {
  if (!existsSync(path)) throw new Error(`no such folder: ${path}`);
  const [cmd, args] = IS_WIN ? ['explorer.exe', [path]] : IS_MAC ? ['open', [path]] : ['xdg-open', [path]];
  // No file manager (xdg-open missing on a minimal system): nothing to show, and no reason to crash.
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref();
}

/** "~/src/app" for display; the full path elsewhere. */
export function tildify(p: string): string {
  return p === home ? '~' : p.startsWith(home + (IS_WIN ? '\\' : '/')) ? '~' + p.slice(home.length) : p;
}

export function expandHome(p: string): string {
  return p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;
}
