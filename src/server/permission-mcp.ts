/**
 * Minimal MCP stdio server for a chat's Claude Code session. Its tools reach the duo GUI server with
 * the chat's own secret:
 *   approve   Claude Code's --permission-prompt-tool. Claude Code calls it whenever it would ask a
 *             person; it forwards the question to the window and returns the user's answer in the format
 *             Claude Code expects: {"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}
 *   ask_lead  In a team chat, for the worker (when DUO_TEAM_LEAD names the lead): a question to the lead
 *             in the middle of its own turn; returns the lead's answer.
 * Uses node:http rather than fetch, whose default 5-minute header timeout would cut off a user (or a
 * lead) who takes longer to answer.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const API = new URL(process.env.DUO_API_URL ?? 'http://127.0.0.1:0');
const TOKEN = process.env.DUO_API_TOKEN ?? '';
const CHAT = process.env.DUO_CHAT_ID ?? '';
const LEAD = process.env.DUO_TEAM_LEAD ?? '';

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function post(path: string, payload: unknown): Promise<{ status: number; data: any }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: API.hostname, port: API.port, path, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
          } catch {
            reject(new Error(`duo returned an unreadable answer (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.setTimeout(0);
    req.on('error', (e) => reject(new Error(`duo GUI unreachable: ${e.message}`)));
    req.end(body);
  });
}

async function approve(args: Record<string, unknown>): Promise<unknown> {
  try {
    return (await post('/api/internal/permission', { chat: CHAT, tool: args.tool_name, input: args.input ?? {}, toolUseId: args.tool_use_id })).data;
  } catch (e) {
    return { behavior: 'deny', message: (e as Error).message };
  }
}

async function askLead(args: Record<string, unknown>): Promise<string> {
  try {
    const r = await post('/api/internal/ask-lead', { question: String(args.question ?? '') });
    return r.status === 200 ? String(r.data.answer ?? '') : `${LEAD} could not be asked: ${String(r.data?.error ?? `HTTP ${r.status}`)}. Carry on with your best judgement, and say so in your report.`;
  } catch (e) {
    return `${LEAD} could not be asked: ${(e as Error).message}. Carry on with your best judgement, and say so in your report.`;
  }
}

const TOOLS = [
  {
    name: 'approve',
    description: 'Ask the user, in the duo window, whether a tool call may run.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
  },
  ...(LEAD
    ? [{
        name: 'ask_lead',
        description: `Ask ${LEAD}, who leads this team chat, a question in the middle of your work, and get ${LEAD}'s answer. Use it whenever the task, the code or the project's plans do not settle a decision, instead of guessing. Include the context ${LEAD} needs to answer.`,
        inputSchema: { type: 'object', properties: { question: { type: 'string', description: `The question for ${LEAD}, with the context it needs.` } }, required: ['question'] },
      }]
    : []),
];

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m: { id?: number | string; method?: string; params?: Record<string, any> };
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  switch (m.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'duo', version: '1.0.0' } } });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const args = m.params?.arguments ?? {};
      if (m.params?.name === 'ask_lead' && LEAD) {
        send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: await askLead(args) }] } });
        return;
      }
      const decision = await approve(args);
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
      return;
    }
    case 'ping':
      send({ jsonrpc: '2.0', id: m.id, result: {} });
      return;
    default:
      if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
