/**
 * Emitting a Playwright test from a capability artifact.
 *
 * Not how Swivel executes anything — the engine replays the artifact directly.
 * This exists because of how these systems get adopted: a bank's QA or
 * integration team will want the flow as code they own, in a framework they
 * already run in CI, before they will let an agent drive it unattended. Handing
 * them that file, generated from the same artifact the engine runs, turns
 * "trust our black box" into "here is the same thing, in your repo".
 *
 * Two rules for the output:
 *
 *   It must be *correct*. A generated test that silently reads the wrong grid
 *   cell is worse than no generated test, because someone will trust it. Grid
 *   access therefore goes through a small emitted helper that resolves a column
 *   by its header at runtime, the way the artifact describes it — not by an
 *   index guessed at generation time.
 *
 *   It must be *honest about what it loses*. Plain Playwright has no scored
 *   targeting, no runtime signal handling, no evidence chain. The header says
 *   so rather than letting the reader assume parity.
 */
import type { Capability, Step, TargetDescriptor } from '@swivel/core';

const q = (s: string) => JSON.stringify(s);

/** Resolve artifact templates for one concrete tenant at generation time. */
function makeRenderer(cap: Capability) {
  const vocab = cap.target.vocabulary;
  return (raw: string): string =>
    raw
      .replace(/\{\{vocab\.(\w+)\}\}/g, (_m, k: string) => vocab[k] ?? k)
      .replace(/\{\{tenant\.baseUrl\}\}/g, '${baseUrl}')
      .replace(/\{\{input\.(\w+)\}\}/g, '${inputs.$1}')
      .replace(/\{\{run\.(\w+)\}\}/g, '${run.$1}');
}

const hasInterpolation = (s: string) => s.includes('${');
/** A plain string literal where possible; a template literal where needed. */
const lit = (s: string) => (hasInterpolation(s) ? `\`${s}\`` : q(s));

function scopeFor(t: TargetDescriptor): string {
  const frames = t.frame?.path ?? [];
  return frames.map((f) => `.frameLocator(${q(`frame[name="${f}"]`)})`).join('');
}

/**
 * `asyncExpr` marks a locator that has to *look at the page* to build itself —
 * `cellInRow` resolves a column from its header at runtime, so it returns a
 * promise. Call sites need to know, because `await f(x).textContent()` and
 * `(await f(x)).textContent()` are different programs and only one of them
 * runs.
 */
function locatorFor(t: TargetDescriptor, render: (s: string) => string): { expr: string; note?: string; asyncExpr?: boolean } {
  const root = `page${scopeFor(t)}`;

  // Grid access: resolve the column by its header at runtime.
  if (t.cell?.rowWhere) {
    const rowValue = render(t.cell.rowWhere.equals);
    const column = t.cell.columnHeader ? render(t.cell.columnHeader.value) : null;
    if (t.role === 'cell' && column) {
      return {
        expr: `cellInRow(${root}, ${lit(rowValue)}, ${lit(column)})`,
        asyncExpr: true,
        note: `the cell under "${column}" in the row whose values include "${rowValue}"`,
      };
    }
    const name = t.name ? `, { name: ${lit(render(t.name.value))} }` : '';
    return {
      expr: `rowContaining(${root}, ${lit(rowValue)}).getByRole(${q(t.role)}${name}).first()`,
      note: `addressed by row value, never by row index — this survives a tenant inserting a column`,
    };
  }

  if (t.name) {
    const exact = (t.name.match ?? 'normalized') === 'exact' ? ', exact: true' : '';
    return { expr: `${root}.getByRole(${q(t.role)}, { name: ${lit(render(t.name.value))}${exact} })` };
  }

  if (t.anchors?.length) {
    const a = t.anchors[0] as NonNullable<TargetDescriptor['anchors']>[number];
    return {
      expr: `fieldBeside(${root}, ${lit(render(a.text.value))}, ${q(t.role)})`,
      note: `this control has no label; the caption "${render(a.text.value)}" beside it is how a person finds it`,
    };
  }

  if (t.hints?.idPattern) {
    const prefix = t.hints.idPattern.split('\\d')[0] ?? '';
    return { expr: `${root}.locator(${q(`[id^="${prefix}"]`)})`, note: 'weak: selector-level fallback only' };
  }
  return { expr: `${root}.getByRole(${q(t.role)})`, note: 'weak: role alone does not identify a control' };
}

