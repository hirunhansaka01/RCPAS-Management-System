// Proves the official-account workflow end to end against the running server:
//   create -> sign in as the new account -> per-account permissions enforced (allow AND deny)
//   -> rename -> reset -> deactivate.
// Uses the Authorized Organizer role, which has no users.manage and no audit.read, so the
// denials are real rather than assumed. Cleans up its own fixtures; tests/db-recover.mjs
// restores the live DB afterwards.
import { passwordFor } from './creds.mjs';

const BASE = 'http://localhost:3000/api';
const EMAIL = `probe.official.${Date.now()}@rcpas.local`;
// Generated per run: the account itself is created by this test and deleted
// again below, so there is no reason to hard-code a password into the source.
const PASSWORD = `Probe.${Date.now()}!aA1`;
const NEW_PASSWORD = `ProbeNew.${Date.now()}!aA1`;

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
};

function jar() {
  const store = new Map();
  return {
    header() { return [...store].map(([k, v]) => `${k}=${v}`).join('; '); },
    absorb(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';'); const i = pair.indexOf('=');
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    }
  };
}

async function call(j, method, path, body) {
  const headers = { cookie: j.header() };
  const ck = j.header();
  if (ck.includes('rcpas_csrf=')) headers['x-csrf-token'] = ck.split('rcpas_csrf=')[1].split(';')[0];
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  j.absorb(res);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

// Login returns {ok:true}; the identity/permissions only appear on /auth/session.
async function signIn(email, password) {
  const j = jar();
  const seed = await call(j, 'GET', '/auth/session');
  const r = await call(j, 'POST', '/auth/password/login', { email, password });
  if (r.status !== 200) return { jar: j, ok: false, user: null, status: r.status };
  const sess = await call(j, 'GET', '/auth/session');
  return { jar: j, ok: true, user: sess.data?.user ?? null, status: 200, seed };
}

console.log('=== official-account workflow ===');

// --- 0. administrator session ---
const admin = await signIn('admin@rcpas.local', passwordFor('TEST_ADMIN_PASSWORD'));
check('admin can sign in', admin.ok, admin.status);
const adminId = admin.user?.id;
check('admin holds users.manage', (admin.user?.permissions || []).includes('users.manage'), admin.user?.permissions);
const A = admin.jar;

const rolesRes = await call(A, 'GET', '/system-roles');
const roles = rolesRes.data?.data || [];
check('system roles listed', rolesRes.status === 200 && roles.length > 0, rolesRes.status);
console.log('        roles: ' + roles.map(r => `${r.id}=${r.name}`).join(', '));

const rolePermsRes = await call(A, 'GET', '/role-permissions');
const codesFor = (role) => [...new Set((rolePermsRes.data?.data || []).filter(rp => rp.roleId === role.id).map(rp => rp.code))].sort();

// The fixture role must lack users.manage so the denial assertions mean something.
const target = roles.find(r => /authorized organizer/i.test(r.name))
  || roles.find(r => !codesFor(r).includes('users.manage') && r.id !== 4);
check('fixture role found', Boolean(target), roles);
const targetCodes = codesFor(target);
console.log(`        ${target.name} grants ${targetCodes.length} permissions`);
console.log(`        users.manage=${targetCodes.includes('users.manage')} audit.read=${targetCodes.includes('audit.read')} members.read=${targetCodes.includes('members.read')}`);
check('fixture role has NO users.manage', !targetCodes.includes('users.manage'), targetCodes);
check('fixture role has NO audit.read', !targetCodes.includes('audit.read'), targetCodes);
check('fixture role HAS members.read', targetCodes.includes('members.read'), targetCodes);

// --- 1. validation ---
const bad = await call(A, 'POST', '/users', { email: 'not-an-email', displayName: 'X', password: 'short', roleIds: [] });
check('POST /users rejects an invalid payload (400)', bad.status === 400, bad.status);
const noRole = await call(A, 'POST', '/users', { email: `probe.norole.${Date.now()}@rcpas.local`, displayName: 'No Role', password: PASSWORD, roleIds: [] });
check('POST /users requires at least one role (400)', noRole.status === 400, noRole.status);
const weakCreate = await call(A, 'POST', '/users', { email: `probe.weak.${Date.now()}@rcpas.local`, displayName: 'Weak Password', password: 'short', roleIds: [target.id] });
check('POST /users rejects a weak password (400, not 500)', weakCreate.status === 400, weakCreate.status);

// --- 2. create ---
const created = await call(A, 'POST', '/users', { email: EMAIL, displayName: 'Probe Official', password: PASSWORD, roleIds: [target.id] });
check('POST /users creates the account (201)', created.status === 201, created);
const newId = created.data?.id;
check('created account echoes roleIds as an array', Array.isArray(created.data?.roleIds), created.data);

// --- 3. duplicate ---
const dup = await call(A, 'POST', '/users', { email: EMAIL, displayName: 'Probe Two', password: PASSWORD, roleIds: [target.id] });
check('duplicate email returns 409', dup.status === 409, dup.status);

// --- 4. listing ---
const list = await call(A, 'GET', '/users');
const row = (list.data?.data || []).find(u => u.email === EMAIL);
check('GET /users lists the account', Boolean(row), row?.email);
check('listed roleIds is a real array', Array.isArray(row?.roleIds), row?.roleIds);
check('listed roleIds contains the chosen role', Array.isArray(row?.roleIds) && row.roleIds.includes(target.id), row?.roleIds);
check('display name stored correctly', row?.displayName === 'Probe Official', row?.displayName);
check('account is active', Boolean(row?.active), row?.active);

// --- 5. the new account signs in, carrying exactly its role's permissions ---
const staff = await signIn(EMAIL, PASSWORD);
check('new account signs in', staff.ok, staff.status);
check('session carries the expected display name', staff.user?.displayName === 'Probe Official', staff.user);
check('session carries the expected role', (staff.user?.roles || []).includes(target.name), staff.user?.roles);
const staffPerms = (staff.user?.permissions || []).sort();
check('session permissions match the role grant exactly', JSON.stringify(staffPerms) === JSON.stringify(targetCodes), { got: staffPerms, want: targetCodes });
const S = staff.jar;

// --- 6. per-account permission enforcement: mixed allow AND deny in one session ---
const seesUsers = await call(S, 'GET', '/users');
check('GET /users DENIED 403 (role has no users.manage)', seesUsers.status === 403, seesUsers.status);

const seesAudit = await call(S, 'GET', '/audit');
check('GET /audit DENIED 403 (role has no audit.read)', seesAudit.status === 403, seesAudit.status);

const seesMembers = await call(S, 'GET', '/members');
check('GET /members ALLOWED 200 (role has members.read)', seesMembers.status === 200, seesMembers.status);

const seesEvents = await call(S, 'GET', '/events');
check('GET /events ALLOWED 200 (role has events.read)', seesEvents.status === 200, seesEvents.status);

// Write attempts must be denied too, not just reads.
const writeUsers = await call(S, 'POST', '/users', { email: `probe.elevate.${Date.now()}@rcpas.local`, displayName: 'Elevate', password: PASSWORD, roleIds: [target.id] });
check('POST /users DENIED 403 for a non-manager account', writeUsers.status === 403, writeUsers.status);

const writeSettings = await call(S, 'PATCH', '/settings', { settings: [] });
check('PATCH /settings DENIED 403 for this account', writeSettings.status === 403, writeSettings.status);

// Unauthenticated must be 401, never a leak.
const anonUsers = await call(jar(), 'GET', '/users');
check('GET /users is 401 with no session', anonUsers.status === 401, anonUsers.status);

// --- 7. rename must NOT deactivate (the old PATCH always wrote `active`) ---
const renamed = await call(A, 'PATCH', `/users/${newId}`, { displayName: 'Probe Official Renamed' });
check('PATCH displayName succeeds (200)', renamed.status === 200, renamed.status);
const afterRename = await call(A, 'GET', '/users');
const renamedRow = (afterRename.data?.data || []).find(u => u.email === EMAIL);
check('display name updated', renamedRow?.displayName === 'Probe Official Renamed', renamedRow?.displayName);
check('account STILL active after a name-only change', Boolean(renamedRow?.active), renamedRow?.active);
const staff2 = await signIn(EMAIL, PASSWORD);
check('renamed account still signs in with the original password', staff2.ok, staff2.status);

// --- 8. self-lockout guard (about the ADMIN's own roles, independent of the fixture role) ---
const adminRole = roles.find(r => /system administrator/i.test(r.name));
const nonManageRoles = roles.filter(r => !codesFor(r).includes('users.manage'));
const lockout = await call(A, 'PATCH', `/users/${adminId}`, { roleIds: nonManageRoles.length ? [nonManageRoles[0].id] : [] });
check('admin cannot strip their own account-management access (400)', lockout.status === 400, lockout);
const stillAdmin = await call(A, 'GET', '/users');
check('admin still has users.manage after the blocked change', stillAdmin.status === 200, stillAdmin.status);

// --- 9. adding a second role takes effect on the very next request ---
if (adminRole) {
  const promote = await call(A, 'PATCH', `/users/${newId}`, { roleIds: [target.id, adminRole.id] });
  check('PATCH roleIds succeeds (200)', promote.status === 200, promote.status);
  const afterPromote = await call(A, 'GET', '/users');
  const promoted = (afterPromote.data?.data || []).find(u => u.email === EMAIL);
  check('both roles now listed', Array.isArray(promoted?.roleIds) && promoted.roleIds.length === 2, promoted?.roleIds);
  // The permission change must be visible immediately on a fresh sign-in.
  const elevated = await signIn(EMAIL, PASSWORD);
  check('second sign-in sees the additional permission', (elevated.user?.permissions || []).includes('users.manage'), elevated.user?.permissions);
  // ...and having gained it, this account may now create accounts itself.
  const sub = await call(elevated.jar, 'POST', '/users', { email: `probe.sub.${Date.now()}@rcpas.local`, displayName: 'Probe Sub', password: PASSWORD, roleIds: [target.id] });
  check('a second official holding users.manage can also create accounts (201)', sub.status === 201, sub.status);
  // Demote back so the rest of the run uses the restricted permission set.
  await call(A, 'PATCH', `/users/${newId}`, { roleIds: [target.id] });
} else {
  console.log('  SKIP  second-creator path (no System Administrator role found)');
}

// --- 10. administrator password reset ends existing sessions ---
const reset = await call(A, 'PATCH', `/users/${newId}`, { password: NEW_PASSWORD });
check('administrator password reset succeeds (200)', reset.status === 200, reset.status);
const oldSession = await call(staff2.jar, 'GET', '/auth/session');
check('previous session was signed out by the reset', oldSession.status === 401 || !oldSession.data?.user, oldSession.status);
const s3 = await signIn(EMAIL, NEW_PASSWORD);
check('new password signs in', s3.ok, s3.status);
const stale = await signIn(EMAIL, PASSWORD);
check('old password is rejected', !stale.ok, stale.status);

// --- 11. weak password rejected with a client error, not a server error ---
const weak = await call(A, 'PATCH', `/users/${newId}`, { password: 'short' });
check('weak password returns 400 (not 500)', weak.status === 400, weak.status);

// --- 12. deactivate blocks sign-in ---
const off = await call(A, 'PATCH', `/users/${newId}`, { active: false });
check('deactivate succeeds (200)', off.status === 200, off.status);
const dead = await signIn(EMAIL, NEW_PASSWORD);
check('deactivated account cannot sign in', !dead.ok, dead.status);
await call(A, 'PATCH', `/users/${newId}`, { active: true });

// --- 13. self-deactivation is refused ---
const selfOff = await call(A, 'PATCH', `/users/${adminId}`, { active: false });
check('admin cannot deactivate their own account (400)', selfOff.status === 400, selfOff.status);

// --- cleanup: deactivate every probe fixture this run created ---
const cleanup = await call(A, 'GET', '/users');
const probes = (cleanup.data?.data || []).filter(x => String(x.email).startsWith('probe.'));
for (const u of probes) await call(A, 'PATCH', `/users/${u.id}`, { active: false });
const remaining = await call(A, 'GET', '/users');
const stillActive = (remaining.data?.data || []).filter(x => String(x.email).startsWith('probe.') && x.active);
check('no probe account is left active', stillActive.length === 0, stillActive.map(l => l.email));
console.log(`        ${probes.length} probe account(s) deactivated (removed by db-recover afterwards)`);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
