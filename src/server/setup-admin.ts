import { ensureAdmin } from './provision.js';

// The CLI intentionally forces a password reset (unlike cold start, which leaves an existing
// password alone). It requires explicit credentials and creates no default account.
const email = await ensureAdmin({ resetPassword: true });
if (!email) throw new Error('SETUP_ADMIN_EMAIL and SETUP_ADMIN_PASSWORD are required; no default credentials are created.');
console.log(`Authorized ${email} as System Administrator with password login enabled.`);
process.exit(0);
