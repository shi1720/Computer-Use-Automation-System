/**
 * MERIDIAN Core markup.
 *
 * This is intentionally hostile, in the specific ways real legacy back-office
 * apps are hostile. Every ugly thing here is deliberate:
 *
 *  - HTML framesets (nav frame + content frame), so automation must reason
 *    about frame paths, not just a page.
 *  - Table-based layout, <font> tags, bgcolor attributes, spacer cells.
 *  - ASP.NET WebForms conventions: __VIEWSTATE, __EVENTVALIDATION,
 *    __doPostBack(), and generated control ids like ctl00_Main_txtMemberNo.
 *  - Almost no <label for=...>. Field captions are just text in the adjacent
 *    <td>. getByLabel() does not work here; a human reads "the box to the
 *    right of the words Member #", and so must the automation.
 *  - Zero data-testid attributes, because enterprise vendors do not ship them.
 *  - Row action links that are identical in text ("View") and distinguished
 *    only by their row.
 */
import type { TenantConfig } from './tenants.js';
import { formatCents, type Member } from './data.js';

/** The simulator's frozen business date. Legacy cores stamp it on every screen. */
export const BUSINESS_DATE = '09/21/2026';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Fake WebForms state blob, regenerated per render like the real thing. */
function viewState(seed: string): string {
  const b = Buffer.from(`/wEPDwUKLTE${seed}${'x'.repeat(48)}`).toString('base64');
  return `<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${esc(b)}" />
    <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="C2EE9ABB" />
    <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="${esc(b.slice(0, 40))}" />
    <input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
    <input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="" />`;
}

const POSTBACK_JS = `
function __doPostBack(eventTarget, eventArgument) {
  var f = document.forms[0];
  f.__EVENTTARGET.value = eventTarget;
  f.__EVENTARGUMENT.value = eventArgument;
  f.submit();
}`;

function baseCss(t: TenantConfig): string {
  return `
  body { background: ${t.theme.bg}; font-family: Tahoma, "MS Sans Serif", Geneva, sans-serif; font-size: 11px; margin: 0; padding: 0; color: #000; }
  table { border-collapse: collapse; }
  .ttlbar { background: ${t.theme.bar}; color: ${t.theme.barText}; font-weight: bold; font-size: 11px; padding: 3px 6px; }
  .grpbox { border: 2px inset #fff; background: ${t.theme.bg}; padding: 6px; }
  .fld { border: 1px inset #808080; background: #fff; font-family: Tahoma, sans-serif; font-size: 11px; padding: 1px 2px; }
  .btn { border: 2px outset #fff; background: ${t.theme.bg}; font-family: Tahoma, sans-serif; font-size: 11px; padding: 1px 10px; cursor: pointer; }
  .btn:active { border-style: inset; }
  .grid { border: 1px solid #808080; background: #fff; width: 100%; }
  .grid th { background: ${t.theme.accent}; color: #fff; font-size: 11px; padding: 3px 5px; text-align: left; border-right: 1px solid #fff; white-space: nowrap; }
  .grid td { padding: 2px 5px; border-bottom: 1px solid #d9d9d9; font-size: 11px; }
  .grid tr.alt td { background: #f0f4f8; }
  .cap { font-weight: bold; }
  .err { background: #ffe8e8; border: 1px solid #a00; color: #900; padding: 6px 8px; font-weight: bold; }
  .warn { background: #fffbe0; border: 1px solid #b8860b; color: #6b4e00; padding: 6px 8px; }
  .okbox { background: #e8f6ea; border: 1px solid #2c7a3f; color: #1c5b2b; padding: 6px 8px; font-weight: bold; }
  a { color: ${t.theme.accent}; }
  .stat { background: #b7b3ab; border-top: 1px solid #fff; padding: 2px 6px; font-size: 10px; color: #333; }
  `;
}

export interface ChromeOpts {
  tenant: TenantConfig;
  title: string;
  /** Screen code, the way real cores label screens (e.g. "INQ-0410"). */
  screenCode: string;
  user?: { displayName: string; role: string; branch: string } | null;
  body: string;
  /** Breadcrumb-ish path shown in the legacy title bar. */
  path?: string;
}

