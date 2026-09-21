#!/usr/bin/env node
/**
 * The Swivel CLI.
 *
 * Two commands carry the system: `discover` puts a model in front of a live
 * application once, and `replay` runs what it learned forever without one.
 * Everything else exists to inspect, review and govern what those two produce.
 */
import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SwivelStore, Runner, AnthropicProvider, ClaudeCliProvider, MockProvider,
  verifyChain, validateCapability, validateOverlay, formatFindings, hasErrors,
  resolveCapability, computeContentHash, getProductProfile, formatResult,
  estimateCostUsd, hashPassword, stabilityScore,
  type Capability, type TenantOverlay, type DiscoveryParameter, type LlmProvider,
} from '@swivel/core';
import { loadConfig, requireTenant, writeDefaultConfig, CONFIG_PATH, type SwivelConfig } from './config.js';
import { ConsoleEscalationBridge } from './escalate.js';
import { banner, c, event, fail, kv, money, rule, statusChip, table, SYMBOL } from './ui.js';

const HELP = `
  ${c.bold(c.cyan('◧ SWIVEL'))} ${c.grey('— computer-use capabilities for systems that were never meant to be automated')}

  ${c.bold('DISCOVER AND REPLAY')}
    discover                 Drive a live application with a model and record a capability
    replay <id>[@version]    Execute a saved capability. No model in the loop.
    stability <id>[@version] Replay N times and report a flakiness signal

  ${c.bold('GOVERN')}
    list                     Capabilities in the catalogue
    show <id>[@version]      Full capability, contract and validation findings
    approve <id>@<version>   Move a capability to approved so agents may invoke it unattended
    catalog                  Print the agent-facing tool catalogue (MCP-compatible)
    codegen <id>[@version]   Emit a runnable Playwright test from an artifact

  ${c.bold('TENANTS')}
    overlay new <id>         Scaffold a tenant overlay from a base capability
    overlay check <id>       Validate an overlay against its base
    import <dir|file>        Load committed capabilities and overlays into the store

  ${c.bold('OPERATE')}
    serve                    Start the operator console and capability API
    meridian                 Start the simulated legacy core (both tenants)
    verify <runId|dir>       Re-verify an evidence bundle's hash chain
    runs                     Recent runs
    init                     Create ${CONFIG_PATH} and seed the local store

  ${c.grey('Run any command with --help for its options.')}
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return; }

  const cfg = await loadConfig();
  const store = new SwivelStore();
  await store.init();

  switch (cmd) {
    case 'init': return cmdInit(store);
    case 'discover': return cmdDiscover(rest, cfg, store);
    case 'replay': return cmdReplay(rest, cfg, store);
    case 'stability': return cmdStability(rest, cfg, store);
    case 'list': return cmdList(store);
    case 'show': return cmdShow(rest, store);
    case 'approve': return cmdApprove(rest, store);
    case 'catalog': return cmdCatalog(rest, store);
    case 'codegen': return cmdCodegen(rest, store);
    case 'overlay': return cmdOverlay(rest, cfg, store);
    case 'import': return cmdImport(rest, store);
    case 'verify': return cmdVerify(rest, store);
    case 'runs': return cmdRuns(store);
    case 'serve': return cmdServe();
    case 'meridian': return cmdMeridian();
    default: fail(`Unknown command "${cmd}". Run \`swivel help\`.`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function llmFromFlag(flag: string | undefined): LlmProvider {
  const kind = (flag ?? process.env.SWIVEL_LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'claude-cli')).toLowerCase();
  if (kind === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      fail('ANTHROPIC_API_KEY is not set. Either export it, or use --llm claude-cli to route through a locally signed-in Claude Code CLI.');
    }
    return new AnthropicProvider();
  }
  if (kind === 'claude-cli') return new ClaudeCliProvider();
  if (kind === 'mock') return new MockProvider([]);
  return fail(`Unknown --llm "${kind}". Use anthropic | claude-cli | mock.`);
}

const parseKv = (pairs: string[] | undefined): Record<string, string> =>
  Object.fromEntries((pairs ?? []).map((p) => {
    const i = p.indexOf('=');
    if (i < 0) fail(`Expected key=value, got "${p}"`);
    return [p.slice(0, i), p.slice(i + 1)];
  }));

function splitRef(ref: string): { id: string; version?: string } {
  const i = ref.lastIndexOf('@');
  return i > 0 ? { id: ref.slice(0, i), version: ref.slice(i + 1) } : { id: ref };
}

async function mustGet(store: SwivelStore, ref: string): Promise<Capability> {
  const { id, version } = splitRef(ref);
  const cap = await store.getCapability(id, version);
  if (!cap) fail(`No capability "${ref}" in the store. Run \`swivel list\`.`);
  return cap;
}

const chromiumPath = process.env.SWIVEL_CHROMIUM_PATH;

