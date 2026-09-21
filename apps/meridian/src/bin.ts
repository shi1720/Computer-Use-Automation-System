/** Start every tenant of the MERIDIAN simulator. */
import { TENANTS } from './tenants.js';
import { startMeridian } from './server.js';

const banner = `
  MERIDIAN Core Banking System — simulated environment
  ----------------------------------------------------`;
console.log(banner);
await Promise.all(Object.keys(TENANTS).map((t) => startMeridian(t)));
console.log(`
  Sign on with any of:  msr01 / meridian   (MSR)
                        tlr07 / meridian   (TELLER — limited authority)
                        sup02 / meridian   (SUPERVISOR)

  All data is synthetic. Scenario control: POST /__sim/scenario
`);
