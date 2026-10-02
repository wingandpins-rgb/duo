/**
 * "Ask" mode for Claude chats: Claude Code routes every permission decision it would normally put
 * to a person through --permission-prompt-tool, which duo points at a tiny MCP server
 * (permission-mcp.ts). That server long-polls this broker, and the broker waits for a click in the GUI.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Bus } from './bus.ts';

export interface PermissionRequest {
  id: string;
  chat: string;
  tool: string;
  input: unknown;
  at: string;
}

export type Decision = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

const TIMEOUT_MS = 30 * 60_000;

export class PermissionBroker {
  private readonly pending = new Map<string, { req: PermissionRequest; resolve: (d: Decision) => void; timer: NodeJS.Timeout }>();
  private readonly allowedTools = new Map<string, Set<string>>();
  private readonly secrets = new Map<string, string>();
  private readonly bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  /**
   * What a chat's permission bridge authenticates with instead of the API token: it lives in a file
   * and a process environment that agents running as the same user could read, so it can do one
   * thing only, ask the window about that chat.
   */
  secretFor(chat: string): string {
    let s = this.secrets.get(chat);
    if (!s) this.secrets.set(chat, (s = randomBytes(24).toString('base64url')));
    return s;
  }

  /** The chat a bridge secret belongs to, if it is one. */
  chatOf(secret: string | undefined): string | undefined {
    if (!secret) return undefined;
    const given = Buffer.from(secret);
    for (const [chat, s] of this.secrets) {
      const own = Buffer.from(s);
      if (own.length === given.length && timingSafeEqual(own, given)) return chat;
    }
    return undefined;
  }

  request(chat: string, tool: string, input: unknown): Promise<Decision> {
    if (this.allowedTools.get(chat)?.has(tool)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const req: PermissionRequest = { id: randomUUID(), chat, tool, input, at: new Date().toISOString() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(req.id, 'deny', 'No answer in the duo window within 30 minutes.'), TIMEOUT_MS);
      this.pending.set(req.id, { req, resolve, timer });
      this.bus.emit({ t: 'permission', request: req });
    });
  }

  decide(id: string, decision: 'allow' | 'allow_session' | 'deny', message?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (decision === 'allow_session') {
      const set = this.allowedTools.get(p.req.chat) ?? new Set<string>();
      set.add(p.req.tool);
      this.allowedTools.set(p.req.chat, set);
    }
    p.resolve(decision === 'deny' ? { behavior: 'deny', message: message || 'The user denied this action.' } : { behavior: 'allow', updatedInput: p.req.input });
    this.bus.emit({ t: 'permission_resolved', id, chat: p.req.chat, decision });
    return true;
  }

  list(chat?: string): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.req).filter((r) => !chat || r.chat === chat);
  }

  /** A stopped turn cannot use its pending answers any more. */
  cancelChat(chat: string): void {
    for (const r of this.list(chat)) this.decide(r.id, 'deny', 'The turn was stopped.');
  }

  allowedFor(chat: string): string[] {
    return [...(this.allowedTools.get(chat) ?? [])];
  }

  /** A deleted chat: its remembered answers and its bridge secret go too. */
  forget(chat: string): void {
    this.allowedTools.delete(chat);
    this.secrets.delete(chat);
  }
}
