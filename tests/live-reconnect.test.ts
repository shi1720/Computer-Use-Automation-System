import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { ControlLeaseManager } from '@swivel/core';
import { startLiveControl } from '../packages/core/src/escalation/live-control.js';
import type { WebSurface } from '../packages/core/src/surface/web.js';

test('a reconnect receives the last screen even when the paused page has not changed', { timeout: 5000 }, async () => {
  const cdp = Object.assign(new EventEmitter(), { send: async () => ({}) });
  const surface = {
    cdpSession: cdp,
    currentUrl: async () => 'http://localhost/main',
    exposeForHumanControl: async () => ({ viewport: { width: 1280, height: 860 }, release: async () => {} }),
  } as unknown as WebSurface;
  const handle = await startLiveControl(surface, new ControlLeaseManager());
  const clients: WebSocket[] = [];
  const connect = () => {
    const ws = new WebSocket(handle.wsUrl, [`swivel.token.${handle.token}`]);
    clients.push(ws);
    const frame = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', raw => { const message = JSON.parse(String(raw)); if (message.t === 'frame') resolve(message); });
    });
    return { ws, frame };
  };
  try {
    const first = connect();
    await once(first.ws, 'open');
    cdp.emit('Page.screencastFrame', { data: 'synthetic-frame', sessionId: 1, metadata: {} });
    assert.equal((await first.frame).data, 'synthetic-frame');
    const closed = once(first.ws, 'close'); first.ws.close(); await closed;
    const second = connect();
    // No new screencast event is emitted between the two connections.
    assert.equal((await second.frame).data, 'synthetic-frame');
  } finally {
    for (const ws of clients) ws.close();
    await handle.stop();
  }
});
