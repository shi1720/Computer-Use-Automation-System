/**
 * The model boundary.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Three providers implement one interface, and the agent loop is written once
 * against it. That only holds if each translation is faithful, and a
 * translation bug here is expensive in a specific way: it does not crash, it
 * degrades. A dropped tool result becomes a model that has forgotten what it
 * just did; a miscounted token becomes a cost figure in the evidence that is
 * quietly wrong.
 *
 * These tests need no network. They check the two things a translation can get
 * wrong without saying so.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesInput, estimateCostUsd, addUsage, emptyUsage, PRICES, type LlmMessage } from '@swivel/core';

describe('translating the loop\'s conversation for the Responses API', () => {
  const conversation: LlmMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Here is the screen.' }] },
    { role: 'assistant', content: [
      { type: 'text', text: 'Opening member search.' },
      { type: 'tool_use', id: 'call_1', name: 'click', input: { ref: 'n2', intent: 'open member search' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'Action completed.' }] },
  ];

  test('every tool call is paired with its result, by the same id', () => {
    // The API rejects a `function_call` with no matching `function_call_output`,
    // and — worse, because it is silent — a mismatched `call_id` detaches the
    // result from the call that produced it. The model then sees itself act and
    // never sees what happened.
    const items = toResponsesInput(conversation);
    const calls = items.filter((i) => (i as { type?: string }).type === 'function_call');
    const outputs = items.filter((i) => (i as { type?: string }).type === 'function_call_output');
    assert.equal(calls.length, 1);
    assert.equal(outputs.length, 1);
    assert.equal((calls[0] as { call_id: string }).call_id, (outputs[0] as { call_id: string }).call_id);
    assert.equal((calls[0] as { call_id: string }).call_id, 'call_1');
  });

  test('a tool call and its result stay in order', () => {
    // Tool blocks live *inside* messages for one vendor and are top-level items
    // for the other. Flattening them in the wrong order shows the model a
    // result before the call it answers.
    const items = toResponsesInput(conversation);
    const kinds = items.map((i) => (i as { type?: string; role?: string }).type ?? (i as { role: string }).role);
    assert.deepEqual(kinds, ['user', 'assistant', 'function_call', 'function_call_output']);
  });

  test('the model\'s own words are carried back as assistant text', () => {
    const items = toResponsesInput(conversation);
    const assistant = items.find((i) => (i as { role?: string }).role === 'assistant') as { content: string };
    assert.equal(assistant.content, 'Opening member search.');
  });

  test('a turn with a tool call and no narration still produces the call', () => {
    // A reasoning model routinely says nothing and just acts. Emitting an empty
    // assistant message would be noise; dropping the call would be a bug.
    const items = toResponsesInput([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c9', name: 'finish', input: {} }] },
    ]);
    assert.equal(items.length, 1);
    assert.equal((items[0] as { type: string }).type, 'function_call');
  });
});

describe('what a discovery run costs', () => {
  test('cached input is not billed as fresh input', () => {
    // OpenAI reports `input_tokens` as the total *including* the cached
    // portion. Adding the cached count on top would inflate every cost figure
    // in the evidence by the size of the system prefix, on every turn — and a
    // 7-turn run resends a ~4k-token prefix each time, so the error is larger
    // than the number it is reporting.
    const M = 1_000_000;
    const p = PRICES['gpt-5.1'] as { in: number; out: number };

    const correct = estimateCostUsd('gpt-5.1', { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 9_000, cacheCreationTokens: 0 });
    const doubleCounted = estimateCostUsd('gpt-5.1', { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 9_000, cacheCreationTokens: 0 });
    assert.ok(correct < doubleCounted, 'the two must differ, or the distinction is not being made');

    const expected = (1_000 * p.in) / M + (9_000 * p.in * 0.1) / M + (500 * p.out) / M;
    assert.ok(Math.abs(correct - expected) < 1e-9, `expected ${expected}, got ${correct}`);
  });

  test('cache reads cost a tenth of fresh input, which is the whole point of caching', () => {
    const fresh = estimateCostUsd('gpt-5.1', { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const cached = estimateCostUsd('gpt-5.1', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000, cacheCreationTokens: 0 });
    assert.ok(Math.abs(cached * 10 - fresh) < 1e-9);
  });

  test('an unknown model does not silently cost nothing', () => {
    // Returning 0 for a model with no published price would put a free
    // discovery run in the evidence. Falling back to a real price is wrong by
    // a bounded amount; reporting zero is wrong by all of it.
    assert.ok(estimateCostUsd('some-model-we-have-never-heard-of', { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 }) > 0);
  });

  test('usage accumulates across turns', () => {
    const a = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 5 };
    const total = addUsage(addUsage(emptyUsage(), a), a);
    assert.deepEqual(total, { inputTokens: 20, outputTokens: 4, cacheReadTokens: 200, cacheCreationTokens: 10 });
  });
});
