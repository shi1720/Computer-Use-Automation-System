/**
 * Seed data for MERIDIAN Core.
 *
 * Everything here is synthetic. No real people, no real account numbers, no real
 * SSNs. The shapes (member number + 2-digit share suffix, share/draft/certificate
 * account types, Reg CC holds, NSF fees) mirror how US credit-union cores actually
 * model retail deposit relationships, because the point of this simulation is to
 * exercise automation against realistic *structure*, not realistic data.
 */

export type ShareType = 'REGULAR SHARE' | 'SPECIAL SAVINGS' | 'SHARE DRAFT' | 'MONEY MARKET' | 'CERTIFICATE' | 'CHRISTMAS CLUB';

export interface ShareAccount {
  /** Two-digit suffix, e.g. member 0100482 share 00 => "0100482-00". */
  suffix: string;
  type: ShareType;
  /** Ledger balance in cents. */
  balanceCents: number;
  /** Available balance in cents (ledger minus holds/pending). */
  availableCents: number;
  status: 'OPEN' | 'DORMANT' | 'FROZEN' | 'CLOSED';
  openedOn: string;
  dividendRate: string;
  holds: Array<{ id: string; amountCents: number; placedOn: string; releaseOn: string; reason: string }>;
}

export interface Transaction {
  id: string;
  postedOn: string;
  suffix: string;
  description: string;
  amountCents: number; // negative = debit
  code: string;
  /** Fee transactions can be reversed through the fee-reversal screen. */
  reversible: boolean;
  reversed?: boolean;
}

export interface Member {
  memberNumber: string;
  firstName: string;
  lastName: string;
  ssnLast4: string;
  dateOfBirth: string;
  memberSince: string;
  branch: string;
  /** Officer/relationship code, shown on the detail screen. */
  officer: string;
  status: 'ACTIVE' | 'RESTRICTED' | 'CLOSED' | 'DECEASED';
  /** Segment code — only *displayed* by the Meridian 10.1 tenant variant. */
  segment: string;
  address: { line1: string; line2: string; city: string; state: string; zip: string };
  phone: string;
  email: string;
  /** Members flagged here trigger the OFAC/compliance interstitial on detail view. */
  complianceFlag?: string;
  /** Members flagged here are locked by "another user" (optimistic locking demo). */
  lockedBy?: string;
  shares: ShareAccount[];
  transactions: Transaction[];
}

const d = (s: string) => s;

