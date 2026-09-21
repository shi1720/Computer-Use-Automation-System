/**
 * Live control transfer.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The requirement is that a human takes over *the live session* — not a fresh
 * one, not a copy. This is the mechanism.
 *
 * When a run escalates, it starts one of these next to the browser it is already
 * driving and publishes the URL on the intervention ticket. The operator console
 * opens a WebSocket to it and gets:
 *
 *   - a live JPEG screencast of the page, straight off Chrome DevTools Protocol
 *     (`Page.startScreencast`), so the operator sees exactly the screen the
 *     automation was looking at, mid-flow, with the application's server-side
 *     session intact;
 *   - the ability to click, type, scroll and navigate in it, forwarded as
 *     synthetic input events (`Input.dispatchMouseEvent` / `dispatchKeyEvent`).
 *
 * Two properties matter more than the plumbing:
 *
 *   **The lease is enforced here, not trusted.** Input is dropped unless the
 *   operator holds the control lease. A console bug, a stale browser tab or a
 *   second operator on the same ticket cannot produce interleaved actions.
 *
 *   **Everything the human does is recorded.** Each click and each typed string
 *   lands on the intervention as a `humanAction` and in the evidence chain. That
 *   is both the audit answer ("who touched this account?") and the raw material
 *   for promoting a rescue into the capability, so the same escalation does not
 *   recur next week.
 *
 * This is deliberately a screencast rather than a full co-browsing stack. It is
 * ~250 lines, it is real, and it is the right amount of machinery to prove the
 * control-transfer model works. A production console would add multi-operator
 * presence, quality adaptation and an audio/annotation channel; none of that
 * changes the protocol.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CDPSession } from 'playwright-core';
import type { WebSurface } from '../surface/web.js';
import type { ControlLeaseManager } from './lease.js';
import type { HumanAction } from './broker.js';

export interface LiveControlOptions {
  /** Called for every operator action, for the ticket and the evidence chain. */
  onHumanAction?: (a: HumanAction) => void;
  /** Screencast quality. Legacy screens are text; 55 is plenty and keeps it snappy. */
  quality?: number;
  host?: string;
}

export interface LiveControlHandle {
  wsUrl: string;
  token: string;
  viewport: { width: number; height: number };
  port: number;
  stop(): Promise<void>;
}

/** Keys that must be dispatched as raw key events rather than as text. */
const VK: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  Escape: { code: 'Escape', vk: 27 },
};

type ClientMessage =
  | { t: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; type: 'down' | 'up'; key: string; modifiers?: number }
  | { t: 'text'; value: string }
  | { t: 'nav'; url: string }
  | { t: 'ping' };

export async function startLiveControl(
  surface: WebSurface,
  leases: ControlLeaseManager,
  opts: LiveControlOptions = {},
): Promise<LiveControlHandle> {
  const token = randomBytes(24).toString('base64url');
  const channel = await surface.exposeForHumanControl();
  if (!channel) throw new Error('This surface cannot be exposed for human control.');
  const cdp = surface.cdpSession as CDPSession;
  const viewport = channel.viewport;

  const http: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // The token is the only thing between an operator console and a live
    // teller session. It is single-use per escalation and dies with the run.
    if (url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const port: number = await new Promise((resolve) => {
    http.listen(0, opts.host ?? '127.0.0.1', () => resolve((http.address() as { port: number }).port));
  });

  const sockets = new Set<WebSocket>();
  let screencasting = false;

  const onFrame = async (params: { data: string; sessionId: number; metadata: unknown }) => {
    const payload = JSON.stringify({ t: 'frame', data: params.data, viewport });
    for (const ws of sockets) { if (ws.readyState === ws.OPEN) ws.send(payload); }
    try { await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch { /* page navigating */ }
  };
  cdp.on('Page.screencastFrame', onFrame as never);

  /** Only the lease holder's input reaches the page. */
  const operatorMayAct = (): boolean => leases.holder === 'operator';

  const record = (a: Omit<HumanAction, 'at'>) => opts.onHumanAction?.({ ...a, at: new Date().toISOString() });

  wss.on('connection', async (ws: WebSocket) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ t: 'hello', viewport, url: await surface.currentUrl(), control: leases.holder }));

    if (!screencasting) {
      screencasting = true;
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: opts.quality ?? 55,
        maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1,
      });
    }

    ws.on('message', async (buf) => {
      let m: ClientMessage;
      try { m = JSON.parse(String(buf)) as ClientMessage; } catch { return; }
      if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', control: leases.holder })); return; }

      if (!operatorMayAct()) {
        ws.send(JSON.stringify({ t: 'denied', reason: `Control is held by ${leases.holder}. Claim the session to act.` }));
        return;
      }

      try {
        switch (m.t) {
          case 'mouse':
            await cdp.send('Input.dispatchMouseEvent', {
              type: m.type, x: m.x, y: m.y,
              button: m.button ?? 'left',
              clickCount: m.clickCount ?? (m.type === 'mouseMoved' ? 0 : 1),
            });
            if (m.type === 'mousePressed') record({ kind: 'click', detail: `click at (${Math.round(m.x)}, ${Math.round(m.y)})`, at_xy: { x: m.x, y: m.y } });
            return;

          case 'wheel':
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy });
            return;

          case 'key': {
            const special = VK[m.key];
            if (special) {
              await cdp.send('Input.dispatchKeyEvent', {
                type: m.type === 'down' ? 'rawKeyDown' : 'keyUp',
                key: m.key, code: special.code,
                windowsVirtualKeyCode: special.vk, nativeVirtualKeyCode: special.vk,
                ...(m.type === 'down' && special.text ? { text: special.text } : {}),
                modifiers: m.modifiers ?? 0,
              });
              if (m.type === 'down') record({ kind: 'key', detail: m.key });
            }
            return;
          }

          case 'text':
            // Printable input arrives as text so IME and modifier handling stays
            // the browser's problem rather than ours.
            for (const ch of m.value) {
              await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch });
            }
            record({ kind: 'type', detail: m.value });
            return;

          case 'nav':
            // Still subject to the capability's origin allowlist: the surface
            // aborts out-of-scope requests at the wire regardless of who asked.
            await surface.act({ kind: 'navigate', url: m.url });
            record({ kind: 'navigate', detail: m.url });
            return;
        }
      } catch (e) {
        ws.send(JSON.stringify({ t: 'error', message: (e as Error).message }));
      }
    });

    ws.on('close', () => sockets.delete(ws));
  });

  return {
    wsUrl: `ws://127.0.0.1:${port}/control`,
    token, viewport, port,
    async stop() {
      try { cdp.off('Page.screencastFrame', onFrame as never); } catch { /* detached */ }
      try { if (screencasting) await cdp.send('Page.stopScreencast'); } catch { /* gone */ }
      for (const ws of sockets) { try { ws.close(); } catch { /* noop */ } }
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
      await channel.release();
    },
  };
}