/** Content-frame chrome. Everything a screen renders goes through here. */
export function contentChrome(o: ChromeOpts): string {
  const t = o.tenant;
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<title>${esc(t.institution)} - ${esc(o.title)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<style type="text/css">${baseCss(t)}</style>
<script type="text/javascript">${POSTBACK_JS}</script>
</head>
<body>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="ttlbar">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td class="ttlbar" style="padding:0"><font face="Tahoma" size="1"><b>${esc(o.title.toUpperCase())}</b></font></td>
      <td class="ttlbar" align="right" style="padding:0"><font face="Tahoma" size="1">SCREEN ${esc(o.screenCode)}&nbsp;&nbsp;|&nbsp;&nbsp;${esc(t.productVersion)}</font></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:8px">
    ${o.body}
  </td></tr>
</table>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="stat"><font face="Tahoma" size="1">F3=Exit&nbsp; F5=Refresh&nbsp; F10=Accept&nbsp; F12=Cancel&nbsp; F24=More Keys</font></td></tr>
  <tr><td class="stat">
  <font face="Tahoma" size="1">${o.user ? `USER: ${esc(o.user.displayName)} (${esc(o.user.role)})&nbsp;&nbsp;BRANCH: ${esc(o.user.branch)}` : 'NOT SIGNED ON'}
  &nbsp;&nbsp;BUSINESS DATE: ${esc(BUSINESS_DATE)}&nbsp;&nbsp;TERM: WS0142&nbsp;&nbsp;|&nbsp;&nbsp;${esc(o.path ?? '')}</font>
</td></tr></table>
</body></html>`;
}

export function loginPage(t: TenantConfig, error?: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head><title>${esc(t.institution)} - MERIDIAN Core Sign On</title>
<style type="text/css">${baseCss(t)} body{padding:40px 0}</style></head>
<body>
<center>
<table width="520" cellpadding="0" cellspacing="0" border="0">
<tr><td class="ttlbar"><font face="Tahoma" size="2"><b>${esc(t.institution)}</b></font></td></tr>
<tr><td class="grpbox">
  <table width="100%" cellpadding="4" cellspacing="0" border="0">
    <tr><td colspan="2"><font face="Tahoma" size="1"><b>MERIDIAN Core Banking System</b> &nbsp; ${esc(t.productVersion)}</font></td></tr>
    <tr><td colspan="2"><hr size="1"></td></tr>
    ${error ? `<tr><td colspan="2"><div class="err" id="${t.ctlPrefix}_lblLoginError">${esc(error)}</div></td></tr>` : ''}
    <tr><td colspan="2">
      <form method="POST" action="signon" id="frmSignOn" name="frmSignOn">
      ${viewState('signon')}
      <table cellpadding="4" cellspacing="0" border="0">
        <tr>
          <td width="110" align="right"><font face="Tahoma" size="1"><b>Operator ID</b></font></td>
          <td><input type="text" name="${t.ctlPrefix}$txtOperatorId" id="${t.ctlPrefix}_txtOperatorId" class="fld" size="20" maxlength="12" autocomplete="off"></td>
        </tr>
        <tr>
          <td align="right"><font face="Tahoma" size="1"><b>Password</b></font></td>
          <td><input type="password" name="${t.ctlPrefix}$txtPassword" id="${t.ctlPrefix}_txtPassword" class="fld" size="20" autocomplete="off"></td>
        </tr>
        <tr>
          <td></td>
          <td><input type="submit" name="${t.ctlPrefix}$btnSignOn" id="${t.ctlPrefix}_btnSignOn" class="btn" value="Sign On">
              &nbsp;<input type="reset" class="btn" value="Clear"></td>
        </tr>
      </table>
      </form>
    </td></tr>
    <tr><td colspan="2"><hr size="1"><font face="Tahoma" size="1" color="#555">
      THIS SYSTEM IS FOR AUTHORIZED USE ONLY. ACTIVITY IS MONITORED AND RECORDED.<br>
      <i>Simulated environment. All data is synthetic.</i>
    </font></td></tr>
  </table>
</td></tr></table>
</center>
</body></html>`;
}

export function complianceAckPage(t: TenantConfig): string {
  return contentChrome({
    tenant: t, title: 'Compliance Acknowledgement', screenCode: 'SEC-0002', user: null, path: 'SECURITY > ACK',
    body: `
    <div class="warn" style="margin-bottom:10px">
      <font face="Tahoma" size="1"><b>ANNUAL COMPLIANCE ACKNOWLEDGEMENT REQUIRED</b><br>
      You must acknowledge the Acceptable Use and GLBA Safeguards policy before accessing ${esc(t.vocab.member.toLowerCase())} records.</font>
    </div>
    <form method="POST" action="compliance-ack" id="frmAck">
      ${viewState('ack')}
      <input type="submit" name="${t.ctlPrefix}$btnAcknowledge" id="${t.ctlPrefix}_btnAcknowledge" class="btn" value="I Acknowledge">
      &nbsp;<input type="button" class="btn" value="Print Policy" onclick="return false;">
    </form>`,
  });
}

export function framesetPage(t: TenantConfig): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html><head><title>${esc(t.institution)} - MERIDIAN Core</title></head>
<frameset cols="180,*" border="1" frameborder="1">
  <frame name="navFrame" src="nav" scrolling="auto" noresize>
  <frame name="contentFrame" src="content/home" scrolling="auto">
  <noframes><body>This application requires frame support.</body></noframes>
</frameset>
</html>`;
}

export function navFrame(t: TenantConfig, user: { displayName: string; role: string }): string {
  const item = (href: string, label: string) =>
    `<tr><td style="padding:3px 6px"><a href="${esc(href)}" target="contentFrame"><font face="Tahoma" size="1">${esc(label)}</font></a></td></tr>`;
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head><title>Navigation</title><style type="text/css">${baseCss(t)}</style></head>
<body>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="ttlbar"><font face="Tahoma" size="1"><b>${esc(t.theme.logoMark)} &nbsp;MAIN MENU</b></font></td></tr>
  ${item('content/home', 'Home')}
  <tr><td class="ttlbar" style="background:#666"><font face="Tahoma" size="1">INQUIRY</font></td></tr>
  ${item('content/member-search', `${t.vocab.member} Search`)}
  <tr><td class="ttlbar" style="background:#666"><font face="Tahoma" size="1">SERVICING</font></td></tr>
  ${item('content/member-search?mode=address', 'Address Maintenance')}
  ${item('content/member-search?mode=open-share', `Open ${t.vocab.share}`)}
  ${item('content/member-search?mode=stop-pay', 'Stop Payment')}
  ${item('content/member-search?mode=fee-reversal', 'Fee Reversal')}
  <tr><td class="ttlbar" style="background:#666"><font face="Tahoma" size="1">SESSION</font></td></tr>
  ${item('signoff', 'Sign Off')}
  <tr><td style="padding:8px 6px"><font face="Tahoma" size="1" color="#444">${esc(user.displayName)}<br>${esc(user.role)}</font></td></tr>
</table>
</body></html>`;
}