function stepCode(s: Step, render: (r: string) => string): string {
  const out: string[] = [];
  // The intent is templated prose — `{{vocab.member}}`, `{{input.memberNumber}}`
  // — because it is shared across institutions. A generated file is for one
  // tenant, so it is rendered here; leaving the braces in produces comments
  // that read like a bug.
  out.push(`  // ${render(s.intent)}${s.risk && s.risk !== 'read_only' ? `   [risk: ${s.risk}]` : ''}`);

  const loc = s.target ? locatorFor(s.target, render) : null;
  if (loc?.note) out.push(`  //   ${loc.note}`);

  switch (s.kind) {
    case 'navigate': out.push(`  await page.goto(${lit(render(s.url ?? ''))});`); break;
    case 'click': out.push(`  await ${loc?.expr}.click();`); break;
    case 'fill': out.push(`  await ${loc?.expr}.fill(${lit(render(s.value ?? ''))});`); break;
    case 'select': out.push(`  await ${loc?.expr}.selectOption(${lit(render(s.value ?? ''))});`); break;
    case 'press': out.push(`  await ${loc?.expr}.press(${q(s.key ?? 'Enter')});`); break;
    case 'extract':
      const read = loc?.asyncExpr ? `(await ${loc.expr}).textContent()` : `${loc?.expr}.textContent()`;
      out.push(`  outputs.${s.extract?.into} = normalise((await ${read}) ?? '', ${q(s.extract?.transform ?? 'none')});`);
      break;
    case 'dismiss_if_present':
      out.push(`  {`, `    const optional = ${loc?.expr};`, `    if (await optional.count()) await optional.first().click();`, `  }`);
      break;
    case 'wait_for': case 'assert': break;
    default: out.push(`  // (${s.kind} is handled by the Swivel engine; there is no direct Playwright equivalent)`);
  }

  if (s.expect) {
    out.push(`  // ${s.expect.description}`);
    for (const a of s.expect.all) out.push(...assertionCode(a, render));
  }
  return out.join('\n');
}

function assertionCode(a: { kind: string; text?: string; regex?: string; target?: TargetDescriptor }, render: (s: string) => string): string[] {
  // Text assertions go through a frame-aware helper. The capability asserts
  // "the screen says X", and on a frameset the screen is several documents.
  if (a.kind === 'text_present' && a.regex) return [`  await screenContains(page, /${a.regex}/i);`];
  if (a.kind === 'text_present' && a.text) return [`  await screenContains(page, ${lit(render(a.text))});`];
  if (a.kind === 'text_absent' && a.regex) return [`  await screenContains(page, /${a.regex}/i, false);`];
  if (a.kind === 'target_visible' && a.target) {
    const { expr } = locatorFor(a.target, render);
    return [`  await expect(${expr}).toBeVisible();`];
  }
  if (a.kind === 'url_matches' && a.regex) return [`  await expect(page).toHaveURL(/${a.regex}/);`];
  return [];
}

