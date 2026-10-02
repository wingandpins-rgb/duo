/**
 * Team chats: the user, a lead and a worker in one conversation. The lead plans, hands out tasks and
 * reviews; the worker does the work and can ask the lead in the middle of it. These are the pure
 * parts: who a message is for, what a member has not seen yet, what the worker actually did (from its
 * tool calls, not from its own account), and each member's rules.
 */
import { isAbsolute, relative } from 'node:path';
import type { Block } from '../live.ts';

export type Engine = 'claude' | 'codex';
export type Role = 'lead' | 'worker';

export interface ChatMember {
  /** How the others address it: "@Astra". One word. */
  name: string;
  role: Role;
  engine: Engine;
  spec: string;
  access: string;
  claudeSessionId?: string;
  claudeStarted?: boolean;
  codexThreadId?: string;
  codexTotals?: { input: number; cached: number; output: number; reasoning: number };
  claudeCost?: number;
  /** Turns before this index have reached this member, one way or another. */
  seen?: number;
}

/** The parts of a chat turn the team logic reads. */
export interface TeamTurn {
  user: string;
  blocks: Block[];
  status: string;
  speaker?: string;
  from?: string;
  to?: string;
  question?: boolean;
}

/** How many messages the members may pass between themselves before the user has to reply. */
export const MAX_HOPS = 20;

const ENGINE_LABEL: Record<Engine, string> = { claude: 'Claude Code', codex: 'Codex' };

/** "Astra" for gpt-6-astra, "Opus" for opus or claude-opus-5-5: the model family, capitalised. */
export function memberName(engine: Engine, model: string): string {
  const words = model.toLowerCase().replace(/\[.*?\]/g, '').split(/[^a-z]+/).filter((w) => w.length >= 3 && w !== 'gpt' && w !== 'claude');
  const w = words.pop();
  return w ? w[0].toUpperCase() + w.slice(1) : engine === 'claude' ? 'Claude' : 'Codex';
}

/** The member a message is for, from an @Name at its start; "you" for the user; undefined if none. */
export function addressee(text: string, members: readonly { name: string }[], self?: string): string | undefined {
  const m = /^\s*@([\p{L}\p{N}_-]+)/u.exec(text);
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  if (name === 'you' || name === 'user') return 'you';
  return members.find((x) => x.name.toLowerCase() === name && x.name !== self)?.name;
}

/** The answer of a turn: the text block marked final, or the last one. */
export function finalText(blocks: readonly Block[]): string {
  const texts = blocks.filter((b) => b.kind === 'text' && b.text);
  return (texts.find((b) => b.phase === 'final') ?? texts[texts.length - 1])?.text ?? '';
}

function parse(input: string | undefined): Record<string, any> {
  try {
    const v = JSON.parse(input ?? '');
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { value: input ?? '' };
  }
}

/** A path as the project knows it; outside the project, the full path, so a wrong folder stands out. */
function where(p: unknown, cwd: string): string {
  const s = String(p ?? '?');
  if (!isAbsolute(s)) return s;
  const r = relative(cwd, s);
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : s;
}

function readRange(i: Record<string, any>): string {
  const offset = Number(i.offset) || 0;
  const limit = Number(i.limit) || 0;
  if (!offset && !limit) return 'from the start, at most 2000 lines';
  const start = offset || 1;
  return limit ? `lines ${start}-${start + limit - 1}` : `from line ${start}, at most 2000 lines`;
}

/**
 * What a member actually did in a turn, from its tool calls: every file read (with the lines), every
 * search, every command (with its result), every change. The lead gets this with each report.
 */
export function activity(blocks: readonly Block[], cwd: string): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'patch') {
      for (const l of (b.text ?? '').split('\n').filter(Boolean)) out.push(`changed ${l.replace(/^(\w+) /, '($1) ')}`);
      continue;
    }
    if (b.kind !== 'tool') continue;
    const i = parse(b.input);
    const failed = b.status === 'error' ? ' (failed)' : '';
    switch (b.name) {
      case 'Read':
        out.push(`read ${where(i.file_path, cwd)} (${readRange(i)})${failed}`);
        break;
      case 'Bash':
      case 'shell': {
        const cmd = String(i.command ?? i.value ?? '').replace(/\s+/g, ' ').trim();
        out.push(`ran \`${cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd}\`${b.exitCode != null ? ` (exit ${b.exitCode})` : failed}`);
        break;
      }
      case 'Edit':
      case 'MultiEdit':
        out.push(`edited ${where(i.file_path, cwd)}${failed}`);
        break;
      case 'NotebookEdit':
        out.push(`edited ${where(i.notebook_path, cwd)}${failed}`);
        break;
      case 'Write':
        out.push(`wrote ${where(i.file_path, cwd)}${failed}`);
        break;
      case 'Grep':
        out.push(`searched for ${JSON.stringify(String(i.pattern ?? ''))}${i.path ? ` in ${where(i.path, cwd)}` : ''}${failed}`);
        break;
      case 'Glob':
        out.push(`listed ${String(i.pattern ?? '')}${i.path ? ` in ${where(i.path, cwd)}` : ''}${failed}`);
        break;
      case 'WebFetch':
        out.push(`fetched ${String(i.url ?? '')}${failed}`);
        break;
      case 'WebSearch':
      case 'web_search':
        out.push(`searched the web for ${JSON.stringify(String(i.query ?? i.value ?? ''))}`);
        break;
      default:
        // Its questions to the lead are in the conversation already.
        if (b.name?.endsWith('ask_lead') || b.name === 'TodoWrite') break;
        out.push(`used ${b.name ?? 'a tool'}${failed}`);
    }
  }
  return out;
}