export function homeScreen(t: TenantConfig, user: any): string {
  return contentChrome({
    tenant: t, title: 'Home', screenCode: 'HOM-0001', user, path: 'HOME',
    body: `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <font face="Tahoma" size="2"><b>Welcome, ${esc(user.displayName)}</b></font><br><br>
      <font face="Tahoma" size="1">
        Select a function from the menu on the left.<br><br>
        <b>Institution:</b> ${esc(t.institution)}<br>
        <b>Core version:</b> ${esc(t.productVersion)}<br>
        <b>Business date:</b> ${esc(BUSINESS_DATE)}<br>
        <b>Your role:</b> ${esc(user.role)} &mdash; ${esc(user.branch)}
      </font>
    </td></tr></table>`,
  });
}

const MODE_TITLES: Record<string, string> = {
  inquiry: 'Search', address: 'Address Maintenance', 'open-share': 'Open Account', 'stop-pay': 'Stop Payment', 'fee-reversal': 'Fee Reversal',
};

export function memberSearchScreen(t: TenantConfig, user: any, mode: string, error?: string): string {
  const v = t.vocab;
  return contentChrome({
    tenant: t, title: `${v.member} ${MODE_TITLES[mode] ?? 'Search'}`, screenCode: 'INQ-0410', user,
    path: `INQUIRY > ${v.member.toUpperCase()} SEARCH`,
    body: `
    ${error ? `<div class="err" id="${t.ctlPrefix}_lblSearchError" style="margin-bottom:8px"><font face="Tahoma" size="1">${esc(error)}</font></div>` : ''}
    <form method="GET" action="member-results" id="frmSearch" name="frmSearch">
    <input type="hidden" name="mode" value="${esc(mode)}">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <table cellpadding="3" cellspacing="0" border="0">
        <tr>
          <td width="14"></td>
          <td width="120" align="right" nowrap><font face="Tahoma" size="1"><b>${esc(v.memberNumber)}</b></font></td>
          <td><input type="text" name="${t.ctlPrefix}$txtMemberNo" id="${t.ctlPrefix}_txtMemberNo" class="fld" size="14" maxlength="10"></td>
          <td width="20"></td>
          <td width="90" align="right" nowrap><font face="Tahoma" size="1"><b>Last Name</b></font></td>
          <td><input type="text" name="${t.ctlPrefix}$txtLastName" id="${t.ctlPrefix}_txtLastName" class="fld" size="20" maxlength="30"></td>
        </tr>
        <tr>
          <td></td>
          <td align="right" nowrap><font face="Tahoma" size="1"><b>SSN (Last 4)</b></font></td>
          <td><input type="text" name="${t.ctlPrefix}$txtSsn4" id="${t.ctlPrefix}_txtSsn4" class="fld" size="6" maxlength="4"></td>
          <td></td>
          <td align="right" nowrap><font face="Tahoma" size="1"><b>Branch</b></font></td>
          <td><select name="${t.ctlPrefix}$ddlBranch" id="${t.ctlPrefix}_ddlBranch" class="fld">
            <option value="">(All Branches)</option>
            <option value="001">001 - MAIN OFFICE</option>
            <option value="002">002 - RIVERBEND</option>
            <option value="003">003 - CEDAR HOLLOW</option>
          </select></td>
        </tr>
        <tr><td colspan="6"><hr size="1"></td></tr>
        <tr>
          <td colspan="2"></td>
          <td colspan="4">
            <input type="submit" name="${t.ctlPrefix}$btnSearch" id="${t.ctlPrefix}_btnSearch" class="btn" value="Search">
            &nbsp;<input type="reset" class="btn" value="Clear">
          </td>
        </tr>
      </table>
    </td></tr></table>
    </form>
    <br><font face="Tahoma" size="1" color="#555">Enter a ${esc(v.memberNumber.toLowerCase())} for an exact match, or a last name for a list. F3 = Exit &nbsp; F5 = Refresh</font>`,
  });
}