/**
 * Load committed capability and overlay documents into the store.
 *
 * Capabilities are version-controlled artifacts, not database rows — the whole
 * point of the format is that a bank's change-management process can review and
 * diff them. So the repository ships the recorded ones as files, and `init`
 * loads them. A reviewer can run the whole demonstration without an API key and
 * without waiting on a discovery run.
 */
async function cmdImport(argv: string[], store: SwivelStore): Promise<void> {
  const target = argv[0] ?? 'capabilities';
  const files: string[] = [];
  const stat = await import('node:fs/promises');
  const isDir = await stat.stat(target).then((s) => s.isDirectory()).catch(() => false);
  if (isDir) {
    for (const f of await stat.readdir(target)) if (f.endsWith('.json')) files.push(join(target, f));
  } else files.push(target);

  if (!files.length) { console.log(`  ${c.grey(`nothing to import from ${target}`)}`); return; }

  let caps = 0, overlays = 0;
  const problems: string[] = [];
  for (const f of files.sort()) {
    const doc = JSON.parse(await stat.readFile(f, 'utf8')) as { kind?: string };
    try {
      if (doc.kind === 'TenantOverlay') { await store.putOverlay(doc as never); overlays++; }
      else { await store.putCapability(doc as never); caps++; }
    } catch (e) { problems.push(`${f}: ${(e as Error).message.split('\n')[0]}`); }
  }
  console.log(kv([
    ['capabilities', String(caps)],
    ['overlays', String(overlays)],
    ...(problems.length ? [['skipped', problems.join('; ')] as [string, string]] : []),
  ]));
}

// ── init ─────────────────────────────────────────────────────────────────────

async function cmdInit(store: SwivelStore): Promise<void> {
  console.log(banner('init', 'Creating local configuration and seeding the console'));
  await writeDefaultConfig();
  const seed = [
    { id: 'shivam', name: 'Shivam Gupta', email: 'shivam@swivel.local', role: 'admin' as const, roles: ['capability.author', 'capability.approve', 'capability.invoke', 'capability.invoke.financial', 'operator.takeover', 'evidence.read'], password: 'swivel' },
    { id: 'reviewer', name: 'K. Brannigan', email: 'reviewer@swivel.local', role: 'reviewer' as const, roles: ['capability.approve', 'capability.invoke', 'evidence.read'], password: 'swivel' },
    { id: 'operator', name: 'R. Solis', email: 'operator@swivel.local', role: 'operator' as const, roles: ['operator.takeover', 'evidence.read'], password: 'swivel' },
  ];
  for (const u of seed) {
    const { hash, salt } = hashPassword(u.password);
    await store.putUser({ id: u.id, name: u.name, email: u.email, role: u.role, roles: u.roles, passwordHash: hash, salt, createdAt: new Date().toISOString() });
  }
  // Load whatever capabilities the repository ships, so the demonstration works
  // immediately on a fresh clone.
  await cmdImport(['capabilities'], store).catch(() => undefined);
  console.log(kv([
    ['config', CONFIG_PATH],
    ['store', store.dir],
    ['users', seed.map((s) => `${s.id}/${s.password}`).join('  ')],
  ]));
  console.log(`\n  ${c.green(SYMBOL.ok)} Ready. Start the simulated core with ${c.cyan('npm run meridian')}, then run ${c.cyan('npm run demo')}.\n`);
}

// ── discover ─────────────────────────────────────────────────────────────────

