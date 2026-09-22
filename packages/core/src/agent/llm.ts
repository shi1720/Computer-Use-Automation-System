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
 * Three real providers ship, and the agent loop cannot tell them apart. That is
 * the point of the interface rather than an accident of it: which vendor's model
 * read the screen is a fact about one discovery run, not a property of the
 * capability it produced. The artifact is the deliverable, and it is the same
 * document either way.
 *
 *   anthropic   Official SDK, native tool use, adaptive thinking, and prompt
 *               caching on the system prefix — which matters here, because the
 *               system prompt and tool schemas are ~4k tokens resent on every
 *               turn of a 15-turn loop.
 *
 *   openai      Official SDK against the Responses API, native function calling
 *               and reasoning effort. Prompt caching is automatic and reported,
 *               so the cost figures in the evidence are measured rather than
 *               estimated.
 *
 *   claude-cli  Routes through the locally authenticated Claude Code CLI. No API
 *               key at all, which means a reviewer can watch a genuine
 *               LLM-driven discovery without first buying credits. Tool calls
 *               are JSON in the prompt rather than native tool blocks, and it
 *               reports no token usage — so it is the right default for trying
 *               the system out and the wrong one for measuring it.
 *
 * Plus `mock`, which replays a scripted sequence so the agent loop itself can be
 * unit-tested without a network or a bill.
 *
 * Credentials come from the environment and are never read from, or written to,
 * anything in this repository.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
  // OpenAI list prices. Cached input bills at a tenth of input on both vendors,
  // which is why `estimateCostUsd` below needs no per-vendor branch.
  'gpt-5.1': { in: 1.25, out: 10 },
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4o': { in: 2.5, out: 10 },
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

// ── OpenAI ───────────────────────────────────────────────────────────────────

/**
 * OpenAI, through the Responses API.
 *
 * The Responses API rather than Chat Completions, for two reasons that both
 * show up in the evidence. Reasoning effort is a first-class parameter, and
 * discovery is exactly the kind of work it is for — reading an unfamiliar
 * legacy screen and deciding which of forty identical-looking controls a teller
 * would use. And usage comes back with cached input broken out, so the cost
 * line in a run's evidence is measured rather than guessed.
 *
 * One deliberate limitation. The loop above hands every provider a complete
 * message list each turn, which keeps providers interchangeable and keeps the
 * loop free of vendor state. Translating that list forward means reasoning
 * items from earlier turns are not replayed, so the model does not see its own
 * prior chain of thought — only the conversation, which carries the same facts.
 * `previous_response_id` would preserve it at the cost of making this provider
 * stateful and the three implementations structurally different. The trade is
 * worth naming and, for a tool loop, cheap.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(readonly model = process.env.SWIVEL_LLM_MODEL ?? 'gpt-5.1', apiKey?: string) {
    this.client = new OpenAI(apiKey ? { apiKey } : {});
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.responses.create({
      model: this.model,
      instructions: req.system,
      input: toResponsesInput(req.messages),
      tools: req.tools.map((t) => ({
        type: 'function' as const,
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
        // Not strict: these schemas have optional properties by design, and
        // strict mode requires every property to be required. Enforcing a
        // shape the tool does not have would push the model into supplying
        // placeholder values, which is worse than validating our own input.
        strict: false,
      })),
      reasoning: { effort: openAiEffort(req.effort) },
      max_output_tokens: req.maxTokens ?? 8_000,
    });

    const text = res.output
      .filter((o) => o.type === 'message')
      .flatMap((o) => (o as { content?: Array<{ type: string; text?: string }> }).content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('\n');

    const toolCalls = res.output
      .filter((o) => o.type === 'function_call')
      .map((o) => {
        const f = o as { call_id: string; name: string; arguments: string };
        return { id: f.call_id, name: f.name, input: safeJson(f.arguments) };
      });

    const u = res.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    return {
      text,
      toolCalls,
      stopReason: toolCalls.length ? 'tool_use' : (res.status ?? 'end_turn'),
      usage: {
        // `input_tokens` is the total and already includes the cached portion.
        // Double-counting it here would inflate every cost figure in the
        // evidence by the size of the system prefix, on every turn.
        inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached),
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheCreationTokens: 0,   // OpenAI caches automatically and does not bill writes
      },
    };
  }
}

/** Reasoning effort, mapped from the loop's vocabulary to OpenAI's. */
function openAiEffort(e: LlmRequest['effort']): 'low' | 'medium' | 'high' {
  if (e === 'low') return 'low';
  if (e === 'medium') return 'medium';
  return 'high';
}

/** Tolerant of a model that emits malformed arguments; the loop treats an empty input as a bad turn. */
function safeJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Translate the loop's message list into Responses API input items.
 *
 * The shapes differ in one way that matters: a tool call and its result are
 * blocks *inside* messages for Anthropic, and top-level items for OpenAI. A
 * `function_call` must be followed by a `function_call_output` carrying the
 * same `call_id` or the request is rejected, which the loop satisfies
 * naturally by construction.
 */
export function toResponsesInput(messages: LlmMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    const texts = m.content.filter((c) => c.type === 'text') as Array<{ type: 'text'; text: string }>;
    if (texts.length) {
      // Assistant turns go back as plain text. The structured `output_text`
      // form is what the API *returns*, and echoing it requires ids and status
      // fields that belong to a response we are not replaying.
      items.push(m.role === 'user'
        ? { role: 'user', content: texts.map((t) => ({ type: 'input_text' as const, text: t.text })) }
        : { role: 'assistant', content: texts.map((t) => t.text).join('\n') });
    }
    for (const c of m.content) {
      if (c.type === 'tool_use') {
        items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) });
      } else if (c.type === 'tool_result') {
        items.push({ type: 'function_call_output', call_id: c.toolUseId, output: c.content });
      }
    }
  }
  return items;
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

/**
 * Pick a provider from the environment.
 *
 * An explicit `SWIVEL_LLM_PROVIDER` always wins. Failing that, whichever API key
 * is present decides — and `claude-cli` is the last resort rather than a
 * preference, because it reports no token usage and a discovery run that cannot
 * state its own cost is a weaker piece of evidence.
 */
export function providerFromEnv(): LlmProvider {
  const explicit = process.env.SWIVEL_LLM_PROVIDER?.toLowerCase();
  const kind = explicit
    ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'claude-cli');
  switch (kind) {
    case 'anthropic': return new AnthropicProvider();
    case 'openai': return new OpenAiProvider();
    case 'claude-cli': return new ClaudeCliProvider();
    case 'mock': return new MockProvider([]);
    default: throw new Error(`Unknown SWIVEL_LLM_PROVIDER "${kind}". Use anthropic | openai | claude-cli | mock.`);
  }
}
