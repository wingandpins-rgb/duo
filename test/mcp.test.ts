/** The chat MCP server Claude Code talks to: its tools, and the worker's question reaching the duo server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', 'src', 'server', 'permission-mcp.ts');

/** A stand-in for the duo server: records each request and answers the lead's question. */
async function stubServer(): Promise<{ url: string; seen: { path: string; auth: string; body: any }[]; close: () => void }> {
  const seen: { path: string; auth: string; body: any }[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
  const server = createServer(async (req, res) => {
    seen.push({ path: req.url ?? '', auth: String(req.headers.authorization), body: JSON.parse(await read(req)) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/internal/ask-lead' ? { answer: 'Use korea-debug.' } : { behavior: 'allow', updatedInput: {} }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

/** Talk to the MCP server over stdio, one JSON-RPC request at a time. */
function mcp(env: Record<string, string>) {
  const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: p.stdout });
  const waiting = new Map<number, (v: any) => void>();
  lines.on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let n = 0;
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, close: () => p.kill() };
}

test('the worker of a team chat gets ask_lead, and its question reaches duo with the chat secret', { timeout: 30_000 }, async () => {
  const srv = await stubServer();
  const c = mcp({ DUO_API_URL: srv.url, DUO_API_TOKEN: 'chat-secret', DUO_CHAT_ID: 'c1', DUO_TEAM_LEAD: 'Astra' });
  try {
    await c.call('initialize', { protocolVersion: '2025-06-18' });
    const tools = (await c.call('tools/list')).result.tools;
    assert.deepEqual(tools.map((t: { name: string }) => t.name), ['approve', 'ask_lead']);
    assert.match(tools[1].description, /Ask Astra, who leads this team chat/);
    const r = await c.call('tools/call', { name: 'ask_lead', arguments: { question: 'Which catalog?' } });
    assert.equal(r.result.content[0].text, 'Use korea-debug.');
    assert.deepEqual(srv.seen.at(-1), { path: '/api/internal/ask-lead', auth: 'Bearer chat-secret', body: { question: 'Which catalog?' } });
  } finally {
    c.close();
    srv.close();
  }
});

test('outside a team chat the server has only the approval tool', { timeout: 30_000 }, async () => {
  const srv = await stubServer();
  const c = mcp({ DUO_API_URL: srv.url, DUO_API_TOKEN: 'chat-secret', DUO_CHAT_ID: 'c1', DUO_TEAM_LEAD: '' });
  try {
    await c.call('initialize', { protocolVersion: '2025-06-18' });
    assert.deepEqual((await c.call('tools/list')).result.tools.map((t: { name: string }) => t.name), ['approve']);
    const r = await c.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
    assert.deepEqual(JSON.parse(r.result.content[0].text), { behavior: 'allow', updatedInput: {} });
    assert.equal(srv.seen.at(-1)?.path, '/api/internal/permission');
  } finally {
    c.close();
    srv.close();
  }
});
