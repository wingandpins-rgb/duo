/**
 * Interactive chats with Claude Code or Codex, the part of the GUI that replaces the two desktop
 * apps. One claw SessionManager hosts every chat; the spawn hook hands each chat its CLI's raw
 * event stream, which is translated into blocks for the window as it arrives.
 *
 * A team chat has two members, a lead and a worker (see team.ts), each in a session of its own. The
 * chat passes their messages between them until one of them hands the floor back to the user, and the
 * worker can ask the lead in the middle of its own turn (askLead).
 */
import { SessionManager, nullLogger } from '@enderfga/claw-orchestrator';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BinSpec } from '../bins.ts';
import type { Config } from '../config.ts';
import { withCodexBin } from '../engine.ts';
import { DEPTH_VAR } from '../env.ts';
import { classifyError, errorHint } from '../errors.ts';
import { claudeRoute, claudeSink, codexRoute, dropCodexRoute } from '../hooks.ts';
import { ClaudeTranslator, CodexTranslator, type Block } from '../live.ts';
import { DUO_HOME } from '../paths.ts';
import { nodeRunner } from '../platform.ts';
import { codexCredits } from '../pricing.ts';
import { saveClaudeQuota, snapshot } from '../quota.ts';
import { codexOverrides, parseSeat, type Seat } from '../seats.ts';
import type { Usage } from '../store.ts';
import type { Bus } from './bus.ts';
import type { PermissionBroker } from './permissions.ts';
import { activity, addressee, finalText, MAX_HOPS, memberName, teamInput, teamRules, unseen, type ChatMember, type Role } from './team.ts';

const GUI_DIR = join(DUO_HOME, 'gui');
const CHATS_DIR = join(GUI_DIR, 'chats');
const TAPS_DIR = join(GUI_DIR, 'taps');
const MCP_DIR = join(GUI_DIR, 'mcp');

export type Engine = 'claude' | 'codex';

/** Claude permission modes, as the GUI names them. "ask", "edits" and "auto" route prompts to the window. */
export const CLAUDE_ACCESS: Record<string, { mode: string; prompts: boolean; label: string }> = {
  plan: { mode: 'plan', prompts: false, label: 'Plan (read-only)' },
  ask: { mode: 'manual', prompts: true, label: 'Ask before acting' },
  edits: { mode: 'acceptEdits', prompts: true, label: 'Auto-accept edits' },
  auto: { mode: 'auto', prompts: true, label: 'Auto mode' },
  full: { mode: 'bypassPermissions', prompts: false, label: 'Full access' },
};

export const CODEX_ACCESS: Record<string, { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; label: string }> = {
  'read-only': { sandbox: 'read-only', label: 'Read-only' },
  workspace: { sandbox: 'workspace-write', label: 'Workspace write' },
  full: { sandbox: 'danger-full-access', label: 'Full access' },
};

/** The worker's tool for asking the lead (the duo MCP server's ask_lead), allowed without a prompt. */
const ASK_TOOL = 'mcp__duo__ask_lead';

export interface ChatTurn {
  id: string;
  user: string;
  at: string;
  spec: string;
  access: string;
  blocks: Block[];
  status: 'running' | 'done' | 'error' | 'stopped';
  durationMs?: number;
  usage?: Usage;
  credits?: number;
  usd?: number;
  error?: string;
  hint?: string;
  /** Team chats: who answers in this turn, who sent what it answers ("you" or a member), whom the answer is for. */
  speaker?: string;
  from?: string;
  to?: string;
  /** The worker's question to the lead, asked in the middle of its own turn. */
  question?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  engine: Engine;
  spec: string;
  access: string;
  cwd: string;
  useCodexConfig: boolean;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  claudeSessionId?: string;
  claudeStarted?: boolean;
  codexThreadId?: string;
  codexTotals?: Usage;
  claudeCost?: number;
  /** Team chats: the lead and the worker. engine, spec and access then mirror the lead's. */
  members?: ChatMember[];
  turns: ChatTurn[];
}