export const SEED_MEMBERS: Member[] = [
  {
    memberNumber: '0100482',
    firstName: 'Dolores',
    lastName: 'Whitfield',
    ssnLast4: '4417',
    dateOfBirth: d('1961-03-14'),
    memberSince: d('1994-06-02'),
    branch: '003 - CEDAR HOLLOW',
    officer: 'MSR-14',
    status: 'ACTIVE',
    segment: 'RETAIL-PREM',
    address: { line1: '2214 ORCHARD LANE', line2: 'APT 4B', city: 'PINE RIDGE', state: 'OR', zip: '97381' },
    phone: '(503) 555-0142',
    email: 'd.whitfield@example.invalid',
    shares: [
      { suffix: '00', type: 'REGULAR SHARE', balanceCents: 2547_11, availableCents: 2547_11, status: 'OPEN', openedOn: d('1994-06-02'), dividendRate: '0.050%', holds: [] },
      { suffix: '01', type: 'SPECIAL SAVINGS', balanceCents: 18_402_66, availableCents: 18_402_66, status: 'OPEN', openedOn: d('2003-11-19'), dividendRate: '0.850%', holds: [] },
      { suffix: '70', type: 'SHARE DRAFT', balanceCents: 1_184_23, availableCents: 934_23, status: 'OPEN', openedOn: d('1996-02-08'), dividendRate: '0.010%', holds: [{ id: 'H-99120', amountCents: 250_00, placedOn: d('2026-09-15'), releaseOn: d('2026-09-22'), reason: 'REG CC - LARGE DEPOSIT' }] },
      { suffix: '51', type: 'CERTIFICATE', balanceCents: 25_000_00, availableCents: 0, status: 'OPEN', openedOn: d('2025-01-30'), dividendRate: '4.150%', holds: [] },
    ],
    transactions: [
      { id: 'T-5500121', postedOn: d('2026-09-18'), suffix: '70', description: 'NSF FEE - ITEM RETURNED', amountCents: -32_00, code: 'FEE-NSF', reversible: true },
      { id: 'T-5500120', postedOn: d('2026-09-18'), suffix: '70', description: 'ACH DEBIT - PACIFIC POWER', amountCents: -211_48, code: 'ACH-D', reversible: false },
      { id: 'T-5500097', postedOn: d('2026-09-15'), suffix: '70', description: 'DEPOSIT - MOBILE', amountCents: 1_250_00, code: 'DEP-RDC', reversible: false },
      { id: 'T-5500044', postedOn: d('2026-09-01'), suffix: '01', description: 'DIVIDEND POSTING', amountCents: 12_94, code: 'DIV', reversible: false },
    ],
  },
  {
    memberNumber: '0100483',
    firstName: 'Marcus',
    lastName: 'Whitfield',
    ssnLast4: '8820',
    dateOfBirth: d('1989-07-30'),
    memberSince: d('2011-04-18'),
    branch: '003 - CEDAR HOLLOW',
    officer: 'MSR-14',
    status: 'ACTIVE',
    segment: 'RETAIL-STD',
    address: { line1: '2214 ORCHARD LANE', line2: 'APT 4B', city: 'PINE RIDGE', state: 'OR', zip: '97381' },
    phone: '(503) 555-0188',
    email: 'm.whitfield@example.invalid',
    shares: [
      { suffix: '00', type: 'REGULAR SHARE', balanceCents: 500_00, availableCents: 500_00, status: 'OPEN', openedOn: d('2011-04-18'), dividendRate: '0.050%', holds: [] },
      { suffix: '70', type: 'SHARE DRAFT', balanceCents: 47_19, availableCents: 47_19, status: 'OPEN', openedOn: d('2011-04-18'), dividendRate: '0.010%', holds: [] },
    ],
    transactions: [
      { id: 'T-5500130', postedOn: d('2026-09-19'), suffix: '70', description: 'COURTESY PAY FEE', amountCents: -29_00, code: 'FEE-CP', reversible: true },
    ],
  },
  {
    memberNumber: '0204915',
    firstName: 'Imani',
    lastName: 'Okafor',
    ssnLast4: '1173',
    dateOfBirth: d('1978-12-02'),
    memberSince: d('2006-09-25'),
    branch: '001 - MAIN OFFICE',
    officer: 'MSR-02',
    status: 'ACTIVE',
    segment: 'SMALL-BUS',
    address: { line1: '881 KESTREL WAY', line2: '', city: 'HARBOR POINT', state: 'OR', zip: '97402' },
    phone: '(503) 555-0110',
    email: 'i.okafor@example.invalid',
    shares: [
      { suffix: '00', type: 'REGULAR SHARE', balanceCents: 5_00, availableCents: 5_00, status: 'OPEN', openedOn: d('2006-09-25'), dividendRate: '0.050%', holds: [] },
      { suffix: '75', type: 'MONEY MARKET', balanceCents: 112_889_04, availableCents: 112_889_04, status: 'OPEN', openedOn: d('2019-03-11'), dividendRate: '2.400%', holds: [] },
      { suffix: '70', type: 'SHARE DRAFT', balanceCents: 9_431_72, availableCents: 9_431_72, status: 'OPEN', openedOn: d('2006-09-25'), dividendRate: '0.010%', holds: [] },
    ],
    transactions: [
      { id: 'T-5610012', postedOn: d('2026-09-17'), suffix: '70', description: 'WIRE FEE - OUTGOING DOMESTIC', amountCents: -25_00, code: 'FEE-WIRE', reversible: true },
    ],
  },
  {
    memberNumber: '0331207',
    firstName: 'Theodore',
    lastName: 'Ashby',
    ssnLast4: '6002',
    dateOfBirth: d('1954-05-21'),
    memberSince: d('1981-01-12'),
    branch: '002 - RIVERBEND',
    officer: 'MSR-09',
    status: 'RESTRICTED',
    segment: 'RETAIL-STD',
    address: { line1: '17 SOUTH FORK RD', line2: '', city: 'PINE RIDGE', state: 'OR', zip: '97381' },
    phone: '(503) 555-0166',
    email: 't.ashby@example.invalid',
    complianceFlag: 'OFAC POTENTIAL MATCH - REVIEW REQUIRED (CASE 2026-0881)',
    shares: [
      { suffix: '00', type: 'REGULAR SHARE', balanceCents: 1_015_44, availableCents: 0, status: 'FROZEN', openedOn: d('1981-01-12'), dividendRate: '0.050%', holds: [] },
    ],
    transactions: [],
  },
  {
    memberNumber: '0442980',
    firstName: 'Priya',
    lastName: 'Ramaswamy',
    ssnLast4: '3345',
    dateOfBirth: d('1992-08-08'),
    memberSince: d('2020-02-14'),
    branch: '001 - MAIN OFFICE',
    officer: 'MSR-02',
    status: 'ACTIVE',
    segment: 'RETAIL-PREM',
    address: { line1: '4402 LARKSPUR CT', line2: 'UNIT 12', city: 'HARBOR POINT', state: 'OR', zip: '97402' },
    phone: '(503) 555-0173',
    email: 'p.ramaswamy@example.invalid',
    lockedBy: 'JTORRES',
    shares: [
      { suffix: '00', type: 'REGULAR SHARE', balanceCents: 6_722_10, availableCents: 6_722_10, status: 'OPEN', openedOn: d('2020-02-14'), dividendRate: '0.050%', holds: [] },
    ],
    transactions: [],
  },
  {
    memberNumber: '0500001',
    firstName: 'Harold',
    lastName: 'Nakamura',
    ssnLast4: '9901',
    dateOfBirth: d('1947-10-03'),
    memberSince: d('1972-08-30'),
    branch: '002 - RIVERBEND',
    officer: 'MSR-09',
    status: 'DECEASED',
    segment: 'ESTATE',
    address: { line1: '90 BIRCHWOOD TER', line2: '', city: 'PINE RIDGE', state: 'OR', zip: '97381' },
    phone: '(503) 555-0199',
    email: '',
    shares: [
      { suffix: '00', type: 'REGULAR SHARE', balanceCents: 3_301_88, availableCents: 3_301_88, status: 'DORMANT', openedOn: d('1972-08-30'), dividendRate: '0.050%', holds: [] },
    ],
    transactions: [],
  },
];

export function cloneSeed(): Member[] {
  return JSON.parse(JSON.stringify(SEED_MEMBERS)) as Member[];
}

export function formatCents(cents: number): string {
  const neg = cents < 0;
  const v = Math.abs(cents);
  const s = (v / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `(${s})` : s;
}
