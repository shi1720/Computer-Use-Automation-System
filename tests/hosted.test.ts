import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { SwivelStore, EscalationBroker } from '@swivel/core';
import { buildConsole } from '../apps/console/src/server.js';
import { DEFAULT_CONFIG } from '../packages/cli/src/config.js';
let dir: string, base: string, server: Server;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swivel-hosted-'));
  const store = new SwivelStore(dir); await store.init();
  const app = await buildConsole({ store, config: DEFAULT_CONFIG, broker: new EscalationBroker(), demo: true });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
const post = (path: string, data: unknown, cookie = '') => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(data) });
async function guest() { const r = await post('/api/auth/demo', {}); assert.equal(r.status, 200); return { cookie: r.headers.getSetCookie()[0]!.split(';')[0]!, body: await r.json() }; }
test('guest sessions use the Firebase forwarded cookie and distinct operator identities', async () => {
  const a = await guest(), b = await guest();
  assert.match(a.cookie, /^__session=/); assert.notEqual(a.body.user.id, b.body.user.id);
  assert.ok(!a.body.user.roles.includes('capability.approve'));
  const me = await fetch(`${base}/api/me`, { headers: { cookie: a.cookie } }).then(r => r.json());
  assert.equal(me.user.id, a.body.user.id);
});
test('hosted execution rejects arbitrary URLs and unsupported scenarios before launching a browser', async () => {
  const { cookie } = await guest();
  assert.equal((await post('/api/demo/run', { scenario: 'http://example.com' }, cookie)).status, 400);
  assert.equal((await post('/api/capabilities/anything/invoke', { tenant: 'pineridge' }, cookie)).status, 403);
  assert.equal((await post('/api/demo/run', { scenario: 'success' })).status, 401);
});
test('malformed authentication inputs return a client error, not a server exception', async () => {
  for (const body of [{ id: {}, password: 'x' }, { id: 'x', password: [] }, {}]) assert.equal((await post('/api/auth/login', body)).status, 400);
});
test('unknown API routes return JSON 404 and responses cannot be cached across sessions', async () => {
  const r = await fetch(`${base}/api/missing`); assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type')!, /json/); assert.match(r.headers.get('cache-control')!, /no-store/);
});
