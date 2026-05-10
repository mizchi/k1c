#!/usr/bin/env node
// Verify the Cloudflare token loaded from .env (via dotenvx) and
// print the account / zone IDs k1c needs for e2e tests + apply.
//
// Usage:
//   dotenvx run -- node scripts/verify-cf-token.mjs

import Cloudflare from 'cloudflare';

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const accountIdHint = process.env.K1C_ACCOUNT_ID;
if (!apiToken) {
  console.error('CLOUDFLARE_API_TOKEN not set; run via `dotenvx run -- node scripts/verify-cf-token.mjs`');
  process.exit(1);
}

const cf = new Cloudflare({ apiToken });

// Tokens that begin with `cfat_` are Account-Owned API Tokens; the
// user-scoped `/user/tokens/verify` and `/accounts` endpoints both
// reject them with 401. For those tokens we hit the account-scoped
// verify endpoint instead, which requires the account id up front.
const isAccountOwned = apiToken.startsWith('cfat_');
let accounts = [];

if (isAccountOwned) {
  if (!accountIdHint) {
    console.error(
      'Account-owned token (cfat_...) detected but K1C_ACCOUNT_ID is not set.\n' +
        'Find the account id in the Cloudflare dash URL (https://dash.cloudflare.com/<ACCOUNT_ID>/...) and add it to .env:\n' +
        '  dotenvx set K1C_ACCOUNT_ID <id>\n' +
        'Then re-run this script.',
    );
    process.exit(2);
  }
  console.log('=== Token verify (account-scoped) ===');
  const verify = await cf.get(`/accounts/${accountIdHint}/tokens/verify`);
  console.log(JSON.stringify(verify, null, 2));
  // We already have the account id; build the list synthetically so
  // the rest of the script keeps working.
  accounts.push({ id: accountIdHint, name: '(from K1C_ACCOUNT_ID)' });
} else {
  console.log('=== Token verify (user-scoped) ===');
  const verify = await cf.user.tokens.verify();
  console.log(JSON.stringify(verify, null, 2));

  console.log('\n=== Accounts ===');
  for await (const a of cf.accounts.list()) {
    accounts.push({ id: a.id, name: a.name });
  }
  console.log(JSON.stringify(accounts, null, 2));
}

console.log('\n=== Zones ===');
const zones = [];
for await (const z of cf.zones.list()) {
  zones.push({ id: z.id, name: z.name, status: z.status });
}
console.log(JSON.stringify(zones, null, 2));

console.log('\n=== Suggested .env entries ===');
if (accounts.length === 1) {
  console.log(`K1C_ACCOUNT_ID=${accounts[0].id}`);
} else if (accounts.length > 1) {
  console.log('# multiple accounts — pick one and set:');
  for (const a of accounts) console.log(`# K1C_ACCOUNT_ID=${a.id}  # ${a.name}`);
}
if (zones.length === 1) {
  console.log(`K1C_ZONE_ID=${zones[0].id}`);
} else if (zones.length > 1) {
  console.log('# multiple zones — pick one and set:');
  for (const z of zones) console.log(`# K1C_ZONE_ID=${z.id}  # ${z.name}`);
}
