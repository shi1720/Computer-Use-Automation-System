/**
 * Evidence.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * An automation that acts on a bank's system of record has to be able to answer,
 * months later and to someone hostile: what did you do, why did you think that
 * was the right thing, and how do I know this record was not edited afterwards?
 *
 * So every run produces a bundle:
 *
 *   run.json        manifest — who ran what, against which tenant, with what
 *                   result, under which policy decisions
 *   events.jsonl    append-only, hash-chained log of every observation,
 *                   decision and action
 *   steps/…         per-step perception snapshots, plus a screenshot and full
 *                   page capture at every failure, escalation and checkpoint
 *   transcript.json (discovery only) the model's reasoning, redacted
 *
 * The hash chain is the cheap part and the valuable part: each event carries the
 * digest of the previous one, so removing or editing an event breaks the chain
 * and `verifyChain()` says exactly where. It is not a blockchain and does not
 * pretend to be — it makes tampering *detectable*, which is what an examiner
 * asks for.
 *
 * Every *text* artefact written here has been through the `Redactor` — the
 * event log, the manifest, perception snapshots, page captures. There is no
 * "raw" copy kept anywhere for convenience.
 *
 * Screenshots are the exception, and pretending otherwise would be worse than
 * the exception itself. A PNG of a member inquiry screen contains the member's
 * name, address and balances as pixels; tokenising that would need OCR, and an
 * OCR pass that misses one field produces a file that *looks* redacted and is
 * not — which is more dangerous than one everybody knows is sensitive. So they
 * are treated as what they are: the most sensitive thing in the bundle. They
 * are written only where they earn their place (failures and escalations, where
 * a person needs to see the screen to act), the manifest records that the
 * bundle contains them, and the console gates them behind an `evidence.read`
 * role rather than any signed-in session.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redactor } from '../redact/redact.js';
import type { Snapshot } from '../surface/types.js';

export type EvidenceEventKind =
  | 'run.started' | 'run.finished'
  | 'policy.decision'
  | 'step.started' | 'step.resolved' | 'step.acted' | 'step.checkpoint' | 'step.skipped' | 'step.done_by_human' | 'step.failed'
  | 'signal.fired' | 'recovery.attempted' | 'recovery.succeeded' | 'recovery.failed'
  | 'extract'
  | 'escalation.raised' | 'escalation.control_granted' | 'escalation.human_action' | 'escalation.control_returned' | 'escalation.resumed'
  | 'model.turn' | 'model.action_proposed' | 'model.action_blocked'
  | 'network.blocked'
  | 'artifact.emitted'
  | 'note';

export interface EvidenceEvent {
  seq: number;
  at: string;
  kind: EvidenceEventKind;
  message: string;
  data?: Record<string, unknown>;
  /** SHA-256 of the previous event's canonical form. Genesis = 64 zeros. */
  prevHash: string;
  hash: string;
}

export interface RunManifest {
  runId: string;
  kind: 'discovery' | 'replay';
  startedAt: string;
  finishedAt?: string;
  capability?: { id: string; version: string; contentHash?: string };
  tenant?: { id: string; institution?: string; baseUrl?: string };
  principal: { id: string; kind: string };
  goal?: string;
  /** Redacted. */
  inputs?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
  counts: { events: number; steps: number; screenshots: number; signals: number; recoveries: number; escalations: number };
  redaction: Record<string, number>;
  /**
   * True when this bundle holds screenshots.
   *
   * Every text artefact here is redacted; a screenshot cannot be. This flag is
   * how a retention policy, an export, or a reviewer decides how to handle the
   * directory without opening it.
   */
  containsScreenCaptures?: boolean;
  /** Digest of the final event, so the manifest pins the whole chain. */
  chainTip?: string;
  swivelVersion: string;
}

const GENESIS = '0'.repeat(64);
const digest = (s: string): string => createHash('sha256').update(s).digest('hex');

export class EvidenceRecorder {
  private seq = 0;
  private prevHash = GENESIS;
  private readonly counts = { events: 0, steps: 0, screenshots: 0, signals: 0, recoveries: 0, escalations: 0 };
  private readonly buffered: EvidenceEvent[] = [];
  private ready: Promise<void>;

