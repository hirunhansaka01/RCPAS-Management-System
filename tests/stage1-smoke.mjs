// Stage 1 end-to-end smoke test. Run with: node tests/stage1-smoke.mjs
import { DatabaseSync } from 'node:sqlite';
import { passwordFor } from './creds.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const jar = new Map();

// Direct DB access is used only to temporarily revoke a permission so the
// server-side contact-masking path can be verified, then restore it.
const db = new DatabaseSync('data/rcpas.sqlite');
db.exec('PRAGMA busy_timeout=5000');
function sql(q) { return db.prepare(q).run(); }

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

async function run() {
  // 1. Health + CSRF bootstrap
  let r = await call('GET', '/health');
  check('health endpoint responds', r.status === 200 && j(r).ok === true, JSON.stringify(r.data));
  await call('GET', '/api/auth/session');
  check('csrf cookie issued', Boolean(jar.get('rcpas_csrf')), String([...jar.keys()]));
  await call('POST', '/api/auth/session'); // ensure csrf enforced on unsafe method
  r = await call('POST', '/api/auth/password/login', { email: 'admin@rcpas.local', password: passwordFor('TEST_ADMIN_PASSWORD') });
  check('admin login succeeds', r.status === 200 && j(r).ok === true, JSON.stringify(r.data));

  // 2. Session + permissions
  r = await call('GET', '/api/auth/session');
  const perms = j(r).user?.permissions || [];
  check('session returns user', Boolean(j(r).user));
  check('admin holds members.register', perms.includes('members.register'));
  check('admin holds contacts.read', perms.includes('contacts.read'));
  check('admin holds reports.export', perms.includes('reports.export'));
  check('admin holds users.manage', perms.includes('users.manage'));

  r = await call('GET', '/api/roles');
  const roles = j(r).roles || [];
  const roleName = (n) => (roles.find((x) => x.name === n) || {}).id;
  check('creative roles seeded', roles.length >= 8, `count=${roles.length}`);
  check('Lead Photographer role exists', Boolean(roleName('Lead Photographer')));
  check('Equipment Coordinator role exists', Boolean(roleName('Equipment Coordinator')));
  check('Second Shooter role exists', Boolean(roleName('Second Shooter')));

  r = await call('GET', '/api/equipment/categories');
  const cats = j(r).categories || [];
  const catId = (n) => (cats.find((c) => c.name === n) || {}).id;
  check('equipment categories seeded', cats.length >= 8, `count=${cats.length}`);

  // 3. Members (multi-role)
  const memberA = {
    memberCode: 'RCPAS/2026/101', fullName: 'Nimal Perera', grade: '12', className: 'A',
    membershipStart: '2026-01-05', status: 'Active', phone: '+94770000001', email: 'nimal@example.test',
    roleIds: [roleName('Photographer'), roleName('Photo Editor'), roleName('Lead Photographer'), roleName('Videographer')].filter(Boolean),
  };
  const memberB = {
    memberCode: 'RCPAS/2026/102', fullName: 'Sanduni Silva', grade: '11', className: 'B',
    membershipStart: '2026-01-05', status: 'Active', phone: '+94770000002', email: 'sanduni@example.test',
    roleIds: [roleName('Photographer'), roleName('Graphic Designer')].filter(Boolean),
  };
  r = await call('POST', '/api/members', memberA);
  check('member A registered (4 roles)', r.status === 201 && Number.isFinite(j(r).id), JSON.stringify(r.data));
  const idA = j(r).id;
  r = await call('POST', '/api/members', memberB);
  check('member B registered', r.status === 201, JSON.stringify(r.data));
  const idB = j(r).id;
  r = await call('POST', '/api/members', memberA);
  check('duplicate member code rejected (409)', r.status === 409, `status=${r.status}`);

  r = await call('GET', `/api/members/${idA}`);
  check('member detail returns 4 roles', (j(r).data?.roles || []).length === 4, JSON.stringify(j(r).data?.roles));
  check('member detail exposes phone (admin has contacts.read)', Boolean(j(r).data?.phone));
  check('member detail includes empty equipment list', Array.isArray(j(r).data?.equipment));

  // 4. Member-owned equipment with auto code
  r = await call('POST', `/api/members/${idA}/equipment`, {
    categoryId: catId('Cameras'), brand: 'Canon', model: 'EOS R5', quantity: 1,
    ownership: 'Personally Owned', conditionStatus: 'Good', availability: 'Available',
    itemName: 'My main body', keywords: 'portrait wedding',
  });
  check('camera body registered', r.status === 201 && Boolean(j(r).equipmentCode), JSON.stringify(r.data));
  const cameraId = j(r).id;

  r = await call('POST', `/api/members/${idA}/equipment`, {
    categoryId: catId('Lenses'), brand: 'Canon', model: 'EF 70-200mm f/2.8L', focalLength: '70-200mm',
    lensMount: 'Canon EF', quantity: 1, ownership: 'Personally Owned', conditionStatus: 'Excellent',
    availability: 'Available', itemName: 'Portrait lens', keywords: 'telephoto portrait sports',
  });
  check('70-200mm lens registered', r.status === 201 && Boolean(j(r).equipmentCode), JSON.stringify(r.data));
  const lensId = j(r).id;
  check('equipment code auto-generated (not empty)', typeof j(r).equipmentCode === 'string' && j(r).equipmentCode.length > 4);
  check('equipment code not manually invented', !/^(EQ-1|1)$/.test(j(r).equipmentCode), String(j(r).equipmentCode));

  r = await call('POST', `/api/members/${idA}/equipment`, { categoryId: catId('Tripods'), brand: 'Manfrotto', model: '190X', quantity: 1, ownership: 'Personally Owned', conditionStatus: 'Good', availability: 'Available' });
  check('tripod registered', r.status === 201, JSON.stringify(r.data));

  r = await call('GET', `/api/members/${idA}/equipment`);
  check('member equipment list has 3 items', (j(r).data || []).length === 3, `count=${(j(r).data || []).length}`);

  // 5. Equipment-based member search (the critical feature)
  for (const [q, label] of [['70-200', '70-200'], ['Canon 70-200', 'Canon 70-200'], ['telephoto lens', 'telephoto lens'], ['EOS R5', 'EOS R5'], ['portrait wedding', 'keywords portrait wedding']]) {
    r = await call('GET', `/api/equipment/search?q=${encodeURIComponent(q)}`);
    const owners = (j(r).data || []).map((x) => x.owner?.id);
    check(`equipment search "${label}" finds the owning member`, owners.includes(idA), `owners=${JSON.stringify(owners)}`);
  }
  r = await call('GET', '/api/equipment/search?q=70-200');
  const hit = (j(r).data || []).find((x) => x.owner?.id === idA);
  check('search hit carries member grade/class/roles', hit?.owner?.grade === '12' && (hit?.owner?.roles || []).includes('Photographer'), JSON.stringify(hit?.owner));
  check('search hit exposes phone for contacts.read holder', hit?.owner?.phone === '+94770000001', String(hit?.owner?.phone));
  r = await call('GET', '/api/equipment/search?q=tripod&ownership=Personally Owned');
  check('ownership filter works', (j(r).data || []).some((x) => x.owner?.id === idA), JSON.stringify(j(r).data?.length));
  r = await call('GET', '/api/members?equipment=70-200');
  check('member list filters by gear', (j(r).data || []).some((m) => m.id === idA), JSON.stringify((j(r).data || []).map((m) => m.id)));
  r = await call('GET', '/api/members/groups?by=role');
  check('member grouping by role returns counts', Array.isArray(j(r).groups) && j(r).groups.length > 0, JSON.stringify(j(r).groups));
  r = await call('GET', '/api/members/groups?by=bogus');
  check('unsupported grouping rejected (400)', r.status === 400, `status=${r.status}`);

  // 6. Events: single day, one start time, no end time
  const eventDate = '2026-11-14';
  const event1 = {
    eventCode: 'EVT-2026-001', name: 'Athletic Meet Coverage', category: 'Sports Coverage',
    description: 'Full day coverage of the inter-house athletic meet.', eventDate, startTime: '08:30',
    venue: 'Rahula College Main Ground', organizerMemberId: idA, priority: 'High', requiredTeamSize: 3,
    additionalInstructions: 'Arrive 30 minutes early for the opening ceremony.',
    photographyRequirements: '70-200mm lens, camera body, tripod',
    creativeRequirements: 'Lead Photographer, Photo Editor, Videographer',
    status: 'Planning', isDraft: true, notes: '',
  };
  r = await call('POST', '/api/events', event1);
  check('event created with date + single start time', r.status === 201, JSON.stringify(r.data));
  const ev1 = j(r).id;

  r = await call('POST', '/api/events', { ...event1, eventCode: 'EVT-2026-002', name: 'Science Exhibition', venue: 'Main Hall', startTime: '09:00' });
  check('second event created (same date)', r.status === 201, JSON.stringify(r.data));
  const ev2 = j(r).id;

  r = await call('GET', `/api/events/${ev1}`);
  const e1 = j(r).data;
  check('event detail exposes eventDate', e1?.eventDate === eventDate, String(e1?.eventDate));
  check('event detail exposes startTime', e1?.startTime === '08:30', String(e1?.startTime));
  check('endsAt is null (no fabricated end time)', e1?.endsAt === null || e1?.endsAt === undefined, String(e1?.endsAt));
  check('isDraft is a boolean', typeof e1?.isDraft === 'boolean', String(e1?.isDraft));
  check('requiredTeamSize persisted', e1?.requiredTeamSize === 3, String(e1?.requiredTeamSize));
  check('priority persisted', e1?.priority === 'High', String(e1?.priority));

  r = await call('POST', '/api/events', { ...event1, eventCode: 'EVT-2026-003', startTime: '25:99' });
  check('invalid start time rejected (400)', r.status === 400, `status=${r.status}`);
  r = await call('POST', '/api/events', { ...event1, eventCode: 'EVT-2026-004', eventDate: 'not-a-date' });
  check('invalid event date rejected (400)', r.status === 400, `status=${r.status}`);
  r = await call('POST', '/api/events', { ...event1, eventCode: 'EVT-2026-001' });
  check('duplicate event code rejected (409)', r.status === 409, `status=${r.status}`);

  // 7. Assignments + conflict warnings + override
  r = await call('POST', '/api/assignments', { eventId: ev1, memberId: idA, responsibility: 'Lead Photographer', status: 'Contact Pending', notes: '' });
  check('assignment created', r.status === 201 && Number.isFinite(j(r).id), JSON.stringify(r.data));
  const asg1 = j(r).id;

  r = await call('POST', '/api/assignments', { eventId: ev1, memberId: idA, responsibility: 'Lead Photographer', status: 'Contact Pending' });
  check('duplicate responsibility assignment rejected (409)', r.status === 409 && j(r).code === 'DUPLICATE_ASSIGNMENT', JSON.stringify(r.data));

  r = await call('POST', '/api/assignments', { eventId: ev2, memberId: idA, responsibility: 'Photo Editor', status: 'Contact Pending', overrideWarnings: false });
  check('same-date conflict returns warning (409)', r.status === 409 && j(r).code === 'ASSIGNMENT_WARNING', JSON.stringify(r.data));
  check('conflict warning is date-based and honest', (j(r).warnings || []).some((w) => /date/i.test(w) && /cannot confirm|cannot determine/i.test(w)), JSON.stringify(j(r).warnings));

  r = await call('POST', '/api/assignments', { eventId: ev2, memberId: idA, responsibility: 'Photo Editor', status: 'Contact Pending', overrideWarnings: true, overrideReason: '' });
  check('override without reason rejected (400)', r.status === 400 && j(r).code === 'OVERRIDE_REASON_REQUIRED', JSON.stringify(r.data));

  r = await call('POST', '/api/assignments', { eventId: ev2, memberId: idA, responsibility: 'Photo Editor', status: 'Contact Pending', overrideWarnings: true, overrideReason: 'Both events are covered by the same person with a break between.' });
  check('authorized same-date override accepted (201)', r.status === 201, JSON.stringify(r.data));
  const asg2 = j(r).id;

  // 8. Contact / confirmation workflow
  r = await call('PATCH', `/api/assignments/${asg1}/contact`, { status: 'Contacted' });
  check('assignment marked contacted', r.status === 200 && j(r).status === 'Contacted', JSON.stringify(r.data));
  r = await call('PATCH', `/api/assignments/${asg1}/contact`, { status: 'Confirmed' });
  check('assignment marked confirmed', r.status === 200 && j(r).status === 'Confirmed', JSON.stringify(r.data));
  r = await call('PATCH', `/api/assignments/${asg1}/contact`, { status: 'Declined' });
  check('assignment marked declined', r.status === 200 && j(r).status === 'Declined', JSON.stringify(r.data));
  r = await call('PATCH', `/api/assignments/${asg1}/contact`, { status: 'Confirmed' });
  check('assignment restored to confirmed', r.status === 200, `status=${r.status}`);
  r = await call('PATCH', `/api/assignments/${asg1}/contact`, { status: 'NotAStatus' });
  check('invalid contact status rejected (400)', r.status === 400, `status=${r.status}`);

  r = await call('GET', '/api/assignments?eventId=' + ev1);
  const stored = (j(r).data || []).find((a) => a.id === asg1);
  check('contacted_at recorded', Boolean(stored?.contactedAt), JSON.stringify(stored));
  check('confirmed_at recorded', Boolean(stored?.confirmedAt), JSON.stringify(stored));
  check('contacted_by resolved to an official', Boolean(stored?.contactedByName), String(stored?.contactedByName));

  r = await call('GET', '/api/audit');
  const auditRows = j(r).data || [];
  check('contact actions audited', auditRows.some((a) => a.action === 'assignment.contact'), JSON.stringify(auditRows.slice(0, 3).map((a) => a.action)));

  // 9. Equipment commitments
  r = await call('POST', `/api/events/${ev1}/commitments`, { equipmentId: lensId, status: 'Awaiting Confirmation' });
  check('equipment commitment recorded', r.status === 201, JSON.stringify(r.data));
  const cmId = j(r).id;
  r = await call('POST', `/api/events/${ev2}/commitments`, { equipmentId: lensId, status: 'Awaiting Confirmation' });
  check('same-date equipment double-booking blocked (409)', r.status === 409 && j(r).code === 'EQUIPMENT_CONFLICT', JSON.stringify(r.data));

  r = await call('PATCH', `/api/equipment/commitments/${cmId}`, { status: 'Confirmed', notes: 'Owner confirmed by phone.' });
  check('commitment confirmed by owner', r.status === 200, JSON.stringify(r.data));
  r = await call('PATCH', `/api/equipment/commitments/${cmId}`, { status: 'Bogus' });
  check('invalid commitment status rejected (400)', r.status === 400, `status=${r.status}`);

  r = await call('GET', `/api/events/${ev1}/commitments`);
  const cm = (j(r).data || []).find((c) => c.id === cmId);
  check('commitment lists brand/model/focal length', cm?.brand === 'Canon' && cm?.focalLength === '70-200mm', JSON.stringify(cm));
  check('commitment lists owning member', cm?.memberName === 'Nimal Perera', String(cm?.memberName));

  // 10. Readiness
  r = await call('GET', `/api/events/${ev1}/readiness`);
  const s = j(r).summary;
  check('readiness returns summary', Boolean(s), JSON.stringify(j(r).data));
  check('readiness reports assigned count', typeof s?.assigned === 'number', String(s?.assigned));
  check('readiness reports required team size', s?.requiredTeamSize === 3, String(s?.requiredTeamSize));
  check('readiness reports same-date conflicts', typeof s?.sameDateConflicts === 'number', String(s?.sameDateConflicts));
  check('readiness lists blockers while incomplete', Array.isArray(s?.blockers) && s.blockers.length > 0, JSON.stringify(s?.blockers));
  check('readiness not ready with unfilled roles', s?.ready === false, String(s?.ready));
  check('readiness groups required roles', Array.isArray(j(r).roles) && j(r).roles.length > 0, JSON.stringify(j(r).roles));

  // 11. Contact sheet
  r = await call('GET', `/api/events/${ev1}/contact-sheet`);
  check('contact sheet returns team', j(r).team?.length >= 1, JSON.stringify(j(r).summary));
  check('contact sheet returns message draft', typeof j(r).message === 'string' && j(r).message.includes('Athletic Meet'), String(j(r).message).slice(0, 60));
  check('contact sheet reports unfilled roles', Array.isArray(j(r).summary?.unfilledRoles), JSON.stringify(j(r).summary));
  r = await call('GET', `/api/events/${ev1}/contact-sheet.csv`);
  check('contact sheet CSV export works', r.status === 200 && String(r.data).includes('memberName'), `status=${r.status} type=${r.headers.get('content-type')}`);

  // 12. Dashboard widgets (all real data)
  r = await call('GET', '/api/dashboard');
  const d = j(r);
  check('dashboard returns welcome block', Boolean(d.welcome), JSON.stringify(d.welcome));
  check('welcome shows real signed-in user', d.welcome?.displayName?.length > 0, String(d.welcome?.displayName));
  check('welcome has greeting', /^(Good morning|Good afternoon|Good evening)/.test(d.welcome?.greeting || ''), String(d.welcome?.greeting));
  check('welcome exposes authorized actions', typeof d.welcome?.canRegisterMember === 'boolean' && typeof d.welcome?.canCreateEvent === 'boolean', JSON.stringify(d.welcome));
  check('welcome counts upcoming events', d.welcome?.upcoming >= 1, String(d.welcome?.upcoming));
  check('welcome counts responses due', typeof d.welcome?.awaitingResponses === 'number', String(d.welcome?.awaitingResponses));
  check('role distribution has real counts', (d.roleDistribution || []).some((x) => x.count > 0), JSON.stringify(d.roleDistribution));
  check('grade distribution has real counts', (d.gradeDistribution || []).length > 0, JSON.stringify(d.gradeDistribution));
  check('recent assignments populated from live data', (d.recentAssignments || []).length >= 1, `count=${(d.recentAssignments || []).length}`);
  const ra = (d.recentAssignments || [])[0];
  check('recent assignment has member/event/date/status', Boolean(ra?.memberName && ra?.eventName && ra?.eventDate && ra?.status), JSON.stringify(ra));
  check('recent administrative activity populated', (d.recentActivity || []).length >= 1, `count=${(d.recentActivity || []).length}`);
  check('recent activity has actor + entity', (d.recentActivity || []).every((a) => a.action && a.entityType !== undefined), JSON.stringify((d.recentActivity || []).slice(0, 2)));

  // 13. Reports + exports
  r = await call('GET', '/api/reports');
  const reportTypes = j(r).reports || [];
  check('report list includes Stage 1 reports', ['directory', 'skills', 'confirmations', 'readiness', 'workload', 'administrative'].every((t) => reportTypes.includes(t)), JSON.stringify(reportTypes));

  for (const t of ['directory', 'skills', 'confirmations', 'readiness', 'workload', 'participation', 'equipment', 'events', 'membership', 'roles', 'administrative']) {
    r = await call('GET', `/api/reports/${t}`);
    check(`report "${t}" returns rows`, r.status === 200 && Array.isArray(j(r).data), `status=${r.status} ${JSON.stringify(j(r)).slice(0, 120)}`);
  }
  r = await call('GET', `/api/reports/readiness?from=${eventDate}&to=${eventDate}`);
  const readyRows = j(r).data || [];
  check('readiness report filters by date', readyRows.some((x) => x.eventName === 'Athletic Meet Coverage'), JSON.stringify(readyRows));

  r = await call('GET', `/api/reports/directory/export.csv?from=&to=`);
  check('directory CSV export works', r.status === 200 && String(r.data).includes('Nimal Perera'), `status=${r.status}`);
  r = await call('GET', `/api/reports/readiness/export.csv?from=${eventDate}&to=${eventDate}`);
  check('readiness CSV export works', r.status === 200, `status=${r.status}`);
  r = await call('GET', '/api/reports/full/export.csv?from=&to=');
  check('full report CSV export works', r.status === 200, `status=${r.status}`);
  check('full report contains all sections', ['Members', 'Personal Equipment', 'Events', 'Assignments', 'Summary'].every((s) => String(r.data).includes(s)), String(r.data).slice(0, 200));
  check('full report contains real member name', String(r.data).includes('Nimal Perera'), String(r.data).slice(0, 200));

  r = await call('GET', '/api/reports/unknowntype');
  check('unknown report type falls back to event summary', r.status === 200, `status=${r.status}`);

  // 14. Members export includes gear + roles
  r = await call('GET', '/api/members/export.csv');
  check('member CSV export includes gear', r.status === 200 && String(r.data).includes('70-200mm'), `status=${r.status}`);
  r = await call('GET', '/api/equipment/export.csv');
  check('equipment CSV export works', r.status === 200 && String(r.data).includes('70-200mm'), `status=${r.status}`);

  // 15. Non-admin permission enforcement
  r = await call('POST', '/api/auth/password/logout');
  await new Promise((res) => setTimeout(res, 200));
  jar.delete('rcpas_session');
  r = await call('GET', '/api/auth/session');
  check('logout clears session', j(r).user === null || j(r).user === undefined, JSON.stringify(j(r)));

  r = await call('POST', '/api/auth/password/login', { email: 'president@rcpas.local', password: passwordFor('TEST_PRESIDENT_PASSWORD') });
  check('president login succeeds', r.status === 200 && j(r).ok === true, JSON.stringify(r.data));
  r = await call('GET', '/api/auth/session');
  const pPerms = j(r).user?.permissions || [];
  check('president lacks members.register', !pPerms.includes('members.register'), JSON.stringify(pPerms));
  check('president has contacts.read', pPerms.includes('contacts.read'), JSON.stringify(pPerms));
  check('president has members.write (can manage members)', pPerms.includes('members.write'), JSON.stringify(pPerms));

  r = await call('POST', '/api/members', { ...memberA, memberCode: 'RCPAS/2026/999', fullName: 'Blocked User' });
  check('non-admin blocked from registering members (403)', r.status === 403, `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await call('GET', '/api/members');
  check('non-admin can read members', r.status === 200, `status=${r.status}`);
  r = await call('GET', '/api/dashboard');
  check('non-admin can read dashboard', r.status === 200, `status=${r.status}`);
  r = await call('POST', '/api/events', { ...event1, eventCode: 'EVT-2026-010' });
  check('non-admin can create events (has events.write)', r.status === 201, `status=${r.status} ${JSON.stringify(r.data)}`);
  // President deliberately holds every permission except members.register.
  r = await call('GET', '/api/users');
  check('president can list users (by design)', r.status === 200, `status=${r.status}`);
  r = await call('GET', '/api/audit');
  check('president can read audit log (by design)', r.status === 200, `status=${r.status}`);
  r = await call('GET', '/api/reports/full/export.csv?from=&to=');
  check('president can export full report (by design)', r.status === 200, `status=${r.status}`);
  r = await call('PATCH', '/api/settings', { society_name: 'Rahula College Photographic Art Society' });
  check('president can update settings (by design)', r.status === 200, `status=${r.status} ${JSON.stringify(r.data)}`);

  // Contact masking: revoke contacts.read (President is the signed-in role here)
  // and confirm phone/email disappear server-side.
  r = await call('GET', `/api/members/${idA}`);
  check('contacts.read holder sees phone', Boolean(j(r).data?.phone), String(j(r).data?.phone));
  sql("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM system_roles WHERE name='President') AND permission_id=(SELECT id FROM permissions WHERE code='contacts.read')");
  r = await call('GET', `/api/members/${idA}`);
  check('phone masked when contacts.read revoked', j(r).data?.phone === null || j(r).data?.phone === undefined, JSON.stringify(j(r).data?.phone));
  check('contactsVisible reported false while masked', j(r).data?.contactsVisible === false, String(j(r).data?.contactsVisible));
  r = await call('GET', `/api/events/${ev1}/contact-sheet`);
  check('contact sheet blocked without contacts.read (403)', r.status === 403, `status=${r.status}`);
  r = await call('GET', '/api/members');
  check('member list phone masked without contacts.read', (j(r).data || []).every((m) => m.phone === null || m.phone === undefined), JSON.stringify((j(r).data || []).map((m) => m.phone)));
  sql("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT (SELECT id FROM system_roles WHERE name='President'), (SELECT id FROM permissions WHERE code='contacts.read')");
  r = await call('GET', `/api/members/${idA}`);
  check('phone visible again after permission restored', Boolean(j(r).data?.phone), String(j(r).data?.phone));

  // Chief Organizer: no users.*, no members.register.
  jar.delete('rcpas_session');
  r = await call('POST', '/api/auth/password/login', { email: 'chief@rcpas.local', password: passwordFor('TEST_CHIEF_PASSWORD') });
  check('chief organizer login succeeds', r.status === 200, JSON.stringify(r.data));
  r = await call('GET', '/api/members');
  check('chief organizer can read members', r.status === 200, `status=${r.status}`);
  r = await call('POST', '/api/members', { ...memberA, memberCode: 'RCPAS/2026/998' });
  check('chief organizer blocked from registering members (403)', r.status === 403, `status=${r.status}`);
  r = await call('GET', '/api/users');
  check('chief organizer blocked from users (403)', r.status === 403, `status=${r.status}`);
  r = await call('GET', '/api/audit');
  check('chief organizer can read audit log (by design)', r.status === 200, `status=${r.status}`);
  r = await call('PATCH', '/api/settings', { society_name: 'Rahula College Photographic Art Society' });
  check('chief organizer can update settings (by design)', r.status === 200, `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await call('GET', '/api/reports/full/export.csv?from=&to=');
  check('chief organizer can export full report', r.status === 200, `status=${r.status}`);
  r = await call('POST', '/api/events', { ...event1, eventCode: 'EVT-2026-011' });
  check('chief organizer can create events', r.status === 201, `status=${r.status} ${JSON.stringify(r.data)}`);

  // Authorized Organizer: 16 scoped operational permissions.
  jar.delete('rcpas_session');
  r = await call('POST', '/api/auth/password/login', { email: 'organizer@rcpas.local', password: passwordFor('TEST_ORGANIZER_PASSWORD') });
  check('authorized organizer login succeeds', r.status === 200, JSON.stringify(r.data));
  r = await call('GET', '/api/dashboard');
  check('organizer can read dashboard', r.status === 200, `status=${r.status}`);
  r = await call('GET', '/api/members');
  check('organizer can read members', r.status === 200, `status=${r.status}`);
  r = await call('POST', '/api/members', { ...memberA, memberCode: 'RCPAS/2026/997' });
  check('organizer blocked from registering members (403)', r.status === 403, `status=${r.status}`);
  r = await call('GET', '/api/settings');
  check('organizer blocked from settings read (403)', r.status === 403, `status=${r.status}`);
  r = await call('GET', '/api/audit');
  check('organizer blocked from audit log (403)', r.status === 403, `status=${r.status}`);
  r = await call('GET', '/api/users');
  check('organizer blocked from users (403)', r.status === 403, `status=${r.status}`);
  r = await call('POST', '/api/assignments', { eventId: ev1, memberId: idB, responsibility: 'Videographer', status: 'Contact Pending' });
  check('organizer can assign with no conflict (201)', r.status === 201, `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await call('POST', '/api/assignments', { eventId: ev2, memberId: idB, responsibility: 'Videographer', status: 'Contact Pending', overrideWarnings: true, overrideReason: 'not permitted' });
  check('organizer blocked from assignments.override (409)', r.status === 409 && j(r).code === 'ASSIGNMENT_WARNING', `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await call('GET', '/api/events/1/readiness');
  check('organizer can read event readiness', r.status === 200 || r.status === 404, `status=${r.status}`);

  // 16. Unauthenticated access
  r = await call('POST', '/api/auth/password/logout');
  await new Promise((res) => setTimeout(res, 200));
  jar.delete('rcpas_session');
  for (const p of ['/api/members', '/api/events', '/api/equipment', '/api/dashboard', '/api/reports/directory']) {
    r = await call('GET', p);
    check(`anonymous blocked from ${p}`, r.status === 401 || r.status === 403, `status=${r.status}`);
  }

  console.log(`\n===== Stage 1 smoke: ${pass} passed, ${fail} failed =====`);
  if (failures.length) {
    console.log('Failed checks:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => { console.error('SMOKE CRASH', e); process.exit(2); });
