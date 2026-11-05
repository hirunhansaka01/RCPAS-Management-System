// Stage 1b — Event Planning Workspace + Gear Directory end-to-end test.
// Run with: node tests/stage1b-workspace.mjs   (server must be running)
//
// Covers the workflow from the rework spec:
//   register member + gear -> search gear directory -> create event -> add
//   requirement -> find owner -> request -> record response -> build team ->
//   readiness -> reuse across events -> permissions -> persistence.
// It cleans up only the records it created, leaving existing data untouched.

import { DatabaseSync } from 'node:sqlite';
import { passwordFor } from './creds.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const STAMP = String(Date.now()).slice(-6);
const MEMBER_CODE = `RCPAS/${new Date().getFullYear()}/${STAMP}`;
const EVENT_A = `EVT-T1A-${STAMP}`;
const EVENT_B = `EVT-T1B-${STAMP}`;
const EVENT_DATE = '2027-03-14';

const jar = new Map();
const db = new DatabaseSync('data/rcpas.sqlite');
db.exec('PRAGMA busy_timeout=5000');
const raw = (q, ...p) => db.prepare(q).all(...p);

function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function absorb(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar.size) headers.Cookie = cookieHeader();
  const csrf = jar.get('rcpas_csrf');
  if (csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  absorb(res);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}
const j = (r) => (typeof r.data === 'object' ? r.data : {});

let memberId, lensId, eventIdA, eventIdB, requirementId, commitmentId, assignmentId, discussionId;
const equipmentBefore = Number(raw('SELECT COUNT(*) c FROM equipment')[0].c);

