/**
 * Keeping one run's data out of a capability's prose.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * A capability's summary and caveats are written by a model that has just been
 * looking at a real member's record. Left alone it narrates what it saw: "For
 * member 0100482 (Dolores Whitfield) the balance was 18,402.66."
 *
 * That prose is not a log line. It is published in the artifact, served to
 * every calling agent through the tool catalogue, and shared across every
 * institution that adopts the capability — so a member of one credit union
 * ends up described in a document another credit union reads. It is also the
 * one place the redactor cannot help, because by the time the artifact is
 * assembled the prose is just a string like any other.
 *
 * So it is scrubbed at the sentence level, and the test is deliberately
 * asymmetric: a sentence that might describe this run is dropped, because the
 * cost of dropping a good sentence is a slightly thinner summary and the cost
 * of keeping a bad one is a member's name in a shared artifact.
 */

/** Fold to a comparable form: case, punctuation and runs of space. */
const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Word tokens of at least two characters. */
const words = (s: string): string[] => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/**
 * A value that reads like a person's name.
 *
 * Screens in this domain render names as `WHITFIELD, DOLORES`. A model writing
 * prose reorders that to "Dolores Whitfield" without being asked, and a plain
 * substring test then finds nothing — which is how a member's name survives a
 * scrubber that looks like it works.
 */
function looksLikeName(value: string): boolean {
  const parts = value.split(/[,\s]+/).filter(Boolean);
  return parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^[A-Za-z][A-Za-z'.-]*$/.test(p));
}

/** Every token of `value` appears in `sentence`, in any order. */
function containsAllWords(sentence: string, value: string): boolean {
  const have = new Set(words(sentence));
  const need = words(value);
  return need.length > 0 && need.every((w) => have.has(w));
}

/**
 * Does this sentence describe the run rather than the capability?
 *
 * Three rules, in order of how often they catch something:
 *
 *  1. Any currency-shaped amount. A capability describes *what* it reads, never
 *     what it read. This one is independent of the forbidden list, which
 *     matters because a balance the model paraphrased ("about 18,402.66") never
 *     appears verbatim in any node.
 *  2. A forbidden value as a substring, case-insensitively. Case mattered
 *     before: the screen says `SMITH, JOHN` and the prose says "Smith, John".
 *  3. Every word of a name-shaped forbidden value, in any order — the
 *     `WHITFIELD, DOLORES` → "Dolores Whitfield" case above.
 */
export function sentenceLeaksRunData(sentence: string, forbidden: string[]): boolean {
  if (/\d[\d,]*\.\d{2}\b/.test(sentence)) return true;
  const folded = fold(sentence);
  for (const raw of forbidden) {
    const value = raw.trim();
    if (value.length < 3) continue;
    if (folded.includes(fold(value))) return true;
    if (looksLikeName(value) && containsAllWords(sentence, value)) return true;
  }
  return false;
}

/**
 * Drop every sentence that describes this run.
 *
 * `onDrop` is how the removal reaches the evidence chain: prose vanishing from
 * an artifact with no record of why is its own kind of opacity.
 *
 * Returns `undefined` when nothing survives, so callers fall back to something
 * written rather than to an empty string.
 */
export function scrubProse(
  prose: string | undefined,
  forbidden: string[],
  onDrop?: (sentence: string) => void,
): string | undefined {
  if (!prose) return undefined;
  const kept: string[] = [];
  // Split on sentence terminators, but treat a newline as one too: a model that
  // writes a bulleted caveat list with no full stops would otherwise be one
  // enormous "sentence", and a single leak anywhere in it takes the whole thing
  // out. That fails safe, but silently, and the summary is worth keeping.
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (sentenceLeaksRunData(s, forbidden)) onDrop?.(s);
    else kept.push(s);
  }
  return kept.join(' ').trim() || undefined;
}
