/**
 * The discovery system prompt.
 *
 * Written to be cached: it is the stable prefix of every turn in a run, and the
 * only thing that changes between turns is the screen digest appended as the
 * user message. On a fifteen-turn discovery that is the difference between
 * paying for the prompt once and paying for it fifteen times.
 *
 * The substance is domain instruction, not framework instruction. A model that
 * knows it is operating a credit union core — that `MSG 0042` means the search
 * found nothing, that a screen saying "PENDING APPROVAL" has not actually
 * changed anything yet — finds the right path in noticeably fewer turns than
 * one told only "you are a browser agent".
 */
export interface PromptContext {
  goal: string;
  institution: string;
  product: string;
  vocabulary: Record<string, string>;
  parameters: Array<{ name: string; value: string; description: string }>;
  allowRisky: boolean;
}

export function discoverySystemPrompt(c: PromptContext): string {
  const vocab = Object.entries(c.vocabulary).map(([k, v]) => `  ${k} = "${v}"`).join('\n');
  const params = c.parameters.length
    ? c.parameters.map((p) => `  ${p.name} = "${p.value}"  — ${p.description}`).join('\n')
    : '  (none)';

  return `You are operating a back-office banking application the way an experienced credit-union
operations specialist would, on behalf of an automation system that is recording
your work so it can be replayed thousands of times without you.

APPLICATION
  Institution : ${c.institution}
  Product     : ${c.product}
  This is a legacy, server-rendered core banking system. It uses framesets,
  table layouts and generated control ids. Many input boxes have no label at
  all — you identify them the way a person does, by the caption printed to
  their left.

YOUR GOAL
  ${c.goal}

PARAMETERS
  These values were supplied by the operator who started this recording. Where
  the goal calls for one of them, use it EXACTLY as given. The recording system
  detects these values and turns them into parameters automatically, so the
  saved capability works for any member, not just this one.
${params}

VOCABULARY AT THIS INSTITUTION
${vocab}

HOW YOU SEE THE SCREEN
  Each turn you receive a digest of the current screen with two kinds of handle:

    [n12]  a control you can operate — a box, a button, a link, a dropdown
    [v34]  a value you can read — a cell in a grid, or a field on a detail
           screen. Use these with the extract tool to return data to the caller.

  You act by naming a handle. You never write a selector, an XPath or a CSS
  rule — describing controls durably is the recording system's job, not yours,
  and it does it from what it can see.

HOW TO WORK
  1. READ THE SCREEN MESSAGES FIRST. This system reports everything through
     numbered messages — MSG 0042 (no record found), MSG 0451 (not authorised),
     MSG 0031 (required field missing), MSG 0600 (end-of-day processing). If one
     is present it is almost always the explanation for whatever just happened.
  2. Take the route a trained operator takes: search, pick the record from the
     results grid, then act from the record. Do not guess at URLs.
  3. One action per turn.
  4. If the system rejects an input, read why and correct it. Do not resubmit
     the same values hoping for a different result.
  5. Watch for screens that only *look* like success. "SUBMITTED FOR APPROVAL"
     means a second person still has to approve it; the change has NOT taken
     effect. Say so in your intent, and make the checkpoint assert what is
     really true.
  6. Pull out the values the caller asked for with \`extract\` before you finish.

WRITING INTENTS
  Every action you take carries an \`intent\`. A bank's change-control reviewer
  will read those intents — not the controls — to decide whether this automation
  is safe to run unattended. Write each one as an instruction to a colleague:
  "Search for the member by member number", not "click n14".

SAFETY
  ${c.allowRisky
    ? 'This recording is permitted to complete state-changing actions. Still stop and escalate before anything the goal did not ask for.'
    : 'This recording is READ-ONLY. You may search, open records and read values. Do NOT submit forms that post transactions, assess fees, place stops or change records. If the goal appears to require one, call `escalate` and explain.'}
  Never enter real-looking personal data of your own invention. Use only the
  parameters above.
  If you are blocked and have genuinely run out of approaches, call \`escalate\`
  with what you tried and what you would need. That is a good outcome, not a
  failure — a human will take over this exact session.

FINISHING
  When the goal is met, call \`finish\`. Give a \`success_text\` that is a short,
  distinctive piece of text visible on the final screen and that will still be
  there on every future run — a screen title, a confirmation heading, a field
  caption. Do NOT use a value that changes between runs, such as a balance, a
  member name or a confirmation number.`;
}

/** Tool schemas offered to the model. Identical for every provider. */
export const DISCOVERY_TOOLS = [
  {
    name: 'click',
    description: 'Click a control — a button, a link, a checkbox or a radio option.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Handle of the control, e.g. "n12".' },
        intent: { type: 'string', description: 'One sentence, written for a human reviewer: what this click accomplishes and why.' },
        expect_text: { type: 'string', description: 'Short, stable text you expect to see on the screen afterwards, proving the click worked. Never a balance, name or reference number.' },
        row_match: { type: 'string', description: 'If the control or value sits in a grid row, the value that identifies the row you mean — e.g. "SPECIAL SAVINGS" or a member number. Recorded so replay finds the right row rather than the same position.' },
      },
      required: ['ref', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description: 'Type a value into a text box. Clears any existing content first.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        value: { type: 'string', description: 'The text to type. Use a parameter value verbatim when the goal calls for one.' },
        intent: { type: 'string' },
      },
      required: ['ref', 'value', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown, by its visible label.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' }, intent: { type: 'string' } },
      required: ['ref', 'value', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Go directly to a URL. Use sparingly — prefer clicking through the application the way an operator would, because recorded navigation is more brittle than recorded clicks.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, intent: { type: 'string' } },
      required: ['url', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract',
    description: 'Record a value from the screen as an output of this capability. This is how the calling agent gets an answer back.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Handle of the value to read — normally a [v..] handle from the READABLE VALUES list.' },
        output_name: { type: 'string', description: 'camelCase name for the output field, e.g. "savingsBalance".' },
        description: { type: 'string', description: 'What this value is, written for the AI agent that will consume it.' },
        transform: {
          type: 'string',
          enum: ['none', 'trim', 'money_to_number', 'digits_only', 'upper', 'lower', 'iso_date'],
          description: 'Normalisation to apply. Use money_to_number for balances so the caller gets a number rather than "18,402.66".',
        },
        row_match: { type: 'string', description: 'If the control or value sits in a grid row, the value that identifies the row you mean — e.g. "SPECIAL SAVINGS" or a member number. Recorded so replay finds the right row rather than the same position.' },
        intent: { type: 'string' },
      },
      required: ['ref', 'output_name', 'description', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'The goal has been achieved. Call this once.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One paragraph for the capability catalogue, written for an AI agent deciding whether to call this capability.' },
        success_text: { type: 'string', description: 'Stable text visible on the final screen that proves the flow completed.' },
        caveats: { type: 'string', description: 'Anything a reviewer should know about this flow.' },
        awaits_second_approval: {
          type: 'boolean',
          description: 'True only if the change you made is NOT yet in effect and is waiting for a second person to authorise it. If the application confirmed the change outright, this is false.',
        },
      },
      required: ['summary', 'success_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalate',
    description: 'You are blocked and need a person. The live session is handed to a human operator with your context.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'What you were trying to do, what you tried, and what you think is needed.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
] as const;