async function cmdDiscover(argv: string[], cfg: SwivelConfig, store: SwivelStore): Promise<void> {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: {
      goal: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' },
      tenant: { type: 'string' }, entry: { type: 'string' },
      param: { type: 'string', multiple: true },
      'param-spec': { type: 'string', multiple: true },
      llm: { type: 'string' }, 'max-turns': { type: 'string' },
      'allow-writes': { type: 'boolean' },
      headed: { type: 'boolean' }, quiet: { type: 'boolean' },
    },
  });

  if (!values.goal) fail('--goal is required, e.g. --goal "Look up member 0100482 and read the balance of their special savings account"');
  const tenant = requireTenant(cfg, values.tenant);
  const capabilityId = values.id ?? `cap-${Date.now().toString(36)}`;

  // Parameters are declared by the person recording, not inferred by the model.
  // They know what the capability's interface should be; the model does not.
  const paramValues = parseKv(values.param);
  const specs = parseKv(values['param-spec']);
  // Format: --param-spec "name=type|description|sensitivity|pattern"
  const parameters: DiscoveryParameter[] = Object.entries(paramValues).map(([name, value]) => {
    const [type = 'string', description = `${name} supplied by the calling agent`, sensitivity = 'internal', pattern] =
      (specs[name] ?? '').split('|');
    return {
      name, value, type: type as DiscoveryParameter['type'],
      description, required: true, example: value,
      sensitivity: sensitivity as DiscoveryParameter['sensitivity'],
      ...(pattern ? { pattern } : {}),
    };
  });

  const llm = llmFromFlag(values.llm);
  const origin = new URL(tenant.baseUrl).origin;

  console.log(banner('discover', `${tenant.institution} · ${cfg.productProfile}`));
  console.log(kv([
    ['goal', values.goal],
    ['tenant', `${tenant.id} (${tenant.baseUrl})`],
    ['model', `${llm.name}/${llm.model}`],
    ['parameters', parameters.map((p) => `${p.name}=${p.value}`).join(', ') || '(none)'],
    ['writes', values['allow-writes'] ? c.yellow('permitted — this run may change records') : c.green('blocked — read-only discovery')],
  ]));
  console.log(rule('run'));

  const runner = new Runner({
    store, headless: !values.headed,
    ...(chromiumPath ? { chromiumPath } : {}),
    onEvent: values.quiet ? undefined : (e) => console.log(event(e.kind, e.message)),
  });

  const result = await runner.runDiscovery({
    goal: values.goal,
    capabilityId,
    title: values.title ?? values.goal.slice(0, 70),
    productProfileId: cfg.productProfile,
    tenant: {
      id: tenant.id, institution: tenant.institution, baseUrl: tenant.baseUrl,
      ...(tenant.productVersion ? { productVersion: tenant.productVersion } : {}),
      ...(tenant.vocabulary ? { vocabulary: tenant.vocabulary } : {}),
    },
    entryUrl: values.entry ?? `${tenant.baseUrl}/main`,
    parameters,
    policy: {
      allowedOrigins: [origin],
      allowedPathPatterns: ['^/(content|nav|main|signon|compliance-ack)'],
      allowedActions: ['navigate', 'click', 'fill', 'select', 'press', 'wait_for', 'extract', 'assert', 'dismiss_if_present'],
    },
    maxTurns: values['max-turns'] ? Number(values['max-turns']) : 22,
    ...(values['allow-writes'] ? { confirmationToken: `discovery-${Date.now()}` } : {}),
    owner: 'shivam',
  }, llm);

  console.log(rule('result'));
  console.log(kv([
    ['status', result.status === 'success' ? c.green(result.status) : c.yellow(result.status)],
    ['message', result.message],
    ['model turns', result.turns],
    ['tokens', `${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.cacheReadTokens} cached`],
    ['discovery cost', money(result.costUsd)],
    ['evidence', result.evidenceDir],
  ]));

  if (result.capability) {
    const cap = result.capability;
    const path = join('artifacts', `${cap.metadata.id}@${cap.metadata.version}.json`);
    await mkdir('artifacts', { recursive: true });
    await writeFile(path, `${JSON.stringify(cap, null, 2)}\n`, 'utf8');

    console.log(rule('capability'));
    console.log(kv([
      ['id', `${cap.metadata.id}@${cap.metadata.version}`],
      ['title', cap.metadata.title],
      ['steps', cap.flow.steps.length],
      ['inputs', cap.contract.inputs.map((i) => `${i.name}:${i.type}`).join(', ') || '(none)'],
      ['outputs', cap.contract.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || '(none)'],
      ['effects', `${cap.contract.effects.mutating ? 'mutating' : 'read-only'} · risk=${cap.contract.effects.riskClass}`],
      ['content hash', cap.contentHash?.slice(0, 16)],
      ['saved to', path],
    ]));

    console.log(`\n  ${c.bold('Flow')}`);
    for (const [i, s] of cap.flow.steps.entries()) {
      const riskTag = s.risk && s.risk !== 'read_only' ? ` ${c.yellow(`[${s.risk}]`)}` : '';
      console.log(`   ${c.grey(String(i + 1).padStart(2))}. ${s.intent}${riskTag}`);
      if (s.target) console.log(`       ${c.grey(`${s.target.role} · ${s.target.note ?? ''}`)}`);
      if (s.expect) console.log(`       ${c.grey(`checkpoint: ${s.expect.description}`)}`);
    }

    if (result.findings.length) {
      console.log(`\n  ${c.bold('Validation')}`);
      console.log(formatFindings(result.findings));
    }
    console.log(`\n  ${c.green(SYMBOL.ok)} Replay it: ${c.cyan(`npx swivel replay ${cap.metadata.id} --tenant ${tenant.id} ${cap.contract.inputs.map((i) => `--input ${i.name}=${i.example ?? '…'}`).join(' ')}`)}\n`);
  } else {
    process.exitCode = 1;
  }
}

// ── replay ───────────────────────────────────────────────────────────────────

