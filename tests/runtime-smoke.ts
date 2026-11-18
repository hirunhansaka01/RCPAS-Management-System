import jwt from 'jsonwebtoken';
import { closeDb, execute, query } from '../src/server/db.js';

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const stamp = Date.now();
const openId = `smoke-openid-${stamp}`;
const email = `${openId}@example.invalid`;
const memberCode = `RCPAS/${new Date().getFullYear()}/${stamp}`;
const equipmentCode = `SMOKE-E-${stamp}`;
const eventCode = `SMOKE-V-${stamp}`;

async function main() {
  if (!process.env.MANUS_JWT_SECRET || !process.env.MANUS_PROJECT_ID) throw new Error('Platform JWT variables are required for the authenticated smoke test.');
  let userId: number | undefined;
  let memberId: number | undefined;
  let equipmentId: number | undefined;
  let eventId: number | undefined;
  try {
    await execute('INSERT INTO users (open_id,email,display_name,active) VALUES (?,?,?,TRUE)', [openId, email, 'Smoke Official']);
    const user = await query<any[]>('SELECT id FROM users WHERE open_id=?', [openId]);
    const role = await query<any[]>('SELECT id FROM system_roles WHERE name=?', ['System Administrator']);
    userId = user[0].id;
    await execute('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [userId, role[0].id]);
    const token = jwt.sign({ appId: process.env.MANUS_PROJECT_ID, openId }, process.env.MANUS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
    const headers = { Cookie: `webdev_app_session=${token}; __Host-rcpas_csrf=smoke-csrf`, 'X-CSRF-Token': 'smoke-csrf', 'Content-Type': 'application/json' };
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
      const text = await response.text();
      if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
      return { response, body: text ? JSON.parse(text) : null };
    };
    for (const path of ['/api/auth/session','/api/dashboard','/api/roles','/api/members','/api/equipment','/api/events','/api/assignments','/api/reports/membership','/api/settings','/api/audit']) { await call(path); console.log(`200 ${path}`); }
    for (const path of ['/api/members/export.csv','/api/equipment/export.csv','/api/reports/membership/export.csv']) { const { response } = await call(path); if (!response.headers.get('content-type')?.includes('text/csv')) throw new Error(`${path} did not return CSV`); console.log(`200 ${path} (CSV)`); }
    const createdMember = await call('/api/members', { method: 'POST', body: JSON.stringify({ memberCode, fullName:'Smoke Member', grade:'12', className:'A', membershipStart:'2026-01-01', status:'Active', roleIds:[] }) });
    memberId = createdMember.body.id; console.log(`201 /api/members (${memberId})`);
    const categories = await call('/api/equipment/categories');
    const createdEquipment = await call('/api/equipment', { method: 'POST', body: JSON.stringify({ equipmentCode, categoryId:categories.body.categories[0].id, brand:'Smoke', model:'Test Kit', quantity:1, ownership:'Society Owned', conditionStatus:'Good', availability:'Available', notes:'Temporary smoke test' }) });
    equipmentId = createdEquipment.body.id; console.log(`201 /api/equipment (${equipmentId})`);
    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000); const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
    const createdEvent = await call('/api/events', { method: 'POST', body: JSON.stringify({ eventCode, name:'Smoke Event', category:'Test', startsAt:startsAt.toISOString(), endsAt:endsAt.toISOString(), venue:'Smoke venue', status:'Upcoming', organizerMemberId:memberId }) });
    eventId = createdEvent.body.id; console.log(`201 /api/events (${eventId})`);
    const assignment = await call('/api/assignments', { method: 'POST', body: JSON.stringify({ eventId, memberId, responsibility:'Event Coordinator', status:'Proposed', notes:'Temporary smoke test', overrideWarnings:false }) });
    console.log(`201 /api/assignments (${assignment.body.id})`);
  } finally {
    if (eventId) await execute('DELETE FROM event_assignments WHERE event_id=?', [eventId]);
    if (equipmentId) await execute('DELETE FROM equipment_allocations WHERE equipment_id=?', [equipmentId]);
    if (eventId) await execute('DELETE FROM event_equipment_requirements WHERE event_id=?', [eventId]);
    if (eventId) await execute('DELETE FROM events WHERE id=?', [eventId]);
    if (equipmentId) await execute('DELETE FROM equipment WHERE id=?', [equipmentId]);
    if (memberId) { await execute('DELETE FROM member_roles WHERE member_id=?', [memberId]); await execute('DELETE FROM members WHERE id=?', [memberId]); }
    if (userId) { await execute('DELETE FROM audit_logs WHERE user_id=?', [userId]); await execute('DELETE FROM user_roles WHERE user_id=?', [userId]); await execute('DELETE FROM users WHERE id=?', [userId]); }
    closeDb();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
