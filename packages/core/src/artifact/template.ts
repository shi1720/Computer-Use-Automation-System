/**
 * The one templating rule in the system: `{{ namespace.path }}`.
 *
 * Used in step values, navigation URLs, target name probes and assertion text.
 * Keeping it to a single, extremely dumb substitution engine is deliberate —
 * anything with conditionals or loops would move decision-making back into the
 * artifact, and the entire value proposition is that replay makes no decisions.
 *
 * Namespaces:
 *   input.*   — the caller's typed arguments
 *   output.*  — values extracted earlier in this same run
 *   vocab.*   — tenant vocabulary (capability defaults, overridden by overlay)
 *   tenant.*  — baseUrl, productVersion, tenantId
 *   run.*     — runId, startedAt
 */
export interface TemplateContext {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  vocab: Record<string, string>;
  tenant: Record<string, string>;
  run: Record<string, string>;
}

export class TemplateError extends Error {
  constructor(public readonly expression: string, message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const EXPR = /\{\{\s*([a-zA-Z_][\w]*)\.([\w.]+)\s*\}\}/g;

export function render(template: string, ctx: TemplateContext): string {
  return template.replace(EXPR, (_m, ns: string, path: string) => {
    const bag = (ctx as unknown as Record<string, Record<string, unknown>>)[ns];
    if (!bag) throw new TemplateError(`${ns}.${path}`, `Unknown template namespace "${ns}"`);
    const value = path.split('.').reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), bag);
    if (value === undefined || value === null) {
      throw new TemplateError(`${ns}.${path}`, `Template value "${ns}.${path}" is not defined at this point in the run`);
    }
    return String(value);
  });
}

/** Render without throwing — used for log messages and previews. */
export function renderLoose(template: string, ctx: TemplateContext): string {
  try { return render(template, ctx); } catch { return template; }
}

/** All `ns.path` expressions referenced by a template string. */
export function referencesOf(template: string): Array<{ ns: string; path: string }> {
  const out: Array<{ ns: string; path: string }> = [];
  for (const m of template.matchAll(EXPR)) out.push({ ns: m[1] as string, path: m[2] as string });
  return out;
}

export function emptyContext(): TemplateContext {
  return { input: {}, output: {}, vocab: {}, tenant: {}, run: {} };
}