async function cmdReplay(argv: string[], cfg: SwivelConfig, store: SwivelStore): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      tenant: { type: 'string' }, input: { type: 'string', multiple: true },
      unattended: { type: 'boolean' }, confirm: { type: 'string' },
      inject: { type: 'string', multiple: true },
      as: { type: 'string' }, headed: { type: 'boolean' }, quiet: { type: 'boolean' },
      json: { type: 'boolean' }, 'no-escalate': { type: 'boolean' },
      'console-url': { type: 'string' },
    },
  });
  const ref = positionals[0];
  if (!ref) fail('Usage: swivel replay <capability-id>[@version] --tenant <id> --input key=value');

  const cap = await mustGet(store, ref);
  const tenant = requireTenant(cfg, values.tenant);
  const overlay = await store.getOverlay(tenant.id, cap.metadata.id);
  const inputs = parseKv(values.input);

  // Scenario injection: the simulator exposes a control surface so every
  // exceptional state is reproducible on demand rather than hoped for.
  if (values.inject?.length) await injectScenarios(tenant.baseUrl, values.inject);

  if (!values.json) {
    console.log(banner('replay', `${cap.metadata.title}`));
    console.log(kv([
      ['capability', `${cap.metadata.id}@${cap.metadata.version} ${statusChip(cap.quality.approvalState)}`],
      ['tenant', `${tenant.institution} (${tenant.id})${overlay ? c.cyan(`  + overlay ${overlay.metadata.id}`) : ''}`],
      ['inputs', JSON.stringify(inputs)],
      ['mode', values.unattended ? 'unattended (agent-invoked)' : 'attended'],
      ['injected', values.inject?.join(', ') ?? '(none)'],
      ['model calls', c.green('0 — replay never consults a model')],
    ]));
    console.log(rule('run'));
  }

  // Escalation needs somewhere for a human to look. If a console is running,
  // route tickets there; otherwise say so plainly rather than pretending the
  // path exists and hanging when a run gets stuck.
  const consoleUrl = values['console-url'] ?? `http://127.0.0.1:${cfg.console.port}`;
  const bridge = values['no-escalate'] || !(await ConsoleEscalationBridge.isReachable(consoleUrl))
    ? null
    : new ConsoleEscalationBridge({ consoleUrl, onNotice: (m) => console.log(m) });
  if (!bridge && !values['no-escalate'] && !values.json) {
    console.log(`  ${c.grey(`(no console at ${consoleUrl} — a stuck run will fail instead of asking for a human. Start one with \`npm run console\`.)`)}`);
  }

  const runner = new Runner({
    store, headless: !values.headed,
    ...(chromiumPath ? { chromiumPath } : {}),
    onEvent: values.quiet || values.json ? undefined : (e) => console.log(event(e.kind, e.message)),
    ...(bridge ? { escalation: { broker: bridge.broker } } : {}),
  });

  const result = await runner.runReplay({
    capability: cap,
    overlay,
    tenant: {
      id: tenant.id, institution: tenant.institution, baseUrl: tenant.baseUrl,
      ...(tenant.productVersion ? { productVersion: tenant.productVersion } : {}),
      ...(tenant.vocabulary ? { vocabulary: tenant.vocabulary } : {}),
    },
    inputs,
    principal: {
      id: values.as ?? 'cli',
      kind: values.unattended ? 'agent' : 'human',
      roles: ['capability.invoke', 'capability.invoke.financial'],
    },
    unattended: Boolean(values.unattended),
    ...(values.confirm ? { confirmationToken: values.confirm } : {}),
  });

  if (values.json) { console.log(JSON.stringify(result, null, 2)); }
  else {
    console.log(rule('result'));
    console.log(`  ${statusChip(result.status)}  ${c.grey(`${result.durationMs}ms · ${result.steps.length} steps · quality ${result.runQuality}/100`)}\n`);
    console.log(formatResult(result).split('\n').slice(1).map((l) => `  ${l}`).join('\n'));
    if (result.recoveries.length) {
      console.log(`\n  ${c.magenta('Recovered from:')}`);
      for (const r of result.recoveries) console.log(`    ${SYMBOL.bullet} ${r.signalTitle} — ${r.strategy}, ${r.attempts} attempt(s), at step "${r.atStepId}"`);
    }
    console.log(`\n  ${c.grey(`evidence: ${result.evidenceDir}`)}\n`);
  }
  if (result.status === 'failed') process.exitCode = 1;
}

async function injectScenarios(baseUrl: string, names: string[]): Promise<void> {
  const MAP: Record<string, Record<string, unknown>> = {
    'session-expiry': { forceSessionExpiry: true },
    'session-expiry-midflow': { sessionExpiresAfterRequests: 3 },
    'transient-error': { transientFailuresRemaining: 2 },
    'eod-lockout': { eodLockout: true },
    'permission-denied': { forcePermissionDenied: true },
    'record-locked': { forceRecordLocked: true },
    'compliance-notice': { alwaysShowComplianceInterstitial: true },
    'slow': { latencyMs: 1200 },
    reset: {},
  };
  await fetch(`${baseUrl}/__sim/reset`, { method: 'POST' }).catch(() => undefined);
  for (const n of names) {
    const patch = MAP[n];
    if (!patch) fail(`Unknown --inject "${n}". Available: ${Object.keys(MAP).join(', ')}`);
    if (n === 'reset') continue;
    await fetch(`${baseUrl}/__sim/scenario`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    }).catch(() => fail(`Could not reach the Meridian simulator at ${baseUrl}. Is \`npm run meridian\` running?`));
  }
}

