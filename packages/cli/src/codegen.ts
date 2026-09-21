/**
 * Emitting a Playwright test from a capability artifact.
 *
 * Not how Swivel executes anything — the engine replays the artifact directly.
 * This exists because of how these systems get adopted: a bank's QA or
 * integration team will want the flow as code they own, in a framework they
 * already run in CI, before they will let an agent drive it unattended. Being
 * able to hand them that file, generated from the same artifact the engine
 * runs, turns "trust our black box" into "here is the same thing, in your
 * repo, that you can read and run".
 *
 * The generated test is intentionally plain Playwright: it uses the same
 * semantic locators the artifact records, so a reviewer can see that the
 * targeting strategy is legible rather than magic.
 */
import type { Capability, Step } from '@swivel/core';
import type { TargetDescriptor } from '@swivel/core';

const q = (s: string) => JSON.stringify(s);

/** Render a TargetDescriptor as the nearest honest Playwright locator. */
function locatorFor(t: TargetDescriptor): string {
  const scope = t.frame?.path.length
    ? t.frame.path.map((f) => `.frameLocator(${q(`frame[name="${f}"]`)})`).join('')
    : '';
  const root = `page${scope}`;

  if (t.cell?.rowWhere) {
    // The one that matters: address the row by a value, never by an index.
    return `${root}.locator('table:has(th)')` +
      `.locator('tr', { has: ${root}.locator('td', { hasText: ${q(t.cell.rowWhere.equals)} }) })` +
      `.getByRole(${q(t.role)}${t.name ? `, { name: ${q(t.name.value)} }` : ''})`;
  }
  if (t.name) return `${root}.getByRole(${q(t.role)}, { name: ${q(t.name.value)}${t.name.match === 'exact' ? ', exact: true' : ''} })`;
  if (t.anchors?.length) {
    const a = t.anchors[0] as NonNullable<TargetDescriptor['anchors']>[number];
    return `${root}.locator('tr', { hasText: ${q(a.text.value)} }).getByRole(${q(t.role)})` +
      `  /* caption "${a.text.value}" sits ${a.relation === 'right-of' ? 'to the left of' : a.relation} the control; the app never used a <label> */`;
  }
  if (t.hints?.idPattern) return `${root}.locator(${q(`[id^="${t.hints.idPattern.split('\\d')[0]}"]`)})`;
  return `${root}.getByRole(${q(t.role)})`;
}

function stepCode(s: Step, cap: Capability): string {
  const lines: string[] = [`    // ${s.intent}${s.risk && s.risk !== 'read_only' ? `   [risk: ${s.risk}]` : ''}`];
  const tmpl = (v: string) => `\`${v.replace(/\{\{input\.(\w+)\}\}/g, '${inputs.$1}').replace(/\{\{tenant\.baseUrl\}\}/g, '${baseUrl}').replace(/\{\{vocab\.(\w+)\}\}/g, (_m, k) => String(cap.target.vocabulary[k] ?? ''))}\``;

  switch (s.kind) {
    case 'navigate': lines.push(`    await page.goto(${tmpl(s.url ?? '')});`); break;
    case 'click': lines.push(`    await ${locatorFor(s.target as TargetDescriptor)}.click();`); break;
    case 'fill': lines.push(`    await ${locatorFor(s.target as TargetDescriptor)}.fill(${tmpl(s.value ?? '')});`); break;
    case 'select': lines.push(`    await ${locatorFor(s.target as TargetDescriptor)}.selectOption(${tmpl(s.value ?? '')});`); break;
    case 'press': lines.push(`    await ${locatorFor(s.target as TargetDescriptor)}.press(${q(s.key ?? 'Enter')});`); break;
    case 'extract':
      lines.push(`    outputs.${s.extract?.into} = (await ${locatorFor(s.target as TargetDescriptor)}.textContent())?.trim();`);
      break;
    case 'dismiss_if_present':
      lines.push(`    const maybe = ${locatorFor(s.target as TargetDescriptor)};`);
      lines.push(`    if (await maybe.count()) await maybe.click();`);
      break;
    default: lines.push(`    // (${s.kind} — handled by the Swivel engine, no direct Playwright equivalent)`);
  }

  if (s.expect) {
    const a = s.expect.all[0];
    if (a?.kind === 'text_present' && a.regex) lines.push(`    await expect(page.locator('body')).toContainText(${`/${a.regex}/i`});   // ${s.expect.description}`);
    else if (a?.kind === 'text_present' && a.text) lines.push(`    await expect(page.locator('body')).toContainText(${q(a.text)});   // ${s.expect.description}`);
  }
  return lines.join('\n');
}

export function generatePlaywrightTest(cap: Capability): string {
  const inputs = cap.contract.inputs.map((i) => `  ${i.name}: ${q(i.example ?? '')},   // ${i.description}`).join('\n');
  return `/**
 * ${cap.metadata.title}
 *
 * GENERATED from Swivel capability ${cap.metadata.id}@${cap.metadata.version}
 * content hash ${cap.contentHash}
 *
 * ${cap.metadata.summary.replace(/\n/g, '\n * ')}
 *
 * This file is a faithful translation of the artifact into Playwright, for teams
 * that want the flow as code in their own CI. The Swivel engine does not use it:
 * it replays the artifact directly, which is what gives it the scored targeting,
 * the runtime signal handling and the evidence chain that this file does not have.
 *
 * ${cap.contract.effects.mutating ? 'WARNING: this flow CHANGES RECORDS.' : 'This flow is read-only.'}
 * ${cap.contract.effects.reversible ? '' : 'WARNING: its effects are IRREVERSIBLE.'}
 */
import { test, expect } from '@playwright/test';

const baseUrl = process.env.MERIDIAN_BASE_URL ?? 'http://127.0.0.1:4711';

const inputs = {
${inputs || '  // (no inputs)'}
};

test(${q(cap.metadata.title)}, async ({ page }) => {
  const outputs: Record<string, unknown> = {};

  // Sign-on is deliberately outside the capability artifact: credentials belong
  // to the session provider and a secret store, never to a shared flow.
  await page.goto(\`\${baseUrl}/\`);
  await page.locator('tr', { hasText: 'Operator ID' }).getByRole('textbox').fill(process.env.MERIDIAN_OPERATOR_ID ?? 'msr01');
  await page.locator('tr', { hasText: 'Password' }).getByRole('textbox').fill(process.env.MERIDIAN_PASSWORD ?? 'meridian');
  await page.getByRole('button', { name: 'Sign On', exact: true }).click();
  await expect(page).toHaveURL(/\\/main$/);

${cap.flow.steps.map((s) => stepCode(s, cap)).join('\n\n')}

  // ${cap.flow.successCheckpoint.description}
${cap.flow.successCheckpoint.all
  .filter((a) => a.kind === 'text_present')
  .map((a) => `  await expect(page.locator('body')).toContainText(${a.regex ? `/${a.regex}/i` : q(a.text ?? '')});`)
  .join('\n')}

  console.log('outputs', outputs);
});
`;
}