  constructor(
    readonly dir: string,
    private readonly manifest: RunManifest,
    private readonly redactor: Redactor,
    /** Also mirror events to stderr for CLI users. */
    private readonly onEvent?: (e: EvidenceEvent) => void,
    /** Whether unredactable screen captures may be written at all. */
    private readonly captures: 'on' | 'off' = 'on',
  ) {
    this.ready = mkdir(join(dir, 'steps'), { recursive: true }).then(() => undefined);
  }

  get events(): readonly EvidenceEvent[] { return this.buffered; }

  async log(kind: EvidenceEventKind, message: string, data?: Record<string, unknown>): Promise<EvidenceEvent> {
    await this.ready;
    const safeMessage = this.redactor.text(message, `event.${kind}`);
    const safeData = data ? this.redactor.deep(data, `event.${kind}`) : undefined;
    const seq = ++this.seq;
    const at = new Date().toISOString();
    const body = JSON.stringify({ seq, at, kind, message: safeMessage, data: safeData, prevHash: this.prevHash });
    const hash = digest(body);
    const ev: EvidenceEvent = safeData === undefined
      ? { seq, at, kind, message: safeMessage, prevHash: this.prevHash, hash }
      : { seq, at, kind, message: safeMessage, data: safeData, prevHash: this.prevHash, hash };
    this.prevHash = hash;
    this.counts.events++;
    if (kind === 'step.started') this.counts.steps++;
    if (kind === 'signal.fired') this.counts.signals++;
    if (kind === 'recovery.succeeded') this.counts.recoveries++;
    if (kind === 'escalation.raised') this.counts.escalations++;
    this.buffered.push(ev);
    this.onEvent?.(ev);
    await appendFile(join(this.dir, 'events.jsonl'), `${JSON.stringify(ev)}\n`, 'utf8');
    return ev;
  }

