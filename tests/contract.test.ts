/**
 * The capability's public contract — the part an AI agent programs against.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateInputs, coerceOutput, type FieldDef } from '@swivel/core';

const memberNumber: FieldDef = {
  name: 'memberNumber', type: 'string', description: 'Member number',
  required: true, pattern: '^\\d{7}$', example: '0100482', sensitivity: 'pii',
};

describe('input validation happens before the browser opens', () => {
  test('accepts a well-formed call', () => {
    const r = validateInputs([memberNumber], { memberNumber: '0100482' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.values.memberNumber, '0100482');
  });

  test('rejects a value that cannot possibly be a member number', () => {
    const r = validateInputs([memberNumber], { memberNumber: 'abc' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /does not match the required format/);
  });

  test('rejects a missing required input by name', () => {
    const r = validateInputs([memberNumber], {});
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /"memberNumber" is required/);
  });

  test('rejects an unknown input rather than silently ignoring it', () => {
    // A caller that misspells an argument deserves an error, not a run against
    // a default — that is how the wrong member gets serviced.
    const r = validateInputs([memberNumber], { memberNumber: '0100482', memberNo: '0100483' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /"memberNo" is not an input/);
  });

  test('enforces enum membership', () => {
    const f: FieldDef = { name: 'reason', type: 'enum', description: 'why', required: true, enumValues: ['LOST', 'DISPUTE'] };
    assert.equal(validateInputs([f], { reason: 'LOST' }).ok, true);
    assert.equal(validateInputs([f], { reason: 'BECAUSE' }).ok, false);
  });

  test('coerces a money input written the way a person writes it', () => {
    const f: FieldDef = { name: 'amount', type: 'money', description: 'amount', required: true };
    const r = validateInputs([f], { amount: '$1,250.00' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.values.amount, 1250);
  });
});

describe('output coercion', () => {
  test('a balance comes back as a number, not a screen string', () => {
    assert.equal(coerceOutput('18,402.66', 'money_to_number', 'money'), 18402.66);
  });

  test('accounting parentheses mean negative', () => {
    // Getting this wrong flips the sign on an overdrawn account — the quiet
    // kind of error that destroys trust in an automation.
    assert.equal(coerceOutput('(1,204.55)', 'money_to_number', 'money'), -1204.55);
  });

  test('a trailing minus also means negative', () => {
    assert.equal(coerceOutput('1,204.55-', 'money_to_number', 'money'), -1204.55);
  });

  test('unparseable money becomes null rather than NaN', () => {
    assert.equal(coerceOutput('N/A', 'money_to_number', 'money'), null);
  });

  test('digits_only strips formatting from an account number', () => {
    assert.equal(coerceOutput('0100482-01', 'digits_only', 'string'), '010048201');
  });

  test('the declared type wins over the transform', () => {
    assert.equal(coerceOutput('  42  ', 'trim', 'integer'), 42);
  });
});
