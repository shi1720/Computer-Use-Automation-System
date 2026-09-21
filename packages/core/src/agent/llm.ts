/**
 * The model boundary.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Swivel calls a model in exactly two places: discovery, and the optional
 * single-step repair during replay. Everything else — every production
 * invocation an AI agent makes — runs with this file untouched. That is the
 * whole economic argument of the system, so the boundary is narrow and explicit
 * rather than woven through the codebase.
 *
 * Two providers ship:
 *
 *   anthropic   The real thing: the official SDK, native tool use, adaptive
 *               thinking, and prompt caching on the system prefix (which matters
 *               a lot here — the system prompt and tool schemas are ~4k tokens
 *               and get resent on every turn of a 15-turn discovery loop).
 *
 *   claude-cli  Routes through the locally authenticated Claude Code CLI. No
 *               API key required, which means a reviewer can run a genuine
 *               LLM-driven discovery without first buying credits. Tool calls
 *               are expressed as JSON rather than native tool blocks; the agent
 *               loop above cannot tell the difference.
 *
 * Plus `mock`, which replays a scripted sequence so the agent loop itself can be
 * unit-tested without a network or a bill.
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage { role: 'user' | 'assistant'; content: LlmContent[] }

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  /** `low` for cheap repair decisions, `high` for discovery. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage: LlmUsage;
  stopReason?: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Published list prices, USD per million tokens. Used for the cost report. */
export const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5-1': { in: 10, out: 50 },
};

/** Cache reads bill at ~0.1x input, cache writes at ~1.25x. */
export function estimateCostUsd(model: string, u: LlmUsage): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5'] as { in: number; out: number };
  const M = 1_000_000;
  return (
    (u.inputTokens * p.in) / M +
    (u.cacheReadTokens * p.in * 0.1) / M +
    (u.cacheCreationTokens * p.in * 1.25) / M +
    (u.outputTokens * p.out) / M
  );
}

export const emptyUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

// ── Anthropic ────────────────────────────────────────────────────────────────

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(readonly model = process.env.SWIVEL_LLM_MODEL ?? 'claude-opus-5', apiKey?: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 8_000,
      // Discovery is exactly the kind of multi-step reasoning adaptive thinking
      // is for: the model has to read an unfamiliar legacy screen and work out
      // which of forty identical-looking controls is the one a teller would use.
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort ?? 'high' },
      system: [
        {
          type: 'text',
          text: req.system,
          // The system prompt and tool schemas are the stable prefix and get
          // resent every turn. Caching them cuts the cost of a discovery run by
          // roughly the ratio of turns to one.
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      })),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((c): Anthropic.ContentBlockParam => {
          if (c.type === 'text') return { type: 'text', text: c.text };
          if (c.type === 'tool_use') return { type: 'tool_use', id: c.id, name: c.name, input: c.input as object };
          return { type: 'tool_result', tool_use_id: c.toolUseId, content: c.content, ...(c.isError ? { is_error: true } : {}) };
        }),
      })),
    });

    const text = res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('\n');
    const toolCalls = res.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        const t = b as Anthropic.ToolUseBlock;
        return { id: t.id, name: t.name, input: t.input as Record<string, unknown> };
      });

    return {
      text,
      toolCalls,
      stopReason: res.stop_reason ?? undefined,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

// ── Claude Code CLI ──────────────────────────────────────────────────────────

/**
 * Routes through the locally authenticated `claude` CLI in headless mode.
 *
 * The CLI has no native tool-calling surface, so tools are described in the
 * prompt and the model is asked for a single JSON object. That is strictly
 * worse than native tool use — no schema enforcement, and the model can produce
 * malformed output — so the parser is defensive and the loop above treats a
 * parse failure as a normal recoverable turn rather than a crash.
 *
 * It exists for one reason and earns its place: a reviewer with no Anthropic
 * API key can still watch a real model drive a real legacy UI.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly name = 'claude-cli';
  constructor(readonly model = 'claude-code-cli', private readonly timeoutMs = Number(process.env.SWIVEL_CLI_TIMEOUT_MS ?? 420_000)) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const prompt = renderCliPrompt(req);
    const out = await this.run(prompt);
    const parsed = parseCliAction(out);
    return {
      text: parsed.reasoning ?? out.slice(0, 2_000),
      toolCalls: parsed.tool ? [{ id: `cli_${Date.now()}`, name: parsed.tool, input: parsed.input ?? {} }] : [],
      // The CLI does not report token usage. Reporting zeros is honest;
      // inventing an estimate would corrupt the cost figures in the evidence.
      usage: emptyUsage(),
      stopReason: parsed.tool ? 'tool_use' : 'end_turn',
    };
  }

  private run(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude CLI timed out after ${this.timeoutMs}ms`)); }, this.timeoutMs);
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`));
        else resolve(stdout);
      });
    });
  }
}

function renderCliPrompt(req: LlmRequest): string {
  const tools = req.tools.map((t) => `### ${t.name}\n${t.description}\nInput JSON schema:\n${JSON.stringify(t.inputSchema)}`).join('\n\n');
  const convo = req.messages.map((m) => {
    const parts = m.content.map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'tool_use') return `[you called ${c.name} with ${JSON.stringify(c.input)}]`;
      return `[result of your last call${c.isError ? ' (ERROR)' : ''}]\n${c.content}`;
    });
    return `## ${m.role === 'user' ? 'OBSERVATION' : 'YOU'}\n${parts.join('\n')}`;
  }).join('\n\n');

  return `${req.system}

# Available tools
${tools}

# Conversation so far
${convo}

# Your response format
Reply with a single fenced JSON block and NOTHING else:
\`\`\`json
{"reasoning": "one or two sentences on why this action", "tool": "<tool name>", "input": { ... }}
\`\`\`
Use exactly one tool per reply. Do not add commentary outside the JSON block.`;
}

/** Pull the action object out of whatever the CLI produced. */
export function parseCliAction(raw: string): { reasoning?: string; tool?: string; input?: Record<string, unknown> } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];
  for (const c of candidates) {
    // Scan for the first balanced object; models like to add a preamble.
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i] as string;
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(c.slice(start, i + 1)) as never; } catch { break; }
        }
      }
    }
  }
  return {};
}

// ── Mock ─────────────────────────────────────────────────────────────────────

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock';
  private i = 0;
  constructor(private readonly script: Array<{ text?: string; tool?: string; input?: Record<string, unknown> }>) {}
  async complete(): Promise<LlmResponse> {
    const s = this.script[this.i++] ?? {};
    return {
      text: s.text ?? '',
      toolCalls: s.tool ? [{ id: `mock_${this.i}`, name: s.tool, input: s.input ?? {} }] : [],
      usage: emptyUsage(),
      stopReason: s.tool ? 'tool_use' : 'end_turn',
    };
  }
}

export function providerFromEnv(): LlmProvider {
  const kind = (process.env.SWIVEL_LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'claude-cli')).toLowerCase();
  switch (kind) {
    case 'anthropic': return new AnthropicProvider();
    case 'claude-cli': return new ClaudeCliProvider();
    case 'mock': return new MockProvider([]);
    default: throw new Error(`Unknown SWIVEL_LLM_PROVIDER "${kind}". Use anthropic | claude-cli | mock.`);
  }
}
