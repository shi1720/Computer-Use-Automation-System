/**
 * A scripted stand-in for a human operator.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The escalation path is the hardest thing in this system to demonstrate,
 * because it needs a person: a run pauses mid-flow, someone opens the console,
 * takes the wheel of the live browser session, does the bit the automation
 * could not, and hands it back. That is exactly the claim worth being
 * sceptical about, and "watch me do it" is not evidence anyone can re-check.
 *
 * So this drives it, and it cheats at nothing. It signs in over the same login
 * route, claims the ticket through the same API, and connects to the same
 * live-control websocket with the same token — which the console will only
 * give to the operator who actually claimed the ticket. Its click is dispatched
 * into the paused page by CDP exactly as a person's would be, and is recorded
 * on the run's evidence chain as a `humanAction` exactly as a person's would
 * be. The only thing it replaces is the pair of eyes.
 *
 * Run it beside a `--no-overlay` replay against Harbor Point:
 *
 *   node scripts/operator-rescue.mjs &
 *   npx swivel replay meridian.member-savings-balance --tenant harborpoint \
 *     --no-overlay --console-url http://127.0.0.1:4700 \
 *     --input memberNumber=0100482 --input "shareType=SPECIAL SAVINGS"
 */
import WebSocket from 'ws';

const C = process.env.SWIVEL_CONSOLE_URL ?? 'http://127.0.0.1:4700';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * How this operator hands the wheel back. Both are real answers a person gives,
 * and the run reports them differently on purpose:
 *
 *   resume              "I unblocked it, carry on." The automation finishes the
 *                       job. Here it only unblocked read-only work, so the run
 *                       still reports `success` — with the escalation on the
 *                       record.
 *   completed_by_human  "I finished it myself." The run reports `escalated`,
 *                       never `success`, because the automation cannot vouch
 *                       for work a person did.
 */
const RESOLUTION = process.argv[2] === 'completed' ? 'completed_by_human' : 'resume';
const NOTE = RESOLUTION === 'completed_by_human'
  ? 'Read both balances by hand off the Deposit Accounts screen and recorded them in the servicing note.'
  : 'Used the Display Deposit Accounts control by hand. This build collapses the balances grid and the base artifact has no step for it.';

const login = await fetch(`${C}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'operator', password: 'swivel' }),
});
const cookie = login.headers.getSetCookie()[0].split(';')[0];
const as = { cookie };
console.log('operator: signed in as R. Solis');

let ticket = null;
for (let i = 0; i < 90 && !ticket; i++) {
  const r = await fetch(`${C}/api/interventions`, { headers: as }).then((x) => x.json());
  ticket = r.interventions.find((t) => t.status === 'open') ?? null;
  if (!ticket) await sleep(1000);
}
if (!ticket) { console.log('operator: no ticket appeared'); process.exit(1); }
console.log(`operator: ${ticket.id} — ${ticket.context.diagnosis.message.slice(0, 90)}…`);

await fetch(`${C}/api/interventions/${ticket.id}/claim`, { method: 'POST', headers: as });
const full = await fetch(`${C}/api/interventions/${ticket.id}`, { headers: as }).then((x) => x.json());
const ctl = full.intervention.context.control;
if (!ctl) { console.log('operator: control was not granted'); process.exit(1); }
console.log('operator: claimed, control granted');

/*
 * Drive the live session.
 *
 * The console's client sends viewport coordinates, because pixels are all a
 * screencast has — and the coordinate a person clicks is a coordinate on the
 * whole page, not inside a frame. These screens are a `cols="180,*"` frameset,
 * so a control the perception layer reports at (16, 188) inside `contentFrame`
 * is at (196, 188) on screen. Getting that axis wrong is silent: the click
 * lands in the nav frame, nothing happens, and the run escalates again — which
 * is at least a failure the system notices.
 */
const NAV_FRAME_WIDTH = 180;
const BUTTON = { x: 16, y: 188, w: 148, h: 18 };   // "Display Deposit Accounts"

await new Promise((resolve) => {
  const ws = new WebSocket(ctl.wsUrl, [`swivel.token.${ctl.token}`]);
  const x = NAV_FRAME_WIDTH + BUTTON.x + BUTTON.w / 2;
  const y = BUTTON.y + BUTTON.h / 2;
  ws.on('open', async () => {
    const send = (m) => ws.send(JSON.stringify(m));
    send({ t: 'mouse', type: 'mouseMoved', x, y });
    await sleep(150);
    send({ t: 'mouse', type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(100);
    send({ t: 'mouse', type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log('operator: used the Display control');
    await sleep(1500);
    ws.close();
    resolve();
  });
  ws.on('error', (e) => { console.log('operator: ws error', e.message); resolve(); });
});

await fetch(`${C}/api/interventions/${ticket.id}/return`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...as },
  body: JSON.stringify({ resolution: RESOLUTION, note: NOTE }),
});
console.log(`operator: handed control back — ${RESOLUTION}`);