function label(name: string | undefined): string {
  return !name || name === 'you' ? 'the user' : name;
}

/**
 * What `me` has not received since its last turn, oldest first: the user's messages to the other
 * member, and the other member's replies that were not addressed to `me`.
 */
export function unseen(turns: readonly TeamTurn[], since: number, upTo: number, me: string): string[] {
  const out: string[] = [];
  for (let k = Math.max(0, since); k < upTo; k++) {
    const t = turns[k];
    // Its own turns, and one still running (the worker asking mid-task): that answer is not given yet.
    if (t.speaker === me || t.status === 'running') continue;
    // A question `me` asked in the middle of its own turn came back to it as the tool's answer.
    if (t.question && t.from === me) continue;
    if (t.from === 'you') out.push(`The user to ${t.speaker}: ${t.user}`);
    const text = finalText(t.blocks);
    // The reply just before this turn, addressed to `me`, arrives as its message.
    if (t.to === me && k === upTo - 1 && text) continue;
    if (text) out.push(`${t.speaker} to ${label(t.to)}: ${text}`);
    else if (t.status === 'stopped' || t.status === 'error') out.push(`${t.speaker}'s turn ended without an answer (${t.status}).`);
  }
  return out;
}

/** The message a member gets for its turn: what it missed, who is talking to it, and (lead) what the worker did. */
export function teamInput(o: { missed: string[]; from: string; text: string; did?: string[]; worker?: string }): string {
  const parts: string[] = [];
  if (o.missed.length) parts.push(`Since your last message:\n${o.missed.map((l) => `- ${l}`).join('\n')}`);
  parts.push(`${o.from === 'you' ? 'The user' : o.from}: ${o.text}`);
  if (o.did) parts.push(`What ${o.worker} actually did (its tool calls${o.did.length ? '' : ': none'}):${o.did.length ? `\n${o.did.map((l) => `- ${l}`).join('\n')}` : ''}`);
  return parts.join('\n\n');
}

/** The rules a member works under, as its system prompt (Codex gets them on top of the first message). */
export function teamRules(me: ChatMember, other: ChatMember, o: { askTool: boolean }): string {
  const who = `${other.name} (${ENGINE_LABEL[other.engine]}, ${other.spec})`;
  const rules = me.role === 'lead'
    ? [
        `You are ${me.name}, the lead in a team chat with ${who} and the user. Everyone sees every message.`,
        `- You lead the work: plan it, give ${other.name} clear tasks, answer its questions, and review what it reports. With each report you also get the list of what it actually did: every file it read (with the lines), every command and its result, every change. Check its claims against that list and the code, and correct it when it is wrong or incomplete.`,
        `- Start every message with @${other.name} to send it to ${other.name}, or with @you for the user. A message without one goes to the user.`,
        `- Hand the floor back to the user (@you) when the work is done, when only the user can decide something, or when you and ${other.name} cannot agree.`,
      ]
    : [
        `You are ${me.name}, working in a team chat with ${who}, who leads, and the user. Everyone sees every message.`,
        `- Do the tasks ${other.name} gives you, in the project folder, and stay inside them.`,
        o.askTool
          ? `- Do not guess project decisions. When the task, the code or the project's plans do not settle something, ask ${other.name} with the ask_lead tool: you get its answer and carry on.`
          : `- Do not guess project decisions. When the task, the code or the project's plans do not settle something, stop and ask ${other.name}.`,
        `- Report exactly what you did, what you did not do, and what you could not verify. ${other.name} sees every file you read (with the lines) and every command you ran, so never claim more than that.`,
        `- Your messages go to ${other.name}. Start one with @you to address the user instead.`,
      ];
  return rules.join('\n');
}
