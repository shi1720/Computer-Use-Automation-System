/**
 * Persistence.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * A directory of JSON files, written atomically, with no database process to
 * install. That is a deliberate choice for a project a reviewer should be able
 * to clone and run in a minute — and it is not as naive as it looks: the access
 * pattern here is "a few thousand small, immutable, version-addressed documents
 * plus an append-only run log", which is exactly the shape a filesystem is good
 * at. The interface is narrow enough that swapping in Postgres is a day's work,
 * and the one place it would matter first — concurrent approval writes — is
 * already guarded by a compare-and-set on the content hash.
 *
 * Capabilities are stored per version and never mutated in place. Approving,
 * deprecating or recording a replay writes a new revision of the *quality*
 * block only; the normative content hash is what identifies behaviour, and it
 * does not change when statistics do.
 */
import { mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { CapabilitySchema, TenantOverlaySchema, type Capability, type TenantOverlay } from '../artifact/schema.js';
import { computeContentHash } from '../artifact/hash.js';

export interface StoredRun {
  runId: string;
  kind: 'discovery' | 'replay';
  capabilityId?: string;
  capabilityVersion?: string;
  tenantId?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  evidenceDir: string;
  summary?: string;
  outcomeCode?: string;
  runQuality?: number;
  costUsd?: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  /** Coarse roles; the policy engine consumes the fine-grained list. */
  role: 'admin' | 'reviewer' | 'operator' | 'agent';
  roles: string[];
  passwordHash?: string;
  salt?: string;
  /** For machine principals invoking capabilities. */
  apiKeyHash?: string;
  createdAt: string;
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

export class SwivelStore {
  constructor(readonly dir: string = process.env.SWIVEL_DATA_DIR ?? '.swivel') {}

  private p(...parts: string[]): string { return join(this.dir, ...parts); }

  async init(): Promise<void> {
    for (const d of ['capabilities', 'overlays', 'runs', 'interventions', 'evidence']) {
      await mkdir(this.p(d), { recursive: true });
    }
  }

  // ── capabilities ──────────────────────────────────────────────────────────

  async putCapability(cap: Capability): Promise<Capability> {
    const withHash: Capability = { ...cap, contentHash: computeContentHash(cap) };
    CapabilitySchema.parse(withHash);
    await atomicWrite(this.p('capabilities', withHash.metadata.id, `${withHash.metadata.version}.json`), JSON.stringify(withHash, null, 2));
    return withHash;
  }

  async getCapability(id: string, version?: string): Promise<Capability | null> {
    if (version) return readJson<Capability>(this.p('capabilities', id, `${version}.json`));
    const versions = await this.listVersions(id);
    const latest = versions[versions.length - 1];
    return latest ? readJson<Capability>(this.p('capabilities', id, `${latest}.json`)) : null;
  }

  async listVersions(id: string): Promise<string[]> {
    try {
      const files = await readdir(this.p('capabilities', id));
      return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(compareSemver);
    } catch { return []; }
  }

  async listCapabilities(): Promise<Capability[]> {
    const out: Capability[] = [];
    let ids: string[] = [];
    try { ids = await readdir(this.p('capabilities')); } catch { return out; }
    for (const id of ids) {
      const c = await this.getCapability(id);
      if (c) out.push(c);
    }
    return out.sort((a, b) => a.metadata.title.localeCompare(b.metadata.title));
  }

  async deleteCapability(id: string): Promise<void> {
    await rm(this.p('capabilities', id), { recursive: true, force: true });
  }

  /**
   * Mutate the quality block only.
   *
   * Guarded by the content hash: if the capability's *behaviour* changed since
   * the caller read it, the update is refused. That is what stops an approval
   * from being applied to a different set of steps than the one the reviewer
   * actually read.
   */
  async updateQuality(
    id: string, version: string, expectedContentHash: string | undefined,
    mutate: (q: Capability['quality'], c: Capability) => Capability['quality'],
    historyEntry?: { actor: string; action: string; note?: string },
  ): Promise<Capability> {
    const cap = await this.getCapability(id, version);
    if (!cap) throw new Error(`No such capability ${id}@${version}`);
    const current = computeContentHash(cap);
    if (expectedContentHash && expectedContentHash !== current) {
      throw new Error(
        `Refusing to update ${id}@${version}: its behaviour changed since you read it ` +
        `(expected ${expectedContentHash.slice(0, 12)}, found ${current.slice(0, 12)}). Re-read and re-review.`);
    }
    const next: Capability = {
      ...cap,
      quality: mutate({ ...cap.quality }, cap),
      provenance: historyEntry
        ? { ...cap.provenance, history: [...cap.provenance.history, { at: new Date().toISOString(), ...historyEntry }] }
        : cap.provenance,
    };
    return this.putCapability(next);
  }

  // ── tenant overlays ───────────────────────────────────────────────────────

  async putOverlay(o: TenantOverlay): Promise<TenantOverlay> {
    TenantOverlaySchema.parse(o);
    await atomicWrite(this.p('overlays', o.metadata.tenantId, `${o.metadata.capabilityId}.json`), JSON.stringify(o, null, 2));
    return o;
  }

  async getOverlay(tenantId: string, capabilityId: string): Promise<TenantOverlay | null> {
    return readJson<TenantOverlay>(this.p('overlays', tenantId, `${capabilityId}.json`));
  }

  async listOverlays(tenantId?: string): Promise<TenantOverlay[]> {
    const out: TenantOverlay[] = [];
    let tenants: string[] = [];
    try { tenants = tenantId ? [tenantId] : await readdir(this.p('overlays')); } catch { return out; }
    for (const t of tenants) {
      let files: string[] = [];
      try { files = await readdir(this.p('overlays', t)); } catch { continue; }
      for (const f of files) {
        const o = await readJson<TenantOverlay>(this.p('overlays', t, f));
        if (o) out.push(o);
      }
    }
    return out;
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async putRun(r: StoredRun): Promise<void> {
    await atomicWrite(this.p('runs', `${r.runId}.json`), JSON.stringify(r, null, 2));
  }

  async listRuns(limit = 100): Promise<StoredRun[]> {
    let files: string[] = [];
    try { files = await readdir(this.p('runs')); } catch { return []; }
    const runs: StoredRun[] = [];
    for (const f of files) {
      const r = await readJson<StoredRun>(this.p('runs', f));
      if (r) runs.push(r);
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    return readJson<StoredRun>(this.p('runs', `${runId}.json`));
  }

  // ── users ─────────────────────────────────────────────────────────────────

  async listUsers(): Promise<User[]> {
    return (await readJson<User[]>(this.p('users.json'))) ?? [];
  }

  async putUser(u: User): Promise<void> {
    const users = await this.listUsers();
    const next = [...users.filter((x) => x.id !== u.id), u];
    await atomicWrite(this.p('users.json'), JSON.stringify(next, null, 2));
  }

  async findUser(idOrEmail: string): Promise<User | null> {
    const users = await this.listUsers();
    const k = idOrEmail.toLowerCase();
    return users.find((u) => u.id.toLowerCase() === k || u.email.toLowerCase() === k) ?? null;
  }

  get initialised(): boolean { return existsSync(this.p('capabilities')); }
}

// ── password handling ────────────────────────────────────────────────────────

/**
 * scrypt with a per-user salt and a constant-time comparison.
 *
 * Deliberately not a hand-rolled SHA of the password: the console holds the
 * keys to automation that can move money, and "it's only a demo" is how that
 * ends up in production.
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  return { hash: scryptSync(password, salt, 64).toString('hex'), salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return candidate.length === known.length && timingSafeEqual(candidate, known);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export { compareSemver };