// ── stability ────────────────────────────────────────────────────────────────

async function cmdStability(argv: string[], cfg: SwivelConfig, store: SwivelStore): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { tenant: { type: 'string' }, input: { type: 'string', multiple: true }, runs: { type: 'string' } },
  });
  const ref = positionals[0];
  if (!ref) fail('Usage: swivel stability <capability-id> --input key=value --runs 5');
  const cap = await mustGet(store, ref);
  const tenant = requireTenant(cfg, values.tenant);
  const overlay = await store.getOverlay(tenant.id, cap.metadata.id);
  const inputs = parseKv(values.input);
  const n = Number(values.runs ?? 5);

  console.log(banner('stability', `${cap.metadata.title} · ${n} consecutive replays`));
  const runner = new Runner({ store, headless: true, ...(chromiumPath ? { chromiumPath } : {}) });
  const rows: string[][] = [];
  const statuses: string[] = [];
  let totalMs = 0;

  for (let i = 1; i <= n; i++) {
    const r = await runner.runReplay({
      capability: cap, overlay,
      tenant: { id: tenant.id, institution: tenant.institution, baseUrl: tenant.baseUrl, ...(tenant.vocabulary ? { vocabulary: tenant.vocabulary } : {}) },
      inputs,
      principal: { id: 'stability', kind: 'system', roles: ['capability.invoke'] },
      unattended: false,
    });
    statuses.push(r.status);
    totalMs += r.durationMs;
    const outputs = r.status === 'success' || r.status === 'business_outcome' ? JSON.stringify(r.outputs) : '—';
    rows.push([String(i), statusChip(r.status), `${r.durationMs}ms`, String(r.runQuality), outputs.slice(0, 52)]);
    process.stdout.write(`  ${c.grey(`run ${i}/${n}`)} ${statusChip(r.status)} ${c.grey(`${r.durationMs}ms`)}\n`);
  }
  // Printed once, after every run, so the columns line up and the comparison
  // between runs is the thing you actually see.
  console.log('');
  console.log(table(['#', 'status', 'time', 'quality', 'outputs'], rows));

  const distinct = new Set(statuses);
  const outcomesIdentical = distinct.size === 1;
  console.log(rule('verdict'));
  console.log(kv([
    ['runs', n],
    ['distinct outcomes', `${distinct.size} (${[...distinct].join(', ')})`],
    ['deterministic', outcomesIdentical ? c.green('yes — every run produced the same outcome') : c.red('NO — outcomes diverged across identical inputs')],
    ['mean duration', `${Math.round(totalMs / n)}ms`],
    ['flakiness', outcomesIdentical ? c.green('0%') : c.red(`${Math.round(((distinct.size - 1) / n) * 100)}%`)],
  ]));
  console.log('');
}

// ── catalogue and governance ─────────────────────────────────────────────────

async function cmdList(store: SwivelStore): Promise<void> {
  const caps = await store.listCapabilities();
  console.log(banner('capabilities', `${caps.length} in the catalogue`));
  if (!caps.length) { console.log(`  ${c.grey('Nothing recorded yet. Run `swivel discover`.')}\n`); return; }
  console.log(table(
    ['id', 'version', 'state', 'risk', 'steps', 'replays', 'stability', 'title'],
    caps.map((x) => [
      c.cyan(x.metadata.id), x.metadata.version, statusChip(x.quality.approvalState),
      x.contract.effects.riskClass === 'read_only' ? c.green('read-only') : c.yellow(x.contract.effects.riskClass),
      String(x.flow.steps.length),
      `${x.quality.replays.success + x.quality.replays.businessOutcome}/${x.quality.replays.total}`,
      x.quality.replays.total ? `${x.quality.stabilityScore}` : c.grey('—'),
      x.metadata.title.slice(0, 40),
    ]),
  ));
  console.log('');
}

