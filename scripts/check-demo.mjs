/** HTTP + real Chromium replay + live CDP handoff acceptance check. */
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
const base = process.env.SWIVEL_TEST_URL || 'http://127.0.0.1:4700';
const pause = ms => new Promise(r => setTimeout(r, ms));
const login = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie()[0].split(';')[0];
async function api(path, body) {
  const r = await fetch(base + path, { headers: { cookie, 'content-type':'application/json' }, ...(body ? { method:'POST', body:JSON.stringify(body) } : {}) });
  const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
}
const checks = [];
for (const scenario of ['success', 'not-found', 'session-expiry', 'second-tenant', 'handoff']) {
  let job = await api('/api/demo/run', { scenario });
  const deadline = Date.now() + 150000;
  let rescued = false;
  while (job.status === 'running' && Date.now() < deadline) {
    await pause(1000);
    job = await api(`/api/demo/jobs/${job.id}`);
    if (scenario === 'handoff' && !rescued) {
      const ticket = (await api('/api/interventions')).interventions.find(i => i.context.runId === job.runId && i.status === 'open');
      if (ticket) {
        await api(`/api/interventions/${ticket.id}/claim`, {});
        let full;
        for (let n = 0; n < 25; n++) { full = (await api(`/api/interventions/${ticket.id}`)).intervention; if (full.context.control) break; await pause(200); }
        const ctl = full.context.control;
        assert.ok(ctl, 'Claim must yield live control');
        const snap = await api(`/api/runs/${job.runId}/file?path=${encodeURIComponent(ticket.context.snapshotRef)}`);
        const target = snap.nodes.find(n => n.role === 'button' && /^Display /.test(n.name));
        assert.ok(target?.bounds, 'The paused screen must contain the Display control');
        const x = target.bounds.x + target.bounds.w/2 + 180, y = target.bounds.y + target.bounds.h/2;
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(ctl.wsUrl, [`swivel.token.${ctl.token}`]);
          const timer = setTimeout(() => { ws.terminate(); reject(new Error('Live channel timed out')); }, 15000);
          let sawFrame = false, clicked = false;
          ws.on('error', reject);
          ws.on('message', async raw => {
            const m = JSON.parse(String(raw));
            if (m.t !== 'frame' || clicked) return;
            sawFrame = true; clicked = true;
            ws.send(JSON.stringify({ t:'mouse', type:'mousePressed', x,y,button:'left',clickCount:1 }));
            ws.send(JSON.stringify({ t:'mouse', type:'mouseReleased', x,y,button:'left',clickCount:1 }));
            await pause(1200); clearTimeout(timer); ws.close(); assert.ok(sawFrame); resolve();
          });
        });
        await api(`/api/interventions/${ticket.id}/return`, { resolution: 'resume', note:'Acceptance check operated the Display control over the same live session.' });
        rescued = true;
      }
    }
  }
  assert.equal(job.status, 'complete', JSON.stringify(job));
  const r = job.result;
  assert.equal(r.status, scenario === 'not-found' ? 'business_outcome' : 'success', JSON.stringify(r));
  if (r.status === 'success') assert.equal(r.outputs.currentBalance, 18402.66);
  if (scenario === 'session-expiry') assert.ok(r.recoveries.length > 0);
  if (scenario === 'handoff') assert.ok(rescued);
  const evidence = await api(`/api/runs/${r.runId}`);
  assert.equal(evidence.chain.ok, true, JSON.stringify(evidence.chain));
  const item = { scenario, runId:r.runId, status:r.status, durationMs:r.durationMs, recoveries:r.recoveries.length, chain:evidence.chain.ok, liveHandoff:rescued };
  checks.push(item); console.log(JSON.stringify(item));
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/demo-acceptance.json', JSON.stringify({ base, at:new Date().toISOString(), checks },null,2));
