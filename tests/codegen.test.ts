/**
 * The generated Playwright test.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * `swivel codegen` translates a capability into plain Playwright for teams that
 * want the flow as code in their own repository. It is the one output of this
 * system that nothing else checks: the engine does not run it, so a translation
 * that is subtly wrong ships looking fine.
 *
 * And "subtly wrong" is the realistic failure. An earlier version of this
 * emitter produced a file that *passed* while returning a member number where a
 * balance belonged — because its grid helper collected `<th>` from the layout
 * tables nested around the real one, computed a column index against a header
 * list no row corresponded to, and read whatever cell that pointed at. A green
 * test with the wrong answer in it is worse than a red one.
 *
 * These tests do not launch a browser. They check the shape of what is emitted,
 * which is where every defect that file has had actually lived.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveCapability, type Capability } from '@swivel/core';
import { generatePlaywrightTest } from '../packages/cli/src/codegen.js';

const capability = async (): Promise<Capability> =>
  JSON.parse(await readFile('capabilities/meridian.member-savings-balance@0.1.0.json', 'utf8')) as Capability;

const spec = async (): Promise<string> => generatePlaywrightTest(resolveCapability(await capability()));

describe('the generated spec', () => {
  test('renders templates rather than emitting them raw', async () => {
    // The artifact's prose is templated because it is shared across
    // institutions; a generated file is for one tenant. Leaving the braces in
    // produces comments that read like a bug and a test nobody trusts.
    const s = await spec();
    assert.ok(!/\{\{vocab\./.test(s), 'unrendered {{vocab.*}} in the generated file');
    assert.ok(!/\{\{input\./.test(s), 'unrendered {{input.*}} in the generated file');
  });

  test('awaits the grid helper before calling a locator method on it', async () => {
    // `cellInRow` resolves a column from its header at runtime, so it returns a
    // promise. `await f(x).textContent()` and `(await f(x)).textContent()` are
    // different programs, and only one of them runs.
    const s = await spec();
    for (const line of s.split('\n')) {
      if (!line.includes('cellInRow(')) continue;
      if (!line.includes('.textContent()')) continue;
      assert.match(line, /\(await cellInRow\(/, `await is in the wrong place:\n${line.trim()}`);
    }
  });

  test('scopes grid lookups to the innermost table and its own rows', async () => {
    // These screens nest layout tables four deep around the real grid. Every
    // ancestor "contains" the row value, so `.first()` selects the page and
    // `table.locator('th')` collects headers that belong to other tables.
    const s = await spec();
    assert.match(s, /table:has\(th\)'\)\.filter\(\{ hasText: rowValue \}\)\.last\(\)/);
    assert.match(s, /:scope > tbody > tr, :scope > tr/);
    assert.match(s, /:scope > td/);
    assert.ok(!/const table = scope\.locator\('table:has\(th\)'\)\.filter\(\{ hasText: rowValue \}\)\.first\(\)/.test(s));
  });

  test('compares screen text the way the engine does', async () => {
    // Whitespace-flattened and case-insensitive. A legacy core renders MEMBER
    // INQUIRY SCREEN in caps across two table cells, and the capability's own
    // success text has been through vocabulary substitution.
    const s = await spec();
    assert.match(s, /replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.toLowerCase\(\)/);
  });

  test('reads frame text without auto-waiting for a body that does not exist', async () => {
    // The outermost document of a frameset has no <body>. A locator auto-waits
    // for one, so that version does not return '' for the top frame — it blocks
    // until the whole test times out and never reaches the frame holding the
    // screen.
    const s = await spec();
    assert.match(s, /frame\.evaluate\(\(\) => document\.body\?\.innerText \?\? ''\)/);
    assert.ok(!/frame\.locator\('body'\)\.innerText\(\)/.test(s), 'auto-waiting body read in the frame loop');
  });

  test('never addresses a grid row by index', async () => {
    // The whole point. A tenant inserting a column is the documented hazard.
    const s = await spec();
    assert.ok(!/\.nth\(\d+\)\s*\/\/ row/.test(s));
    assert.match(s, /resolved from its header at runtime/);
  });
});