async function cmdShow(argv: string[], store: SwivelStore): Promise<void> {
  const ref = argv[0];
  if (!ref) fail('Usage: swivel show <capability-id>[@version]');
  const cap = await mustGet(store, ref);
  const findings = validateCapability(cap);

  console.log(banner(cap.metadata.title, `${cap.metadata.id}@${cap.metadata.version}`));
  console.log(kv([
    ['summary', cap.metadata.summary],
    ['product', `${cap.target.vendor} ${cap.target.product} ${cap.target.productVersions}`],
    ['state', statusChip(cap.quality.approvalState)],
    ['effects', `${cap.contract.effects.mutating ? 'MUTATING' : 'read-only'} · ${cap.contract.effects.reversible ? 'reversible' : c.red('IRREVERSIBLE')} · risk=${cap.contract.effects.riskClass}`],
    ['discovered', `${cap.provenance.discoveredAt} via ${cap.provenance.discoveredBy.provider ?? '—'}/${cap.provenance.discoveredBy.model ?? '—'}`],
    ['content hash', computeContentHash(cap)],
    ['replays', `${cap.quality.replays.total} total · ${cap.quality.replays.success} success · ${cap.quality.replays.businessOutcome} business · ${cap.quality.replays.failed} failed`],
  ]));

  console.log(`\n  ${c.bold('Contract')}`);
  console.log(`  ${c.grey('inputs')}`);
  for (const i of cap.contract.inputs) console.log(`    ${i.name}${i.required ? '*' : ''}: ${c.cyan(i.type)} ${c.grey(`— ${i.description}`)}${i.sensitivity && i.sensitivity !== 'internal' ? c.yellow(` [${i.sensitivity}]`) : ''}`);
  console.log(`  ${c.grey('outputs')}`);
  for (const o of cap.contract.outputs) console.log(`    ${o.name}: ${c.cyan(o.type)} ${c.grey(`— ${o.description}`)}`);
  console.log(`  ${c.grey('outcomes')}`);
  for (const o of cap.contract.outcomes) console.log(`    ${o.kind === 'business' ? c.blue(o.code) : c.red(o.code)}${o.retryable ? c.grey(' (retryable)') : ''} ${c.grey(`— ${o.description}`)}`);

  console.log(`\n  ${c.bold('Flow')}`);
  for (const [i, s] of cap.flow.steps.entries()) {
    console.log(`   ${c.grey(String(i + 1).padStart(2))}. ${s.intent}${s.risk && s.risk !== 'read_only' ? ` ${c.yellow(`[${s.risk}]`)}` : ''}`);
    if (s.target) console.log(`       ${c.grey(`${s.target.role} · ${s.target.note ?? ''}`)}`);
    if (s.expect) console.log(`       ${c.grey(`✓ ${s.expect.description}`)}`);
  }
  console.log(`\n  ${c.bold('Success condition')}\n    ${cap.flow.successCheckpoint.description}`);

  console.log(`\n  ${c.bold('Runtime signals')} ${c.grey(`(${cap.signals.length} watched after every step)`)}`);
  for (const s of cap.signals) {
    const tag = s.kind === 'business' ? c.blue(s.kind) : s.kind === 'recoverable' ? c.magenta(s.kind) : c.red(s.kind);
    console.log(`    ${tag.padEnd(22)} ${s.title}${s.outcomeCode ? c.grey(` → ${s.outcomeCode}`) : ''}${s.recovery ? c.grey(` → ${s.recovery.strategy} ×${s.recovery.maxAttempts}`) : ''}`);
  }

  console.log(`\n  ${c.bold('Validation')}`);
  console.log(findings.length ? formatFindings(findings) : `    ${c.green(SYMBOL.ok)} no findings`);
  console.log('');
}

async function cmdApprove(argv: string[], store: SwivelStore): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { as: { type: 'string' }, note: { type: 'string' }, force: { type: 'boolean' } },
  });
  const ref = positionals[0];
  if (!ref) fail('Usage: swivel approve <capability-id>@<version> --as <reviewer>');
  const { id, version } = splitRef(ref);
  if (!version) fail('Approval must name an exact version — approving "latest" approves something you have not read.');

  const cap = await mustGet(store, ref);
  const findings = validateCapability(cap);
  if (hasErrors(findings) && !values.force) {
    console.log(formatFindings(findings));
    fail('Refusing to approve a capability with validation errors. Fix them, or pass --force and own it.');
  }
  const approver = values.as ?? 'reviewer';
  if (cap.quality.replays.total === 0 && !values.force) {
    fail('Refusing to approve a capability that has never been replayed. Run it at least once first.');
  }

  const approvedHash = computeContentHash(cap);
  const updated = await store.updateQuality(id, version, cap.contentHash, (q) => ({
    ...q, approvalState: 'approved', approvedBy: approver, approvedAt: new Date().toISOString(),
    // Pin what was approved. Any later edit to the steps, targets or policy
    // changes this hash and the policy engine refuses to run it unattended.
    approvedContentHash: approvedHash,
    notes: values.note ? [...q.notes, values.note] : q.notes,
  }), { actor: approver, action: 'approved', ...(values.note ? { note: values.note } : {}) });

  console.log(banner('approve', `${id}@${version}`));
  console.log(kv([
    ['state', statusChip(updated.quality.approvalState)],
    ['approved by', approver],
    ['content hash', updated.contentHash?.slice(0, 16)],
    ['effect', 'AI agents may now invoke this capability unattended'],
  ]));
  console.log(`\n  ${c.grey('Approval is pinned to this content hash. Edit the steps, targets or policy and unattended')}`);
  console.log(`  ${c.grey('invocation is refused with APPROVAL_STALE until a reviewer signs off again.')}\n`);
}