async function run() {
  // ---------------------------------------------------------------- bootstrap
  let r = await call('GET', '/api/auth/session');
  await call('GET', '/health');
  check('csrf cookie issued', Boolean(jar.get('rcpas_csrf')));
  r = await call('POST', '/api/auth/password/login', { email: 'admin@rcpas.local', password: passwordFor('TEST_ADMIN_PASSWORD') });
  check('admin login succeeds', r.status === 200, JSON.stringify(r.data));

  // ------------------------------------------- 1. register member with gear
  const roles = j(await call('GET', '/api/roles')).roles || [];
  const roleName = (n) => (roles.find((x) => x.name === n) || {}).id;
  const cats = j(await call('GET', '/api/equipment/categories')).categories || [];
  const catId = (n) => (cats.find((c) => c.name === n) || {}).id;

  r = await call('POST', '/api/members', {
    memberCode: MEMBER_CODE, fullName: 'Test Gear Owner', grade: '12', className: 'A',
    membershipStart: '2026-02-01', status: 'Active', phone: '+94770000003',
    email: `gearowner${STAMP}@example.test`,
    roleIds: [roleName('Photographer'), roleName('Photo Editor')].filter(Boolean),
  });
  check('member registered', r.status === 201 && Number.isFinite(j(r).id), JSON.stringify(r.data));
  memberId = j(r).id;

  r = await call('POST', `/api/members/${memberId}/equipment`, {
    categoryId: catId('Lenses'), brand: 'Canon', model: 'EF 70-200mm f/2.8L IS', focalLength: '70-200mm',
    lensMount: 'Canon EF', quantity: 1, ownership: 'Personally Owned', conditionStatus: 'Excellent',
    availability: 'Available', itemName: 'Telephoto zoom', keywords: 'telephoto portrait sports',
  });
  check('70-200mm lens registered with auto code', r.status === 201 && Boolean(j(r).equipmentCode), JSON.stringify(r.data));
  lensId = j(r).id;

  // ------------------------------------- 2. gear directory search + filters
  r = await call('GET', '/api/equipment/search?q=70-200');
  let hits = j(r).data || [];
  check('search "70-200" returns the lens', hits.length >= 1 && hits.some((h) => h.equipmentId === lensId), `hits=${hits.length}`);
  check('search returns the owning member', hits.find((h) => h.equipmentId === lensId)?.owner?.fullName === 'Test Gear Owner');
  check('search returns owner creative roles', (hits.find((h) => h.equipmentId === lensId)?.owner?.roles || []).includes('Photographer'));

  r = await call('GET', '/api/equipment/search?q=70-200&role=Videographer');
  check('role filter excludes a non-matching owner', !(j(r).data || []).some((h) => h.equipmentId === lensId), JSON.stringify(j(r).data).slice(0, 160));

  r = await call('GET', '/api/equipment/search?q=70-200&grade=12&className=A');
  check('grade/class filter keeps the owner', (j(r).data || []).some((h) => h.equipmentId === lensId));

  r = await call('GET', '/api/equipment/search?q=70-200&grade=9');
  check('grade filter excludes the owner', !(j(r).data || []).some((h) => h.equipmentId === lensId));

  r = await call('GET', '/api/equipment/search?q=70-200&availability=Unavailable');
  check('availability filter excludes an available item', !(j(r).data || []).some((h) => h.equipmentId === lensId));

  r = await call('GET', `/api/equipment/search?q=70-200&categoryId=${catId('Lenses')}`);
  check('category filter keeps the lens', (j(r).data || []).some((h) => h.equipmentId === lensId));

  r = await call('GET', '/api/equipment/search?q=70-200&confirmationStatus=Confirmed');
  check('confirmation filter without an event is rejected (400)', r.status === 400, `status=${r.status}`);

  r = await call('GET', '/api/equipment/search?q=70-200&availability=Archived');
  check('narrow filters combine (Archived yields none)', (j(r).data || []).length === 0);

  // --------------------------------------------------- 3. create the event
  r = await call('POST', '/api/events', {
    eventCode: EVENT_A, name: 'Stage 1b Portrait Workshop', description: 'Workspace test event',
    category: 'Workshop', eventDate: EVENT_DATE, startTime: '09:30', venue: 'Media Room',
    priority: 'High', requiredTeamSize: 1, creativeRequirements: 'Photographer, Photo Editor',
    photographyRequirements: '', isDraft: true, status: 'Planning',
  });
  check('event created as draft', r.status === 201 && Number.isFinite(j(r).id), JSON.stringify(r.data));
  eventIdA = j(r).id;

  // ------------------------------------------- 4. structured gear requirements
  r = await call('POST', `/api/events/${eventIdA}/requirements`, {
    description: '70-200mm lens', quantity: 1, priority: 'Critical', notes: 'For the outdoor session',
  });
  check('gear requirement added', r.status === 201 && Number.isFinite(j(r).id), JSON.stringify(r.data));
  requirementId = j(r).id;

  r = await call('POST', `/api/events/${eventIdA}/requirements`, { description: '70-200mm lens' });
  check('duplicate requirement rejected (409)', r.status === 409 && j(r).code === 'DUPLICATE_REQUIREMENT', `status=${r.status}`);

  r = await call('POST', `/api/events/${eventIdA}/requirements`, { description: 'x' });
  check('short description rejected (400)', r.status === 400, `status=${r.status}`);

  r = await call('GET', `/api/events/${eventIdA}/requirements`);
  let reqs = j(r).data || [];
  check('requirement listed', reqs.length === 1 && reqs[0].id === requirementId, JSON.stringify(reqs));
  check('requirement starts Not Requested', reqs[0]?.availability === 'Not Requested', String(reqs[0]?.availability));
  check('unowned requirement is not fulfilled', reqs[0]?.fulfilled === false);
  check('requirement priority stored', reqs[0]?.priority === 'Critical');

  // ------------------------------------------------ 5. find the gear owner
  r = await call('GET', `/api/equipment/search?q=70-200&eventId=${eventIdA}&date=${EVENT_DATE}`);
  hits = j(r).data || [];
  const ownerHit = hits.find((h) => h.equipmentId === lensId);
  check('owner found from the event workspace', Boolean(ownerHit), `hits=${hits.length}`);
  check('owner contact visible to admin', Boolean(ownerHit?.owner?.phone));
  check('no commitment before the request', ownerHit?.commitment === null);
  check('owner has no same-date clash yet', Number(ownerHit?.owner?.assignmentsOnDate || 0) === 0);

  // --------------------------------------------------- 6. request for event
  r = await call('PATCH', `/api/events/${eventIdA}/requirements/${requirementId}`, { equipmentId: lensId });
  check('requirement linked to the gear record', r.status === 200, JSON.stringify(r.data));

  r = await call('POST', `/api/events/${eventIdA}/commitments`, { equipmentId: lensId, status: 'Awaiting Confirmation', notes: 'Requested by organizer' });
  check('owner request recorded as awaiting response', r.status === 201 || r.status === 200, JSON.stringify(r.data));
  commitmentId = j(r).id;

  r = await call('GET', `/api/events/${eventIdA}/requirements`);
  reqs = j(r).data || [];
  check('requirement now shows the owner', reqs[0]?.ownerName === 'Test Gear Owner', String(reqs[0]?.ownerName));
  check('availability is Awaiting Response (not confirmed)', reqs[0]?.availability === 'Awaiting Response', String(reqs[0]?.availability));
  check('still not fulfilled before confirmation', reqs[0]?.fulfilled === false);

  r = await call('GET', `/api/events/${eventIdA}/readiness`);
  check('readiness reports the requirement', j(r).summary?.gearRequirements >= 1, JSON.stringify(j(r).summary));
  check('readiness blocks on unconfirmed gear', (j(r).summary?.blockers || []).some((b) => b.includes('70-200mm lens')), JSON.stringify(j(r).summary?.blockers));

  // ------------------------------------------------- 7. team + contact flow
  r = await call('POST', '/api/assignments', {
    eventId: eventIdA, memberId, responsibility: 'Photographer', status: 'Contact Pending', notes: '',
    overrideWarnings: false,
  });
  check('member assigned to the team', r.status === 201 && Number.isFinite(j(r).id), JSON.stringify(r.data));
  assignmentId = j(r).id;

  r = await call('PATCH', `/api/assignments/${assignmentId}/contact`, { status: 'Contacted' });
  check('marked contacted', r.status === 200, JSON.stringify(r.data));

  r = await call('GET', `/api/events/${eventIdA}/contact-sheet`);
  const msg = j(r).message || '';
  check('message draft contains the event name', msg.includes('Stage 1b Portrait Workshop'), msg.slice(0, 200));
  check('message draft contains the date', msg.includes(EVENT_DATE), msg.slice(0, 200));
  check('message draft contains the start time', msg.includes('09:30'), msg.slice(0, 200));
  check('message draft contains the venue', msg.includes('Media Room'), msg.slice(0, 200));
  check('contact sheet lists the member', (j(r).team || []).some((t) => t.memberName === 'Test Gear Owner'));

  r = await call('PATCH', `/api/assignments/${assignmentId}/contact`, { status: 'Confirmed' });
  check('assignment confirmed', r.status === 200, JSON.stringify(r.data));

  r = await call('GET', '/api/assignments');
  const mine = (j(r).data || []).find((a) => a.id === assignmentId);
  check('assignment status persisted as Confirmed', mine?.status === 'Confirmed', String(mine?.status));

  // --------------------------------------- 8. owner confirms the gear for it
  r = await call('PATCH', `/api/equipment/commitments/${commitmentId}`, { status: 'Confirmed', notes: 'Owner confirmed by phone' });
  check('owner confirmation recorded', r.status === 200, JSON.stringify(r.data));

  r = await call('GET', `/api/events/${eventIdA}/requirements`);
  reqs = j(r).data || [];
  check('requirement now Confirmed for Event', reqs[0]?.availability === 'Confirmed for Event', String(reqs[0]?.availability));
  check('requirement now fulfilled', reqs[0]?.fulfilled === true);

  r = await call('GET', `/api/events/${eventIdA}/readiness`);
  const gearBlockers = (j(r).summary?.blockers || []).filter((b) => b.includes('70-200mm lens'));
  check('readiness no longer blocks on confirmed gear', gearBlockers.length === 0, JSON.stringify(gearBlockers));
  check('readiness counts gear as fulfilled', j(r).summary?.gearFulfilled >= 1, JSON.stringify(j(r).summary));

  // ------------------------------------------------------- 9. gear waiver
  r = await call('PATCH', `/api/events/${eventIdA}/requirements/${requirementId}`, { waive: true });
  check('waiver without a reason rejected (400)', r.status === 400 && j(r).code === 'WAIVE_REASON_REQUIRED', `status=${r.status}`);

  r = await call('PATCH', `/api/events/${eventIdA}/requirements/${requirementId}`, { waive: true, waiveReason: 'The venue provides its own lens' });
  check('waiver accepted with a reason', r.status === 200, JSON.stringify(r.data));

  r = await call('GET', `/api/events/${eventIdA}/readiness`);
  check('readiness counts the waiver', j(r).summary?.gearWaived === 1, JSON.stringify(j(r).summary));

  r = await call('PATCH', `/api/events/${eventIdA}/requirements/${requirementId}`, { waive: false });
  check('waiver can be reversed', r.status === 200, JSON.stringify(r.data));

  // ---------------------------------------- 10. reuse the same gear elsewhere
  r = await call('POST', '/api/events', {
    eventCode: EVENT_B, name: 'Stage 1b Sports Day', description: 'Second event',
    category: 'Coverage', eventDate: '2027-04-10', startTime: '16:00', venue: 'Main Ground',
    priority: 'Normal', requiredTeamSize: 1, creativeRequirements: 'Photographer', isDraft: true, status: 'Planning',
  });
  check('second event created', r.status === 201, JSON.stringify(r.data));
  eventIdB = j(r).id;

  r = await call('POST', `/api/events/${eventIdB}/requirements`, { description: '70-200mm lens', equipmentId: lensId });
  check('second event reuses the same gear record', r.status === 201, JSON.stringify(r.data));
  const requirementB = j(r).id;

  r = await call('POST', `/api/events/${eventIdB}/requirements`, { description: '70-200mm lens', equipmentId: lensId });
  check('duplicate requirement still rejected on event B', r.status === 409, `status=${r.status}`);

  const equipmentAfter = Number(raw('SELECT COUNT(*) c FROM equipment')[0].c);
  check('no duplicate equipment record created', equipmentAfter === equipmentBefore + 1, `before=${equipmentBefore} after=${equipmentAfter}`);
  const shared = raw('SELECT COUNT(DISTINCT equipment_id) d FROM event_equipment_requirements WHERE id IN (?,?)', requirementId, requirementB);
  check('both events point at one gear record', Number(shared[0].d) === 1, String(shared[0].d));

  // --------------------------------------- 11. cross-event isolation of edits
  r = await call('DELETE', `/api/events/${eventIdB}/requirements/${requirementId}`);
  check('requirement from event A cannot be deleted via event B (404)', r.status === 404, `status=${r.status}`);
  check('requirement from event A still exists', Number(raw('SELECT COUNT(*) c FROM event_equipment_requirements WHERE id=?', requirementId)[0].c) === 1);

  // ------------------------------------------------ 12. planning discussion
  r = await call('POST', `/api/events/${eventIdA}/discussions`, { body: '' });
  check('empty discussion post rejected (400)', r.status === 400, `status=${r.status}`);

  r = await call('POST', `/api/events/${eventIdA}/discussions`, { body: 'Confirm whether the Media Room projector is free.' });
  check('planning note posted', r.status === 201 && Number.isFinite(j(r).id), JSON.stringify(r.data));
  discussionId = j(r).id;

  r = await call('GET', `/api/events/${eventIdA}/discussions`);
  const notes = j(r).data || [];
  check('planning note listed with an author', notes.length === 1 && Boolean(notes[0].authorName), JSON.stringify(notes));

  // ------------------------------------------------------ 13. activity log
  r = await call('GET', `/api/events/${eventIdA}/activity`);
  const actions = (j(r).data || []).map((a) => a.action);
  check('activity records the event creation', actions.includes('event.create'), actions.join(','));
  check('activity records the requirement', actions.includes('event.requirement_add'), actions.join(','));
  check('activity records the assignment', actions.includes('assignment.create'), actions.join(','));
  check('activity records the discussion post', actions.includes('event.discussion_post'), actions.join(','));
  check('activity records the contact change', actions.includes('assignment.contact'), actions.join(','));
  check('activity rows carry an actor', (j(r).data || []).every((a) => Boolean(a.actorName)), JSON.stringify(j(r).data?.[0]));

  r = await call('GET', '/api/events/999999999/activity');
  check('activity for an unknown event is 404', r.status === 404, `status=${r.status}`);

  // -------------------------------------------- 14. dashboard + permissions
  r = await call('GET', '/api/dashboard');
  check('dashboard exposes activity to audit.read holder', Array.isArray(j(r).recentActivity), typeof j(r).recentActivity);

  // Anonymous requests must be refused before any data is returned.
  const anon = new Map();
  const anonCall = async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (anon.size) headers.Cookie = [...anon.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = anon.get('rcpas_csrf');
    if (csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) { const [pair] = c.split(';'); const i = pair.indexOf('='); anon.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  await anonCall('GET', '/api/auth/session');
  check('anonymous requirements read refused (401)', (await anonCall('GET', `/api/events/${eventIdA}/requirements`)).status === 401);
  check('anonymous discussion read refused (401)', (await anonCall('GET', `/api/events/${eventIdA}/discussions`)).status === 401);
  check('anonymous discussion write refused (401)', (await anonCall('POST', `/api/events/${eventIdA}/discussions`, { body: 'nope' })).status === 401);
  check('anonymous requirement write refused (401)', (await anonCall('POST', `/api/events/${eventIdA}/requirements`, { description: 'nope lens' })).status === 401);
  check('anonymous gear search refused (401)', (await anonCall('GET', '/api/equipment/search?q=70-200')).status === 401);
  check('anonymous activity read refused (401)', (await anonCall('GET', `/api/events/${eventIdA}/activity`)).status === 401);

  // ----------------------------------------- 15. persistence across re-login
  jar.clear();
  await call('GET', '/api/auth/session'); // a fresh jar must fetch the CSRF cookie first
  check('csrf cookie reissued after clearing the jar', Boolean(jar.get('rcpas_csrf')));
  r = await call('POST', '/api/auth/password/login', { email: 'admin@rcpas.local', password: passwordFor('TEST_ADMIN_PASSWORD') });
  check('re-login succeeds', r.status === 200, JSON.stringify(r.data));
  r = await call('GET', `/api/events/${eventIdA}/requirements`);
  check('requirement persisted across sessions', (j(r).data || []).length >= 1, JSON.stringify(j(r).data));
  r = await call('GET', `/api/events/${eventIdA}/discussions`);
  check('discussion persisted across sessions', (j(r).data || []).some((d) => d.id === discussionId), JSON.stringify(j(r).data));
}

/** Removes only the rows this script created. Never touches pre-existing data. */
function cleanup() {
  const removed = [];
  try {
    if (discussionId) { db.prepare('DELETE FROM event_discussions WHERE id=?').run(discussionId); removed.push('discussion'); }
    if (eventIdA) db.prepare('DELETE FROM event_equipment_requirements WHERE event_id=?').run(eventIdA);
    if (eventIdB) db.prepare('DELETE FROM event_equipment_requirements WHERE event_id=?').run(eventIdB);
    removed.push('requirements');
    if (eventIdA) db.prepare('DELETE FROM event_equipment_commitments WHERE event_id=?').run(eventIdA);
    if (eventIdB) db.prepare('DELETE FROM event_equipment_commitments WHERE event_id=?').run(eventIdB);
    removed.push('commitments');
    if (assignmentId) db.prepare('DELETE FROM event_assignments WHERE id=?').run(assignmentId);
    removed.push('assignments');
    if (eventIdA) { db.prepare('DELETE FROM audit_logs WHERE entity_type=\'event\' AND entity_id=?').run(String(eventIdA)); db.prepare('DELETE FROM events WHERE id=?').run(eventIdA); removed.push('event A'); }
    if (eventIdB) { db.prepare('DELETE FROM audit_logs WHERE entity_type=\'event\' AND entity_id=?').run(String(eventIdB)); db.prepare('DELETE FROM events WHERE id=?').run(eventIdB); removed.push('event B'); }
    if (lensId) db.prepare('DELETE FROM equipment WHERE id=?').run(lensId);
    if (memberId) { db.prepare('DELETE FROM member_roles WHERE member_id=?').run(memberId); db.prepare('DELETE FROM members WHERE id=?').run(memberId); removed.push('member'); }
    console.log(`\n  Cleaned up test records: ${removed.join(', ')}`);
  } catch (error) {
    console.log(`\n  WARNING — partial cleanup: ${(error && error.message) || error}`);
    console.log('  Test records may remain; remove them via tests/reset-data.mjs if needed.');
  }
}

try {
  await run();
} finally {
  cleanup();
  db.close();
}

console.log(`\nStage 1b: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
