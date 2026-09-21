/**
 * Two tenants running the SAME vendor product at different versions.
 *
 * This is the crux of the multi-tenant problem in the brief: hundreds of
 * institutions run the same core, branded and configured differently. The
 * differences below are deliberately chosen to break the locator strategies
 * people reach for first:
 *
 *  - different accessible names for the same control  ("Member #" vs "Customer ID")
 *    -> breaks getByLabel('Member #')
 *  - an extra column inserted in the middle of the results grid
 *    -> breaks nth-child / column-index locators
 *  - different generated control ids (ctl00_Main_... vs ctl00_cphMain_...)
 *    -> breaks recorded #id selectors
 *  - an extra mandatory interstitial after login
 *    -> breaks "navigate then assume you're on the home screen"
 *  - different page chrome, colors and title
 *
 * A capability recorded against Pine Ridge should replay against Harbor Point
 * with a small, reviewable overlay -- not a re-recording.
 */

export interface TenantConfig {
  id: string;
  institution: string;
  productVersion: string;
  port: number;
  /** Vocabulary map: the same concept, different words per tenant. */
  vocab: {
    member: string;         // "Member" | "Customer"
    memberNumber: string;   // "Member #" | "Customer ID"
    share: string;          // "Share" | "Deposit Account"
    shareList: string;      // "Share Accounts" | "Deposit Accounts"
  };
  theme: { bg: string; bar: string; barText: string; accent: string; logoMark: string };
  /** ASP.NET-style control-id prefix. Differs by product version. */
  ctlPrefix: string;
  /** 10.1 forces a compliance acknowledgement screen after login. */
  requiresComplianceAck: boolean;
  /** 10.1 shows a Segment column in search results, inserted before Name. */
  showsSegmentColumn: boolean;
}

export const TENANTS: Record<string, TenantConfig> = {
  pineridge: {
    id: 'pineridge',
    institution: 'Pine Ridge Federal Credit Union',
    productVersion: 'MERIDIAN Core 9.2.14',
    port: Number(process.env.MERIDIAN_PINERIDGE_PORT ?? 4711),
    vocab: { member: 'Member', memberNumber: 'Member #', share: 'Share', shareList: 'Share Accounts' },
    theme: { bg: '#d4d0c8', bar: '#123a63', barText: '#ffffff', accent: '#1f5c9e', logoMark: 'PR' },
    ctlPrefix: 'ctl00_Main',
    requiresComplianceAck: false,
    showsSegmentColumn: false,
  },
  harborpoint: {
    id: 'harborpoint',
    institution: 'Harbor Point Savings Bank',
    productVersion: 'MERIDIAN Core 10.1.3',
    port: Number(process.env.MERIDIAN_HARBORPOINT_PORT ?? 4712),
    vocab: { member: 'Customer', memberNumber: 'Customer ID', share: 'Deposit Account', shareList: 'Deposit Accounts' },
    theme: { bg: '#e8e6e1', bar: '#0f4c3a', barText: '#ffffff', accent: '#11694f', logoMark: 'HP' },
    ctlPrefix: 'ctl00_cphMain',
    requiresComplianceAck: true,
    showsSegmentColumn: true,
  },
};

export const USERS: Record<string, { password: string; displayName: string; role: 'TELLER' | 'MSR' | 'SUPERVISOR'; branch: string }> = {
  // Demo credentials only. These are fake users in a simulator; there is nothing
  // to protect here, and the README tells reviewers exactly what they are.
  msr01:  { password: 'meridian', displayName: 'A. NGUYEN',  role: 'MSR',        branch: '001 - MAIN OFFICE' },
  tlr07:  { password: 'meridian', displayName: 'R. SOLIS',   role: 'TELLER',     branch: '003 - CEDAR HOLLOW' },
  sup02:  { password: 'meridian', displayName: 'K. BRANNIGAN', role: 'SUPERVISOR', branch: '001 - MAIN OFFICE' },
};
