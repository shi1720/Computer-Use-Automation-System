/**
 * The console client ships as plain ES modules with no build step, which means
 * nothing type-checks it and nothing would catch a syntax error before a
 * reviewer opened the page to a blank screen. This does.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

describe('console client assets', () => {
  test('app.js parses as a module', async () => {
    const src = await readFile('apps/console/public/app.js', 'utf8');
    // `--check` on a module needs the input on disk; evaluating it surfaces the
    // parse error first, and a `location is not defined` ReferenceError after
    // parsing is exactly the success case in Node.
    const r = await run(process.execPath, ['--input-type=module', '-e', src]).catch((e: { stderr?: string }) => e);
    const stderr = (r as { stderr?: string }).stderr ?? '';
    assert.ok(!/SyntaxError/.test(stderr), `app.js has a syntax error:\n${stderr.split('\n').slice(0, 6).join('\n')}`);
  });

  test('index.html references the stylesheet and the module', async () => {
    const html = await readFile('apps/console/public/index.html', 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
    assert.match(html, /<script type="module" src="\/app\.js">/);
  });

  test('the stylesheet defines the theme tokens the client relies on', async () => {
    const css = await readFile('apps/console/public/styles.css', 'utf8');
    for (const token of ['--bg', '--surface', '--border', '--text', '--accent', '--ok', '--warn', '--danger']) {
      assert.match(css, new RegExp(`${token}:`), `missing design token ${token}`);
    }
  });
});