const PRELUDE = `
/**
 * Assert that the *screen* contains something.
 *
 * A capability asserts against the screen; on a frameset the screen is several
 * documents, and \`page.locator('body')\` is only the outermost one — which on
 * these applications contains nothing but the frameset itself. The engine
 * evaluates assertions across every frame it perceived; this is that, by hand.
 */
async function screenContains(page: Page, needle: string | RegExp, expected = true) {
  // Whitespace-flattened and case-insensitive, which is how the engine compares
  // text. A legacy core renders MEMBER INQUIRY SCREEN in caps and across two
  // table cells; asserting on the exact bytes of one rendering is how a
  // translation like this one passes review and then fails on the first run.
  const flat = (t: string) => t.replace(/\\s+/g, ' ').trim().toLowerCase();
  // evaluate(), not locator('body').innerText(). The outermost document of a
  // frameset has no <body> at all, and a locator auto-waits for one — so that
  // version does not return '' for the top frame, it blocks until the whole
  // test times out, and never reaches the frame that holds the screen.
  // expect.poll is already the retry; each read should report what is there now.
  const textOf = (frame: Frame) =>
    frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      const text = await textOf(frame);
      if (typeof needle === 'string' ? flat(text).includes(flat(needle)) : needle.test(text)) return true;
    }
    return false;
  }, { timeout: 15_000, message: \`screen \${expected ? 'should' : 'should not'} contain \${needle}\` }).toBe(expected);
}

/**
 * The control beside a caption.
 *
 * Using .last() here is doing real work. These screens nest layout tables four
 * deep, so several ancestor rows contain the same caption text and a bare
 * locator('tr', { hasText }) is ambiguous — Playwright refuses to act on it.
 * The innermost matching row is the one that actually holds the field, and in
 * document order that is the last match.
 *
 * The Swivel engine does not need this trick: it scores candidates and picks
 * the one the evidence actually supports. This is the cost of translating to
 * plain selectors.
 */
function fieldBeside(scope: FrameLocatorOrPage, caption: string, role: 'textbox' | 'combobox' | 'checkbox' | 'radio' | 'button' | 'link' | 'cell' | 'text' = 'textbox') {
  return scope.locator('tr').filter({ hasText: caption }).last().getByRole(role as never).first();
}

/**
 * Find the row of a data grid by a value it contains, rather than by index.
 *
 * last() on the table for the same reason as cellInRow: every ancestor layout
 * table contains the value too, and the innermost one is the grid.
 */
function rowContaining(scope: FrameLocatorOrPage, value: string) {
  const table = scope.locator('table:has(th)').filter({ hasText: value }).last();
  return table.locator(':scope > tbody > tr, :scope > tr').filter({ hasText: value });
}

/**
 * The cell under a named column, in the row containing a given value.
 *
 * The column is resolved from its header at runtime. Generating a fixed column
 * index instead would read the wrong balance the day the vendor inserts a
 * column — exactly the failure this whole approach exists to avoid.
 *
 * Two details are load-bearing, and both come from these screens nesting layout
 * tables four deep around the real grid:
 *
 *   last() picks the **innermost** table containing the value. Every ancestor
 *   layout table also "contains" it, and the outermost one is the whole page.
 *
 *   The header and row lookups use ':scope >' so they see only *this* table's
 *   own rows and cells. Without that, table.locator('th') collects headers
 *   from nested tables too and the column index is computed against a header
 *   list that does not correspond to any row — which does not throw. It returns
 *   a number from the wrong column, and a test that passes with the wrong
 *   answer is worse than one that fails.
 *
 * The engine does not need any of this: it resolves against a perceived table
 * structure where a cell already knows its own row and column. This is the cost
 * of translating that into plain selectors.
 */
async function cellInRow(scope: FrameLocatorOrPage, rowValue: string, columnHeader: string) {
  const table = scope.locator('table:has(th)').filter({ hasText: rowValue }).last();
  const ownHeaders = table.locator(':scope > thead > tr > th, :scope > tbody > tr > th, :scope > tr > th');
  const headers = await ownHeaders.allTextContents();
  const index = headers.findIndex((h) => h.trim().toLowerCase() === columnHeader.trim().toLowerCase());
  if (index < 0) throw new Error(\`No column "\${columnHeader}" in this grid. Columns: \${headers.join(', ')}\`);
  const row = table.locator(':scope > tbody > tr, :scope > tr').filter({ hasText: rowValue }).first();
  return row.locator(':scope > td').nth(index);
}

/** Match the artifact's declared output transforms. */
function normalise(raw: string, transform: string): string | number | null {
  const t = raw.trim();
  if (transform === 'money_to_number') {
    const negative = /^\\(.*\\)$/.test(t) || t.endsWith('-');
    const n = Number(t.replace(/[(),$\\s-]/g, ''));
    return Number.isFinite(n) ? (negative ? -n : n) : null;
  }
  if (transform === 'digits_only') return t.replace(/\\D/g, '');
  if (transform === 'upper') return t.toUpperCase();
  return t;
}
`;

