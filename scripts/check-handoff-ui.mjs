import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.SWIVEL_TEST_URL || 'http://127.0.0.1:4700';
const browser = await chromium.launch({ headless: true,
  ...(process.env.SWIVEL_CHROMIUM_PATH ? { executablePath: process.env.SWIVEL_CHROMIUM_PATH } : {}),
});
let context, ticketId;
try {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [], sockets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => sockets.push(socket));
  page.on('dialog', dialog => dialog.accept('Verified console reconnect and same-session rescue.'));
  await page.goto(base);
  await page.getByRole('button', { name: 'Open interactive demo' }).click();
  await page.getByRole('button', { name: /Take the controls/ }).click();
  await page.getByRole('button', { name: 'Run this scenario' }).click();
  await page.getByRole('link', { name: 'Open live session' }).click({ timeout: 90000 });
  const ticketUrl = page.url();
  ticketId = ticketUrl.split('/').at(-1);
  await page.getByRole('button', { name: 'Claim and take control' }).click();
  const ready = () => page.waitForFunction(() => {
    const image = document.querySelector('img[alt="live session"]');
    return image?.complete && image.naturalWidth > 0 && image.getBoundingClientRect().height > 100;
  });
  await ready();

  // Leaving the view must release its driver socket so returning can reconnect.
  await page.locator('.sidebar').getByRole('link', { name: 'Interactive demo' }).click();
  if (!sockets[0].isClosed()) await sockets[0].waitForEvent('close', { timeout: 10000 });
  assert.equal(sockets[0].isClosed(), true, 'Leaving the view closes the original socket');
  await page.goto(ticketUrl);
  await ready();
  assert.equal(sockets.length, 2, 'The operator reconnected to the same ticket');

  const id = ticketUrl.split('/').at(-1);
  const detail = await context.request.get(`${base}/api/interventions/${id}`).then(r => r.json());
  const runId = detail.intervention.context.runId;
  const snapshot = await context.request.get(`${base}/api/runs/${runId}/file?path=${encodeURIComponent(detail.intervention.context.snapshotRef)}`).then(r => r.json());
  const target = snapshot.nodes.find(node => node.role === 'button' && /^Display /.test(node.name));
  assert.ok(target, 'The synthetic bank exposes its Display control');
  const frame = page.getByRole('img', { name: 'live session', exact: true });
  const box = await frame.boundingBox();
  await frame.click({ position: {
    x: (target.bounds.x + target.bounds.w / 2 + 180) / 1280 * box.width,
    y: (target.bounds.y + target.bounds.h / 2) / 860 * box.height,
  } });
  assert.equal(await frame.evaluate(e => document.activeElement === e), true);
  await page.keyboard.press('Escape');
  assert.equal(await frame.evaluate(e => document.activeElement === e), false);
  const resume = page.getByRole('button', { name: 'Resume automation', exact: true });
  await resume.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/#/operators');
  await page.locator('.sidebar').getByRole('link', { name: 'Interactive demo' }).click();
  await page.locator('.result-box.success').waitFor({ timeout: 60000 });
  assert.deepEqual(errors, []);
  const result = { base, runId, status: 'success', renderedFrame: true,
    reconnect: true, keyboardResume: true, errors };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/handoff-ui.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (context && ticketId) await context.request.post(`${base}/api/interventions/${ticketId}/return`, { data: { resolution: 'abort', note: 'Acceptance test cleanup if the session remained open.' } }).catch(() => {});
  await browser.close();
}