export function searchResultsScreen(t: TenantConfig, user: any, rows: Member[], query: string, mode: string): string {
  const v = t.vocab;
  const header = t.showsSegmentColumn
    ? `<th>${esc(v.memberNumber)}</th><th>Segment</th><th>Name</th><th>SSN</th><th>Branch</th><th>Status</th><th>Action</th>`
    : `<th>${esc(v.memberNumber)}</th><th>Name</th><th>SSN</th><th>Branch</th><th>Status</th><th>Action</th>`;
  const body = rows.map((m, i) => {
    const cells = t.showsSegmentColumn
      ? `<td><font face="Tahoma" size="1">${esc(m.memberNumber)}</font></td>
         <td><font face="Tahoma" size="1">${esc(m.segment)}</font></td>
         <td><font face="Tahoma" size="1">${esc(m.lastName)}, ${esc(m.firstName)}</font></td>`
      : `<td><font face="Tahoma" size="1">${esc(m.memberNumber)}</font></td>
         <td><font face="Tahoma" size="1">${esc(m.lastName)}, ${esc(m.firstName)}</font></td>`;
    // Row-action link: identical text on every row, ASP.NET-style generated id
    // whose ordinal shifts whenever the result set changes.
    const ctl = `${t.ctlPrefix}_grdResults_ctl${String(i + 2).padStart(2, '0')}_lnkView`;
    return `<tr class="${i % 2 ? 'alt' : ''}">
      ${cells}
      <td><font face="Tahoma" size="1">***-**-${esc(m.ssnLast4)}</font></td>
      <td><font face="Tahoma" size="1">${esc(m.branch)}</font></td>
      <td><font face="Tahoma" size="1">${esc(m.status)}</font></td>
      <td><a id="${ctl}" href="member/${esc(m.memberNumber)}?mode=${esc(mode)}"><font face="Tahoma" size="1">View</font></a></td>
    </tr>`;
  }).join('\n');

  return contentChrome({
    tenant: t, title: `${v.member} Search Results`, screenCode: 'INQ-0411', user,
    path: `INQUIRY > ${v.member.toUpperCase()} SEARCH > RESULTS`,
    body: `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <font face="Tahoma" size="1"><b>${rows.length}</b> record(s) returned for <b>${esc(query)}</b></font>
      <br><br>
      <table class="grid" cellpadding="0" cellspacing="0" border="0" id="${t.ctlPrefix}_grdResults">
        <tr>${header}</tr>
        ${body}
      </table>
      <br>
      <a href="member-search?mode=${esc(mode)}"><font face="Tahoma" size="1">&laquo; New Search</font></a>
    </td></tr></table>`,
  });
}

export function noResultsScreen(t: TenantConfig, user: any, query: string, mode: string): string {
  const v = t.vocab;
  return contentChrome({
    tenant: t, title: `${v.member} Search Results`, screenCode: 'INQ-0411', user,
    path: `INQUIRY > ${v.member.toUpperCase()} SEARCH > RESULTS`,
    body: `
    <div class="err" id="${t.ctlPrefix}_lblNoResults" style="margin-bottom:8px">
      <font face="Tahoma" size="1">MSG 0042 &mdash; NO ${esc(v.member.toUpperCase())} RECORD FOUND MATCHING THE SEARCH CRITERIA (${esc(query)}). VERIFY AND RE-ENTER.</font>
    </div>
    <a href="member-search?mode=${esc(mode)}"><font face="Tahoma" size="1">&laquo; New Search</font></a>`,
  });
}

export function complianceInterstitial(t: TenantConfig, user: any, m: Member, mode: string): string {
  return contentChrome({
    tenant: t, title: 'Compliance Review Notice', screenCode: 'BSA-0170', user, path: 'COMPLIANCE > NOTICE',
    body: `
    <div class="warn" style="margin-bottom:10px">
      <font face="Tahoma" size="1"><b>RESTRICTED RECORD &mdash; BSA/OFAC NOTICE</b><br>
      ${esc(m.complianceFlag ?? 'THIS RECORD IS SUBJECT TO ENHANCED REVIEW.')}<br><br>
      Viewing this record will be logged. Do not disclose the existence of this review to the ${esc(t.vocab.member.toLowerCase())}.</font>
    </div>
    <form method="GET" action="${esc(m.memberNumber)}">
      <input type="hidden" name="mode" value="${esc(mode)}">
      <input type="hidden" name="ack" value="1">
      <input type="submit" name="${t.ctlPrefix}$btnAcknowledgeNotice" id="${t.ctlPrefix}_btnAcknowledgeNotice" class="btn" value="Acknowledge and Continue">
      &nbsp;<input type="button" class="btn" value="Return to Search" onclick="location.href='../member-search'">
    </form>`,
  });
}

