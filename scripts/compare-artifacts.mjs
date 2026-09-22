/**
 * Compare two capability artifacts, structurally.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The claim this exists to test is the load-bearing one in §2 of REPORT.md:
 * *the model chooses which control, Swivel decides how it is described*. If
 * that is true, recording the same goal with a different vendor's model should
 * produce the same document — same steps, same target descriptors, same
 * checkpoints — because none of those are things the model is asked for.
 *
 * If it is false, the format is recording a model's idiosyncrasies rather than
 * an application's structure, and every downstream claim about durability is
 * weaker than it sounds. So it is checked rather than asserted:
 *
 *   node scripts/compare-artifacts.mjs a.json b.json
 *
 * Only the behaviour-determining parts are compared. Timestamps, provenance,
 * usage and the content hash differ between any two runs and say nothing.
 */
import { readFile } from 'node:fs/promises';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('usage: node scripts/compare-artifacts.mjs <a.json> <b.json>');
  process.exit(2);
}

const load = async (p) => JSON.parse(await readFile(p, 'utf8'));
const [a, b] = await Promise.all([load(aPath), load(bPath)]);

/** The parts of a step that decide what it does. */
const shape = (c) => c.flow.steps.map((s) => ({
  id: s.id,
  kind: s.kind,
  risk: s.risk ?? 'read_only',
  target: s.target && {
    id: s.target.id,
    role: s.target.role,
    name: s.target.name?.value ?? null,
    frame: (s.target.frame?.path ?? []).join('/'),
    anchors: (s.target.anchors ?? []).map((x) => `${x.relation}:${x.text?.value}`),
    cell: s.target.cell ? JSON.stringify(s.target.cell) : null,
  },
  value: s.value ?? null,
  extract: s.extract ? `${s.extract.into}:${s.extract.source}:${s.extract.transform}` : null,
  expect: (s.expect?.all ?? []).map((x) => x.regex ?? x.text ?? ''),
}));

const summary = (c) => ({
  steps: shape(c),
  outputs: c.contract.outputs.map((o) => `${o.name}:${o.type}`),
  inputs: c.contract.inputs.map((i) => `${i.name}:${i.type}`),
  effects: c.contract.effects,
  success: (c.flow.successCheckpoint.all ?? []).map((x) => x.regex ?? x.text ?? ''),
});

const A = summary(a), B = summary(b);
const label = (c) => `${c.provenance?.discoveredBy?.provider ?? '?'}/${c.provenance?.discoveredBy?.model ?? '?'}`;

console.log(`A  ${label(a)}   ${aPath}`);
console.log(`B  ${label(b)}   ${bPath}`);
console.log('');

let differences = 0;
const line = (ok, text) => { if (!ok) differences++; console.log(`  ${ok ? '=' : '≠'}  ${text}`); };

line(A.steps.length === B.steps.length, `step count: ${A.steps.length} vs ${B.steps.length}`);
for (let i = 0; i < Math.max(A.steps.length, B.steps.length); i++) {
  const x = A.steps[i], y = B.steps[i];
  const same = JSON.stringify(x) === JSON.stringify(y);
  line(same, `step ${i + 1}: ${x?.id ?? '—'} / ${y?.id ?? '—'}`);
  if (!same && x && y) {
    for (const k of Object.keys(x)) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
        console.log(`        ${k}\n          A: ${JSON.stringify(x[k])}\n          B: ${JSON.stringify(y[k])}`);
      }
    }
  }
}
for (const k of ['inputs', 'outputs', 'success']) {
  line(JSON.stringify(A[k]) === JSON.stringify(B[k]), `${k}: ${JSON.stringify(A[k])} / ${JSON.stringify(B[k])}`);
}
line(JSON.stringify(A.effects) === JSON.stringify(B.effects), `effects: ${JSON.stringify(A.effects.riskClass)} / ${JSON.stringify(B.effects.riskClass)}`);

console.log('');
console.log(differences === 0
  ? '  Identical where it matters. The model chose the controls; Swivel described them.'
  : `  ${differences} difference(s) above.`);
process.exit(differences === 0 ? 0 : 1);
