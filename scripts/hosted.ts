/** A deliberately bounded public sandbox. All bank records are synthetic. */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SwivelStore, EscalationBroker, type Capability, type TenantOverlay, type StoredRun } from '@swivel/core';
import { buildConsole } from '../apps/console/src/server.js';
import { createMeridian } from '../apps/meridian/src/server.js';
import { DEFAULT_CONFIG } from '../packages/cli/src/config.js';

process.env.SWIVEL_CRED_MERIDIAN_OPERATOR_ID = 'msr01';
process.env.SWIVEL_CRED_MERIDIAN_PASSWORD = 'meridian';
if (!process.env.K_SERVICE) process.env.SWIVEL_PUBLIC_RUN_URL ??= `http://127.0.0.1:${process.env.PORT ?? 4700}`;

for (const [id, port] of [['pineridge', 4711], ['harborpoint', 4712]] as const) {
  const { app } = createMeridian(id);
  await new Promise<void>((resolve, reject) => app.listen(port, '127.0.0.1', () => resolve()).on('error', reject));
}
const store = new SwivelStore();
await store.init();
for (const file of await readdir('capabilities')) {
  if (!file.endsWith('.json')) continue;
  const doc = JSON.parse(await readFile(join('capabilities', file), 'utf8')) as Capability | TenantOverlay;
  if (doc.kind === 'TenantOverlay') await store.putOverlay(doc);
  else if (!await store.getCapability(doc.metadata.id)) await store.putCapability(doc);
}
// Committed evidence is available after cold starts; new demo runs are ephemeral.
for (const dir of await readdir('evidence/runs').catch(() => [] as string[])) {
  try {
    const m = JSON.parse(await readFile(join('evidence/runs', dir, 'run.json'), 'utf8'));
    if (!m.runId || !m.finishedAt) continue;
    await store.putRun({ runId: m.runId, kind: m.kind, status: m.outcome?.status ?? 'unknown', startedAt: m.startedAt,
      finishedAt: m.finishedAt, evidenceDir: join('evidence/runs', dir), tenantId: m.tenant?.id,
      capabilityId: m.capability?.id, summary: m.outcome?.message ?? m.outcome?.status ?? 'Saved evidence',
      durationMs: new Date(m.finishedAt).getTime() - new Date(m.startedAt).getTime(),
    } as StoredRun);
  } catch { /* ignore non-bundle directories */ }
}
const broker = new EscalationBroker(undefined, 10 * 60_000);
const app = await buildConsole({ store, config: DEFAULT_CONFIG, broker, demo: true });
const server = createServer(app);
// Cloud Run exposes one port. Proxy only existing live sessions, whose upstream
// independently verifies the one-time bearer token and current control lease.
server.on('upgrade', (req, socket, head) => {
  const id = /^\/live\/(int_[a-zA-Z0-9-]+)$/.exec(req.url ?? '')?.[1];
  const ctl = id ? broker.get(id)?.context.control : undefined;
  if (!ctl) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const target = new URL(ctl.wsUrl);
  const upstream = connect(Number(target.port), '127.0.0.1', () => {
    upstream.write(`${req.method} ${target.pathname} HTTP/1.1\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
    upstream.write('\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(Number(process.env.PORT ?? 4700), '0.0.0.0', () => console.log('Swivel demo ready'));
