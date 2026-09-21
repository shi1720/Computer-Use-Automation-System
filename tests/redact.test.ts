/**
 * Redaction. This system reads screens full of regulated data and writes
 * evidence that outlives it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, type FieldDef } from '@swivel/core';

const make = () => new Redactor({ salt: 'test-salt', revealTail: 4 });

describe('field-level redaction, driven by the contract', () => {
  const fields: FieldDef[] = [
    { name: 'memberNumber', type: 'string', description: '', sensitivity: 'pii' },
    { name: 'balance', type: 'money', description: '', sensitivity: 'sensitive' },
    { name: 'branch', type: 'string', description: '', sensitivity: 'internal' },
    { name: 'password', type: 'string', description: '', sensitivity: 'secret' },
  ];

  test('PII is tokenised, not erased — evidence stays correlatable', () => {
    const r = make();
    const out = r.record({ memberNumber: '0100482', branch: '003' }, fields, 'input');
    assert.match(String(out.memberNumber), /^«pii:[0-9a-f]{8}…0482»$/);
    assert.equal(out.branch, '003', 'internal data is not redacted');
  });

  test('the same value tokenises identically, so two runs can be correlated', () => {
    const a = make().record({ memberNumber: '0100482' }, fields, 'input');
    const b = make().record({ memberNumber: '0100482' }, fields, 'input');
    assert.equal(a.memberNumber, b.memberNumber);
  });

  test('different values tokenise differently', () => {
    const r = make();
    assert.notEqual(
      r.record({ memberNumber: '0100482' }, fields, 'a').memberNumber,
      r.record({ memberNumber: '0100483' }, fields, 'b').memberNumber,
    );
  });

  test('a secret is never tokenised — there is nothing to correlate', () => {
    const out = make().record({ password: 'meridian' }, fields, 'input');
    assert.equal(out.password, '«secret:withheld»');
    assert.ok(!JSON.stringify(out).includes('meridian'));
  });
});

describe('pattern backstop for text scraped off a screen', () => {
  test('redacts an SSN', () => {
    const out = make().text('SSN 123-45-6789 on file');
    assert.ok(!out.includes('123-45-6789'));
    assert.match(out, /«pii:/);
  });

  test('redacts an email address', () => {
    assert.ok(!make().text('d.whitfield@example.invalid').includes('@example.invalid'));
  });

  test('redacts a card number that passes Luhn', () => {
    const out = make().text('card 4111 1111 1111 1111');
    assert.ok(!out.includes('4111 1111 1111 1111'));
  });

  test('leaves a reference number alone — it is not a card number', () => {
    // A 16-digit journal reference must survive, or every confirmation in the
    // evidence bundle becomes unreadable.
    const ref = '2026092100087112';
    assert.ok(make().text(`Journal reference ${ref}`).includes(ref));
  });

  test('redacts a bearer token wherever it appears', () => {
    const out = make().text('Authorization: Bearer abcdefghijklmnop1234');
    assert.ok(!out.includes('abcdefghijklmnop1234'));
  });

  test('deep-redacts nested structures', () => {
    const out = make().deep({ a: { b: ['contact d.whitfield@example.invalid now'] } });
    assert.ok(!JSON.stringify(out).includes('example.invalid'));
  });

  test('reports what it redacted, so the evidence bundle is auditable', () => {
    const r = make();
    r.text('SSN 123-45-6789 and mail a@b.co');
    const s = r.summary();
    assert.equal(s.ssn, 1);
    assert.equal(s.email, 1);
  });
});