// ── agent-facing catalogue ───────────────────────────────────────────────────

async function cmdCatalog(argv: string[], store: SwivelStore): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, all: { type: 'boolean' } } });
  const caps = await store.listCapabilities();
  const visible = values.all ? caps : caps.filter((x) => x.quality.approvalState === 'approved');
  const tools = visible.map(toToolDefinition);

  if (values.json) { console.log(JSON.stringify({ tools }, null, 2)); return; }
  console.log(banner('capability catalogue', `${tools.length} callable by an AI agent${values.all ? '' : ' (approved only)'}`));
  for (const t of tools) {
    console.log(`\n  ${c.bold(c.cyan(t.name))}\n  ${c.grey(t.description.split('\n')[0] ?? '')}`);
    console.log(`    ${c.grey('args  ')} ${Object.keys((t.inputSchema.properties ?? {}) as object).join(', ') || '(none)'}`);
    console.log(`    ${c.grey('returns')} ${Object.keys(((t.outputSchema ?? {}).properties ?? {}) as object).join(', ') || '(none)'}`);
  }
  console.log(`\n  ${c.grey('Serve these over MCP with `swivel serve`.')}\n`);
}

/** A capability compiles directly into a tool definition — that is the point of the contract. */
export function toToolDefinition(cap: Capability): {
  name: string; description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  outputSchema?: { type: 'object'; properties: Record<string, unknown> };
} {
  const jsonType = (t: string) => (t === 'money' || t === 'number' ? 'number' : t === 'integer' ? 'integer' : t === 'boolean' ? 'boolean' : 'string');
  const props = Object.fromEntries(cap.contract.inputs.map((i) => [i.name, {
    type: jsonType(i.type), description: i.description,
    ...(i.pattern ? { pattern: i.pattern } : {}), ...(i.enumValues ? { enum: i.enumValues } : {}),
  }]));
  const outs = Object.fromEntries(cap.contract.outputs.map((o) => [o.name, { type: jsonType(o.type), description: o.description }]));
  const outcomes = cap.contract.outcomes.map((o) => `  ${o.code}${o.retryable ? ' (retryable)' : ''}: ${o.description}`).join('\n');

  return {
    name: cap.metadata.id.replace(/-/g, '_'),
    description:
      `${cap.metadata.summary}\n\n` +
      `Effects: ${cap.contract.effects.mutating ? 'CHANGES RECORDS' : 'read-only'}` +
      `${cap.contract.effects.reversible ? '' : ', IRREVERSIBLE'}` +
      `${cap.contract.effects.financialImpact ? ', has financial impact' : ''}.\n` +
      `${cap.contract.effects.summary ?? ''}\n\n` +
      `Besides success, this may return one of these business outcomes, which are answers rather than errors:\n${outcomes}`,
    inputSchema: {
      type: 'object', properties: props,
      required: cap.contract.inputs.filter((i) => i.required).map((i) => i.name),
      additionalProperties: false,
    },
    ...(cap.contract.outputs.length ? { outputSchema: { type: 'object' as const, properties: outs } } : {}),
  };
}

// ── code generation ──────────────────────────────────────────────────────────

async function cmdCodegen(argv: string[], store: SwivelStore): Promise<void> {
  const ref = argv[0];
  if (!ref) fail('Usage: swivel codegen <capability-id>[@version]');
  const cap = await mustGet(store, ref);
  const { generatePlaywrightTest } = await import('./codegen.js');
  const code = generatePlaywrightTest(cap);
  const path = join('artifacts', `${cap.metadata.id}.spec.ts`);
  await mkdir('artifacts', { recursive: true });
  await writeFile(path, code, 'utf8');
  console.log(banner('codegen', `${cap.metadata.id}@${cap.metadata.version}`));
  console.log(kv([['written', path], ['framework', 'Playwright test'], ['note', 'Generated for review and for teams that want to own the code — the engine does not need it.']]));
  console.log('');
}

// ── overlays ─────────────────────────────────────────────────────────────────

