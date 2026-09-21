/**
 * Compiling a capability into an agent-callable tool definition.
 *
 * The capability contract was designed to make this a projection rather than a
 * translation: inputs are already a JSON-Schema subset, outputs are typed, and
 * business outcomes are enumerated. If this file had to be clever, the schema
 * would be wrong.
 *
 * The description matters more than it looks. It is the only thing a calling
 * agent reads before deciding to run automation against a bank's core, so it
 * states plainly whether the capability changes records, whether that change is
 * reversible, and which non-success answers it can return.
 */
import type { Capability } from '@swivel/core';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  outputSchema?: { type: 'object'; properties: Record<string, unknown> };
  /** Non-standard, but a calling agent should know before it calls. */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    requiresConfirmation: boolean;
    approvalState: string;
    stabilityScore: number;
    capability: string;
  };
}

const jsonType = (t: string): string =>
  t === 'money' || t === 'number' ? 'number' : t === 'integer' ? 'integer' : t === 'boolean' ? 'boolean' : 'string';

export function toToolDefinition(cap: Capability): ToolDefinition {
  const properties = Object.fromEntries(cap.contract.inputs.map((i) => [i.name, {
    type: jsonType(i.type),
    description: i.description,
    ...(i.pattern ? { pattern: i.pattern } : {}),
    ...(i.enumValues ? { enum: i.enumValues } : {}),
    ...(i.example ? { examples: [i.example] } : {}),
  }]));

  const outcomes = cap.contract.outcomes
    .map((o) => `  - ${o.code}${o.retryable ? ' (retryable)' : ''}: ${o.description}`)
    .join('\n');

  const description = [
    cap.metadata.summary,
    '',
    `Effects: ${cap.contract.effects.mutating ? 'CHANGES RECORDS in the institution\'s system of record' : 'read-only, changes nothing'}` +
      `${cap.contract.effects.reversible ? '' : ' — IRREVERSIBLE'}` +
      `${cap.contract.effects.financialImpact ? ' — has financial impact' : ''}` +
      `${cap.contract.effects.dualControl ? ' — subject to dual control; completion means "submitted for approval", not "applied"' : ''}.`,
    cap.contract.effects.summary ?? '',
    '',
    'Besides success, this returns one of the following business outcomes. These are answers, not errors — branch on them rather than retrying:',
    outcomes,
  ].filter(Boolean).join('\n');

  return {
    name: cap.metadata.id.replace(/[.-]/g, '_'),
    description,
    inputSchema: {
      type: 'object',
      properties,
      required: cap.contract.inputs.filter((i) => i.required).map((i) => i.name),
      additionalProperties: false,
    },
    ...(cap.contract.outputs.length
      ? {
          outputSchema: {
            type: 'object' as const,
            properties: Object.fromEntries(cap.contract.outputs.map((o) => [o.name, { type: jsonType(o.type), description: o.description }])),
          },
        }
      : {}),
    annotations: {
      readOnlyHint: !cap.contract.effects.mutating,
      destructiveHint: !cap.contract.effects.reversible,
      idempotentHint: cap.contract.effects.idempotent,
      requiresConfirmation: cap.policy.requiresPerInvocationConfirmation,
      approvalState: cap.quality.approvalState,
      stabilityScore: cap.quality.stabilityScore,
      capability: `${cap.metadata.id}@${cap.metadata.version}`,
    },
  };
}