export type ChatSummary = Omit<ChatSession, 'turns' | 'codexTotals'> & { turnCount: number; running: boolean; lastText?: string; draft?: boolean };

const EDITABLE = ['title', 'spec', 'access', 'useCodexConfig', 'cwd', 'pinned'] as const;

/** What a CLI session runs as: a whole chat, or one member of a team chat. */
type Participant = Pick<ChatMember, 'engine' | 'spec' | 'access' | 'claudeSessionId' | 'claudeStarted' | 'codexThreadId' | 'codexTotals' | 'claudeCost'>;

interface LiveTurn {
  chat: string;
  turn: ChatTurn;
  translator: ClaudeTranslator | CodexTranslator;
  pending: Set<Block>;
  timer?: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChatManager {
  private readonly manager: SessionManager;
  private readonly sessions = new Map<string, ChatSession>();
  /** Chats created in the window but not sent to yet: kept in memory only, so empty chats never pile up. */
  private readonly drafts = new Set<string>();
  /** The CLI session behind each chat, or each member of a team chat (see slot). */
  private readonly live = new Map<string, { clawName: string; key: string; route?: string }>();
  /** Per chat: what stops it (its turn, or a team chat's whole exchange). */
  private readonly running = new Map<string, { stop: () => void }>();
  /** Per team member: what stops the turn it is taking. */
  private readonly memberStops = new Map<string, () => void>();
  private readonly current = new Map<string, LiveTurn>();
  private readonly bus: Bus;
  private readonly cfg: Config;
  private readonly bins: { codex: BinSpec; claude: BinSpec };
  private readonly perms: PermissionBroker;
  private readonly api: { url: string };
  private readonly mcpScript: string;

  constructor(bus: Bus, cfg: Config, bins: { codex: BinSpec; claude: BinSpec }, perms: PermissionBroker, api: { url: string }, mcpScript: string) {
    this.bus = bus;
    this.cfg = cfg;
    this.bins = bins;
    this.perms = perms;
    this.api = api;
    this.mcpScript = mcpScript;
    for (const d of [CHATS_DIR, TAPS_DIR]) mkdirSync(d, { recursive: true });
    // The MCP configs hold a chat's permission-bridge secret (see mcpConfig): keep them private to this user.
    mkdirSync(MCP_DIR, { recursive: true, mode: 0o700 });
    chmodSync(MCP_DIR, 0o700);
    this.manager = new SessionManager(
      { claudeBin: claudeRoute('gui', bins.claude), maxConcurrentSessions: 64, sessionTtlMinutes: 12 * 60 },
      nullLogger,
    );
    this.load();
  }

  private load(): void {
    for (const f of readdirSync(CHATS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const path = join(CHATS_DIR, f);
      try {
        const s = JSON.parse(readFileSync(path, 'utf8')) as ChatSession;
        // Earlier versions saved a chat as soon as it was opened; an empty one carries nothing.
        if (!s.turns.length && Date.now() - statSync(path).mtimeMs > 10 * 60_000) {
          rmSync(path, { force: true });
          continue;
        }
        // A turn that was running when the app closed can't be finished any more.
        for (const t of s.turns) if (t.status === 'running') t.status = 'stopped';
        this.sessions.set(s.id, s);
      } catch {
        /* skip a corrupt file */
      }
    }
  }

  private save(s: ChatSession): void {
    // A draft is not saved yet; a deleted chat must not come back when its last turn ends.
    if (this.drafts.has(s.id) || !this.sessions.has(s.id)) return;
    const path = join(CHATS_DIR, `${s.id}.json`);
    writeFileSync(path + '.tmp', JSON.stringify(s));
    renameSync(path + '.tmp', path);
  }

  summary(s: ChatSession): ChatSummary {
    const { turns, codexTotals: _t, ...rest } = s;
    const last = turns[turns.length - 1];
    const lastText = last?.blocks.filter((b) => b.kind === 'text').pop()?.text;
    return { ...rest, turnCount: turns.length, running: this.running.has(s.id), lastText: lastText?.slice(0, 140), draft: this.drafts.has(s.id) || undefined };
  }

  list(): ChatSummary[] {
    return [...this.sessions.values()]
      .filter((s) => !this.drafts.has(s.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => this.summary(s));
  }

  get(id: string): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no chat ${id}`);
    return s;
  }

  private validate(engine: Engine, spec: string, access: string): Seat {
    const seat = parseSeat(spec, 'A', this.cfg.defaults);
    if (seat.engine !== engine) throw new Error(`a ${engine} chat needs a ${engine} seat (got ${spec})`);
    const table = engine === 'claude' ? CLAUDE_ACCESS : CODEX_ACCESS;
    if (!table[access]) throw new Error(`unknown access "${access}" for ${engine} (${Object.keys(table).join(', ')})`);
    return seat;
  }

  private newMember(role: Role, engine: unknown, o: { spec?: string; access?: string } = {}): ChatMember {
    if (engine !== 'claude' && engine !== 'codex') throw new Error(`unknown engine "${String(engine)}" (claude or codex)`);
    const d = engine === 'claude' ? this.cfg.gui.claude : this.cfg.gui.codex;
    const spec = o.spec ?? d.spec;
    const access = o.access ?? d.access;
    const seat = this.validate(engine, spec, access);
    return { name: memberName(engine, seat.model), role, engine, spec, access };
  }

  create(o: {
    engine?: Engine;
    team?: boolean;
    spec?: string;
    access?: string;
    cwd: string;
    useCodexConfig?: boolean;
    title?: string;
    lead?: { engine?: Engine; spec?: string; access?: string };
    worker?: { engine?: Engine; spec?: string; access?: string };
  }): ChatSession {
    if (!existsSync(o.cwd)) throw new Error(`folder does not exist: ${o.cwd}`);
    const now = new Date().toISOString();
    const base = { id: randomUUID(), cwd: o.cwd, useCodexConfig: o.useCodexConfig ?? this.cfg.gui.codex.useConfig, createdAt: now, updatedAt: now, turns: [] };
    let s: ChatSession;
    if (o.team) {
      const lead = this.newMember('lead', o.lead?.engine ?? 'codex', o.lead);
      const worker = this.newMember('worker', o.worker?.engine ?? 'claude', o.worker);
      if (worker.name.toLowerCase() === lead.name.toLowerCase()) worker.name += '2';
      s = { ...base, title: o.title ?? 'New team chat', engine: lead.engine, spec: lead.spec, access: lead.access, members: [lead, worker] };
    } else {
      const engine = o.engine ?? 'claude';
      const d = engine === 'claude' ? this.cfg.gui.claude : this.cfg.gui.codex;
      const spec = o.spec ?? d.spec;
      const access = o.access ?? d.access;
      this.validate(engine, spec, access);
      s = { ...base, title: o.title ?? 'New chat', engine, spec, access };
    }
    this.sessions.set(s.id, s);
    this.drafts.add(s.id);
    return s;
  }

  update(id: string, patch: Partial<Pick<ChatSession, (typeof EDITABLE)[number]>> & { members?: unknown }): ChatSession {
    const s = this.get(id);
    if (s.members && (patch.spec !== undefined || patch.access !== undefined)) throw new Error("a team chat sets each member's model and access (members)");
    if (patch.spec !== undefined || patch.access !== undefined) this.validate(s.engine, patch.spec ?? s.spec, patch.access ?? s.access);
    const changes = Array.isArray(patch.members) ? (patch.members as { name?: unknown; spec?: unknown; access?: unknown }[]) : [];
    if (changes.length && !s.members) throw new Error('only a team chat has members');
    const edits = changes.map((c) => {
      const m = s.members!.find((x) => x.name === c.name);
      if (!m) throw new Error(`no member ${String(c.name)}`);
      const spec = c.spec === undefined ? m.spec : String(c.spec);
      const access = c.access === undefined ? m.access : String(c.access);
      this.validate(m.engine, spec, access);
      return { m, spec, access };
    });
    if (patch.cwd !== undefined && !existsSync(patch.cwd)) throw new Error(`folder does not exist: ${patch.cwd}`);
    // Only the editable fields: the patch is the raw request body, and fields such as `id` name the file the chat is saved to.
    Object.assign(s, Object.fromEntries(EDITABLE.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])));
    for (const e of edits) Object.assign(e.m, { spec: e.spec, access: e.access });
    const lead = s.members?.find((m) => m.role === 'lead');
    if (lead) Object.assign(s, { engine: lead.engine, spec: lead.spec, access: lead.access });
    if (patch.title === undefined && patch.pinned === undefined) s.updatedAt = new Date().toISOString();
    this.save(s);
    if (!this.drafts.has(s.id)) this.bus.emit({ t: 'chat', chat: this.summary(s) });
    return s;
  }

  async remove(id: string): Promise<void> {
    this.running.get(id)?.stop();
    const s = this.sessions.get(id);
    for (const m of [undefined, ...(s?.members ?? [])]) {
      const key = s ? this.slot(s, m) : id;
      const l = this.live.get(key);
      if (l) {
        await this.manager.stopSession(l.clawName).catch(() => undefined);
        if (l.route) dropCodexRoute(l.route);
      }
      this.live.delete(key);
      const p: Participant | undefined = m ?? s;
      if (p?.claudeSessionId) claudeSink(p.claudeSessionId, undefined);
      // The raw event stream holds every prompt, reply and tool output of the chat.
      if (s) rmSync(this.tapFile(s, m), { force: true });
    }
    this.sessions.delete(id);
    this.drafts.delete(id);
    this.perms.forget(id);
    rmSync(join(CHATS_DIR, `${id}.json`), { force: true });
    rmSync(join(MCP_DIR, `${id}.json`), { force: true });
    this.bus.emit({ t: 'chat_removed', id });
  }

  /** The CLI session of a chat, or of one member of a team chat. */
  private slot(s: ChatSession, m?: ChatMember): string {
    return m ? `${s.id}:${m.name}` : s.id;
  }

  private tapFile(s: ChatSession, m?: ChatMember): string {
    return join(TAPS_DIR, `${s.id}${m ? `.${m.name}` : ''}.jsonl`);
  }

  private mcpConfig(chat: string, lead?: string): string {
    const path = join(MCP_DIR, `${chat}.json`);
    const node = nodeRunner();
    // Recreate rather than overwrite, so the private mode applies even to a file an older version wrote.
    rmSync(path, { force: true });
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        duo: {
          type: 'stdio',
          command: node.command,
          args: [this.mcpScript],
          // Not the API token: a secret that can only ask the window, or the lead, about this chat.
          env: { ...node.env, DUO_API_URL: this.api.url, DUO_API_TOKEN: this.perms.secretFor(chat), DUO_CHAT_ID: chat, ...(lead ? { DUO_TEAM_LEAD: lead } : {}) },
        },
      },
    }), { mode: 0o600 });
    return path;
  }

  /** Raw stream line from a chat's CLI: keep it for the trace and update the live view. */
  private onLine(s: ChatSession, m: ChatMember | undefined, line: string): void {
    if (!this.sessions.has(s.id)) return;
    try {
      appendFileSync(this.tapFile(s, m), line + '\n');
    } catch {
      /* trace is best effort */
    }
    const key = this.slot(s, m);
    const cur = this.current.get(key);
    if (!cur) return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    for (const b of cur.translator.apply([ev])) cur.pending.add(b);
    if (!cur.timer && cur.pending.size) cur.timer = setTimeout(() => this.flush(key), 90);
  }

  private flush(key: string): void {
    const cur = this.current.get(key);
    if (!cur) return;
    clearTimeout(cur.timer);
    cur.timer = undefined;
    if (!cur.pending.size) return;
    const changed = [...cur.pending];
    cur.pending.clear();
    cur.turn.blocks = cur.translator.blocks;
    this.bus.emit({ t: 'chat_blocks', chat: cur.chat, turn: cur.turn.id, blocks: changed });
  }

  /**
   * Start (or restart with the new settings, resuming the conversation) the claw session behind a chat,
   * or behind one member of a team chat.
   */
  private async ensureLive(s: ChatSession, m?: ChatMember, force = false): Promise<string> {
    const p: Participant = m ?? s;
    const slot = this.slot(s, m);
    const key = `${p.spec}|${p.access}|${s.useCodexConfig}|${s.cwd}`;
    const cur = this.live.get(slot);
    if (!force && cur && cur.key === key && this.manager.hasSession(cur.clawName)) return cur.clawName;
    if (cur) {
      await this.manager.stopSession(cur.clawName).catch(() => undefined);
      if (cur.route) dropCodexRoute(cur.route);
    }
    this.live.delete(slot);
    const seat = this.validate(p.engine, p.spec, p.access);
    const clawName = `gui-${s.id.slice(0, 8)}${m ? `-${m.name.toLowerCase()}` : ''}-${Date.now().toString(36)}`;
    const other = m && s.members?.find((x) => x !== m);
    const asks = m?.role === 'worker' && m.engine === 'claude' && !!other;
    const rules = m && other ? teamRules(m, other, { askTool: asks }) : undefined;
    let route: string | undefined;
    if (seat.engine === 'codex') {
      route = codexRoute(`chat-${s.id}${m ? `-${m.name}` : ''}-${Date.now().toString(36)}`, {
        bin: this.bins.codex,
        overrides: [...codexOverrides(seat), `shell_environment_policy.set={${DEPTH_VAR}="1"}`],
        ignoreRules: false,
        onLine: (line) => this.onLine(s, m, line),
      });
      await withCodexBin(route, () => this.manager.startSession({
        name: clawName,
        engine: 'codex',
        cwd: s.cwd,
        model: seat.model,
        effort: seat.effort as any,
        sandboxMode: CODEX_ACCESS[p.access].sandbox,
        ignoreUserConfig: !s.useCodexConfig,
        skipPersistence: true,
        permissionMode: 'dontAsk',
        // Codex has no system prompt: claw puts these on top of the conversation's first message.
        ...(rules ? { appendSystemPrompt: rules } : {}),
        ...(p.codexThreadId ? { resumeSessionId: p.codexThreadId } : {}),
      }));
    } else {
      const a = CLAUDE_ACCESS[p.access];
      if (!p.claudeSessionId) p.claudeSessionId = randomUUID();
      claudeSink(p.claudeSessionId, (line) => this.onLine(s, m, line));
      await this.manager.startSession({
        name: clawName,
        engine: 'claude',
        cwd: s.cwd,
        model: seat.model,
        effort: seat.effort as any,
        permissionMode: a.mode as any,
        skipPersistence: true,
        crossSessionInbound: 'refuse',
        ...(p.claudeStarted ? { claudeResumeId: p.claudeSessionId } : { customSessionId: p.claudeSessionId }),
        ...(rules ? { appendSystemPrompt: rules } : {}),
        ...(a.prompts ? { permissionPromptTool: 'mcp__duo__approve' } : {}),
        ...(a.prompts || asks ? { mcpConfig: this.mcpConfig(s.id, asks ? other!.name : undefined) } : {}),
        // Asking the lead is the point of the worker's rules; it never waits for an approval.
        ...(asks ? { allowedTools: [ASK_TOOL] } : {}),
        ...(seat.addDirs.length ? { addDir: seat.addDirs } : {}),
      });
    }
    this.live.set(slot, { clawName, key, route });
    return clawName;
  }

  send(id: string, text: string): ChatTurn {
    const s = this.get(id);
    if (this.running.has(id)) throw new Error('this chat is still working; stop it or wait');
    if (!text.trim()) throw new Error('empty message');
    if (s.members) {
      const to = addressee(text, s.members);
      const speaker = to && to !== 'you' ? to : this.lead(s).name;
      const turn = this.teamTurn(s, { speaker, from: 'you', user: text });
      void this.teamLoop(s, turn);
      return turn;
    }
    const turn: ChatTurn = { id: randomUUID().slice(0, 8), user: text, at: new Date().toISOString(), spec: s.spec, access: s.access, blocks: [], status: 'running' };
    this.open(s, turn);
    void this.runTurn(s, turn, text);
    return turn;
  }

  /** Add a turn to a chat: the first message turns a draft into a real chat. */
  private open(s: ChatSession, turn: ChatTurn): void {
    s.turns.push(turn);
    s.updatedAt = turn.at;
    if (turn.from === undefined || turn.from === 'you') {
      if (s.title === 'New chat' || s.title === 'New team chat') s.title = turn.user.replace(/\s+/g, ' ').trim().slice(0, 70);
    }
    this.drafts.delete(s.id);
    this.save(s);
    this.bus.emit({ t: 'chat_turn', chat: s.id, turn });
    this.bus.emit({ t: 'chat', chat: { ...this.summary(s), running: true } });
  }

  /** Send the last message again (after an error, a stop, or to try another model). */
  retry(id: string): ChatTurn {
    const s = this.get(id);
    const last = s.turns[s.turns.length - 1];
    if (!last) throw new Error('nothing to retry');
    if (!s.members) return this.send(id, last.user);
    if (this.running.has(id)) throw new Error('this chat is still working; stop it or wait');
    const turn = this.teamTurn(s, { speaker: last.speaker ?? this.lead(s).name, from: last.from ?? 'you', user: last.user });
    void this.teamLoop(s, turn);
    return turn;
  }

  stop(id: string): boolean {
    const r = this.running.get(id);
    if (!r) return false;
    r.stop();
    return true;
  }

  private async runTurn(s: ChatSession, turn: ChatTurn, text: string, m?: ChatMember): Promise<void> {
    const p: Participant = m ?? s;
    const slot = this.slot(s, m);
    const started = Date.now();
    let stopped = false;
    let clawName = '';
    // A plain chat's turn is what stops the chat; a member's turn is stopped by its team chat's exchange.
    const onStop = (stop: () => void) => (m ? this.memberStops.set(slot, stop) : this.running.set(s.id, { stop }));
    onStop(() => {
      stopped = true;
    });
    try {
      clawName = await this.ensureLive(s, m);
    } catch (e) {
      return this.endTurn(s, turn, started, { error: `could not start ${p.engine}: ${(e as Error).message}` }, m);
    }
    if (stopped) {
      // Stopped (or deleted) while the session was starting: that session must not linger.
      const l = this.live.get(slot);
      this.live.delete(slot);
      await this.manager.stopSession(clawName).catch(() => undefined);
      if (l?.route) dropCodexRoute(l.route);
      return this.endTurn(s, turn, started, { stopped: true }, m);
    }

    const fresh = () => {
      const translator = p.engine === 'claude' ? new ClaudeTranslator() : new CodexTranslator();
      this.current.set(slot, { chat: s.id, turn, translator, pending: new Set() });
      return translator;
    };
    let translator = fresh();
    onStop(() => {
      stopped = true;
      if (!m) this.perms.cancelChat(s.id);
      const l = this.live.get(slot);
      this.live.delete(slot);
      void this.manager.stopSession(clawName).catch(() => undefined);
      if (l?.route) dropCodexRoute(l.route);
    });

    const attempt = async (): Promise<string | undefined> => {
      try {
        const res = await this.manager.sendMessage(clawName, text, { timeout: 6 * 3600_000 });
        return res.error;
      } catch (e) {
        return (e as Error).message;
      }
    };
    let error = await attempt();
    if (!stopped && classifyError(error) === 'dead_session') {
      // The CLI process behind the chat went away (crash, update, sleep); start it again on the same conversation.
      try {
        if (p.engine === 'claude' && translator.facts.sessionId) p.claudeStarted = true;
        if (p.engine === 'claude' && s.turns.some((t) => t !== turn && (t.speaker === m?.name || !m))) p.claudeStarted = true;
        clawName = await this.ensureLive(s, m, true);
        translator = fresh();
        error = await attempt();
      } catch (e) {
        error = `restart failed: ${(e as Error).message}`;
      }
    }
    await sleep(150);
    this.flush(slot);
    if (translator instanceof CodexTranslator) {
      const changed = translator.finalize();
      if (changed.length) this.bus.emit({ t: 'chat_blocks', chat: s.id, turn: turn.id, blocks: changed });
    }
    this.current.delete(slot);
    turn.blocks = translator.blocks;
    const f = translator.facts;
    if (f.threadId) p.codexThreadId = f.threadId;
    if (p.engine === 'claude' && f.sessionId) p.claudeStarted = true;
    if (f.rateLimits) saveClaudeQuota(f.rateLimits);
    this.endTurn(s, turn, started, { stopped, error: f.error ?? error, usage: f.usage, costUsd: f.costUsd }, m);
  }

  private endTurn(s: ChatSession, turn: ChatTurn, started: number, o: { stopped?: boolean; error?: string; usage?: Usage; costUsd?: number }, m?: ChatMember): void {
    if (m) this.memberStops.delete(this.slot(s, m));
    else this.running.delete(s.id);
    // Deleted while the turn ran: nothing to record or show.
    if (!this.sessions.has(s.id)) return;
    const p: Participant = m ?? s;
    turn.durationMs = Date.now() - started;
    if (o.usage) {
      if (p.engine === 'codex') {
        // codex reports usage cumulatively per thread
        const prev = p.codexTotals;
        p.codexTotals = o.usage;
        turn.usage = prev && o.usage.input >= prev.input
          ? { input: o.usage.input - prev.input, cached: Math.max(0, o.usage.cached - prev.cached), output: Math.max(0, o.usage.output - prev.output), reasoning: Math.max(0, o.usage.reasoning - prev.reasoning) }
          : o.usage;
        const seat = parseSeat(turn.spec, 'A', this.cfg.defaults);
        turn.credits = codexCredits(seat.model, turn.usage, seat.tier);
      } else {
        turn.usage = o.usage;
      }
    }
    if (o.costUsd !== undefined) {
      const prev = p.claudeCost ?? 0;
      turn.usd = o.costUsd >= prev ? o.costUsd - prev : o.costUsd;
      p.claudeCost = o.costUsd;
    }
    const answered = turn.blocks.some((b) => b.kind === 'text' && b.text);
    turn.status = o.stopped ? 'stopped' : o.error && !answered ? 'error' : 'done';
    if (!o.stopped && o.error) {
      turn.error = o.error;
      turn.hint = errorHint(o.error);
    }
    // Whom a member's answer is for: the member or "you" named at its start, else the worker reports
    // to the lead and the lead to the user. A mid-task answer goes back to the worker that asked.
    if (m && turn.status === 'done' && !turn.question) {
      turn.to = addressee(finalText(turn.blocks), s.members!, m.name) ?? (m.role === 'worker' ? this.lead(s).name : 'you');
    }
    s.updatedAt = new Date().toISOString();
    this.save(s);
    this.bus.emit({ t: 'chat_turn_end', chat: s.id, turn });
    this.bus.emit({ t: 'chat', chat: this.summary(s) });
    this.bus.emit({ t: 'quota', quota: snapshot() });
  }

  // ── team chats ─────────────────────────────────────────────────────────

  private lead(s: ChatSession): ChatMember {
    return s.members!.find((m) => m.role === 'lead')!;
  }

  private worker(s: ChatSession): ChatMember {
    return s.members!.find((m) => m.role === 'worker')!;
  }

  private member(s: ChatSession, name: string | undefined): ChatMember {
    const m = s.members!.find((x) => x.name === name);
    if (!m) throw new Error(`no member ${String(name)}`);
    return m;
  }

  private teamTurn(s: ChatSession, o: { speaker: string; from: string; user: string; question?: boolean }): ChatTurn {
    const m = this.member(s, o.speaker);
    const turn: ChatTurn = {
      id: randomUUID().slice(0, 8),
      user: o.user,
      at: new Date().toISOString(),
      spec: m.spec,
      access: m.access,
      blocks: [],
      status: 'running',
      speaker: m.name,
      from: o.from,
      ...(o.question ? { question: true, to: o.from } : {}),
    };
    this.open(s, turn);
    return turn;
  }

  /** The message a member gets for its turn: what it missed, the message itself, and (lead) what the worker did. */
  private teamMessage(s: ChatSession, m: ChatMember, turn: ChatTurn): string {
    const k = s.turns.indexOf(turn);
    const missed = unseen(s.turns, m.seen ?? 0, k, m.name);
    m.seen = k + 1;
    const worker = this.worker(s);
    let did: string[] | undefined;
    if (m.role === 'lead' && turn.from === worker.name) {
      // The worker's turn that this report ends, or (asked mid-task) the one still running.
      const source = turn.question
        ? this.current.get(this.slot(s, worker))?.translator.blocks
        : [...s.turns.slice(0, k)].reverse().find((t) => t.speaker === worker.name && !t.question)?.blocks;
      did = activity(source ?? [], s.cwd);
    }
    const text = teamInput({ missed, from: turn.from ?? 'you', text: turn.user, did, worker: worker.name });
    return turn.question ? `${text}\n\n(${worker.name} asks this in the middle of its work; your answer goes straight back to it. Answer the question only.)` : text;
  }

  /** One message from the user, and everything the members say to each other after it, until one hands the floor back. */
  private async teamLoop(s: ChatSession, first: ChatTurn): Promise<void> {
    let stopped = false;
    this.running.set(s.id, {
      stop: () => {
        stopped = true;
        this.perms.cancelChat(s.id);
        for (const m of s.members!) this.memberStops.get(this.slot(s, m))?.();
      },
    });
    const limit = MAX_HOPS;
    try {
      let turn = first;
      for (let hops = 0; ; hops++) {
        const m = this.member(s, turn.speaker);
        await this.runTurn(s, turn, this.teamMessage(s, m, turn), m);
        if (stopped || !this.sessions.has(s.id) || turn.status !== 'done' || !turn.to || turn.to === 'you') break;
        if (hops + 1 >= limit) {
          turn.blocks = [...turn.blocks, { id: 'paused', kind: 'note', status: 'done', text: `Paused after ${limit} messages between ${s.members!.map((x) => x.name).join(' and ')}. Reply to carry on.` }];
          this.save(s);
          this.bus.emit({ t: 'chat_turn_end', chat: s.id, turn });
          break;
        }
        turn = this.teamTurn(s, { speaker: turn.to, from: m.name, user: finalText(turn.blocks) });
      }
    } finally {
      this.running.delete(s.id);
      if (this.sessions.has(s.id)) this.bus.emit({ t: 'chat', chat: this.summary(s) });
    }
  }

  /**
   * The worker's question to the lead, from its ask_lead tool in the middle of its own turn: the lead
   * answers in a turn of its own, and the answer goes back to the worker as the tool's result.
   */
  async askLead(id: string, question: string): Promise<string> {
    const s = this.get(id);
    if (!s.members) throw new Error('only a team chat has a lead');
    const lead = this.lead(s);
    const worker = this.worker(s);
    const carryOn = 'Carry on with your best judgement, and say so in your report.';
    if (!question.trim()) return `Ask a question. ${carryOn}`;
    if (!this.running.has(id)) return `The team chat is not running. ${carryOn}`;
    if (this.memberStops.has(this.slot(s, lead))) return `${lead.name} is busy. ${carryOn}`;
    const turn = this.teamTurn(s, { speaker: lead.name, from: worker.name, user: question.trim(), question: true });
    await this.runTurn(s, turn, this.teamMessage(s, lead, turn), lead);
    return finalText(turn.blocks) || `${lead.name} did not answer (${turn.error ?? turn.status}). ${carryOn}`;
  }

  async close(): Promise<void> {
    for (const r of this.running.values()) r.stop();
    for (const stop of this.memberStops.values()) stop();
    await this.manager.shutdown().catch(() => undefined);
  }
}
