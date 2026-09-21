#!/usr/bin/env node
/**
 * Swivel MCP server — the agent-facing edge of the system.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * This is what the whole architecture is for. An AI agent — the product that
 * actually talks to a member service rep — lists the capabilities its
 * institution has approved, and calls one by name with typed arguments. It does
 * not reason about the UI. It does not know there is a UI. It gets a typed
 * result back in a few seconds, at no model cost, with an evidence bundle
 * written behind it.
 *
 * Deliberate choices:
 *
 *  - **Only approved capabilities are listed.** A draft capability is invisible
 *    to agents by construction, not by convention.
 *  - **The tool description carries the safety contract.** Whether the call
 *    changes records, whether it is reversible, and which business outcomes it
 *    can return are in the text the calling model reads before deciding.
 *  - **Business outcomes are not errors.** `RECORD_NOT_FOUND` comes back as a
 *    normal result with a structured payload, so the agent branches instead of
 *    retrying. Only genuine failures set `isError`.
 *  - **Irreversible capabilities need a confirmation token** that the agent
 *    must pass explicitly. A model cannot talk its way past it.
 *
 * Transport is stdio JSON-RPC, so it drops straight into Claude Desktop or
 * Claude Code:
 *
 *   {
 *     "mcpServers": {
 *       "swivel": {
 *         "command": "npx",
 *         "args": ["tsx", "packages/mcp/src/main.ts"],
 *         "env": { "SWIVEL_CONSOLE_URL": "http://127.0.0.1:4700",
 *                  "SWIVEL_API_USER": "shivam", "SWIVEL_API_PASSWORD": "swivel" }
 *       }
 *     }
 *   }
 */
import { createInterface } from 'node:readline';

const CONSOLE_URL = (process.env.SWIVEL_CONSOLE_URL ?? 'http://127.0.0.1:4700').replace(/\/$/, '');
const USER = process.env.SWIVEL_API_USER ?? 'shivam';
const PASSWORD = process.env.SWIVEL_API_PASSWORD ?? 'swivel';
const DEFAULT_TENANT = process.env.SWIVEL_TENANT ?? 'pineridge';
const PROTOCOL_VERSION = '2024-11-05';

let cookie = '';

const log = (...a: unknown[]) => process.stderr.write(`[swivel-mcp] ${a.join(' ')}\n`);

async function signIn(): Promise<void> {
  const res = await fetch(`${CONSOLE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: USER, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Could not sign in to the Swivel console at ${CONSOLE_URL}: ${res.status}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  log(`signed in as ${USER}`);
}

async function callApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!cookie) await signIn();
  const res = await fetch(`${CONSOLE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });
  if (res.status === 401) { cookie = ''; await signIn(); return callApi<T>(path, init); }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; requiresConfirmation: boolean; capability: string; stabilityScore: number };
}

let toolCache: ToolDef[] = [];

async function listTools(): Promise<ToolDef[]> {
  const { tools } = await callApi<{ tools: ToolDef[] }>('/api/tools');
  toolCache = tools;
  return tools;
}

/**
 * Every capability gains two synthetic arguments.
 *
 * `tenant` because the same capability serves many institutions and the agent
 * knows which one it is acting for. `confirmationToken` because an irreversible
 * capability must not be invocable by a model that merely decided it was a good
 * idea — the token has to come from the caller's own authorisation step.
 */
function withEnvelope(t: ToolDef): ToolDef {
  const properties: Record<string, unknown> = {
    ...t.inputSchema.properties,
    tenant: {
      type: 'string',
      description: `Institution to act against. Defaults to "${DEFAULT_TENANT}".`,
      default: DEFAULT_TENANT,
    },
  };
  if (t.annotations.requiresConfirmation) {
    properties.confirmationToken = {
      type: 'string',
      description: 'REQUIRED. This capability is irreversible. Supply a confirmation token obtained from an explicit human or policy authorisation. The call is refused without it.',
    };
  }
  return {
    ...t,
    inputSchema: {
      ...t.inputSchema,
      properties,
      required: t.annotations.requiresConfirmation ? [...t.inputSchema.required, 'confirmationToken'] : t.inputSchema.required,
    },
  };
}

