/**
 * The resolver is the load-bearing piece of the whole system: it decides which
 * control an artifact meant, and — more importantly — when to refuse.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, canonicaliseId, emptyContext } from '@swivel/core';
import type { TargetDescriptor } from '@swivel/core';
import { captionedInput, node, resultsGrid, snapshot } from './helpers.js';

const ctx = { ...emptyContext(), input: { memberNumber: '0100482' }, vocab: { memberNumber: 'Member #' } };

describe('accessible name targeting', () => {
  test('resolves a uniquely named button with full confidence', () => {
    const snap = snapshot([
      node({ role: 'button', name: 'Search', raw: { tag: 'input', inputType: 'submit' } }),
      node({ role: 'button', name: 'Clear', raw: { tag: 'input', inputType: 'reset' } }),
    ]);
    const t: TargetDescriptor = { id: 'search', role: 'button', name: { value: 'Search', match: 'exact' } };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.score, 100); assert.equal(r.node.name, 'Search'); }
  });

  test('never crosses roles: a link named Search does not satisfy a button', () => {
    const snap = snapshot([node({ role: 'link', name: 'Search' })]);
    const r = resolveTarget({ id: 'search', role: 'button', name: { value: 'Search' } }, snap, { ctx });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_candidates');
  });
});

describe('anchor targeting — the unlabelled-input case', () => {
  const snap = snapshot([
    ...captionedInput('Member #', { y: 40, domId: 'ctl00_Main_txtMemberNo' }),
    ...captionedInput('Last Name', { y: 40, domId: 'ctl00_Main_txtLastName' }).map((n, i) =>
      i === 0 ? { ...n, bounds: { x: 300, y: 40, w: 70, h: 14 } } : { ...n, bounds: { x: 390, y: 39, w: 110, h: 16 } }),
    ...captionedInput('SSN (Last 4)', { y: 62, domId: 'ctl00_Main_txtSsn4' }),
  ]);

  test('picks the box beside the right caption, on a row with three boxes', () => {
    const t: TargetDescriptor = {
      id: 'member_no', role: 'textbox',
      anchors: [{ relation: 'right-of', text: { value: '{{vocab.memberNumber}}', match: 'normalized' }, maxDistancePx: 320 }],
    };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.node.raw?.domId, 'ctl00_Main_txtMemberNo');
  });

  test('resolves the same control at a tenant that renamed the caption', () => {
    const harbor = snapshot(captionedInput('Customer ID', { y: 40, domId: 'ctl00_cphMain_txtMemberNo' }));
    const t: TargetDescriptor = {
      id: 'member_no', role: 'textbox',
      anchors: [{ relation: 'right-of', text: { value: '{{vocab.memberNumber}}', match: 'normalized' }, maxDistancePx: 320 }],
    };
    // Same artifact, different tenant vocabulary. No re-recording.
    const r = resolveTarget(t, harbor, { ctx: { ...ctx, vocab: { memberNumber: 'Customer ID' } } });
    assert.equal(r.ok, true);
  });

  test('does not read across rows — the SSN box is not "Member #"', () => {
    const t: TargetDescriptor = {
      id: 'ssn', role: 'textbox',
      anchors: [{ relation: 'right-of', text: { value: 'SSN (Last 4)', match: 'normalized' }, maxDistancePx: 320 }],
    };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.node.raw?.domId, 'ctl00_Main_txtSsn4');
  });
});

describe('grid row targeting', () => {
  const rows = [
    { 'Member #': '0100482', Name: 'Whitfield, Dolores', Status: 'ACTIVE' },
    { 'Member #': '0100483', Name: 'Whitfield, Marcus', Status: 'ACTIVE' },
  ];

  const viewLink: TargetDescriptor = {
    id: 'view', role: 'link', name: { value: 'View', match: 'normalized' },
    cell: {
      columnHeader: { value: 'Action', match: 'normalized' },
      rowWhere: { columnHeader: { value: '{{vocab.memberNumber}}', match: 'normalized' }, equals: '{{input.memberNumber}}', match: 'normalized' },
    },
  };

  test('picks the row by value, not by position', () => {
    const r = resolveTarget(viewLink, snapshot(resultsGrid(rows)), { ctx });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.node.table?.rowValues['Member #'], '0100482');
  });

  test('survives a tenant inserting a column in the middle of the grid', () => {
    // This is the scenario that breaks nth-child and column-index locators.
    const r = resolveTarget(viewLink, snapshot(resultsGrid(rows, { extraColumnFirst: true })), { ctx });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.node.table?.rowValues['Member #'], '0100482');
  });

  test('survives the result set being reordered', () => {
    const r = resolveTarget(viewLink, snapshot(resultsGrid([...rows].reverse())), { ctx });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.node.table?.rowValues['Member #'], '0100482');
  });
});

describe('refusal', () => {
  test('refuses to guess between two indistinguishable candidates', () => {
    const snap = snapshot(resultsGrid([
      { 'Member #': '0100482', Name: 'A' },
      { 'Member #': '0100483', Name: 'B' },
    ]));
    // Name only, no row constraint: both View links score identically.
    const r = resolveTarget({ id: 'view', role: 'link', name: { value: 'View' } }, snap, { ctx });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, 'ambiguous');
      assert.match(r.message, /Refusing to guess/);
    }
  });

  test('refuses when the evidence that identified the control has gone', () => {
    // The control is still there, but renamed and re-idded — a version bump.
    const snap = snapshot([node({ role: 'button', name: 'Submit Request', raw: { tag: 'input', domId: 'ctl00_cphMain_btnGo' } })]);
    const t: TargetDescriptor = {
      id: 'submit', role: 'button', name: { value: 'Open Account', match: 'exact' },
      hints: { idPattern: 'ctl00_Main_btnSubmit' },
      require: { minScore: 60, unique: true, timeoutMs: 1000 },
    };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'below_min_score');
  });

  test('reports which evidence matched and which did not, for diagnosis', () => {
    const snap = snapshot([node({ role: 'button', name: 'Search', raw: { tag: 'input', domId: 'ctl00_cphMain_btnSearch' } })]);
    const t: TargetDescriptor = {
      id: 'search', role: 'button', name: { value: 'Search', match: 'exact' },
      hints: { idPattern: 'ctl00_Main_btn\\d+' },
    };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.matched.includes('name'));
      assert.ok(r.missed.includes('hints.idPattern'));
    }
  });

  test('a stale id pattern does not weaken an unambiguous identification', () => {
    // This is a different build of the same vendor product: the name still
    // matches exactly, the generated id prefix has changed. Letting the id
    // drag the score down would refuse a control that was identified perfectly
    // — which is the most volatile evidence in the system vetoing the most
    // stable.
    const snap = snapshot([node({ role: 'button', name: 'Search', raw: { tag: 'input', domId: 'ctl00_cphMain_btnSearch' } })]);
    const t: TargetDescriptor = {
      id: 'search', role: 'button', name: { value: 'Search', match: 'exact' },
      hints: { idPattern: 'ctl\\d+_Main_btnSearch', tag: 'input' },
      require: { minScore: 60, unique: true, timeoutMs: 1000 },
    };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.score, 100, 'identified on the name alone');
      assert.ok(r.corroboration < 100, 'and the drift is still reported');
      assert.ok(r.missed.includes('hints.idPattern'));
    }
  });

  test('refuses a target identified by nothing but implementation detail', () => {
    // Every corroborating probe matches perfectly — the tag is right, the
    // generated id matches the recorded pattern exactly. None of that says
    // *this is the control a person would have clicked*, so the score caps at
    // 50 and the default threshold refuses it. An id pattern is not an
    // identification; it is a fingerprint of one build of one vendor's markup,
    // and acting on it alone is precisely the guess this resolver exists to
    // not make.
    const snap = snapshot([node({ role: 'textbox', raw: { tag: 'input', domId: 'ctl00_Main_txt1' } })]);
    const t: TargetDescriptor = { id: 'weak', role: 'textbox', hints: { idPattern: 'ctl\\d+_Main_txt\\d+', tag: 'input' } };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, false, 'corroborating evidence alone must never carry a resolution');
    if (!r.ok) {
      assert.equal(r.reason, 'below_min_score');
      const best = r.best[0]!;
      assert.equal(best.score, 50, 'capped at half, because half the evidence is missing entirely');
      assert.ok(best.matched.includes('hints.idPattern'));
    }
  });
});

describe('id canonicalisation', () => {
  test('turns a generated WebForms id into a stable shape', () => {
    assert.equal(
      canonicaliseId('ctl00_Main_grdResults_ctl03_lnkView'),
      'ctl\\d+_Main_grdResults_ctl\\d+_lnkView',
    );
  });

  test('the canonical pattern still matches after rows are added', () => {
    const pattern = canonicaliseId('ctl00_Main_grdResults_ctl03_lnkView');
    assert.match('ctl00_Main_grdResults_ctl11_lnkView', new RegExp(`^${pattern}$`));
  });

  test('digits are generalised everywhere, including the container prefix', () => {
    // Meridian 9.2 emits ctl00_Main_*; 10.1 emits ctl00_cphMain_*. The digits
    // generalise; the developer's naming is what carries the (weak) signal.
    const pattern = canonicaliseId('ctl00_Main_txtMemberNo');
    assert.match('ctl02_Main_txtMemberNo', new RegExp(`^${pattern}$`));
    assert.doesNotMatch('ctl00_cphMain_txtMemberNo', new RegExp(`^${pattern}$`));
  });
});

describe('frame scoping', () => {
  test('does not resolve a control that lives in a different frame', () => {
    const snap = snapshot([node({ role: 'button', name: 'Sign On', framePath: ['navFrame'] })]);
    const r = resolveTarget(
      { id: 'sign_on', role: 'button', name: { value: 'Sign On' }, frame: { path: ['contentFrame'] } },
      snap, { ctx },
    );
    assert.equal(r.ok, false);
  });
});

describe('probes that cannot discriminate are not scored', () => {
  /**
   * The reproduction that motivated all of this.
   *
   * A hand-authored descriptor for the Member # box: scoped to a panel, with a
   * tag hint, an input-type hint and a `nearText` hint. On a screen where the
   * Member # box is gone and only the SSN box remains inside that panel, three
   * separate always-true probes — the container the pool was *already* filtered
   * by, the whole-frame text search called "nearText", and a tag every input
   * shares — carried the SSN box over the threshold. The name probe was listed
   * as `missed` in the very same result.
   *
   * The engine would then type a member number into the SSN field and record it
   * as a maximally unambiguous resolution. On a banking UI.
   */
  test('a control whose accessible name does not match is refused, however much else agrees', () => {
    const panel = node({ ref: 'panel', role: 'form', name: 'Member Search', bounds: { x: 0, y: 0, w: 600, h: 200 } });
    const ssn = node({
      ref: 'ssn', role: 'textbox', name: '', parentRef: 'panel',
      raw: { tag: 'input', inputType: 'text', domId: 'ctl00_Main_txtSSN' },
      bounds: { x: 120, y: 60, w: 160, h: 20 },
    });
    // The caption is on screen, because the *screen* is a search form — which
    // is exactly why searching the whole frame for it proves nothing.
    const caption = node({ ref: 'cap', role: 'text', text: 'Member #', parentRef: 'panel', bounds: { x: 20, y: 140, w: 60, h: 16 } });
    (panel as { childRefs: string[] }).childRefs = ['ssn', 'cap'];

    const snap = snapshot([panel, ssn, caption]);
    const t: TargetDescriptor = {
      id: 'member_number', role: 'textbox',
      within: { id: 'panel', role: 'form', name: { value: 'Member Search', match: 'exact' } },
      name: { value: 'Member #', match: 'normalized' },
      hints: { tag: 'input', inputType: 'text', nearText: ['Member #'] },
      require: { minScore: 55, unique: true, timeoutMs: 1000 },
    };

    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, false, 'the name is the only thing that identifies this box, and it did not match');
    if (!r.ok) assert.equal(r.reason, 'below_min_score');
  });

  test('the reported margin is a real distance, not a flattering one', () => {
    // One candidate of the role on the whole screen. That is not "beat the
    // runner-up by 100 points"; there was no runner-up. Writing 100 into the
    // evidence log made an unverifiable claim look like a measurement.
    const snap = snapshot([node({ role: 'button', name: 'Search' })]);
    const t: TargetDescriptor = { id: 'search', role: 'button', name: { value: 'Search', match: 'exact' } };
    const r = resolveTarget(t, snap, { ctx });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.candidatesConsidered, 1);
      assert.equal(r.margin, r.score, 'the distance to nothing is the score itself');
    }
  });
});