async function cmdOverlay(argv: string[], cfg: SwivelConfig, store: SwivelStore): Promise<void> {
  const sub = argv[0];
  const { values, positionals } = parseArgs({
    args: argv.slice(1), allowPositionals: true,
    options: { tenant: { type: 'string' }, out: { type: 'string' } },
  });
  const ref = positionals[0];
  if (!sub || !ref) fail('Usage: swivel overlay <new|check> <capability-id> --tenant <id>');
  const cap = await mustGet(store, ref);
  const tenant = requireTenant(cfg, values.tenant);

  if (sub === 'new') {
    const overlay: TenantOverlay = {
      apiVersion: 'swivel.dev/cap-1', kind: 'TenantOverlay',
      metadata: {
        id: `${cap.metadata.id}--${tenant.id}`, tenantId: tenant.id, institution: tenant.institution,
        createdAt: new Date().toISOString(), capabilityId: cap.metadata.id, capabilityVersions: '*',
        notes: ['Scaffolded by `swivel overlay new`. Add only what genuinely differs at this institution.'],
      },
      tenant: { baseUrl: tenant.baseUrl, ...(tenant.productVersion ? { productVersion: tenant.productVersion } : {}) },
      vocabulary: tenant.vocabulary ?? {},
      targetOverrides: {}, extraSignals: [], stepPatches: [],
    };
    await store.putOverlay(overlay);
    const path = values.out ?? join('artifacts', `${overlay.metadata.id}.overlay.json`);
    await mkdir('artifacts', { recursive: true });
    await writeFile(path, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
    console.log(banner('overlay', `${cap.metadata.id} → ${tenant.institution}`));
    console.log(kv([['overlay', overlay.metadata.id], ['vocabulary', JSON.stringify(overlay.vocabulary)], ['saved', path]]));
    console.log(`\n  ${c.grey('Replay against the new tenant to see whether anything else needs overriding:')}\n  ${c.cyan(`npx swivel replay ${cap.metadata.id} --tenant ${tenant.id} --input …`)}\n`);
    return;
  }

  if (sub === 'check') {
    const overlay = await store.getOverlay(tenant.id, cap.metadata.id);
    if (!overlay) fail(`No overlay for ${cap.metadata.id} at tenant ${tenant.id}.`);
    const findings = validateOverlay(overlay, cap);
    const merged = resolveCapability(cap, overlay);
    console.log(banner('overlay check', `${overlay.metadata.id}`));
    console.log(kv([
      ['base', `${cap.metadata.id}@${cap.metadata.version}`],
      ['patches', String(overlay.stepPatches.length)],
      ['target overrides', String(Object.keys(overlay.targetOverrides).length)],
      ['extra signals', String(overlay.extraSignals.length)],
      ['vocabulary', JSON.stringify(overlay.vocabulary)],
      ['resolved steps', String(merged.flow.steps.length)],
    ]));
    console.log(`\n  ${c.bold('Validation')}`);
    console.log(findings.length ? formatFindings(findings) : `    ${c.green(SYMBOL.ok)} no findings`);
    console.log('');
    return;
  }
  fail(`Unknown overlay subcommand "${sub}".`);
}

// ── evidence ─────────────────────────────────────────────────────────────────

async function cmdVerify(argv: string[], store: SwivelStore): Promise<void> {
  const ref = argv[0];
  if (!ref) fail('Usage: swivel verify <runId|evidence-dir>');
  const run = await store.getRun(ref);
  const dir = run?.evidenceDir ?? ref;
  const r = await verifyChain(dir);
  console.log(banner('verify evidence', dir));
  console.log(kv([
    ['events', String(r.events)],
    ['chain', r.ok ? c.green(`${SYMBOL.ok} intact`) : c.red(`${SYMBOL.fail} broken at event ${r.brokenAt}`)],
    ['detail', r.message],
  ]));
  console.log(`\n  ${c.grey('Each event carries the digest of its predecessor, so removing or editing one is detectable.')}\n`);
  if (!r.ok) process.exitCode = 1;
}

async function cmdRuns(store: SwivelStore): Promise<void> {
  const runs = await store.listRuns(25);
  console.log(banner('runs', `${runs.length} most recent`));
  if (!runs.length) { console.log(`  ${c.grey('No runs yet.')}\n`); return; }
  console.log(table(
    ['run', 'kind', 'capability', 'tenant', 'status', 'time', 'summary'],
    runs.map((r) => [
      c.grey(r.runId), r.kind, r.capabilityId ?? '—', r.tenantId ?? '—',
      statusChip(r.status), r.durationMs ? `${r.durationMs}ms` : '—',
      (r.summary ?? '').slice(0, 46),
    ]),
  ));
  console.log('');
}

// ── services ─────────────────────────────────────────────────────────────────

async function cmdServe(): Promise<void> {
  const { startConsole } = await import('@swivel/console');
  await startConsole();
}

async function cmdMeridian(): Promise<void> {
  const { TENANTS, startMeridian } = await import('@swivel/meridian');
  console.log(banner('MERIDIAN Core', 'simulated legacy core banking system — all data is synthetic'));
  await Promise.all(Object.keys(TENANTS).map((t) => startMeridian(t)));
  console.log(`\n${kv([
    ['operators', 'msr01/meridian · tlr07/meridian (teller) · sup02/meridian (supervisor)'],
    ['scenarios', 'POST /__sim/scenario   — inject session expiry, EOD lockout, 503s, locks'],
  ])}\n`);
}

void (async () => {
  try { await main(); }
  catch (e) { fail((e as Error).stack ?? (e as Error).message); }
})();

export { stabilityScore, getProductProfile, estimateCostUsd };