interface InvokeResult {
  status: 'success' | 'business_outcome' | 'escalated' | 'failed';
  outputs?: Record<string, unknown>;
  outcome?: { code: string; retryable: boolean; message: string; data: Record<string, unknown> };
  error?: { class: string; message: string; stepId?: string; expected?: string; observed?: string };
  intervention?: { id: string; reason: string; resolution?: string };
  runId: string; durationMs: number; evidenceDir: string; llmCalls: number;
  recoveries: Array<{ signalTitle: string; strategy: string; attempts: number }>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!toolCache.length) await listTools();
  const tool = toolCache.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: `No approved capability named "${name}". Call tools/list to see what this institution has approved.` }], isError: true };
  }
  const [capabilityId, version] = tool.annotations.capability.split('@');
  const { tenant = DEFAULT_TENANT, confirmationToken, ...inputs } = args;

  const result = await callApi<InvokeResult>(`/api/capabilities/${encodeURIComponent(capabilityId as string)}/invoke`, {
    method: 'POST',
    body: JSON.stringify({ version, tenant, inputs, unattended: true, confirmationToken }),
  });

  const trailer = `\n\n— run ${result.runId} · ${result.durationMs}ms · ${result.llmCalls} model calls · evidence: ${result.evidenceDir}`;

  switch (result.status) {
    case 'success':
      return { content: [{ type: 'text', text: `${JSON.stringify(result.outputs, null, 2)}${result.recoveries.length ? `\n\n(recovered from: ${result.recoveries.map((r) => r.signalTitle).join(', ')})` : ''}${trailer}` }] };

    case 'business_outcome':
      // Not an error. The application gave a real answer and the agent should
      // act on it rather than retry.
      return {
        content: [{
          type: 'text',
          text: `OUTCOME ${result.outcome?.code}${result.outcome?.retryable ? ' (retryable)' : ''}\n${result.outcome?.message}\n` +
            `${Object.keys(result.outcome?.data ?? {}).length ? `\n${JSON.stringify(result.outcome?.data, null, 2)}` : ''}` +
            `\n\nThis is a legitimate result, not a failure. Do not retry unless it is marked retryable.${trailer}`,
        }],
      };

    case 'escalated':
      return {
        content: [{
          type: 'text',
          text: `ESCALATED to a human operator (${result.intervention?.reason}). Resolution: ${result.intervention?.resolution ?? 'pending'}.` +
            `\nThe work may or may not be complete — verify before acting on it.${trailer}`,
        }],
      };

    case 'failed':
    default:
      return {
        content: [{
          type: 'text',
          text: `FAILED ${result.error?.class} at step "${result.error?.stepId ?? '-'}"\n${result.error?.message}` +
            `${result.error?.expected ? `\nexpected: ${result.error.expected}` : ''}` +
            `${result.error?.observed ? `\nobserved: ${result.error.observed}` : ''}${trailer}`,
        }],
        isError: true,
      };
  }
}

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

type Rpc = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> };

function reply(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;   // notification
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function replyError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(msg: Rpc): Promise<void> {
  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'swivel', version: '1.0.0' },
        instructions:
          'Swivel exposes approved back-office capabilities for legacy banking applications. Each tool drives a real UI ' +
          'deterministically — no model is involved in execution. Read each tool description before calling: it states ' +
          'whether the call changes records, whether that change is reversible, and which business outcomes it can return. ' +
          'Business outcomes such as RECORD_NOT_FOUND are answers, not errors — branch on them rather than retrying.',
      });
      return;

    case 'notifications/initialized':
      return;

    case 'tools/list': {
      const tools = (await listTools()).map(withEnvelope);
      reply(msg.id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            readOnlyHint: t.annotations.readOnlyHint,
            destructiveHint: t.annotations.destructiveHint,
            idempotentHint: false,
            openWorldHint: false,
          },
        })),
      });
      return;
    }

    case 'tools/call': {
      const { name, arguments: args } = (msg.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
      try { reply(msg.id, await callTool(name, args ?? {})); }
      catch (e) { reply(msg.id, { content: [{ type: 'text', text: `Swivel could not complete the call: ${(e as Error).message}` }], isError: true }); }
      return;
    }

    case 'ping':
      reply(msg.id, {});
      return;

    default:
      replyError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: Rpc;
  try { msg = JSON.parse(line) as Rpc; }
  catch { return; }
  void handle(msg).catch((e) => replyError(msg.id, -32603, (e as Error).message));
});

log(`ready — proxying ${CONSOLE_URL}`);
