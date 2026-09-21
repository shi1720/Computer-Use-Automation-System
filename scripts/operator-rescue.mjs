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

/**
 * Work the queue, not one ticket.
 *
 * A real operator watches their queue until the run they are helping is done,
 * and a run can ask twice — the second time for a different reason. Handling
 * exactly one ticket and exiting looks fine until the run escalates again and
 * nobody is there, which is a property of this script rather than of the system
 * and should not be mistaken for one.
 */
const MAX_RESCUES = 3;
let handled = 0;

for (let i = 0; i < 400 && handled < MAX_RESCUES; i++) {
  const list = await fetch(`${C}/api/interventions`, { headers: as }).then((x) => x.json());
  const ticket = list.interventions.find((t) => t.status === 'open');
  if (!ticket) { await sleep(300); continue; }

  console.log(`operator: ${ticket.id} — ${ticket.context.diagnosis.message.slice(0, 90)}…`);
  await fetch(`${C}/api/interventions/${ticket.id}/claim`, { method: 'POST', headers: as });
  const full = await fetch(`${C}/api/interventions/${ticket.id}`, { headers: as }).then((x) => x.json());
  const ctl = full.intervention.context.control;
  if (!ctl) { console.log('operator: control was not granted'); break; }
  console.log('operator: claimed, control granted');

  /*
   * Find the control the way a person finds it: by looking at the screen.
   *
   * The ticket carries the perception snapshot the run was looking at when it
   * stopped, so the button's position comes from there rather than from a
   * constant in this file. A hardcoded coordinate is a silent failure — the
   * click lands somewhere harmless, nothing happens, and the run escalates
   * again looking exactly as though the system is broken when it is the script.
   *
   * One conversion is needed, and it is the whole subtlety of driving a
   * screencast: perception reports geometry *within a frame*, and the
   * screencast is the whole page. These screens are a cols="180,*" frameset, so
   * anything in contentFrame sits 180px further right than the snapshot says.
   */
  const FRAME_OFFSET = { navFrame: 0, contentFrame: 180 };
  const snap = await fetch(
    `${C}/api/runs/${ticket.context.runId}/file?path=${encodeURIComponent(ticket.context.snapshotRef)}`,
    { headers: as },
  ).then((x) => x.json()).catch(() => null);

  const target = snap?.nodes?.find((n) => n.role === 'button' && /^Display /.test(n.name ?? ''));
  if (!target?.bounds) {
    console.log('operator: could not find the Display control on the paused screen');
    break;
  }
  const dx = FRAME_OFFSET[target.framePath?.[0]] ?? 0;
  const x = dx + target.bounds.x + target.bounds.w / 2;
  const y = target.bounds.y + target.bounds.h / 2;
  console.log(`operator: "${target.name}" is at (${Math.round(x)}, ${Math.round(y)})`);

  await new Promise((resolve) => {
    const ws = new WebSocket(ctl.wsUrl, [`swivel.token.${ctl.token}`]);
    ws.on('open', async () => {
      const send = (m) => ws.send(JSON.stringify(m));
      send({ t: 'mouse', type: 'mouseMoved', x, y });
      await sleep(120);
      send({ t: 'mouse', type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(80);
      send({ t: 'mouse', type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      console.log('operator: clicked it');
      await sleep(1200);
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
  handled += 1;
  if (RESOLUTION === 'completed_by_human') break;   // the run is over either way
  await sleep(800);
}

if (handled === 0) { console.log('operator: no ticket appeared'); process.exit(1); }