  /**
   * Persist a perception snapshot.
   *
   * Stored in reduced form: refs, roles, names, values and table context, but
   * not geometry or raw attributes for every node. The full snapshot of a legacy
   * screen is ~1500 nodes and the parts that matter for debugging "why did this
   * not resolve" are the semantic ones. Failures keep the full capture.
   */
  async snapshot(label: string, snap: Snapshot, full = false): Promise<string> {
    await this.ready;
    const nodes = snap.nodes
      .filter((n) => full || n.role !== 'text' || (n.text?.length ?? 0) > 0)
      .map((n) => (full ? n : {
        ref: n.ref, role: n.role, name: n.name, value: n.value, text: n.text,
        visible: n.visible, enabled: n.enabled, framePath: n.framePath,
        table: n.table, domId: n.raw?.domId,
      }));
    const payload = this.redactor.deep({
      id: snap.id, at: snap.at, url: snap.url, title: snap.title,
      frames: snap.frames, frameTexts: snap.frameTexts, nodeCount: snap.nodes.length, nodes,
    }, `snapshot.${label}`);
    const file = join('steps', `${label}.snapshot.json`);
    await writeFile(join(this.dir, file), JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  /**
   * Write a screen capture.
   *
   * This is the only unredacted artefact in the bundle — see the module header.
   * `captures` defaults to 'on' because an escalation ticket without the screen
   * the operator is being asked about is close to useless; a deployment with a
   * stricter posture sets it to 'off' and loses that, knowingly.
   */
  async screenshot(label: string, png: Buffer): Promise<string | undefined> {
    if (this.captures === 'off') return undefined;
    await this.ready;
    const file = join('steps', `${label}.png`);
    await writeFile(join(this.dir, file), png);
    this.counts.screenshots++;
    return file;
  }

  async pageCapture(label: string, html: string): Promise<string> {
    await this.ready;
    const file = join('steps', `${label}.html`);
    await writeFile(join(this.dir, file), this.redactor.text(html, `capture.${label}`), 'utf8');
    return file;
  }

  /** Discovery only. The model's turns, redacted, stored beside the artifact. */
  async transcript(turns: unknown[]): Promise<{ file: string; sha256: string }> {
    await this.ready;
    const safe = this.redactor.deep(turns, 'transcript');
    const json = JSON.stringify(safe, null, 2);
    await writeFile(join(this.dir, 'transcript.json'), json, 'utf8');
    return { file: 'transcript.json', sha256: digest(json) };
  }

  async finish(outcome: Record<string, unknown>): Promise<RunManifest> {
    await this.ready;
    const m: RunManifest = {
      ...this.manifest,
      finishedAt: new Date().toISOString(),
      outcome: this.redactor.deep(outcome, 'outcome'),
      counts: { ...this.counts },
      redaction: this.redactor.summary(),
      ...(this.counts.screenshots > 0 ? { containsScreenCaptures: true } : {}),
      chainTip: this.prevHash,
    };
    await writeFile(join(this.dir, 'run.json'), JSON.stringify(m, null, 2), 'utf8');
    return m;
  }
}

/**
 * Re-verify a stored evidence chain. Used by the console and by `swivel verify`.
 *
 * Walking the chain forward proves that no event was edited, removed from the
 * middle, or reordered — each event names its predecessor's digest, so any of
 * those breaks the very next link.
 *
 * What it cannot prove on its own is that the chain is *complete*. Delete the
 * last N lines — everything after the interesting event — and the remainder is
 * a perfectly valid chain that verifies clean. That is the easiest tampering to
 * perform and the most useful, so it has to be caught.
 *
 * The manifest is what catches it. `finish()` records `chainTip`: the digest of
 * the final event, written once at the end of the run. Truncating the log
 * leaves a tip that no longer matches, and no amount of trimming can produce
 * one that does without also forging the manifest — which is a second file, and
 * a separate act.
 */
export async function verifyChain(dir: string): Promise<{ ok: boolean; events: number; brokenAt?: number; message: string }> {
  let raw: string;
  try { raw = await readFile(join(dir, 'events.jsonl'), 'utf8'); }
  catch { return { ok: false, events: 0, message: `No events.jsonl in ${dir}` }; }

  const lines = raw.split('\n').filter(Boolean);
  let prev = GENESIS;
  for (const [i, line] of lines.entries()) {
    const ev = JSON.parse(line) as EvidenceEvent;
    if (ev.prevHash !== prev) {
      return { ok: false, events: lines.length, brokenAt: ev.seq, message: `Event ${ev.seq} does not chain to its predecessor — an event was removed, reordered or edited.` };
    }
    const body = JSON.stringify({ seq: ev.seq, at: ev.at, kind: ev.kind, message: ev.message, data: ev.data, prevHash: ev.prevHash });
    const expect = digest(body);
    if (expect !== ev.hash) {
      return { ok: false, events: lines.length, brokenAt: ev.seq, message: `Event ${ev.seq} (${ev.kind}) has been modified since it was written.` };
    }
    prev = ev.hash;
    void i;
  }

  // ── completeness ─────────────────────────────────────────────────────────
  let manifest: RunManifest | null = null;
  try { manifest = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunManifest; }
  catch { manifest = null; }

  if (!manifest) {
    return {
      ok: false, events: lines.length,
      message: `${lines.length} events chain correctly, but there is no run.json to pin them to. ` +
        `An unfinished or interrupted run looks like this; so does one whose manifest has been removed.`,
    };
  }
  if (!manifest.chainTip) {
    return {
      ok: false, events: lines.length,
      message: `${lines.length} events chain correctly, but run.json records no chainTip, ` +
        `so there is nothing to prove the log has not been truncated.`,
    };
  }
  if (manifest.chainTip !== prev) {
    return {
      ok: false, events: lines.length,
      ...(lines.length ? { brokenAt: (JSON.parse(lines[lines.length - 1] as string) as EvidenceEvent).seq } : {}),
      message: `The chain is internally consistent but incomplete: run.json pins the final event at ` +
        `${manifest.chainTip.slice(0, 12)}…, and the log ends at ${prev.slice(0, 12)}…. Events have been removed from the end.`,
    };
  }

  return {
    ok: true, events: lines.length,
    message: `${lines.length} events verified; chain intact and complete to the tip recorded in run.json.`,
  };
}