export function memberDetailScreen(t: TenantConfig, user: any, m: Member, mode: string, banner?: string, accountsShown = true): string {
  const v = t.vocab;
  const shareRows = m.shares.map((s, i) => `
    <tr class="${i % 2 ? 'alt' : ''}">
      <td><font face="Tahoma" size="1">${esc(m.memberNumber)}-${esc(s.suffix)}</font></td>
      <td><font face="Tahoma" size="1">${esc(s.type)}</font></td>
      <td align="right"><font face="Tahoma" size="1">${esc(formatCents(s.balanceCents))}</font></td>
      <td align="right"><font face="Tahoma" size="1">${esc(formatCents(s.availableCents))}</font></td>
      <td><font face="Tahoma" size="1">${esc(s.status)}</font></td>
      <td align="right"><font face="Tahoma" size="1">${esc(s.dividendRate)}</font></td>
    </tr>`).join('\n');

  const actions = [
    ['address', 'Address Maintenance'],
    ['open-share', `Open ${v.share}`],
    ['stop-pay', 'Stop Payment'],
    ['fee-reversal', 'Fee Reversal'],
  ].map(([k, label]) =>
    `<input type="button" class="btn" value="${esc(label)}" onclick="location.href='${esc(m.memberNumber)}/${esc(k)}'">`).join('&nbsp;');

  return contentChrome({
    tenant: t, title: `${v.member} Inquiry`, screenCode: 'INQ-0420', user,
    path: `INQUIRY > ${v.member.toUpperCase()} ${esc(m.memberNumber)}`,
    body: `
    ${banner ? `<div class="okbox" style="margin-bottom:8px"><font face="Tahoma" size="1">${esc(banner)}</font></div>` : ''}
    ${m.status !== 'ACTIVE' ? `<div class="warn" style="margin-bottom:8px"><font face="Tahoma" size="1"><b>${esc(v.member.toUpperCase())} STATUS: ${esc(m.status)}</b> &mdash; servicing restrictions may apply.</font></div>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="grpbox">
        <table width="100%" cellpadding="2" cellspacing="0" border="0">
          <tr>
            <td width="110" align="right"><font face="Tahoma" size="1"><b>${esc(v.memberNumber)}</b></font></td>
            <td width="150"><font face="Tahoma" size="1"><b><span id="${t.ctlPrefix}_lblMemberNo">${esc(m.memberNumber)}</span></b></font></td>
            <td width="90" align="right"><font face="Tahoma" size="1"><b>Name</b></font></td>
            <td><font face="Tahoma" size="1"><span id="${t.ctlPrefix}_lblName">${esc(m.lastName)}, ${esc(m.firstName)}</span></font></td>
          </tr>
          <tr>
            <td align="right"><font face="Tahoma" size="1"><b>SSN</b></font></td>
            <td><font face="Tahoma" size="1">***-**-${esc(m.ssnLast4)}</font></td>
            <td align="right"><font face="Tahoma" size="1"><b>Date of Birth</b></font></td>
            <td><font face="Tahoma" size="1">${esc(m.dateOfBirth)}</font></td>
          </tr>
          <tr>
            <td align="right"><font face="Tahoma" size="1"><b>${esc(v.member)} Since</b></font></td>
            <td><font face="Tahoma" size="1">${esc(m.memberSince)}</font></td>
            <td align="right"><font face="Tahoma" size="1"><b>Branch</b></font></td>
            <td><font face="Tahoma" size="1">${esc(m.branch)}</font></td>
          </tr>
          <tr>
            <td align="right" valign="top"><font face="Tahoma" size="1"><b>Address</b></font></td>
            <td colspan="3"><font face="Tahoma" size="1"><span id="${t.ctlPrefix}_lblAddress">${esc(m.address.line1)}${m.address.line2 ? ', ' + esc(m.address.line2) : ''}, ${esc(m.address.city)}, ${esc(m.address.state)} ${esc(m.address.zip)}</span></font></td>
          </tr>
          <tr>
            <td align="right"><font face="Tahoma" size="1"><b>Status</b></font></td>
            <td><font face="Tahoma" size="1"><b><span id="${t.ctlPrefix}_lblStatus">${esc(m.status)}</span></b></font></td>
            <td align="right"><font face="Tahoma" size="1"><b>Officer</b></font></td>
            <td><font face="Tahoma" size="1">${esc(m.officer)}</font></td>
          </tr>
        </table>
      </td></tr>
      <tr><td height="8"></td></tr>
      <tr><td class="grpbox">
        <font face="Tahoma" size="1"><b>${esc(v.shareList)}</b></font><br><br>
        ${accountsShown ? `
        <table class="grid" cellpadding="0" cellspacing="0" border="0" id="${t.ctlPrefix}_grdShares">
          <tr><th>Account</th><th>Type</th><th>Balance</th><th>Available</th><th>Status</th><th>Rate</th></tr>
          ${shareRows}
        </table>` : `
        <font face="Tahoma" size="1" color="#555">Balances are not displayed by default under your institution's configuration.</font><br><br>
        <input type="button" class="btn" id="${t.ctlPrefix}_btnDisplayAccounts" value="Display ${esc(v.shareList)}"
               onclick="location.href='${esc(m.memberNumber)}?accts=1&mode=${esc(mode)}'">`}
      </td></tr>
      <tr><td height="8"></td></tr>
      <tr><td class="grpbox">
        <font face="Tahoma" size="1"><b>Servicing Actions</b></font><br><br>
        ${actions}
      </td></tr>
    </table>`,
  });
}

// ── Servicing forms ───────────────────────────────────────────────────────────

export function openShareScreen(t: TenantConfig, user: any, m: Member, error?: string): string {
  const v = t.vocab;
  return contentChrome({
    tenant: t, title: `Open ${v.share}`, screenCode: 'SVC-0620', user,
    path: `SERVICING > OPEN ${v.share.toUpperCase()}`,
    body: `
    ${error ? `<div class="err" id="${t.ctlPrefix}_lblFormError" style="margin-bottom:8px"><font face="Tahoma" size="1">${esc(error)}</font></div>` : ''}
    <form method="POST" action="open-share" id="frmOpenShare">
    ${viewState('openshare')}
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <table cellpadding="3" cellspacing="0" border="0">
        <tr><td colspan="2"><font face="Tahoma" size="1"><b>${esc(v.member)}:</b> ${esc(m.memberNumber)} &mdash; ${esc(m.lastName)}, ${esc(m.firstName)}</font></td></tr>
        <tr><td colspan="2"><hr size="1"></td></tr>
        <tr>
          <td width="140" align="right" nowrap><font face="Tahoma" size="1"><b>${esc(v.share)} Type</b></font></td>
          <td><select name="${t.ctlPrefix}$ddlShareType" id="${t.ctlPrefix}_ddlShareType" class="fld">
            <option value="">(Select)</option>
            <option value="SPECIAL SAVINGS">SPECIAL SAVINGS</option>
            <option value="SHARE DRAFT">SHARE DRAFT</option>
            <option value="MONEY MARKET">MONEY MARKET</option>
            <option value="CHRISTMAS CLUB">CHRISTMAS CLUB</option>
          </select></td>
        </tr>
        <tr>
          <td align="right" nowrap><font face="Tahoma" size="1"><b>Opening Deposit</b></font></td>
          <td><input type="text" name="${t.ctlPrefix}$txtOpeningDeposit" id="${t.ctlPrefix}_txtOpeningDeposit" class="fld" size="12" maxlength="12"> <font face="Tahoma" size="1">USD</font></td>
        </tr>
        <tr>
          <td align="right" nowrap><font face="Tahoma" size="1"><b>Funding ${esc(v.share)}</b></font></td>
          <td><select name="${t.ctlPrefix}$ddlFunding" id="${t.ctlPrefix}_ddlFunding" class="fld">
            ${m.shares.filter((s) => s.status === 'OPEN').map((s) => `<option value="${esc(s.suffix)}">${esc(m.memberNumber)}-${esc(s.suffix)} ${esc(s.type)}</option>`).join('')}
          </select></td>
        </tr>
        <tr>
          <td align="right" nowrap><font face="Tahoma" size="1"><b>Statement Cycle</b></font></td>
          <td><select name="${t.ctlPrefix}$ddlCycle" id="${t.ctlPrefix}_ddlCycle" class="fld">
            <option value="M">MONTHLY</option><option value="Q">QUARTERLY</option>
          </select></td>
        </tr>
        <tr><td colspan="2"><hr size="1"></td></tr>
        <tr><td></td><td>
          <input type="submit" name="${t.ctlPrefix}$btnSubmit" id="${t.ctlPrefix}_btnSubmit" class="btn" value="Open Account">
          &nbsp;<input type="button" class="btn" value="Cancel" onclick="location.href='../${esc(m.memberNumber)}'">
        </td></tr>
      </table>
    </td></tr></table>
    </form>`,
  });
}

export function openShareConfirmScreen(t: TenantConfig, user: any, m: Member, newSuffix: string, type: string, amount: string, confirmation: string): string {
  const v = t.vocab;
  return contentChrome({
    tenant: t, title: `Open ${v.share} - Confirmation`, screenCode: 'SVC-0629', user,
    path: `SERVICING > OPEN ${v.share.toUpperCase()} > CONFIRM`,
    body: `
    <div class="okbox" style="margin-bottom:10px">
      <font face="Tahoma" size="1">MSG 0100 &mdash; ${esc(v.share.toUpperCase())} OPENED SUCCESSFULLY.</font>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <table cellpadding="3" cellspacing="0" border="0">
        <tr><td width="160" align="right"><font face="Tahoma" size="1"><b>Confirmation Number</b></font></td>
            <td><font face="Tahoma" size="1"><b><span id="${t.ctlPrefix}_lblConfirmation">${esc(confirmation)}</span></b></font></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>New Account</b></font></td>
            <td><font face="Tahoma" size="1"><span id="${t.ctlPrefix}_lblNewAccount">${esc(m.memberNumber)}-${esc(newSuffix)}</span></font></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Type</b></font></td>
            <td><font face="Tahoma" size="1">${esc(type)}</font></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Opening Deposit</b></font></td>
            <td><font face="Tahoma" size="1">${esc(amount)}</font></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Posted By</b></font></td>
            <td><font face="Tahoma" size="1">${esc(user.displayName)}</font></td></tr>
      </table>
      <br>
      <input type="button" class="btn" value="Return to ${esc(v.member)}" onclick="location.href='../${esc(m.memberNumber)}'">
    </td></tr></table>`,
  });
}

export function addressScreen(t: TenantConfig, user: any, m: Member, error?: string): string {
  const v = t.vocab;
  return contentChrome({
    tenant: t, title: 'Address Maintenance', screenCode: 'SVC-0510', user, path: 'SERVICING > ADDRESS',
    body: `
    ${error ? `<div class="err" id="${t.ctlPrefix}_lblFormError" style="margin-bottom:8px"><font face="Tahoma" size="1">${esc(error)}</font></div>` : ''}
    <div class="warn" style="margin-bottom:8px"><font face="Tahoma" size="1">
      <b>DUAL CONTROL</b> &mdash; address changes require supervisor review before they take effect.</font></div>
    <form method="POST" action="address" id="frmAddress">
    ${viewState('address')}
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <table cellpadding="3" cellspacing="0" border="0">
        <tr><td colspan="2"><font face="Tahoma" size="1"><b>${esc(v.member)}:</b> ${esc(m.memberNumber)} &mdash; ${esc(m.lastName)}, ${esc(m.firstName)}</font></td></tr>
        <tr><td colspan="2"><hr size="1"></td></tr>
        <tr><td width="130" align="right"><font face="Tahoma" size="1"><b>Address Line 1</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtLine1" id="${t.ctlPrefix}_txtLine1" class="fld" size="34" value="${esc(m.address.line1)}"></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Address Line 2</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtLine2" id="${t.ctlPrefix}_txtLine2" class="fld" size="34" value="${esc(m.address.line2)}"></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>City</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtCity" id="${t.ctlPrefix}_txtCity" class="fld" size="24" value="${esc(m.address.city)}"></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>State</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtState" id="${t.ctlPrefix}_txtState" class="fld" size="4" maxlength="2" value="${esc(m.address.state)}"></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>ZIP</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtZip" id="${t.ctlPrefix}_txtZip" class="fld" size="12" maxlength="10" value="${esc(m.address.zip)}"></td></tr>
        <tr><td colspan="2"><hr size="1"></td></tr>
        <tr><td></td><td>
          <input type="submit" name="${t.ctlPrefix}$btnSubmit" id="${t.ctlPrefix}_btnSubmit" class="btn" value="Submit for Review">
          &nbsp;<input type="button" class="btn" value="Cancel" onclick="location.href='../${esc(m.memberNumber)}'">
        </td></tr>
      </table>
    </td></tr></table>
    </form>`,
  });
}

export function stopPaymentScreen(t: TenantConfig, user: any, m: Member, error?: string): string {
  const v = t.vocab;
  const drafts = m.shares.filter((s) => s.type === 'SHARE DRAFT' && s.status === 'OPEN');
  return contentChrome({
    tenant: t, title: 'Stop Payment', screenCode: 'SVC-0740', user, path: 'SERVICING > STOP PAYMENT',
    body: `
    ${error ? `<div class="err" id="${t.ctlPrefix}_lblFormError" style="margin-bottom:8px"><font face="Tahoma" size="1">${esc(error)}</font></div>` : ''}
    <div class="warn" style="margin-bottom:8px"><font face="Tahoma" size="1">
      <b>IRREVERSIBLE &mdash; FEE BEARING.</b> A $32.00 stop payment fee will be assessed immediately and cannot be reversed from this screen.</font></div>
    <form method="POST" action="stop-pay" id="frmStopPay">
    ${viewState('stoppay')}
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <table cellpadding="3" cellspacing="0" border="0">
        <tr><td colspan="2"><font face="Tahoma" size="1"><b>${esc(v.member)}:</b> ${esc(m.memberNumber)} &mdash; ${esc(m.lastName)}, ${esc(m.firstName)}</font></td></tr>
        <tr><td colspan="2"><hr size="1"></td></tr>
        <tr><td width="130" align="right"><font face="Tahoma" size="1"><b>Account</b></font></td>
            <td><select name="${t.ctlPrefix}$ddlAccount" id="${t.ctlPrefix}_ddlAccount" class="fld">
              ${drafts.map((s) => `<option value="${esc(s.suffix)}">${esc(m.memberNumber)}-${esc(s.suffix)} ${esc(s.type)}</option>`).join('')}
            </select></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Check Number</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtCheckNo" id="${t.ctlPrefix}_txtCheckNo" class="fld" size="12" maxlength="8"></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Amount</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtAmount" id="${t.ctlPrefix}_txtAmount" class="fld" size="12"></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Reason</b></font></td>
            <td><select name="${t.ctlPrefix}$ddlReason" id="${t.ctlPrefix}_ddlReason" class="fld">
              <option value="LOST">LOST / STOLEN</option><option value="DISPUTE">DISPUTE WITH PAYEE</option><option value="OTHER">OTHER</option>
            </select></td></tr>
        <tr><td colspan="2"><hr size="1"></td></tr>
        <tr><td></td><td>
          <input type="submit" name="${t.ctlPrefix}$btnSubmit" id="${t.ctlPrefix}_btnSubmit" class="btn" value="Place Stop Payment">
          &nbsp;<input type="button" class="btn" value="Cancel" onclick="location.href='../${esc(m.memberNumber)}'">
        </td></tr>
      </table>
    </td></tr></table>
    </form>`,
  });
}

export function feeReversalScreen(t: TenantConfig, user: any, m: Member, error?: string): string {
  const v = t.vocab;
  const fees = m.transactions.filter((tx) => tx.reversible && !tx.reversed);
  const rows = fees.length
    ? fees.map((tx, i) => `<tr class="${i % 2 ? 'alt' : ''}">
        <td><input type="radio" name="${t.ctlPrefix}$rblFee" id="${t.ctlPrefix}_rblFee_${i}" value="${esc(tx.id)}"></td>
        <td><font face="Tahoma" size="1">${esc(tx.postedOn)}</font></td>
        <td><font face="Tahoma" size="1">${esc(m.memberNumber)}-${esc(tx.suffix)}</font></td>
        <td><font face="Tahoma" size="1">${esc(tx.description)}</font></td>
        <td align="right"><font face="Tahoma" size="1">${esc(formatCents(tx.amountCents))}</font></td>
      </tr>`).join('')
    : `<tr><td colspan="5"><font face="Tahoma" size="1">NO REVERSIBLE FEE TRANSACTIONS IN THE CURRENT PERIOD.</font></td></tr>`;
  return contentChrome({
    tenant: t, title: 'Fee Reversal', screenCode: 'SVC-0810', user, path: 'SERVICING > FEE REVERSAL',
    body: `
    ${error ? `<div class="err" id="${t.ctlPrefix}_lblFormError" style="margin-bottom:8px"><font face="Tahoma" size="1">${esc(error)}</font></div>` : ''}
    <div class="warn" style="margin-bottom:8px"><font face="Tahoma" size="1">
      <b>SUPERVISOR OVERRIDE REQUIRED</b> &mdash; fee reversals above $25.00 require a SUPERVISOR role.</font></div>
    <form method="POST" action="fee-reversal" id="frmFeeReversal">
    ${viewState('feerev')}
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <font face="Tahoma" size="1"><b>${esc(v.member)}:</b> ${esc(m.memberNumber)} &mdash; ${esc(m.lastName)}, ${esc(m.firstName)}</font><br><br>
      <table class="grid" cellpadding="0" cellspacing="0" border="0" id="${t.ctlPrefix}_grdFees">
        <tr><th width="20"></th><th>Posted</th><th>Account</th><th>Description</th><th>Amount</th></tr>
        ${rows}
      </table>
      <br>
      <table cellpadding="3" cellspacing="0" border="0">
        <tr><td width="130" align="right"><font face="Tahoma" size="1"><b>Reversal Reason</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtReason" id="${t.ctlPrefix}_txtReason" class="fld" size="40" maxlength="60"></td></tr>
      </table>
      <hr size="1">
      <input type="submit" name="${t.ctlPrefix}$btnSubmit" id="${t.ctlPrefix}_btnSubmit" class="btn" value="Reverse Fee">
      &nbsp;<input type="button" class="btn" value="Cancel" onclick="location.href='../${esc(m.memberNumber)}'">
    </td></tr></table>
    </form>`,
  });
}

export function genericConfirmScreen(t: TenantConfig, user: any, title: string, screenCode: string, msg: string, rows: Array<[string, string]>, backHref: string): string {
  return contentChrome({
    tenant: t, title, screenCode, user, path: `SERVICING > CONFIRM`,
    body: `
    <div class="okbox" style="margin-bottom:10px"><font face="Tahoma" size="1">${esc(msg)}</font></div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="grpbox">
      <table cellpadding="3" cellspacing="0" border="0">
        ${rows.map(([k, val]) => `<tr><td width="170" align="right"><font face="Tahoma" size="1"><b>${esc(k)}</b></font></td>
          <td><font face="Tahoma" size="1"><span id="${t.ctlPrefix}_lbl${esc(k.replace(/[^A-Za-z]/g, ''))}">${esc(val)}</span></font></td></tr>`).join('')}
      </table>
      <br><input type="button" class="btn" value="Continue" onclick="location.href='${esc(backHref)}'">
    </td></tr></table>`,
  });
}

// ── Exceptional states ────────────────────────────────────────────────────────

export function sessionExpiredScreen(t: TenantConfig): string {
  return contentChrome({
    tenant: t, title: 'Session Expired', screenCode: 'SEC-0900', user: null, path: 'SECURITY',
    body: `
    <div class="err" id="${t.ctlPrefix}_lblSessionExpired" style="margin-bottom:10px">
      <font face="Tahoma" size="1">MSG 0900 &mdash; YOUR SESSION HAS TIMED OUT DUE TO INACTIVITY. PLEASE SIGN ON AGAIN.</font>
    </div>
    <form method="POST" action="/signon" id="frmReauth" target="_top">
      <table cellpadding="3" cellspacing="0" border="0">
        <tr><td width="110" align="right"><font face="Tahoma" size="1"><b>Operator ID</b></font></td>
            <td><input type="text" name="${t.ctlPrefix}$txtOperatorId" id="${t.ctlPrefix}_txtOperatorId" class="fld" size="20"></td></tr>
        <tr><td align="right"><font face="Tahoma" size="1"><b>Password</b></font></td>
            <td><input type="password" name="${t.ctlPrefix}$txtPassword" id="${t.ctlPrefix}_txtPassword" class="fld" size="20"></td></tr>
        <tr><td></td><td><input type="submit" class="btn" value="Sign On"></td></tr>
      </table>
    </form>`,
  });
}

export function permissionDeniedScreen(t: TenantConfig, user: any, detail: string): string {
  return contentChrome({
    tenant: t, title: 'Authorization Failure', screenCode: 'SEC-0451', user, path: 'SECURITY',
    body: `<div class="err" id="${t.ctlPrefix}_lblAuthError">
      <font face="Tahoma" size="1">MSG 0451 &mdash; OPERATOR NOT AUTHORIZED FOR THIS FUNCTION. ${esc(detail)}</font></div>
      <br><font face="Tahoma" size="1">Contact your supervisor to obtain an override.</font>`,
  });
}

export function eodLockoutScreen(t: TenantConfig, user: any): string {
  return contentChrome({
    tenant: t, title: 'System Unavailable', screenCode: 'SYS-0600', user, path: 'SYSTEM',
    body: `<div class="err" id="${t.ctlPrefix}_lblEod">
      <font face="Tahoma" size="1">MSG 0600 &mdash; THE SYSTEM IS CURRENTLY IN END-OF-DAY PROCESSING. INQUIRY AND MAINTENANCE FUNCTIONS ARE UNAVAILABLE UNTIL PROCESSING COMPLETES. PLEASE TRY AGAIN LATER.</font></div>`,
  });
}

export function recordLockedScreen(t: TenantConfig, user: any, m: Member): string {
  return contentChrome({
    tenant: t, title: 'Record In Use', screenCode: 'SYS-0310', user, path: 'SYSTEM',
    body: `<div class="err" id="${t.ctlPrefix}_lblLocked">
      <font face="Tahoma" size="1">MSG 0310 &mdash; RECORD ${esc(m.memberNumber)} IS IN USE BY OPERATOR ${esc(m.lockedBy ?? 'UNKNOWN')}. MAINTENANCE IS NOT AVAILABLE UNTIL THE RECORD IS RELEASED.</font></div>
      <br><input type="button" class="btn" value="Retry" onclick="location.reload()">`,
  });
}

export function transientErrorPage(t: TenantConfig): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head><title>Server Error</title><style type="text/css">${baseCss(t)}</style></head>
<body><table width="100%" cellpadding="8"><tr><td>
<div class="err"><font face="Tahoma" size="2"><b>MERIDIAN APPLICATION SERVER</b></font><br><br>
<font face="Tahoma" size="1">HTTP 503 &mdash; Service Temporarily Unavailable.<br>
The application server did not respond within the configured timeout. Reference CORR-${Math.floor(Math.random() * 900000 + 100000)}.</font></div>
</td></tr></table></body></html>`;
}