export function generatePlaywrightTest(cap: Capability, tenantBaseUrl = 'http://127.0.0.1:4711'): string {
  const render = makeRenderer(cap);
  const inputs = cap.contract.inputs
    .map((i) => `  ${i.name}: ${q(i.example ?? '')},${i.description ? `   // ${i.description}` : ''}`)
    .join('\n');

  const warnings = [
    cap.contract.effects.mutating ? 'This flow CHANGES RECORDS.' : 'This flow is read-only.',
    cap.contract.effects.reversible ? null : 'Its effects are IRREVERSIBLE.',
    cap.contract.effects.dualControl ? 'It is subject to dual control: completing it means "submitted for approval", not "applied".' : null,
  ].filter(Boolean).join(' ');

  return `/**
 * ${cap.metadata.title}
 *
 * GENERATED by \`swivel codegen\` from capability ${cap.metadata.id}@${cap.metadata.version}
 * content hash ${cap.contentHash}
 *
 * ${render(cap.metadata.summary).replace(/\$\{inputs\.(\w+)\}/g, '<$1>').replace(/\n/g, '\n * ')}
 *
 * ${warnings}
 *
 * WHAT THIS FILE IS
 *   A faithful translation of the capability into Playwright, for teams that
 *   want the flow as code in their own CI, reviewable in their own repository.
 *
 * WHAT IT IS NOT
 *   The Swivel engine does not run this. Replaying the artifact directly is what
 *   provides scored target resolution that refuses rather than guesses, the
 *   runtime signal handling (session expiry, interstitials, record locks,
 *   end-of-day lockout), the business-outcome result contract, and the
 *   hash-chained evidence bundle. None of that survives into this file.
 *
 * Vocabulary has been resolved for one tenant at generation time. Regenerate for
 * another institution rather than editing the strings by hand.
 */
import { test, expect, type Frame, type Page, type FrameLocator } from '@playwright/test';

type FrameLocatorOrPage = Page | FrameLocator;

const baseUrl = process.env.MERIDIAN_BASE_URL ?? ${q(tenantBaseUrl)};

const inputs = {
${inputs || '  // (this capability takes no inputs)'}
};
${PRELUDE}
test(${q(cap.metadata.title)}, async ({ page }) => {
  const outputs: Record<string, unknown> = {};

  // Sign-on is deliberately outside the capability artifact: credentials belong
  // to the session provider and a secret store, never to a flow shared between
  // institutions.
  await page.goto(\`\${baseUrl}/\`);
  await fieldBeside(page, 'Operator ID').fill(process.env.MERIDIAN_OPERATOR_ID ?? 'msr01');
  await fieldBeside(page, 'Password').fill(process.env.MERIDIAN_PASSWORD ?? 'meridian');
  await page.getByRole('button', { name: 'Sign On', exact: true }).click();
  await expect(page).toHaveURL(/\\/main$/);

${cap.flow.steps.map((s) => stepCode(s, render)).join('\n\n')}

  // ${cap.flow.successCheckpoint.description}
${cap.flow.successCheckpoint.all.flatMap((a) => assertionCode(a, render)).join('\n')}

  console.log('outputs', outputs);
});
`;
}
