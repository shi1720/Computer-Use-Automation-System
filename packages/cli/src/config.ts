/**
 * Deployment configuration.
 *
 * Tenants are configuration, not code — that is the whole multi-tenant premise.
 * Adding an institution is a JSON entry plus, if its instance of the vendor
 * product differs, a small overlay. It is never a code change and never a
 * re-recording.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface TenantConfig {
  id: string;
  institution: string;
  baseUrl: string;
  productVersion?: string;
  /** Per-institution wording that overrides the product defaults. */
  vocabulary?: Record<string, string>;
  /** Credential names — never values. Resolved from the secret store at runtime. */
  credentials?: { operatorIdRef: string; passwordRef: string };
}

export interface SwivelConfig {
  productProfile: string;
  defaultTenant: string;
  tenants: Record<string, TenantConfig>;
  console: { port: number };
}

export const CONFIG_PATH = process.env.SWIVEL_CONFIG ?? 'swivel.config.json';

export const DEFAULT_CONFIG: SwivelConfig = {
  productProfile: 'meridian-core',
  defaultTenant: 'pineridge',
  console: { port: Number(process.env.SWIVEL_CONSOLE_PORT ?? 4700) },
  tenants: {
    pineridge: {
      id: 'pineridge',
      institution: 'Pine Ridge Federal Credit Union',
      baseUrl: `http://127.0.0.1:${process.env.MERIDIAN_PINERIDGE_PORT ?? 4711}`,
      productVersion: '9.2.14',
      credentials: { operatorIdRef: 'meridian_operator_id', passwordRef: 'meridian_password' },
    },
    harborpoint: {
      id: 'harborpoint',
      institution: 'Harbor Point Savings Bank',
      baseUrl: `http://127.0.0.1:${process.env.MERIDIAN_HARBORPOINT_PORT ?? 4712}`,
      productVersion: '10.1.3',
      // Same vendor product, different words for the same concepts. This map is
      // the entire reason one artifact serves both institutions.
      vocabulary: { member: 'Customer', memberNumber: 'Customer ID', share: 'Deposit Account', shareList: 'Deposit Accounts' },
      credentials: { operatorIdRef: 'meridian_operator_id', passwordRef: 'meridian_password' },
    },
  },
};

export async function loadConfig(): Promise<SwivelConfig> {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Partial<SwivelConfig>;
  return { ...DEFAULT_CONFIG, ...raw, tenants: { ...DEFAULT_CONFIG.tenants, ...(raw.tenants ?? {}) } };
}

export async function writeDefaultConfig(): Promise<void> {
  await writeFile(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
}

export function requireTenant(cfg: SwivelConfig, id: string | undefined): TenantConfig {
  const t = cfg.tenants[id ?? cfg.defaultTenant];
  if (!t) throw new Error(`Unknown tenant "${id}". Configured tenants: ${Object.keys(cfg.tenants).join(', ')}`);
  return t;
}
