import crypto from 'node:crypto';
import { Router } from 'express';
import { commitmentSchema, contactUpdateSchema, discussionSchema, eventSchema, assignmentSchema, allocationSchema, equipmentSchema, listQuerySchema, memberSchema, requirementSchema, requirementUpdateSchema } from '../../shared/schemas.js';
import { execute, query, withTransaction, type ExecuteResult } from '../db.js';
import { audit, requireAuth, requirePermission } from '../middleware/auth.js';
import { toCsv } from '../services/csv.js';
import { hashPassword, validatePasswordInput, verifyPassword } from '../password.js';

export const api = Router();
api.param('id', (_req, res, next, value) => { if (!/^\d+$/.test(value)) return res.status(400).json({ error: 'A numeric record ID is required.' }); next(); });

const pageMeta = (page: number, pageSize: number, total: number) => ({ page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) });
const int = (value: unknown) => Number.parseInt(String(value), 10);
const can = (req: any, permission: string) => Boolean(req.user?.permissions?.includes(permission));
const str = (value: unknown, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
/** Coerces a request body's role list to distinct positive integers. */
const normaliseRoleIds = (value: unknown): number[] => Array.isArray(value) ? [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];

/** All dates are stored as Sri Lanka wall-clock text; these are the display forms. */
const eventSelect = `SELECT e.id, e.event_code eventCode, e.name, e.description, e.category,
  e.event_date eventDate, e.start_time startTime,
  e.event_date || 'T' || e.start_time || ':00+05:30' startsAt,
  e.ends_at endsAt, e.venue, e.organizer_member_id organizerMemberId, om.full_name organizerName,
  e.priority, e.required_team_size requiredTeamSize, e.additional_instructions additionalInstructions,
  e.photography_requirements photographyRequirements, e.creative_requirements creativeRequirements,
  e.status, e.is_draft isDraft, e.notes,
  (SELECT COUNT(*) FROM event_assignments ea WHERE ea.event_id=e.id AND ea.status NOT IN ('Cancelled','Declined')) assignmentCount,
  (SELECT COUNT(*) FROM event_equipment_commitments ec WHERE ec.event_id=e.id AND ec.status NOT IN ('Released','Declined')) equipmentCount,
  e.created_at createdAt, e.updated_at updatedAt
  FROM events e LEFT JOIN members om ON om.id=e.organizer_member_id`;

const mapEvent = (row: any) => ({ ...row, isDraft: Number(row?.isDraft ?? 0) === 1 });

const ASSIGNMENT_ACTIVE = ['Proposed', 'Contact Pending', 'Contacted', 'Confirmed', 'Completed', 'Reassignment Needed'];
const AWAITING_RESPONSE = ['Proposed', 'Contact Pending', 'Contacted', 'Reassignment Needed'];

api.get('/auth/session', (req, res) => res.json({ user: req.user ?? null }));
api.post('/auth/password/login', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password || email.length > 191) return res.status(401).json({ error: 'Email or password is incorrect.', code: 'AUTH_FAILED' });
    const rows = await query<any[]>('SELECT id,open_id openId,email,display_name displayName,active,password_hash passwordHash,failed_login_count failedLoginCount,locked_until lockedUntil FROM users WHERE LOWER(email)=? LIMIT 1', [email]);
    const account = rows[0];
    if (!account?.active || !account.passwordHash) return res.status(401).json({ error: 'Email or password is incorrect.', code: 'AUTH_FAILED' });
    if (account.lockedUntil && new Date(account.lockedUntil).getTime() > Date.now()) return res.status(429).json({ error: 'This account is temporarily locked. Try again later or contact an administrator.', code: 'AUTH_LOCKED' });
    if (!await verifyPassword(password, account.passwordHash)) {
      await execute("UPDATE users SET failed_login_count=failed_login_count+1, locked_until=CASE WHEN failed_login_count+1 >= 5 THEN datetime('now','+15 minutes') ELSE locked_until END WHERE id=?", [account.id]);
      return res.status(401).json({ error: 'Email or password is incorrect.', code: 'AUTH_FAILED' });
    }
    const sessionId = crypto.randomBytes(32).toString('hex');
    await execute("INSERT INTO auth_sessions (id,user_id,expires_at,ip_address,user_agent) VALUES (?, ?, datetime('now','+8 hours'), ?, ?)", [sessionId, account.id, req.ip, String(req.get('user-agent') || '').slice(0, 255)]);
    await execute('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=CURRENT_TIMESTAMP WHERE id=?', [account.id]);
    await execute('INSERT INTO audit_logs (user_id,action,entity_type,entity_id,details,ip_address) VALUES (?, ?, ?, ?, ?, ?)', [account.id, 'auth.password_login', 'user', String(account.id), JSON.stringify({ method: 'password' }), req.ip]);
    res.cookie('rcpas_session', sessionId, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 8 * 60 * 60 * 1000 });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
api.post('/auth/password/change', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = validatePasswordInput(req.body?.newPassword);
    const rows = await query<any[]>('SELECT password_hash passwordHash FROM users WHERE id=? AND active=TRUE', [req.user!.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Official account not found.' });
    if (rows[0].passwordHash && !await verifyPassword(currentPassword, rows[0].passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.', code: 'PASSWORD_FAILED' });
    await execute('UPDATE users SET password_hash=?,password_changed_at=CURRENT_TIMESTAMP,failed_login_count=0,locked_until=NULL WHERE id=?', [await hashPassword(newPassword), req.user!.id]);
    if (req.cookies?.rcpas_session) await execute('DELETE FROM auth_sessions WHERE user_id=? AND id<>?', [req.user!.id, req.cookies.rcpas_session]);
    await audit(req, 'auth.password_change', 'user', req.user!.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
api.post('/auth/logout', requireAuth, async (req, res) => { if (req.cookies?.rcpas_session) await execute('DELETE FROM auth_sessions WHERE id=?', [req.cookies.rcpas_session]); await audit(req, 'auth.logout', 'user', req.user!.id); res.clearCookie('rcpas_session', { httpOnly: true, sameSite: 'lax', secure: true }); res.json({ ok: true }); });

// ---------------------------------------------------------------------------
// Dashboard — every widget reads live database records.
// ---------------------------------------------------------------------------
api.get('/dashboard', requirePermission('dashboard.view'), async (req, res) => {
  const greetingHour = Number(new Date().getHours());
  const greeting = greetingHour < 12 ? 'Good morning' : greetingHour < 17 ? 'Good afternoon' : 'Good evening';
  const [metrics, roleDistribution, gradeDistribution, upcomingEvents, recentAssignments, recentActivity, userCounts] = await Promise.all([
    query<any[]>(`SELECT
      (SELECT COUNT(*) FROM members WHERE archived_at IS NULL) totalMembers,
      (SELECT COUNT(*) FROM members WHERE status='Active' AND archived_at IS NULL) activeMembers,
      (SELECT COUNT(DISTINCT mr.member_id) FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE cr.name='Photographer' AND cr.active=TRUE) photographers,
      (SELECT COUNT(DISTINCT mr.member_id) FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE cr.name='Photo Editor' AND cr.active=TRUE) editors,
      (SELECT COUNT(DISTINCT mr.member_id) FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE cr.name='Graphic Designer' AND cr.active=TRUE) designers,
      (SELECT COUNT(DISTINCT mr.member_id) FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE cr.name='Videographer' AND cr.active=TRUE) videographers,
      (SELECT COUNT(*) FROM events WHERE status IN ('Planning','Ready','Confirmed') AND archived_at IS NULL AND event_date >= date('now')) upcomingEvents,
      (SELECT COALESCE(SUM(quantity),0) FROM equipment WHERE availability='Available' AND archived_at IS NULL) availableEquipment,
      (SELECT COUNT(*) FROM events e WHERE e.archived_at IS NULL AND e.status IN ('Planning','Ready','Confirmed')
         AND e.event_date >= date('now')
         AND (SELECT COUNT(*) FROM event_assignments ea WHERE ea.event_id=e.id AND ea.status='Confirmed')
             < CASE WHEN e.required_team_size > 0 THEN e.required_team_size ELSE 1 END) pendingEvents,
      (SELECT COUNT(*) FROM event_assignments WHERE status IN ('Proposed','Contact Pending','Contacted','Reassignment Needed')) awaitingConfirmation,
      (SELECT COUNT(*) FROM event_equipment_commitments WHERE status IN ('Offered','Awaiting Confirmation')) equipmentAwaiting,
      (SELECT COUNT(*) FROM event_equipment_commitments WHERE status='Confirmed') equipmentConfirmed,
      (SELECT COUNT(*) FROM events e WHERE e.archived_at IS NULL AND e.status IN ('Planning','Ready','Confirmed') AND e.required_team_size > 0
         AND (SELECT COUNT(*) FROM event_assignments ea WHERE ea.event_id=e.id AND ea.status NOT IN ('Cancelled','Declined')) < e.required_team_size) unfilledRoles`),
    query<any[]>(`SELECT cr.name, COUNT(DISTINCT CASE WHEN m.id IS NOT NULL AND m.archived_at IS NULL THEN mr.member_id END) count
      FROM creative_roles cr LEFT JOIN member_roles mr ON mr.role_id=cr.id LEFT JOIN members m ON m.id=mr.member_id
      WHERE cr.active=TRUE GROUP BY cr.id, cr.name ORDER BY count DESC, cr.name ASC`),
    query<any[]>(`SELECT m.grade, m.class_name className, COUNT(*) count FROM members m WHERE m.archived_at IS NULL AND m.status='Active' GROUP BY m.grade, m.class_name ORDER BY m.grade, m.class_name`),
    query<any[]>(`${eventSelect} WHERE e.archived_at IS NULL AND e.status IN ('Planning','Ready','Confirmed') AND e.event_date >= date('now') ORDER BY e.event_date ASC, e.start_time ASC LIMIT 5`),
    query<any[]>(`SELECT ea.id, ea.event_id eventId, e.name eventName, e.event_date eventDate, e.start_time startTime,
      e.event_date || 'T' || e.start_time || ':00+05:30' startsAt, ea.member_id memberId, m.full_name memberName,
      m.member_code memberCode, ea.responsibility, ea.status, ea.notes, ea.updated_at updatedAt
      FROM event_assignments ea JOIN events e ON e.id=ea.event_id JOIN members m ON m.id=ea.member_id
      WHERE e.archived_at IS NULL ORDER BY ea.updated_at DESC LIMIT 8`),
    query<any[]>(`SELECT a.id, a.action, a.entity_type entityType, a.entity_id entityId, a.details, a.created_at createdAt, u.display_name actorName
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 8`),
    query<any[]>(`SELECT (SELECT COUNT(*) FROM users WHERE active=TRUE) activeOfficials,
      (SELECT COUNT(*) FROM event_assignments WHERE status IN ('Proposed','Contact Pending','Contacted','Reassignment Needed')) responsesDue`),
  ]);

  const me = req.user!;
  const upcomingCount = Number(upcomingEvents.length);
  const responsesDue = Number(userCounts[0]?.responsesDue ?? 0);
  res.json({
    metrics: metrics[0] ?? {},
    roleDistribution,
    gradeDistribution,
    upcomingEvents: upcomingEvents.map(mapEvent),
    recentAssignments,
    recentActivity: can(req, 'audit.read') ? recentActivity : null,
    welcome: {
      displayName: me.displayName,
      roles: me.roles,
      greeting,
      upcoming: upcomingCount,
      awaitingResponses: responsesDue,
      pendingEvents: Number((metrics[0] as any)?.pendingEvents ?? 0),
      unfilledRoles: Number((metrics[0] as any)?.unfilledRoles ?? 0),
      equipmentAwaiting: Number((metrics[0] as any)?.equipmentAwaiting ?? 0),
      canRegisterMember: can(req, 'members.register'),
      canCreateEvent: can(req, 'events.write'),
      canManageMembers: can(req, 'members.write'),
      canViewReports: can(req, 'reports.read'),
    },
  });
});

// ---------------------------------------------------------------------------
// Creative roles
// ---------------------------------------------------------------------------
api.get('/roles', requirePermission('creative.read'), async (_req, res) => res.json({ roles: await query<any[]>('SELECT id, name, active FROM creative_roles WHERE active=TRUE ORDER BY name') }));
api.post('/roles', requirePermission('creative.write'), async (req, res, next) => {
  try {
    const name = str(req.body?.name, 80);
    if (name.length < 2) return res.status(400).json({ error: 'A role name of at least 2 characters is required.' });
    const existing = await query<any[]>('SELECT id FROM creative_roles WHERE LOWER(name)=?', [name.toLowerCase()]);
    if (existing[0]) return res.status(409).json({ error: 'A creative role with that name already exists.', code: 'DUPLICATE_ROLE' });
    const result = await execute('INSERT INTO creative_roles (name) VALUES (?)', [name]);
    await audit(req, 'creative_role.create', 'creative_role', result.insertId, { name });
    res.status(201).json({ id: result.insertId });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
api.get('/members/export.csv', requirePermission('members.export'), async (req, res) => {
  const includeContacts = can(req, 'contacts.read');
  const rows = await query<any[]>(`SELECT m.member_code memberId, m.full_name fullName, m.grade, m.class_name className, m.status,
    ${includeContacts ? 'm.email, m.phone' : "'' email, '' phone"},
    COALESCE((SELECT GROUP_CONCAT(cr.name, '; ') FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE mr.member_id=m.id), '') roles,
    COALESCE((SELECT GROUP_CONCAT(eq.brand || ' ' || eq.model || CASE WHEN eq.focal_length IS NULL OR eq.focal_length = '' THEN '' ELSE ' (' || eq.focal_length || ')' END, '; ')
      FROM equipment eq WHERE eq.responsible_member_id = m.id AND eq.archived_at IS NULL), '') equipment
    FROM members m WHERE m.archived_at IS NULL ORDER BY m.full_name`);
  await audit(req, 'member.export', 'export', 'members', { count: rows.length, includeContacts });
  res.type('text/csv').attachment('rcpas-members.csv').send(toCsv(rows));
});

api.get('/members/groups', requirePermission('members.read'), async (req, res) => {
  const by = str(req.query.by, 20) || 'role';
  const map: Record<string, string> = {
    role: `SELECT cr.name key, COUNT(DISTINCT m.id) count FROM creative_roles cr
           LEFT JOIN member_roles mr ON mr.role_id=cr.id LEFT JOIN members m ON m.id=mr.member_id AND m.archived_at IS NULL AND m.status='Active'
           WHERE cr.active=TRUE GROUP BY cr.id, cr.name ORDER BY count DESC, cr.name`,
    grade: `SELECT m.grade || ' - ' || m.class_name key, COUNT(*) count FROM members m WHERE m.archived_at IS NULL AND m.status='Active' GROUP BY m.grade, m.class_name ORDER BY m.grade, m.class_name`,
    status: `SELECT m.status key, COUNT(*) count FROM members m WHERE m.archived_at IS NULL GROUP BY m.status ORDER BY count DESC`,
    availability: `SELECT COALESCE(NULLIF(m.availability, ''), 'Not specified') key, COUNT(*) count FROM members m WHERE m.archived_at IS NULL AND m.status='Active' GROUP BY key ORDER BY count DESC`,
  };
  if (!map[by]) return res.status(400).json({ error: `Unsupported grouping "${by}". Use role, grade, status, or availability.` });
  res.json({ by, groups: await query<any[]>(map[by]) });
});

// ---------------------------------------------------------------------------
// Unified search: one query across members, events, and gear.
// Each section is only returned when the caller holds that module's read
// permission, so the endpoint never leaks data the caller could not already
// list from its own page.
// ---------------------------------------------------------------------------
api.get('/search', requireAuth, async (req, res, next) => {
  try {
    const q = str(req.query.q, 120).trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 25);
    const result: { q: string; members: any[]; events: any[]; gear: any[] } = { q, members: [], events: [], gear: [] };
    if (q.length < 2) return res.json(result);
    const like = `%${q}%`;

    if (can(req, 'members.read')) {
      result.members = await query<any[]>(
        `SELECT m.id, m.member_code memberCode, m.full_name fullName, m.grade, m.class_name className, m.status
         FROM members m WHERE m.archived_at IS NULL
           AND (m.full_name LIKE ? OR m.member_code LIKE ? OR m.email LIKE ? OR m.phone LIKE ? OR m.skills LIKE ?)
         ORDER BY m.full_name ASC LIMIT ?`,
        [like, like, like, like, like, limit]);
    }

    if (can(req, 'events.read')) {
      result.events = await query<any[]>(
        `SELECT e.id, e.event_code eventCode, e.name, e.event_date eventDate, e.start_time startTime, e.venue, e.status
         FROM events e WHERE e.archived_at IS NULL
           AND (e.name LIKE ? OR e.event_code LIKE ? OR e.venue LIKE ? OR e.category LIKE ?)
         ORDER BY e.event_date DESC LIMIT ?`,
        [like, like, like, like, limit]);
    }

    if (can(req, 'equipment.read')) {
      result.gear = await query<any[]>(
        `SELECT e.id, e.equipment_code equipmentCode, e.brand, e.model, e.item_name itemName, e.focal_length focalLength,
                e.availability, c.name categoryName, m.full_name ownerName, m.id ownerId
         FROM equipment e
         JOIN equipment_categories c ON c.id = e.category_id
         LEFT JOIN members m ON m.id = e.responsible_member_id AND m.archived_at IS NULL
         WHERE e.archived_at IS NULL
           AND (e.equipment_code LIKE ? OR e.brand LIKE ? OR e.model LIKE ? OR e.item_name LIKE ?
                OR e.focal_length LIKE ? OR e.keywords LIKE ? OR c.name LIKE ? OR m.full_name LIKE ?)
         ORDER BY e.updated_at DESC LIMIT ?`,
        [like, like, like, like, like, like, like, like, limit]);
    }

    res.json(result);
  } catch (error) { next(error); }
});

api.get('/members', requirePermission('members.read'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid member filters.', details: parsed.error.flatten().fieldErrors });
  const { search, status, grade, className, role, page, pageSize, sort } = parsed.data;
  const equipmentQuery = str(req.query.equipment, 160);
  const where = ['m.archived_at IS NULL'];
  const params: any[] = [];
  const orderBy = sort === 'name' ? 'm.full_name ASC' : sort === 'grade' ? 'm.grade ASC, m.class_name ASC, m.full_name ASC' : 'm.updated_at DESC';
  const contactColumns = can(req, 'contacts.read') ? 'm.phone, m.email' : 'NULL phone, NULL email';

  if (search) {
    const like = `%${search}%`;
    where.push(`(m.full_name LIKE ? OR m.member_code LIKE ? OR m.email LIKE ? OR m.phone LIKE ? OR m.grade LIKE ? OR m.class_name LIKE ?
      OR m.skills LIKE ? OR m.experience LIKE ? OR m.availability LIKE ?
      OR EXISTS (SELECT 1 FROM member_roles mr3 JOIN creative_roles cr3 ON cr3.id=mr3.role_id WHERE mr3.member_id=m.id AND cr3.name LIKE ?)
      OR EXISTS (SELECT 1 FROM equipment eq WHERE eq.responsible_member_id=m.id AND eq.archived_at IS NULL
        AND (eq.brand LIKE ? OR eq.model LIKE ? OR eq.focal_length LIKE ? OR eq.item_name LIKE ? OR eq.keywords LIKE ?
             OR eq.lens_mount LIKE ? OR eq.equipment_code LIKE ?
             OR eq.category_id IN (SELECT id FROM equipment_categories WHERE name LIKE ?))))`);
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like);
  }
  if (equipmentQuery) {
    const like = `%${equipmentQuery}%`;
    where.push(`EXISTS (SELECT 1 FROM equipment eq2 WHERE eq2.responsible_member_id=m.id AND eq2.archived_at IS NULL
      AND (eq2.brand LIKE ? OR eq2.model LIKE ? OR eq2.focal_length LIKE ? OR eq2.item_name LIKE ? OR eq2.keywords LIKE ?
           OR eq2.lens_mount LIKE ? OR eq2.equipment_code LIKE ?
           OR eq2.category_id IN (SELECT id FROM equipment_categories WHERE name LIKE ?)))`);
    params.push(like, like, like, like, like, like, like, like);
  }
  if (status) { where.push('m.status=?'); params.push(status); }
  if (grade) { where.push('m.grade=?'); params.push(grade); }
  if (className) { where.push('m.class_name=?'); params.push(className); }
  if (role) { where.push('EXISTS (SELECT 1 FROM member_roles mr2 JOIN creative_roles cr2 ON cr2.id=mr2.role_id WHERE mr2.member_id=m.id AND cr2.name=?)'); params.push(role); }

  const whereSql = where.join(' AND ');
  const totalRows = await query<any[]>(`SELECT COUNT(*) total FROM members m WHERE ${whereSql}`, params);
  const total = Number(totalRows[0]?.total || 0);
  const offset = (page - 1) * pageSize;
  const rows = await query<any[]>(`SELECT m.id, m.member_code memberCode, m.full_name fullName, m.grade, m.class_name className,
    date(m.membership_start) membershipStart, m.status, ${contactColumns}, m.experience, m.skills, m.availability, m.notes,
    m.created_at createdAt, m.updated_at updatedAt,
    COALESCE((SELECT GROUP_CONCAT(CONCAT(cr.id, ':', cr.name, ':', mr.level), '|') FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE mr.member_id=m.id), '') roleData,
    COALESCE((SELECT GROUP_CONCAT(eq.brand || ' ' || eq.model || CASE WHEN eq.focal_length IS NULL OR eq.focal_length = '' THEN '' ELSE ' (' || eq.focal_length || ')' END, '; ') FROM equipment eq WHERE eq.responsible_member_id = m.id AND eq.archived_at IS NULL), '') equipment,
    (SELECT COUNT(*) FROM equipment eq WHERE eq.responsible_member_id=m.id AND eq.archived_at IS NULL) equipmentCount,
    (SELECT COUNT(*) FROM event_assignments ea WHERE ea.member_id=m.id AND ea.status NOT IN ('Cancelled','Declined')) assignmentCount
    FROM members m WHERE ${whereSql} GROUP BY m.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  res.json({
    data: rows.map((row) => ({
      ...row,
      roles: row.roleData ? String(row.roleData).split('|').map((v) => { const [id, name, level] = v.split(':'); return { id: Number(id), name, level }; }) : [],
    })),
    meta: pageMeta(page, pageSize, total),
  });
});

api.get('/members/:id', requirePermission('members.read'), async (req, res) => {
  const contactColumns = can(req, 'contacts.read') ? 'm.phone, m.email' : 'NULL phone, NULL email';
  const rows = await query<any[]>(`SELECT m.*, ${contactColumns}, date(m.membership_start) membershipStart,
    COALESCE((SELECT GROUP_CONCAT(CONCAT(cr.id, ':', cr.name, ':', mr.level), '|') FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE mr.member_id=m.id), '') roleData
    FROM members m WHERE m.id=? GROUP BY m.id`, [int(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Member not found.' });
  const row = rows[0];
  const equipment = await query<any[]>(`SELECT e.id, e.equipment_code equipmentCode, e.asset_id assetId, e.category_id categoryId, c.name categoryName,
    e.item_name itemName, e.brand, e.model, e.focal_length focalLength, e.lens_mount lensMount, e.keywords,
    e.quantity, e.ownership, e.condition_status conditionStatus, e.availability, e.notes, e.created_at createdAt, e.updated_at updatedAt
    FROM equipment e JOIN equipment_categories c ON c.id=e.category_id
    WHERE e.responsible_member_id=? AND e.archived_at IS NULL ORDER BY c.name, e.brand, e.model`, [int(req.params.id)]);
  const assignments = await query<any[]>(`SELECT ea.id, ea.event_id eventId, e.name eventName, e.event_date eventDate, e.start_time startTime,
    ea.responsibility, ea.status, ea.notes, ea.contacted_at contactedAt, ea.confirmed_at confirmedAt, ea.created_at createdAt
    FROM event_assignments ea JOIN events e ON e.id=ea.event_id WHERE ea.member_id=? AND e.archived_at IS NULL
    ORDER BY e.event_date DESC, e.start_time DESC LIMIT 50`, [int(req.params.id)]);
  res.json({
    data: {
      ...row,
      roles: row.roleData ? String(row.roleData).split('|').map((v) => { const [id, name, level] = v.split(':'); return { id: Number(id), name, level }; }) : [],
      equipment,
      assignments,
      contactsVisible: can(req, 'contacts.read'),
    },
  });
});

api.get('/members/:id/equipment', requirePermission('equipment.read'), async (req, res) => {
  const id = int(req.params.id);
  const member = await query<any[]>('SELECT id FROM members WHERE id=? AND archived_at IS NULL', [id]);
  if (!member[0]) return res.status(404).json({ error: 'Member not found.' });
  res.json({ data: await query<any[]>(`SELECT e.id, e.equipment_code equipmentCode, e.asset_id assetId, e.category_id categoryId, c.name categoryName,
    e.item_name itemName, e.brand, e.model, e.focal_length focalLength, e.lens_mount lensMount, e.keywords,
    e.quantity, e.ownership, e.condition_status conditionStatus, e.availability, e.notes, e.created_at createdAt, e.updated_at updatedAt
    FROM equipment e JOIN equipment_categories c ON c.id=e.category_id WHERE e.responsible_member_id=? AND e.archived_at IS NULL
    ORDER BY c.name, e.brand, e.model`, [id]) });
});

api.post('/members', requirePermission('members.register'), async (req, res, next) => {
  try {
    const data = memberSchema.parse(req.body);
    const duplicate = await query<any[]>('SELECT id FROM members WHERE member_code=? AND archived_at IS NULL', [data.memberCode]);
    if (duplicate[0]) return res.status(409).json({ error: 'A member with that member ID already exists.', code: 'DUPLICATE_MEMBER_CODE' });
    const created = await withTransaction(async (connection) => {
      const [result] = await connection.execute<any>('INSERT INTO members (member_code, full_name, grade, class_name, membership_start, status, phone, email, experience, skills, availability, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [data.memberCode, data.fullName, data.grade, data.className, data.membershipStart, data.status, data.phone || null, data.email || null, data.experience || null, data.skills || null, data.availability || null, data.notes || null]);
      for (const roleId of data.roleIds) await connection.execute('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)', [result.insertId, roleId]);
      return result.insertId;
    });
    await audit(req, 'member.create', 'member', created, { memberCode: data.memberCode, roles: data.roleIds.length });
    res.status(201).json({ id: created });
  } catch (error) { next(error); }
});
api.patch('/members/:id', requirePermission('members.write'), async (req, res, next) => {
  try {
    const data = memberSchema.parse(req.body);
    const id = int(req.params.id);
    const duplicate = await query<any[]>('SELECT id FROM members WHERE member_code=? AND archived_at IS NULL AND id<>?', [data.memberCode, id]);
    if (duplicate[0]) return res.status(409).json({ error: 'A member with that member ID already exists.', code: 'DUPLICATE_MEMBER_CODE' });
    await withTransaction(async (connection) => {
      await connection.execute('UPDATE members SET member_code=?, full_name=?, grade=?, class_name=?, membership_start=?, status=?, phone=?, email=?, experience=?, skills=?, availability=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND archived_at IS NULL', [data.memberCode, data.fullName, data.grade, data.className, data.membershipStart, data.status, data.phone || null, data.email || null, data.experience || null, data.skills || null, data.availability || null, data.notes || null, id]);
      await connection.execute('DELETE FROM member_roles WHERE member_id=?', [id]);
      for (const roleId of data.roleIds) await connection.execute('INSERT INTO member_roles (member_id, role_id) VALUES (?, ?)', [id, roleId]);
    });
    await audit(req, 'member.update', 'member', id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
api.delete('/members/:id', requirePermission('members.write'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    await execute("UPDATE members SET status='Inactive', archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND archived_at IS NULL", [id]);
    await audit(req, 'member.archive', 'member', id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Equipment — member-owned gear, auto-assigned internal code, owner search.
// ---------------------------------------------------------------------------
const EQUIPMENT_SELECT = `SELECT e.id, e.equipment_code equipmentCode, e.asset_id assetId, e.category_id categoryId, c.name categoryName,
  e.item_name itemName, e.brand, e.model, e.focal_length focalLength, e.lens_mount lensMount, e.keywords,
  e.quantity, e.ownership, e.responsible_member_id ownerMemberId, m.full_name ownerMemberName,
  e.responsible_member_id responsibleMemberId, m.full_name responsibleMemberName,
  e.condition_status conditionStatus, e.availability, e.notes, e.created_at createdAt, e.updated_at updatedAt
  FROM equipment e JOIN equipment_categories c ON c.id=e.category_id LEFT JOIN members m ON m.id=e.responsible_member_id`;

/** Free-text terms that resolve to a seeded category when no explicit category word is present. */
const EQUIPMENT_SYNONYMS: Record<string, string> = {
  telephoto: "(e.focal_length LIKE '%70-200%' OR e.focal_length LIKE '%75-300%' OR e.focal_length LIKE '%100-400%' OR e.focal_length LIKE '%135%' OR e.focal_length LIKE '%200%' OR e.focal_length LIKE '%300%' OR e.keywords LIKE '%telephoto%')",
  lens: "c.name='Lenses'", lenses: "c.name='Lenses'", prime: "c.name='Lenses'", zoom: "c.name='Lenses'",
  camera: "c.name='Cameras'", cameras: "c.name='Cameras'", body: "c.name='Cameras'", dslr: "c.name='Cameras'", mirrorless: "c.name='Cameras'",
  tripod: "c.name='Tripods'", monopod: "c.name='Tripods'",
  flash: "c.name='Flashes'", strobe: "c.name='Flashes'", 'external flash': "c.name='Flashes'", speedlight: "c.name='Flashes'",
  microphone: "c.name='Microphones'", mic: "c.name='Microphones'", audio: "c.name='Microphones'",
  gimbal: "c.name='Stabilizers'", stabilizer: "c.name='Stabilizers'", steadicam: "c.name='Stabilizers'",
  lighting: "c.name='Lighting'", light: "c.name='Lighting'", led: "c.name='Lighting'", stand: "c.name='Lighting'", reflector: "c.name='Lighting'", softbox: "c.name='Lighting'",
  drone: "c.name='Drones'", memory: "c.name='Memory Cards & Accessories'", card: "c.name='Memory Cards & Accessories'",
  battery: "c.name='Memory Cards & Accessories'",
};

function buildEquipmentMatcher(queryText: string): { sql: string; params: any[] } {
  const tokens = queryText.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return { sql: '1=1', params: [] };
  const clauses: string[] = [];
  const params: any[] = [];
  for (const token of tokens) {
    if (EQUIPMENT_SYNONYMS[token]) { clauses.push(EQUIPMENT_SYNONYMS[token]); continue; }
    clauses.push(`(LOWER(COALESCE(e.brand,'')) LIKE ? OR LOWER(COALESCE(e.model,'')) LIKE ? OR LOWER(COALESCE(e.focal_length,'')) LIKE ?
      OR LOWER(COALESCE(e.item_name,'')) LIKE ? OR LOWER(COALESCE(e.keywords,'')) LIKE ? OR LOWER(COALESCE(e.lens_mount,'')) LIKE ?
      OR LOWER(e.equipment_code) LIKE ? OR LOWER(COALESCE(c.name,'')) LIKE ? OR LOWER(COALESCE(m.full_name,'')) LIKE ?)`);
    const like = `%${token}%`;
    params.push(like, like, like, like, like, like, like, like, like);
  }
  return { sql: clauses.join(' AND '), params };
}

api.get('/equipment/categories', requirePermission('equipment.read'), async (_req, res) => res.json({ categories: await query<any[]>('SELECT id, name FROM equipment_categories WHERE active=TRUE ORDER BY name') }));

/**
 * Critical feature: search every member's registered gear and return the owning
 * member with role, grade and class so an organizer can build a team from gear.
 */
api.get('/equipment/search', requirePermission('equipment.read'), async (req, res) => {
  const q = str(req.query.q, 160);
  const eventId = Number(req.query.eventId || 0) || null;
  const dateFilter = str(req.query.date, 10) || null;
  const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
  const { sql, params } = buildEquipmentMatcher(q);
  const where = ['e.archived_at IS NULL', 'm.archived_at IS NULL'];
  if (sql !== '1=1') where.push(`(${sql})`);
  const ownership = str(req.query.ownership, 40);
  if (ownership) { where.push('e.ownership=?'); params.push(ownership); }
  // Gear Directory filters — every one narrows the same real result set.
  const categoryId = Number(req.query.categoryId || 0) || null;
  if (categoryId) { where.push('e.category_id=?'); params.push(categoryId); }
  const availability = str(req.query.availability, 40);
  if (availability) { where.push('e.availability=?'); params.push(availability); }
  const grade = str(req.query.grade, 40);
  if (grade) { where.push('m.grade=?'); params.push(grade); }
  const className = str(req.query.className, 40);
  if (className) { where.push('m.class_name=?'); params.push(className); }
  const role = str(req.query.role, 100);
  if (role) {
    where.push('EXISTS (SELECT 1 FROM member_roles mr3 JOIN creative_roles cr3 ON cr3.id=mr3.role_id WHERE mr3.member_id=m.id AND cr3.name=?)');
    params.push(role);
  }
  const confirmationStatus = str(req.query.confirmationStatus, 40);
  if (confirmationStatus) {
    if (!eventId) return res.status(400).json({ error: 'Choose an event before filtering by confirmation status.' });
    if (confirmationStatus === 'Not Requested') where.push('ec.id IS NULL');
    else { where.push('ec.status=?'); params.push(confirmationStatus); }
  }

  const rows = await query<any[]>(`SELECT e.id, e.equipment_code equipmentCode, e.asset_id assetId, e.category_id categoryId, c.name categoryName,
    e.item_name itemName, e.brand, e.model, e.focal_length focalLength, e.lens_mount lensMount, e.keywords,
    e.quantity, e.ownership, e.responsible_member_id ownerMemberId, m.full_name ownerMemberName,
    e.condition_status conditionStatus, e.availability, e.notes, e.created_at createdAt, e.updated_at updatedAt,
    m.member_code memberCode, m.full_name memberName, m.grade, m.class_name className, m.status memberStatus,
    m.availability memberAvailability,
    ${can(req, 'contacts.read') ? 'm.phone, m.email' : 'NULL phone, NULL email'},
    COALESCE((SELECT GROUP_CONCAT(cr2.name, ', ') FROM member_roles mr2 JOIN creative_roles cr2 ON cr2.id=mr2.role_id WHERE mr2.member_id=m.id), '') roleNames,
    (SELECT COUNT(*) FROM event_assignments ea JOIN events ev ON ev.id=ea.event_id
      WHERE ea.member_id=m.id AND ea.status NOT IN ('Cancelled','Declined') AND ev.status<>'Cancelled' AND ev.archived_at IS NULL
        AND ((? IS NOT NULL AND ev.event_date = ?) OR (? IS NOT NULL AND ev.event_date = ?))) assignmentsOnDate,
    ec.status commitmentStatus, ec.notes commitmentNotes
    FROM equipment e
    JOIN equipment_categories c ON c.id=e.category_id
    LEFT JOIN members m ON m.id=e.responsible_member_id
    LEFT JOIN event_equipment_commitments ec ON ec.equipment_id=e.id AND ec.event_id=?
    WHERE ${where.join(' AND ')}
    ORDER BY (e.availability='Available') DESC, e.ownership='Personally Owned' DESC, c.name, e.brand, e.model
    LIMIT ?`,
    [dateFilter, dateFilter, dateFilter, dateFilter, eventId, ...params, limit]);

  res.json({
    query: q,
    eventId,
    date: dateFilter,
    contactsVisible: can(req, 'contacts.read'),
    data: rows.map((row) => ({
      equipmentId: row.id,
      equipmentCode: row.equipmentCode,
      brand: row.brand,
      model: row.model,
      itemName: row.itemName,
      focalLength: row.focalLength,
      lensMount: row.lensMount,
      categoryName: row.categoryName,
      conditionStatus: row.conditionStatus,
      availability: row.availability,
      ownership: row.ownership,
      notes: row.notes,
      owner: {
        id: row.ownerMemberId,
        memberCode: row.memberCode,
        fullName: row.ownerMemberName,
        grade: row.grade,
        className: row.className,
        status: row.memberStatus,
        availability: row.memberAvailability,
        phone: row.phone,
        email: row.email,
        roles: row.roleNames ? String(row.roleNames).split(', ') : [],
        assignmentsOnDate: Number(row.assignmentsOnDate || 0),
      },
      commitment: row.commitmentStatus ? { status: row.commitmentStatus, notes: row.commitmentNotes } : null,
    })),
  });
});

api.get('/equipment/export.csv', requirePermission('equipment.read'), async (req, res) => {
  const includeContacts = can(req, 'contacts.read');
  const rows = await query<any[]>(`SELECT e.equipment_code equipmentId, e.asset_id assetId, c.name category, e.item_name itemName,
    e.brand, e.model, e.focal_length focalLength, e.lens_mount lensMount, e.quantity, e.ownership,
    m.full_name ownerMember, ${includeContacts ? 'm.phone, m.phone AS ownerPhone' : "'' phone, '' ownerPhone"},
    e.condition_status condition, e.availability
    FROM equipment e JOIN equipment_categories c ON c.id=e.category_id LEFT JOIN members m ON m.id=e.responsible_member_id
    WHERE e.archived_at IS NULL ORDER BY c.name, e.brand`);
  await audit(req, 'equipment.export', 'export', 'equipment', { count: rows.length });
  res.type('text/csv').attachment('rcpas-equipment-audit.csv').send(toCsv(rows));
});

api.get('/equipment', requirePermission('equipment.read'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid equipment filters.' });
  const { search, status, category, ownership, page, pageSize } = parsed.data;
  const where = ['e.archived_at IS NULL'];
  const params: any[] = [];
  if (search) { where.push('(e.equipment_code LIKE ? OR e.asset_id LIKE ? OR e.brand LIKE ? OR e.model LIKE ? OR e.item_name LIKE ? OR e.focal_length LIKE ? OR e.keywords LIKE ? OR m.full_name LIKE ?)'); params.push(...Array(8).fill(`%${search}%`)); }
  if (status) { where.push('e.availability=?'); params.push(status); }
  if (category) { where.push('c.name=?'); params.push(category); }
  if (ownership) { where.push('e.ownership=?'); params.push(ownership); }
  const whereSql = where.join(' AND ');
  const totalRows = await query<any[]>(`SELECT COUNT(*) total FROM equipment e JOIN equipment_categories c ON c.id=e.category_id LEFT JOIN members m ON m.id=e.responsible_member_id WHERE ${whereSql}`, params);
  const total = Number(totalRows[0]?.total || 0);
  const offset = (page - 1) * pageSize;
  const rows = await query<any[]>(`${EQUIPMENT_SELECT} WHERE ${whereSql} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  res.json({ data: rows, meta: pageMeta(page, pageSize, total) });
});

async function nextEquipmentCode(categoryName: string): Promise<string> {
  const prefix = (categoryName || 'EQ').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'EQ';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const clash = await query<any[]>('SELECT 1 FROM equipment WHERE equipment_code=?', [code]);
    if (!clash[0]) return code;
  }
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

async function validateOwner(ownerMemberId: number | null | undefined) {
  if (!ownerMemberId) return null;
  const rows = await query<any[]>('SELECT id FROM members WHERE id=? AND archived_at IS NULL', [ownerMemberId]);
  if (!rows[0]) throw Object.assign(new Error('The selected member no longer exists.'), { status: 422 });
  return ownerMemberId;
}

api.post('/equipment', requirePermission('equipment.write'), async (req, res, next) => {
  try {
    const data = equipmentSchema.parse(req.body);
    const ownerId = await validateOwner(data.responsibleMemberId);
    const category = await query<any[]>('SELECT name FROM equipment_categories WHERE id=?', [data.categoryId]);
    if (!category[0]) return res.status(422).json({ error: 'Select a valid equipment category.' });
    const equipmentCode = data.equipmentCode ? data.equipmentCode : await nextEquipmentCode(category[0].name);
    const clash = await query<any[]>('SELECT id FROM equipment WHERE equipment_code=?', [equipmentCode]);
    if (clash[0]) return res.status(409).json({ error: 'That equipment code is already in use.', code: 'DUPLICATE_EQUIPMENT_CODE' });
    const result = await execute('INSERT INTO equipment (equipment_code, asset_id, category_id, item_name, brand, model, focal_length, lens_mount, keywords, quantity, ownership, responsible_member_id, condition_status, availability, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [equipmentCode, data.assetId || null, data.categoryId, data.itemName || null, data.brand, data.model, data.focalLength || null, data.lensMount || null, data.keywords || null, data.quantity, data.ownership, ownerId, data.conditionStatus, data.availability, data.notes || null]);
    await audit(req, 'equipment.create', 'equipment', result.insertId, { equipmentCode, ownerMemberId: ownerId });
    res.status(201).json({ id: result.insertId, equipmentCode });
  } catch (error) { next(error); }
});

api.post('/members/:id/equipment', requirePermission('equipment.write'), async (req, res, next) => {
  try {
    const memberId = int(req.params.id);
    const member = await query<any[]>('SELECT id, member_code FROM members WHERE id=? AND archived_at IS NULL', [memberId]);
    if (!member[0]) return res.status(404).json({ error: 'Member not found.' });
    const data = equipmentSchema.parse({ ...(req.body || {}), responsibleMemberId: memberId });
    const category = await query<any[]>('SELECT name FROM equipment_categories WHERE id=?', [data.categoryId]);
    if (!category[0]) return res.status(422).json({ error: 'Select a valid equipment category.' });
    const equipmentCode = data.equipmentCode ? data.equipmentCode : await nextEquipmentCode(category[0].name);
    const result = await execute('INSERT INTO equipment (equipment_code, asset_id, category_id, item_name, brand, model, focal_length, lens_mount, keywords, quantity, ownership, responsible_member_id, condition_status, availability, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [equipmentCode, data.assetId || null, data.categoryId, data.itemName || null, data.brand, data.model, data.focalLength || null, data.lensMount || null, data.keywords || null, data.quantity, data.ownership, memberId, data.conditionStatus, data.availability, data.notes || null]);
    await audit(req, 'equipment.create', 'equipment', result.insertId, { equipmentCode, ownerMemberId: memberId });
    res.status(201).json({ id: result.insertId, equipmentCode });
  } catch (error) { next(error); }
});

api.patch('/equipment/:id', requirePermission('equipment.write'), async (req, res, next) => {
  try {
    const data = equipmentSchema.parse(req.body);
    const id = int(req.params.id);
    const ownerId = await validateOwner(data.responsibleMemberId);
    const category = await query<any[]>('SELECT name FROM equipment_categories WHERE id=?', [data.categoryId]);
    if (!category[0]) return res.status(422).json({ error: 'Select a valid equipment category.' });
    const clash = await query<any[]>('SELECT id FROM equipment WHERE equipment_code=? AND id<>?', [data.equipmentCode, id]);
    if (clash[0]) return res.status(409).json({ error: 'That equipment code is already in use.', code: 'DUPLICATE_EQUIPMENT_CODE' });
    await execute('UPDATE equipment SET equipment_code=?, asset_id=?, category_id=?, item_name=?, brand=?, model=?, focal_length=?, lens_mount=?, keywords=?, quantity=?, ownership=?, responsible_member_id=?, condition_status=?, availability=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND archived_at IS NULL',
      [data.equipmentCode, data.assetId || null, data.categoryId, data.itemName || null, data.brand, data.model, data.focalLength || null, data.lensMount || null, data.keywords || null, data.quantity, data.ownership, ownerId, data.conditionStatus, data.availability, data.notes || null, id]);
    await audit(req, 'equipment.update', 'equipment', id, { ownerMemberId: ownerId });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

api.delete('/equipment/:id', requirePermission('equipment.write'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    await execute("UPDATE equipment SET availability='Archived', archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    await audit(req, 'equipment.archive', 'equipment', id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

api.get('/equipment/allocations', requirePermission('equipment.read'), async (_req, res) => res.json({ data: await query<any[]>(`SELECT ea.id, ea.equipment_id equipmentId, e.equipment_code equipmentCode, ea.event_id eventId, ev.name eventName, ev.event_date eventDate, ea.quantity, ea.issued_at issuedAt, ea.returned_at returnedAt, ea.return_status returnStatus, ea.notes FROM equipment_allocations ea JOIN equipment e ON e.id=ea.equipment_id JOIN events ev ON ev.id=ea.event_id ORDER BY ea.created_at DESC`) }));
api.post('/equipment/allocations', requirePermission('equipment.allocate'), async (req, res, next) => {
  try {
    const data = allocationSchema.parse(req.body);
    const overlap = await query<any[]>(`SELECT ea.id, ev2.name otherEvent FROM equipment_allocations ea JOIN events ev2 ON ev2.id=ea.event_id
      JOIN events target ON target.id=? WHERE ea.equipment_id=? AND ea.returned_at IS NULL AND ev2.status <> 'Cancelled'
      AND ev2.event_date = target.event_date`, [data.eventId, data.equipmentId]);
    if (overlap[0]) return res.status(409).json({ error: `This equipment is already allocated to "${overlap[0].otherEvent}" on that date.`, code: 'EQUIPMENT_CONFLICT' });
    const result = await execute('INSERT INTO equipment_allocations (equipment_id, event_id, quantity, issued_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)', [data.equipmentId, data.eventId, data.quantity, data.issuedAt ? new Date(data.issuedAt) : null, data.notes || null, req.user!.id]);
    await execute("UPDATE equipment SET availability='Allocated', updated_at=CURRENT_TIMESTAMP WHERE id=? AND availability <> 'Archived'", [data.equipmentId]);
    await audit(req, 'equipment.allocate', 'equipment_allocation', result.insertId);
    res.status(201).json({ id: result.insertId });
  } catch (error) { next(error); }
});
api.post('/equipment/allocations/:id/return', requirePermission('equipment.allocate'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const allocation = await query<any[]>('SELECT equipment_id equipmentId FROM equipment_allocations WHERE id=?', [id]);
    if (!allocation[0]) return res.status(404).json({ error: 'Allocation not found.' });
    await execute('UPDATE equipment_allocations SET returned_at=CURRENT_TIMESTAMP, return_status=?, notes=? WHERE id=?', [req.body.returnStatus || 'Returned', req.body.notes || null, id]);
    await execute("UPDATE equipment SET availability='Available' WHERE id=? AND NOT EXISTS (SELECT 1 FROM equipment_allocations WHERE equipment_id=? AND returned_at IS NULL)", [allocation[0].equipmentId, allocation[0].equipmentId]);
    await audit(req, 'equipment.return', 'equipment_allocation', id, req.body);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// --- Lightweight per-event equipment commitments (owner confirmation) -------
api.get('/events/:id/commitments', requirePermission('equipment.read'), async (req, res) => {
  const id = int(req.params.id);
  res.json({ data: await query<any[]>(`SELECT ec.id, ec.event_id eventId, ec.equipment_id equipmentId, e.equipment_code equipmentCode,
    e.brand, e.model, e.focal_length focalLength, c.name categoryName, ec.member_id memberId, m.full_name memberName,
    ec.status, ec.notes, ec.created_at createdAt, ec.updated_at updatedAt
    FROM event_equipment_commitments ec JOIN equipment e ON e.id=ec.equipment_id
    JOIN equipment_categories c ON c.id=e.category_id LEFT JOIN members m ON m.id=COALESCE(ec.member_id, e.responsible_member_id)
    WHERE ec.event_id=? ORDER BY c.name, e.brand, e.model`, [id]) });
});

api.post('/events/:id/commitments', requirePermission('equipment.allocate'), async (req, res, next) => {
  try {
    const eventId = int(req.params.id);
    const event = await query<any[]>('SELECT id, status FROM events WHERE id=? AND archived_at IS NULL', [eventId]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    const data = commitmentSchema.parse({ ...(req.body || {}), eventId });
    const equipment = await query<any[]>('SELECT id, responsible_member_id ownerId, availability FROM equipment WHERE id=? AND archived_at IS NULL', [data.equipmentId]);
    if (!equipment[0]) return res.status(404).json({ error: 'Equipment not found.' });
    const conflicting = await query<any[]>(`SELECT ec.id, ev.name otherEvent FROM event_equipment_commitments ec JOIN events ev ON ev.id=ec.event_id
      WHERE ec.equipment_id=? AND ec.event_id<>? AND ec.status IN ('Offered','Awaiting Confirmation','Confirmed') AND ev.status<>'Cancelled' AND ev.archived_at IS NULL
        AND ev.event_date = (SELECT event_date FROM events WHERE id=?)`, [data.equipmentId, eventId, eventId]);
    if (conflicting[0]) return res.status(409).json({ error: `This item is already committed to "${conflicting[0].otherEvent}" on the same date.`, code: 'EQUIPMENT_CONFLICT' });

    const warnings: string[] = [];
    if (data.status === 'Confirmed' && equipment[0].ownerId && !data.override && !can(req, 'equipment.allocate')) {
      warnings.push('You are not permitted to confirm personal equipment without the owner.');
    }
    if (equipment[0].availability === 'Unavailable' || equipment[0].availability === 'Archived') warnings.push('This item is currently marked unavailable.');
    if (warnings.length && !data.override) return res.status(409).json({ error: 'Equipment needs review before it can be confirmed.', code: 'EQUIPMENT_WARNING', warnings });
    if (warnings.length && !data.overrideReason) return res.status(400).json({ error: 'An override reason is required.', code: 'OVERRIDE_REASON_REQUIRED' });

    const result = await execute(`INSERT INTO event_equipment_commitments (event_id, equipment_id, member_id, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, equipment_id) DO UPDATE SET status=excluded.status, notes=excluded.notes, member_id=excluded.member_id, updated_at=CURRENT_TIMESTAMP`,
      [eventId, data.equipmentId, equipment[0].ownerId, data.status, data.overrideReason ? `${data.notes || ''} [override: ${data.overrideReason}]`.trim() : data.notes || null, req.user!.id]);
    await audit(req, 'equipment.commit', 'event_equipment_commitment', result.insertId, { eventId, equipmentId: data.equipmentId, status: data.status, warnings });
    res.status(201).json({ id: result.insertId, warnings });
  } catch (error) { next(error); }
});

api.patch('/equipment/commitments/:id', requirePermission('equipment.allocate'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const existing = await query<any[]>('SELECT id, event_id eventId FROM event_equipment_commitments WHERE id=?', [id]);
    if (!existing[0]) return res.status(404).json({ error: 'Commitment not found.' });
    const status = str(req.body?.status, 40);
    if (!['Offered', 'Awaiting Confirmation', 'Confirmed', 'Declined', 'Unavailable', 'Released'].includes(status)) return res.status(400).json({ error: 'Invalid commitment status.' });
    await execute('UPDATE event_equipment_commitments SET status=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, str(req.body?.notes, 2000) || null, id]);
    await audit(req, 'equipment.commitment_update', 'event_equipment_commitment', id, { status });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

api.delete('/equipment/commitments/:id', requirePermission('equipment.allocate'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const existing = await query<any[]>('SELECT id FROM event_equipment_commitments WHERE id=?', [id]);
    if (!existing[0]) return res.status(404).json({ error: 'Commitment not found.' });
    await execute("UPDATE event_equipment_commitments SET status='Released', updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    await audit(req, 'equipment.commitment_release', 'event_equipment_commitment', id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Structured gear requirements for one event.
// The Gear Directory is the reusable source of member-owned gear; an event only
// ever references it, so the same lens never becomes a duplicate record.
// ---------------------------------------------------------------------------
/** Maps a stored commitment status onto the planning availability vocabulary. */
const gearAvailability = (status: unknown) =>
  !status || status === 'Released' ? 'Not Requested'
  : status === 'Confirmed' ? 'Confirmed for Event'
    : status === 'Declined' || status === 'Unavailable' ? 'Unavailable'
      : 'Awaiting Response';

const parseDetails = (raw: unknown) => { try { return JSON.parse(String(raw || '{}')); } catch { return {}; } };

api.get('/events/:id/requirements', requirePermission('events.read'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const event = await query<any[]>('SELECT id FROM events WHERE id=?', [id]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    const rows = await query<any[]>(`SELECT r.id, r.event_id eventId, r.equipment_id equipmentId, r.description, r.quantity, r.priority,
      r.notes, r.waived_at waivedAt, r.waived_reason waivedReason, wu.display_name waivedByName,
      r.created_at createdAt, r.updated_at updatedAt,
      e.equipment_code equipmentCode, e.brand, e.model, e.focal_length focalLength, c.name categoryName,
      m.full_name ownerName, m.id ownerId,
      (SELECT ec.status FROM event_equipment_commitments ec WHERE ec.event_id=r.event_id AND ec.equipment_id=r.equipment_id LIMIT 1) commitmentStatus
      FROM event_equipment_requirements r
      LEFT JOIN equipment e ON e.id=r.equipment_id
      LEFT JOIN equipment_categories c ON c.id=e.category_id
      LEFT JOIN members m ON m.id=e.responsible_member_id
      LEFT JOIN users wu ON wu.id=r.waived_by
      WHERE r.event_id=?
      ORDER BY CASE r.priority WHEN 'Critical' THEN 0 WHEN 'Required' THEN 1 ELSE 2 END, (r.waived_at IS NOT NULL), r.description`,
      [id]);
    res.json({
      data: rows.map((row) => ({
        ...row,
        quantity: Number(row.quantity || 1),
        availability: gearAvailability(row.commitmentStatus),
        fulfilled: Boolean(row.waivedAt) || Boolean(row.equipmentId && row.commitmentStatus === 'Confirmed'),
      })),
    });
  } catch (error) { next(error); }
});

api.post('/events/:id/requirements', requirePermission('events.write'), async (req, res, next) => {
  try {
    const eventId = int(req.params.id);
    const event = await query<any[]>('SELECT id FROM events WHERE id=? AND archived_at IS NULL', [eventId]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    const data = requirementSchema.parse({ ...(req.body || {}) });
    if (data.equipmentId) {
      const linked = await query<any[]>('SELECT id FROM equipment WHERE id=? AND archived_at IS NULL', [data.equipmentId]);
      if (!linked[0]) return res.status(404).json({ error: 'That gear record no longer exists.' });
    }
    const duplicate = await query<any[]>('SELECT id FROM event_equipment_requirements WHERE event_id=? AND LOWER(description)=LOWER(?)', [eventId, data.description]);
    if (duplicate[0]) return res.status(409).json({ error: 'That requirement is already listed for this event.', code: 'DUPLICATE_REQUIREMENT' });

    const result = await execute(`INSERT INTO event_equipment_requirements (event_id, equipment_id, description, quantity, priority, notes, created_by)
      VALUES (?,?,?,?,?,?,?)`, [eventId, data.equipmentId ?? null, data.description, data.quantity, data.priority, data.notes || null, req.user!.id]);
    await audit(req, 'event.requirement_add', 'event_equipment_requirement', result.insertId, { eventId, description: data.description });
    res.status(201).json({ id: result.insertId });
  } catch (error) { next(error); }
});

api.patch('/events/:id/requirements/:reqId', requirePermission('events.write'), async (req, res, next) => {
  try {
    const eventId = int(req.params.id);
    const reqId = int(req.params.reqId);
    const existing = await query<any[]>('SELECT id, event_id eventId, description FROM event_equipment_requirements WHERE id=?', [reqId]);
    if (!existing[0] || existing[0].eventId !== eventId) return res.status(404).json({ error: 'That requirement was not found for this event.' });
    const data = requirementUpdateSchema.parse({ ...(req.body || {}) });

    const sets: string[] = [];
    const params: any[] = [];
    if (data.description !== undefined && data.description !== existing[0].description) {
      const duplicate = await query<any[]>('SELECT id FROM event_equipment_requirements WHERE event_id=? AND id<>? AND LOWER(description)=LOWER(?)', [eventId, reqId, data.description]);
      if (duplicate[0]) return res.status(409).json({ error: 'That requirement is already listed for this event.', code: 'DUPLICATE_REQUIREMENT' });
      sets.push('description=?'); params.push(data.description);
    }
    if (data.equipmentId !== undefined) { sets.push('equipment_id=?'); params.push(data.equipmentId ?? null); }
    if (data.quantity !== undefined) { sets.push('quantity=?'); params.push(data.quantity); }
    if (data.priority !== undefined) { sets.push('priority=?'); params.push(data.priority); }
    if (data.notes !== undefined) { sets.push('notes=?'); params.push(data.notes || null); }

    // A requirement may be waived when the organizer decides it is unnecessary,
    // so readiness never blocks on it without an explicit, attributed decision.
    const waive = (req.body as any)?.waive;
    if (typeof waive === 'boolean') {
      if (waive) {
        const reason = str((req.body as any)?.waiveReason, 500);
        if (!reason) return res.status(400).json({ error: 'Record why this gear requirement is not needed before waiving it.', code: 'WAIVE_REASON_REQUIRED' });
        sets.push('waived_at=CURRENT_TIMESTAMP', 'waived_by=?', 'waived_reason=?');
        params.push(req.user!.id, reason);
      } else { sets.push('waived_at=NULL', 'waived_by=NULL', 'waived_reason=NULL'); }
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push('updated_at=CURRENT_TIMESTAMP');
    await execute(`UPDATE event_equipment_requirements SET ${sets.join(', ')} WHERE id=?`, [...params, reqId]);
    const action = typeof waive === 'boolean' ? (waive ? 'event.requirement_waive' : 'event.requirement_unwaive') : 'event.requirement_update';
    await audit(req, action, 'event_equipment_requirement', reqId, { eventId, description: existing[0].description });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

api.delete('/events/:id/requirements/:reqId', requirePermission('events.write'), async (req, res, next) => {
  try {
    const eventId = int(req.params.id);
    const reqId = int(req.params.reqId);
    const existing = await query<any[]>('SELECT id, event_id eventId, description FROM event_equipment_requirements WHERE id=?', [reqId]);
    if (!existing[0] || existing[0].eventId !== eventId) return res.status(404).json({ error: 'That requirement was not found for this event.' });
    await execute('DELETE FROM event_equipment_requirements WHERE id=?', [reqId]);
    await audit(req, 'event.requirement_remove', 'event_equipment_requirement', reqId, { eventId, description: existing[0].description });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Internal planning discussion — officials only, never a public forum.
// ---------------------------------------------------------------------------
api.get('/events/:id/discussions', requirePermission('events.read'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const event = await query<any[]>('SELECT id FROM events WHERE id=?', [id]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    res.json({ data: await query<any[]>(`SELECT d.id, d.event_id eventId, d.body, d.created_at createdAt,
      u.id authorId, u.display_name authorName,
      COALESCE((SELECT GROUP_CONCAT(r.name, ', ') FROM user_roles ur JOIN system_roles r ON r.id=ur.role_id WHERE ur.user_id=u.id), '') authorRoles
      FROM event_discussions d LEFT JOIN users u ON u.id=d.author_id
      WHERE d.event_id=? ORDER BY d.created_at DESC, d.id DESC`, [id]) });
  } catch (error) { next(error); }
});

api.post('/events/:id/discussions', requirePermission('events.write'), async (req, res, next) => {
  try {
    const eventId = int(req.params.id);
    const event = await query<any[]>('SELECT id FROM events WHERE id=? AND archived_at IS NULL', [eventId]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    const data = discussionSchema.parse(req.body);
    const result = await execute('INSERT INTO event_discussions (event_id, author_id, body) VALUES (?,?,?)', [eventId, req.user!.id, data.body]);
    await audit(req, 'event.discussion_post', 'event_discussion', result.insertId, { eventId });
    res.status(201).json({ id: result.insertId });
  } catch (error) { next(error); }
});

api.delete('/events/:id/discussions/:discId', requirePermission('events.write'), async (req, res, next) => {
  try {
    const eventId = int(req.params.id);
    const discId = int(req.params.discId);
    const existing = await query<any[]>('SELECT id, event_id eventId, author_id authorId FROM event_discussions WHERE id=?', [discId]);
    if (!existing[0] || existing[0].eventId !== eventId) return res.status(404).json({ error: 'That post was not found for this event.' });
    if (existing[0].authorId !== req.user!.id && !can(req, 'users.manage')) return res.status(403).json({ error: 'Only the author or a System Administrator can remove this post.' });
    await execute('DELETE FROM event_discussions WHERE id=?', [discId]);
    await audit(req, 'event.discussion_delete', 'event_discussion', discId, { eventId });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Real change history for one event (audit rows only — nothing is fabricated).
// Scoped to this event rather than the whole log, so `events.read` suffices;
// the unfiltered audit trail stays behind `audit.read`.
// ---------------------------------------------------------------------------
api.get('/events/:id/activity', requirePermission('events.read'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const event = await query<any[]>('SELECT id FROM events WHERE id=?', [id]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    const rows = await query<any[]>(`SELECT a.id, a.action, a.entity_type entityType, a.entity_id entityId, a.details, a.created_at createdAt,
      u.display_name actorName
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
      WHERE (a.entity_type='event' AND a.entity_id=?)
         OR (a.entity_type='event_assignment' AND a.entity_id IN (SELECT CAST(id AS TEXT) FROM event_assignments WHERE event_id=?))
         OR (a.entity_type='event_equipment_commitment' AND a.entity_id IN (SELECT CAST(id AS TEXT) FROM event_equipment_commitments WHERE event_id=?))
         OR (a.entity_type='event_equipment_requirement' AND a.entity_id IN (SELECT CAST(id AS TEXT) FROM event_equipment_requirements WHERE event_id=?))
         OR (a.entity_type='event_discussion' AND a.entity_id IN (SELECT CAST(id AS TEXT) FROM event_discussions WHERE event_id=?))
         OR (a.entity_type='export' AND (a.details LIKE ? OR a.details LIKE ?))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 200`,
      // audit_logs.entity_id is TEXT; node:sqlite binds JS numbers as REAL, which
      // stringifies to "4.0" and would never match — bind the text form instead.
      [String(id), id, id, id, id, `%"eventId":${id},%`, `%"eventId":${id}}%`]);
    res.json({ data: rows.map((row) => ({ ...row, details: parseDetails(row.details) })) });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Events — one date plus exactly one start time.
// ---------------------------------------------------------------------------
api.get('/events', requirePermission('events.read'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid event filters.' });
  const { search, status, category, from, to } = parsed.data;
  const where = ['e.archived_at IS NULL'];
  const params: any[] = [];
  if (search) { where.push('(e.name LIKE ? OR e.event_code LIKE ? OR e.venue LIKE ? OR e.category LIKE ?)'); params.push(...Array(4).fill(`%${search}%`)); }
  if (status) { where.push('e.status=?'); params.push(status); } else { where.push("e.status <> 'Cancelled'"); }
  if (category) { where.push('e.category=?'); params.push(category); }
  if (from) { where.push('e.event_date >= ?'); params.push(from.slice(0, 10)); }
  if (to) { where.push('e.event_date <= ?'); params.push(to.slice(0, 10)); }
  const scope = str(req.query.scope, 20);
  if (scope === 'upcoming') where.push('e.event_date >= date(\'now\') AND e.status IN (\'Planning\',\'Ready\',\'Confirmed\')');
  if (scope === 'past') where.push("(e.event_date < date('now') OR e.status = 'Completed')");
  res.json({ data: (await query<any[]>(`${eventSelect} WHERE ${where.join(' AND ')} ORDER BY e.event_date ASC, e.start_time ASC`, params)).map(mapEvent) });
});

api.get('/events/:id', requirePermission('events.read'), async (req, res) => {
  const rows = await query<any[]>(`${eventSelect} WHERE e.id=?`, [int(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Event not found.' });
  const assignments = await query<any[]>(`SELECT ea.*, m.full_name memberName, m.member_code memberCode, m.phone, m.email, u.display_name contactedByName
    FROM event_assignments ea JOIN members m ON m.id=ea.member_id LEFT JOIN users u ON u.id=ea.contacted_by
    WHERE ea.event_id=? ORDER BY ea.responsibility, m.full_name`, [int(req.params.id)]);
  res.json({ data: { ...mapEvent(rows[0]), assignments } });
});

api.get('/events/:id/readiness', requirePermission('events.read'), async (req, res) => {
  const id = int(req.params.id);
  const rows = await query<any[]>(`${eventSelect} WHERE e.id=?`, [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Event not found.' });
  const event = mapEvent(rows[0]);
  const assignments = await query<any[]>(`SELECT ea.id, ea.responsibility, ea.status, ea.member_id memberId, m.full_name memberName
    FROM event_assignments ea JOIN members m ON m.id=ea.member_id WHERE ea.event_id=?`, [id]);
  const commitments = await query<any[]>(`SELECT ec.id, ec.equipment_id equipmentId, e.equipment_code equipmentCode, ec.status,
    e.brand, e.model, e.focal_length focalLength, m.full_name ownerName
    FROM event_equipment_commitments ec JOIN equipment e ON e.id=ec.equipment_id LEFT JOIN members m ON m.id=e.responsible_member_id
    WHERE ec.event_id=?`, [id]);
  const requirements = await query<any[]>(`SELECT r.id, r.equipment_id equipmentId, r.description, r.quantity, r.priority, r.notes,
    r.waived_at waivedAt, r.waived_reason waivedReason, e.brand, e.model, e.focal_length focalLength,
    (SELECT ec.status FROM event_equipment_commitments ec WHERE ec.event_id=r.event_id AND ec.equipment_id=r.equipment_id LIMIT 1) commitmentStatus
    FROM event_equipment_requirements r LEFT JOIN equipment e ON e.id=r.equipment_id
    WHERE r.event_id=? ORDER BY CASE r.priority WHEN 'Critical' THEN 0 WHEN 'Required' THEN 1 ELSE 2 END, r.description`, [id]);
  const requiredRoles = String(event.creativeRequirements || '').split(/[,;\n]/).map((v) => v.trim()).filter(Boolean).map((responsibility) => ({
    responsibility,
    required: assignments.filter((a) => a.responsibility === responsibility).length,
    assigned: assignments.filter((a) => a.responsibility === responsibility && !['Cancelled', 'Declined'].includes(a.status)).length,
    confirmed: assignments.filter((a) => a.responsibility === responsibility && a.status === 'Confirmed').length,
  }));
  const confirmed = assignments.filter((a) => a.status === 'Confirmed').length;
  const awaiting = assignments.filter((a) => AWAITING_RESPONSE.includes(a.status)).length;
  const declined = assignments.filter((a) => a.status === 'Declined').length;
  const activeCount = assignments.filter((a) => !['Cancelled', 'Declined'].includes(a.status)).length;
  const unconfirmedEquipment = commitments.filter((c) => !['Confirmed', 'Released'].includes(c.status)).length;

  const conflicts = await query<any[]>(`SELECT COUNT(*) total FROM (
    SELECT ea.member_id FROM event_assignments ea JOIN events other ON other.id=ea.event_id
    WHERE other.event_date=? AND other.id<>? AND other.status<>'Cancelled' AND other.archived_at IS NULL
      AND ea.status NOT IN ('Cancelled','Declined')
    INTERSECT
    SELECT member_id FROM event_assignments WHERE event_id=? AND status NOT IN ('Cancelled','Declined'))`, [event.eventDate, id, id]);

  // A gear requirement blocks readiness only when it is neither confirmed nor
  // explicitly waived — an organizer may decide an item is unnecessary.
  const openGear = requirements.filter((r) => !r.waivedAt && !(r.equipmentId && r.commitmentStatus === 'Confirmed'));

  const blockers: string[] = [];
  const required = Number(event.requiredTeamSize || 0);
  if (required > 0 && activeCount < required) blockers.push(`${required - activeCount} more team member(s) still needed.`);
  if (awaiting > 0) blockers.push(`${awaiting} team member(s) have not responded yet.`);
  if (declined > 0) blockers.push(`${declined} team member(s) declined and need reassignment.`);
  if (unconfirmedEquipment > 0) blockers.push(`${unconfirmedEquipment} equipment item(s) still awaiting owner confirmation.`);
  for (const requirement of openGear.filter((r) => r.priority !== 'Optional')) {
    blockers.push(!requirement.equipmentId
      ? `Gear requirement "${requirement.description}" has no owner linked yet — find one in the Gear Directory or waive it.`
      : (requirement.commitmentStatus
        ? `Gear requirement "${requirement.description}" is still awaiting the owner's confirmation.`
        : `Gear requirement "${requirement.description}" has not been requested from an owner yet.`));
  }
  if (!activeCount) blockers.push('No team members have been assigned yet.');
  if (event.status === 'Cancelled') blockers.push('This event is cancelled.');

  res.json({
    event,
    roles: requiredRoles,
    assignments,
    equipment: commitments.map((c) => ({ equipmentId: c.equipmentId, equipmentCode: c.equipmentCode, label: `${c.brand} ${c.model}${c.focalLength ? ` (${c.focalLength})` : ''}`, ownerName: c.ownerName, status: c.status })),
    requirements: requirements.map((r) => ({
      ...r,
      availability: gearAvailability(r.commitmentStatus),
      fulfilled: Boolean(r.waivedAt) || Boolean(r.equipmentId && r.commitmentStatus === 'Confirmed'),
    })),
    summary: {
      requiredTeamSize: required,
      assigned: activeCount,
      confirmed,
      awaitingResponse: awaiting,
      declined,
      unconfirmedEquipment,
      gearRequirements: requirements.length,
      gearFulfilled: requirements.filter((r) => !r.waivedAt && r.equipmentId && r.commitmentStatus === 'Confirmed').length,
      gearWaived: requirements.filter((r) => r.waivedAt).length,
      gearOpen: openGear.length,
      sameDateConflicts: Number(conflicts[0]?.total || 0),
      ready: blockers.length === 0,
      blockers,
    },
  });
});

api.post('/events', requirePermission('events.write'), async (req, res, next) => {
  try {
    const data = eventSchema.parse(req.body);
    if (data.organizerMemberId) await validateOwner(data.organizerMemberId);
    const clash = await query<any[]>('SELECT id FROM events WHERE event_code=?', [data.eventCode]);
    if (clash[0]) return res.status(409).json({ error: 'An event with that code already exists.', code: 'DUPLICATE_EVENT_CODE' });
    const result = await execute(`INSERT INTO events (event_code,name,description,category,event_date,start_time,starts_at,ends_at,venue,organizer_member_id,
      priority,required_team_size,additional_instructions,photography_requirements,creative_requirements,status,is_draft,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.eventCode, data.name, data.description || null, data.category, data.eventDate, data.startTime, `${data.eventDate} ${data.startTime}:00`,
        data.endsAt ? String(data.endsAt).slice(0, 19).replace('T', ' ') : null, data.venue, data.organizerMemberId || null,
        data.priority, data.requiredTeamSize, data.additionalInstructions || null, data.photographyRequirements || null,
        data.creativeRequirements || null, data.status, data.isDraft ? 1 : 0, data.notes || null, req.user!.id]);
    await audit(req, 'event.create', 'event', result.insertId, { eventDate: data.eventDate, startTime: data.startTime, isDraft: data.isDraft });
    res.status(201).json({ id: result.insertId });
  } catch (error) { next(error); }
});

api.patch('/events/:id', requirePermission('events.write'), async (req, res, next) => {
  try {
    const data = eventSchema.parse(req.body);
    const id = int(req.params.id);
    const existing = await query<any[]>('SELECT id, status FROM events WHERE id=? AND archived_at IS NULL', [id]);
    if (!existing[0]) return res.status(404).json({ error: 'Event not found.' });
    if (data.organizerMemberId) await validateOwner(data.organizerMemberId);
    const clash = await query<any[]>('SELECT id FROM events WHERE event_code=? AND id<>?', [data.eventCode, id]);
    if (clash[0]) return res.status(409).json({ error: 'An event with that code already exists.', code: 'DUPLICATE_EVENT_CODE' });
    await execute(`UPDATE events SET event_code=?,name=?,description=?,category=?,event_date=?,start_time=?,starts_at=?,ends_at=?,venue=?,organizer_member_id=?,
      priority=?,required_team_size=?,additional_instructions=?,photography_requirements=?,creative_requirements=?,status=?,is_draft=?,notes=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND archived_at IS NULL`,
      [data.eventCode, data.name, data.description || null, data.category, data.eventDate, data.startTime, `${data.eventDate} ${data.startTime}:00`,
        data.endsAt ? String(data.endsAt).slice(0, 19).replace('T', ' ') : null, data.venue, data.organizerMemberId || null,
        data.priority, data.requiredTeamSize, data.additionalInstructions || null, data.photographyRequirements || null,
        data.creativeRequirements || null, data.status, data.isDraft ? 1 : 0, data.notes || null, id]);
    if (data.status === 'Cancelled') await execute("UPDATE event_equipment_commitments SET status='Released', updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND status NOT IN ('Released')", [id]);
    await audit(req, 'event.update', 'event', id, { status: data.status, eventDate: data.eventDate, startTime: data.startTime });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

api.post('/events/:id/duplicate', requirePermission('events.write'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const original = await query<any[]>(`SELECT * FROM events WHERE id=?`, [id]);
    if (!original[0]) return res.status(404).json({ error: 'Event not found.' });
    const e = original[0];
    const result = await execute(`INSERT INTO events (event_code,name,description,category,event_date,start_time,starts_at,ends_at,venue,organizer_member_id,
      priority,required_team_size,additional_instructions,photography_requirements,creative_requirements,status,is_draft,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [`${e.event_code}-COPY-${Date.now().toString(36).toUpperCase()}`, `${e.name} (Copy)`, e.description, e.category, e.event_date, e.start_time,
        `${e.event_date} ${e.start_time}:00`, e.ends_at, e.venue, e.organizer_member_id, e.priority, e.required_team_size,
        e.additional_instructions, e.photography_requirements, e.creative_requirements, 'Planning', 1, e.notes, req.user!.id]);
    await audit(req, 'event.duplicate', 'event', result.insertId, { sourceEventId: id });
    res.status(201).json({ id: result.insertId });
  } catch (error) { next(error); }
});

api.delete('/events/:id', requirePermission('events.write'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    await execute("UPDATE events SET status='Cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    await execute("UPDATE event_equipment_commitments SET status='Released', updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND status NOT IN ('Released')", [id]);
    await audit(req, 'event.cancel', 'event', id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Assignments + contact / confirmation workflow
// ---------------------------------------------------------------------------
api.get('/assignments', requirePermission('assignments.read'), async (req, res) => {
  const search = str(req.query.search, 160);
  const status = str(req.query.status, 40);
  const eventId = Number(req.query.eventId || 0) || null;
  const params: any[] = [];
  const where = ['1=1'];
  if (search) { where.push('(m.full_name LIKE ? OR e.name LIKE ? OR ea.responsibility LIKE ? OR m.member_code LIKE ?)'); params.push(...Array(4).fill(`%${search}%`)); }
  if (status) { where.push('ea.status=?'); params.push(status); }
  if (eventId) { where.push('ea.event_id=?'); params.push(eventId); }
  res.json({ data: await query<any[]>(`SELECT ea.id, ea.event_id eventId, e.name eventName, e.event_date eventDate, e.start_time startTime,
    e.event_date || 'T' || e.start_time || ':00+05:30' startsAt, e.venue, ea.member_id memberId, m.full_name memberName, m.member_code memberCode,
    ${can(req, 'contacts.read') ? 'm.phone, m.email' : 'NULL phone, NULL email'},
    ea.responsibility, ea.status, ea.notes, ea.override_reason overrideReason,
    ea.contacted_at contactedAt, u.display_name contactedByName, ea.confirmed_at confirmedAt, ea.created_at createdAt
    FROM event_assignments ea JOIN events e ON e.id=ea.event_id JOIN members m ON m.id=ea.member_id
    LEFT JOIN users u ON u.id=ea.contacted_by
    WHERE ${where.join(' AND ')} AND e.archived_at IS NULL
    ORDER BY e.event_date DESC, e.start_time DESC, ea.responsibility`, params) });
});

async function sameDateConflicts(memberId: number, eventId: number, eventDate: string) {
  return query<any[]>(`SELECT e.id, e.name, e.start_time startTime, ea.responsibility, ea.status
    FROM event_assignments ea JOIN events e ON e.id=ea.event_id
    WHERE ea.member_id=? AND e.event_date=? AND e.id<>? AND e.archived_at IS NULL
      AND e.status<>'Cancelled' AND ea.status NOT IN ('Cancelled','Declined')
    ORDER BY e.start_time`, [memberId, eventDate, eventId]);
}

api.post('/assignments', requirePermission('assignments.write'), async (req, res, next) => {
  try {
    const data = assignmentSchema.parse(req.body);
    const event = await query<any[]>('SELECT id, status, event_date eventDate, required_team_size requiredTeamSize, name FROM events WHERE id=? AND archived_at IS NULL', [data.eventId]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    const member = await query<any[]>('SELECT status, full_name FROM members WHERE id=? AND archived_at IS NULL', [data.memberId]);
    if (!member[0]) return res.status(404).json({ error: 'Member not found.' });
    const duplicate = await query<any[]>(`SELECT id FROM event_assignments WHERE event_id=? AND member_id=? AND responsibility=? AND status NOT IN ('Cancelled','Declined')`, [data.eventId, data.memberId, data.responsibility]);
    if (duplicate[0]) return res.status(409).json({ error: 'This member is already assigned to that responsibility for this event.', code: 'DUPLICATE_ASSIGNMENT' });

    const conflicts = await sameDateConflicts(data.memberId, data.eventId, event[0].eventDate);
    const warnings: string[] = [];
    if (member[0].status !== 'Active') warnings.push(`${member[0].full_name} is currently marked ${member[0].status}.`);
    if (conflicts.length) warnings.push(`${member[0].full_name} is already assigned to ${conflicts.length} other event(s) on ${event[0].eventDate}: ${conflicts.map((c) => `${c.name} (${c.startTime})`).join(', ')}. Only the date is known, so the system cannot confirm whether the time ranges actually overlap.`);
    if (data.status === 'Confirmed' && !can(req, 'assignments.override') && !data.overrideWarnings) warnings.push('Recording a confirmation on behalf of a member requires confirmation.');

    if (warnings.length && (!data.overrideWarnings || !can(req, 'assignments.override'))) return res.status(409).json({ error: 'This assignment needs review before it can be saved.', code: 'ASSIGNMENT_WARNING', warnings });
    if (warnings.length && !data.overrideReason) return res.status(400).json({ error: 'An override reason is required to save these warnings.', code: 'OVERRIDE_REASON_REQUIRED' });

    const result = await execute(`INSERT INTO event_assignments (event_id,member_id,responsibility,status,notes,override_reason,created_by)
      VALUES (?,?,?,?,?,?,?)`, [data.eventId, data.memberId, data.responsibility, data.status, data.notes || null, data.overrideReason || null, req.user!.id]);
    await audit(req, warnings.length ? 'assignment.override' : 'assignment.create', 'event_assignment', result.insertId, { eventId: data.eventId, memberId: data.memberId, warnings, reason: data.overrideReason || null });
    res.status(201).json({ id: result.insertId, warnings });
  } catch (error) { next(error); }
});

api.patch('/assignments/:id', requirePermission('assignments.write'), async (req, res, next) => {
  try {
    const data = assignmentSchema.parse(req.body);
    const id = int(req.params.id);
    const existing = await query<any[]>('SELECT id FROM event_assignments WHERE id=?', [id]);
    if (!existing[0]) return res.status(404).json({ error: 'Assignment not found.' });
    const event = await query<any[]>('SELECT event_date eventDate FROM events WHERE id=?', [data.eventId]);
    if (!event[0]) return res.status(404).json({ error: 'Event not found.' });
    const duplicate = await query<any[]>(`SELECT id FROM event_assignments WHERE event_id=? AND member_id=? AND responsibility=? AND id<>? AND status NOT IN ('Cancelled','Declined')`, [data.eventId, data.memberId, data.responsibility, id]);
    if (duplicate[0]) return res.status(409).json({ error: 'This member is already assigned to that responsibility for this event.', code: 'DUPLICATE_ASSIGNMENT' });

    const conflicts = await sameDateConflicts(data.memberId, data.eventId, event[0].eventDate);
    const warnings: string[] = [];
    if (conflicts.length) warnings.push(`${conflicts.length} same-date conflict(s) detected on ${event[0].eventDate}. Only the date is known, so exact time overlap cannot be determined.`);
    if (warnings.length && (!data.overrideWarnings || !can(req, 'assignments.override'))) return res.status(409).json({ error: 'This assignment needs review before it can be saved.', code: 'ASSIGNMENT_WARNING', warnings });
    if (warnings.length && !data.overrideReason) return res.status(400).json({ error: 'An override reason is required to save these warnings.', code: 'OVERRIDE_REASON_REQUIRED' });

    await execute('UPDATE event_assignments SET event_id=?,member_id=?,responsibility=?,status=?,notes=?,override_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [data.eventId, data.memberId, data.responsibility, data.status, data.notes || null, data.overrideReason || null, id]);
    await audit(req, 'assignment.update', 'event_assignment', id, { status: data.status });
    res.json({ ok: true, warnings });
  } catch (error) { next(error); }
});

/** Contact / confirmation status change with an audited responsible official. */
api.patch('/assignments/:id/contact', requirePermission('assignments.write'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const data = contactUpdateSchema.parse(req.body || {});
    const existing = await query<any[]>('SELECT id, status, member_id memberId FROM event_assignments WHERE id=?', [id]);
    if (!existing[0]) return res.status(404).json({ error: 'Assignment not found.' });
    const now = new Date().toISOString();
    await execute(`UPDATE event_assignments SET status=?,
      contacted_at = CASE WHEN ? IN ('Contacted','Confirmed','Declined','Completed') THEN COALESCE(contacted_at, ?) ELSE contacted_at END,
      contacted_by = CASE WHEN ? IN ('Contacted','Confirmed','Declined','Completed') THEN COALESCE(contacted_by, ?) ELSE contacted_by END,
      confirmed_at = CASE WHEN ? = 'Confirmed' THEN ? WHEN ? IN ('Declined','Contact Pending') THEN NULL ELSE confirmed_at END,
      notes = CASE WHEN ? IS NULL THEN notes ELSE ? END,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [data.status, data.status, now, data.status, req.user!.id, data.status, now, data.status, data.notes ?? null, data.notes ?? null, id]);
    await audit(req, 'assignment.contact', 'event_assignment', id, { from: existing[0].status, to: data.status });
    res.json({ ok: true, status: data.status });
  } catch (error) { next(error); }
});

api.delete('/assignments/:id', requirePermission('assignments.write'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    await execute("UPDATE event_assignments SET status='Cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    await audit(req, 'assignment.cancel', 'event_assignment', id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/** Authorized team contact sheet plus a ready-to-send message body. */
api.get('/events/:id/contact-sheet', requirePermission('assignments.read'), async (req, res) => {
  const id = int(req.params.id);
  const rows = await query<any[]>(`${eventSelect} WHERE e.id=?`, [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Event not found.' });
  const event = mapEvent(rows[0]);
  if (!can(req, 'contacts.read')) return res.status(403).json({ error: 'You do not have permission to view member contact details.', code: 'CONTACTS_FORBIDDEN' });
  const team = await query<any[]>(`SELECT ea.id, ea.responsibility, ea.status, ea.contacted_at contactedAt, ea.confirmed_at confirmedAt,
    m.id memberId, m.member_code memberCode, m.full_name memberName, m.phone, m.email
    FROM event_assignments ea JOIN members m ON m.id=ea.member_id
    WHERE ea.event_id=? AND ea.status NOT IN ('Cancelled') ORDER BY ea.responsibility, m.full_name`, [id]);
  const responsesDue = team.filter((t) => AWAITING_RESPONSE.includes(t.status)).length;
  const unfilledRoles = String(event.creativeRequirements || '').split(/[,;\n]/).map((v) => v.trim()).filter(Boolean)
    .filter((r) => !team.some((t) => t.responsibility === r && !['Cancelled', 'Declined'].includes(t.status)));
  const message = [
    `*${event.name}*`,
    `Date: ${event.eventDate}`,
    `Start: ${event.startTime} (Sri Lanka time)`,
    `Venue: ${event.venue}`,
    event.additionalInstructions ? `Notes: ${event.additionalInstructions}` : null,
    '',
    'Please reply to confirm you can attend with your assigned responsibility.',
  ].filter((line) => line !== null).join('\n');
  await audit(req, 'assignment.contact_sheet_view', 'event', id, { teamSize: team.length });
  res.json({ event, team, summary: { teamSize: team.length, responsesDue, unfilledRoles }, message, whatsappSupported: team.some((t) => t.phone) });
});

api.get('/events/:id/contact-sheet.csv', requirePermission('assignments.read'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    if (!can(req, 'contacts.read')) return res.status(403).json({ error: 'You do not have permission to export member contact details.', code: 'CONTACTS_FORBIDDEN' });
    const rows = await query<any[]>(`SELECT ea.responsibility, ea.status, m.member_code memberId, m.full_name memberName,
      m.grade, m.class_name className, m.phone, m.email, ea.contacted_at contactedAt, ea.confirmed_at confirmedAt
      FROM event_assignments ea JOIN members m ON m.id=ea.member_id
      WHERE ea.event_id=? AND ea.status NOT IN ('Cancelled') ORDER BY ea.responsibility, m.full_name`, [id]);
    await audit(req, 'assignment.contact_sheet_export', 'export', 'contact-sheet', { eventId: id, count: rows.length });
    res.type('text/csv').attachment(`rcpas-contact-sheet-${id}.csv`).send(toCsv(rows));
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
async function reportRows(type: string, from: string, to: string) {
  const inRange = from && to ? [from.slice(0, 10), to.slice(0, 10)] : ['1970-01-01', '2999-12-31'];
  if (type === 'membership') return query<any[]>('SELECT grade, class_name className, status, COUNT(*) total FROM members WHERE archived_at IS NULL GROUP BY grade,class_name,status ORDER BY grade,class_name');
  if (type === 'roles') return query<any[]>('SELECT cr.name role, COUNT(DISTINCT mr.member_id) members FROM creative_roles cr LEFT JOIN member_roles mr ON mr.role_id=cr.id LEFT JOIN members m ON m.id=mr.member_id AND m.archived_at IS NULL GROUP BY cr.id ORDER BY members DESC');
  if (type === 'directory') return query<any[]>(`SELECT m.member_code memberId, m.full_name fullName, m.grade, m.class_name className, m.status,
    COALESCE((SELECT GROUP_CONCAT(cr.name, '; ') FROM member_roles mr JOIN creative_roles cr ON cr.id=mr.role_id WHERE mr.member_id=m.id), '') roles,
    m.skills, m.experience, m.availability,
    COALESCE((SELECT GROUP_CONCAT(eq.brand || ' ' || eq.model || CASE WHEN eq.focal_length = '' OR eq.focal_length IS NULL THEN '' ELSE ' (' || eq.focal_length || ')' END, '; ') FROM equipment eq WHERE eq.responsible_member_id=m.id AND eq.archived_at IS NULL), '') equipment
    FROM members m WHERE m.archived_at IS NULL ORDER BY m.full_name`);
  if (type === 'skills') return query<any[]>(`SELECT m.member_code memberId, m.full_name fullName, m.grade, m.class_name className,
    m.skills, m.experience, m.availability,
    COALESCE((SELECT GROUP_CONCAT(eq.brand || ' ' || eq.model || CASE WHEN eq.focal_length = '' OR eq.focal_length IS NULL THEN '' ELSE ' (' || eq.focal_length || ')' END, '; ') FROM equipment eq WHERE eq.responsible_member_id=m.id AND eq.archived_at IS NULL), '') equipment
    FROM members m WHERE m.archived_at IS NULL AND m.status='Active' ORDER BY m.grade, m.full_name`);
  if (type === 'events') return query<any[]>("SELECT event_code eventId, name, category, status, event_date eventDate, start_time startTime, venue, priority, required_team_size requiredTeamSize FROM events WHERE event_date BETWEEN ? AND ? AND archived_at IS NULL ORDER BY event_date DESC, start_time DESC", inRange);
  if (type === 'equipment') return query<any[]>(`SELECT c.name category, e.equipment_code equipmentId, e.item_name itemName, e.brand, e.model, e.focal_length focalLength,
    e.quantity, e.ownership, m.full_name ownerMember, e.condition_status condition, e.availability
    FROM equipment e JOIN equipment_categories c ON c.id=e.category_id LEFT JOIN members m ON m.id=e.responsible_member_id
    WHERE e.archived_at IS NULL ORDER BY c.name, e.brand`);
  if (type === 'workload') return query<any[]>(`SELECT m.member_code memberId, m.full_name memberName, m.grade, m.class_name className,
    COUNT(ea.id) assignments, SUM(CASE WHEN ea.status='Completed' THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN ea.status='Confirmed' THEN 1 ELSE 0 END) confirmed,
    SUM(CASE WHEN ea.status IN ('Proposed','Contact Pending','Contacted','Reassignment Needed') THEN 1 ELSE 0 END) awaiting
    FROM members m LEFT JOIN event_assignments ea ON ea.member_id=m.id AND ea.status NOT IN ('Cancelled','Declined')
    WHERE m.archived_at IS NULL GROUP BY m.id ORDER BY assignments DESC, m.full_name`);
  if (type === 'participation' || type === 'assignments') return query<any[]>(`SELECT e.event_code eventId, e.name eventName, e.event_date eventDate, e.start_time startTime,
    m.member_code memberId, m.full_name memberName, ea.responsibility, ea.status, ea.contacted_at contactedAt, ea.confirmed_at confirmedAt
    FROM event_assignments ea JOIN events e ON e.id=ea.event_id JOIN members m ON m.id=ea.member_id
    WHERE e.event_date BETWEEN ? AND ? ORDER BY e.event_date DESC, e.start_time DESC, m.full_name`, inRange);
  if (type === 'confirmations') return query<any[]>(`SELECT e.event_code eventId, e.name eventName, e.event_date eventDate, e.start_time startTime,
    m.full_name memberName, ea.responsibility, ea.status, ea.contacted_at contactedAt, u.display_name contactedBy, ea.confirmed_at confirmedAt
    FROM event_assignments ea JOIN events e ON e.id=ea.event_id JOIN members m ON m.id=ea.member_id LEFT JOIN users u ON u.id=ea.contacted_by
    WHERE e.event_date BETWEEN ? AND ? ORDER BY e.event_date DESC, e.start_time DESC, m.full_name`, inRange);
  if (type === 'readiness') return query<any[]>(`SELECT e.event_code eventId, e.name eventName, e.event_date eventDate, e.start_time startTime, e.status, e.priority,
    e.required_team_size requiredTeamSize,
    (SELECT COUNT(*) FROM event_assignments ea WHERE ea.event_id=e.id AND ea.status NOT IN ('Cancelled','Declined')) assigned,
    (SELECT COUNT(*) FROM event_assignments ea WHERE ea.event_id=e.id AND ea.status='Confirmed') confirmed,
    (SELECT COUNT(*) FROM event_assignments ea WHERE ea.event_id=e.id AND ea.status IN ('Proposed','Contact Pending','Contacted','Reassignment Needed')) awaiting,
    (SELECT COUNT(*) FROM event_equipment_commitments ec WHERE ec.event_id=e.id AND ec.status NOT IN ('Confirmed','Released')) unconfirmedEquipment
    FROM events e WHERE e.archived_at IS NULL AND e.event_date BETWEEN ? AND ? ORDER BY e.event_date DESC, e.start_time DESC`, inRange);
  if (type === 'staffing') return query<any[]>("SELECT e.event_code eventId, e.name eventName, e.status, e.event_date eventDate, e.start_time startTime, COUNT(ea.id) crewCount FROM events e LEFT JOIN event_assignments ea ON ea.event_id=e.id AND ea.status NOT IN ('Cancelled','Declined') WHERE e.archived_at IS NULL AND e.event_date BETWEEN ? AND ? GROUP BY e.id ORDER BY e.event_date DESC, e.start_time DESC", inRange);
  if (type === 'availability') return query<any[]>("SELECT availability, COUNT(*) equipmentCount, SUM(quantity) units FROM equipment WHERE archived_at IS NULL GROUP BY availability ORDER BY availability");
  if (type === 'allocations') return query<any[]>(`SELECT e.equipment_code equipmentId, ev.event_code eventId, ev.name eventName, ev.event_date eventDate,
    ea.quantity, ea.issued_at issuedAt, ea.returned_at returnedAt, ea.return_status returnStatus
    FROM equipment_allocations ea JOIN equipment e ON e.id=ea.equipment_id JOIN events ev ON ev.id=ea.event_id
    WHERE ev.event_date BETWEEN ? AND ? ORDER BY ev.event_date DESC`, inRange);
  if (type === 'administrative') return query<any[]>('SELECT a.id, a.action, a.entity_type entityType, a.entity_id entityId, a.details, a.created_at createdAt, u.display_name actorName FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 500');
  return query<any[]>("SELECT e.name eventName, e.status, e.event_date eventDate, COUNT(ea.id) assignments FROM events e LEFT JOIN event_assignments ea ON ea.event_id=e.id AND ea.status NOT IN ('Cancelled','Declined') WHERE e.archived_at IS NULL AND e.event_date BETWEEN ? AND ? GROUP BY e.id ORDER BY e.event_date DESC, e.start_time DESC", inRange);
}

const REPORT_TYPES = ['membership', 'roles', 'directory', 'skills', 'events', 'equipment', 'workload', 'participation', 'assignments', 'confirmations', 'readiness', 'staffing', 'availability', 'allocations', 'administrative'];
api.get('/reports', requirePermission('reports.read'), async (_req, res) => res.json({ reports: REPORT_TYPES }));

api.get('/reports/:type', requirePermission('reports.read'), async (req, res) => {
  const type = String(req.params.type);
  const from = req.query.from ? String(req.query.from) : '1970-01-01';
  const to = req.query.to ? String(req.query.to) : '2999-12-31';
  res.json({ data: await reportRows(type, from, to), filters: { from, to }, generatedAt: new Date().toISOString() });
});

/** Combined full export covering members, roles, gear, events, assignments and a summary. */
api.get('/reports/full/export.csv', requirePermission('reports.export'), async (req, res) => {
  const from = req.query.from ? String(req.query.from) : '1970-01-01';
  const to = req.query.to ? String(req.query.to) : '2999-12-31';
  const sections: { name: string; rows: any[] }[] = [
    { name: 'Members', rows: await reportRows('directory', from, to) },
    { name: 'Creative Roles', rows: await reportRows('roles', from, to) },
    { name: 'Personal Equipment', rows: await reportRows('equipment', from, to) },
    { name: 'Events', rows: await reportRows('events', from, to) },
    { name: 'Assignments', rows: await reportRows('participation', from, to) },
    { name: 'Confirmations', rows: await reportRows('confirmations', from, to) },
    { name: 'Readiness', rows: await reportRows('readiness', from, to) },
    { name: 'Summary', rows: await query<any[]>(`SELECT
      (SELECT COUNT(*) FROM members WHERE archived_at IS NULL) totalMembers,
      (SELECT COUNT(*) FROM members WHERE status='Active' AND archived_at IS NULL) activeMembers,
      (SELECT COUNT(*) FROM events WHERE archived_at IS NULL) totalEvents,
      (SELECT COUNT(*) FROM equipment WHERE archived_at IS NULL) totalEquipmentItems,
      (SELECT COUNT(*) FROM event_assignments WHERE status NOT IN ('Cancelled','Declined')) activeAssignments,
      (SELECT COUNT(*) FROM event_assignments WHERE status='Confirmed') confirmedAssignments,
      (SELECT COUNT(*) FROM event_equipment_commitments WHERE status='Confirmed') confirmedEquipment`) },
  ];
  const csv = sections.map((section) => `# ${section.name} (filters: from=${from}, to=${to}; exported ${new Date().toISOString()})\n${toCsv(section.rows)}`).join('\n\n');
  await audit(req, 'report.export_full', 'report', 'full', { from, to, sections: sections.map((s) => `${s.name}:${s.rows.length}`).join(', ') });
  res.type('text/csv').attachment('rcpas-full-report.csv').send(csv);
});

api.get('/reports/:type/export.csv', requirePermission('reports.export'), async (req, res) => {
  const type = String(req.params.type);
  const from = req.query.from ? String(req.query.from) : '1970-01-01';
  const to = req.query.to ? String(req.query.to) : '2999-12-31';
  const rows = await reportRows(type, from, to);
  await audit(req, 'report.export', 'report', type, { from, to, count: rows.length });
  res.type('text/csv').attachment(`rcpas-${type}-report.csv`).send(toCsv(rows));
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------
api.get('/settings', requirePermission('settings.read'), async (_req, res) => res.json({ data: await query<any[]>('SELECT setting_key settingKey, setting_value settingValue, updated_at updatedAt FROM society_settings ORDER BY setting_key') }));
api.patch('/settings', requirePermission('settings.write'), async (req, res, next) => {
  try {
    const entries = req.body as Record<string, string>;
    for (const [key, value] of Object.entries(entries)) {
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key) || typeof value !== 'string' || value.length > 2000) return res.status(400).json({ error: 'Invalid setting.' });
      await execute('INSERT INTO society_settings (setting_key,setting_value,updated_by,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP', [key, value, req.user!.id]);
    }
    await audit(req, 'settings.update', 'settings', null, entries);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
api.get('/users', requirePermission('users.manage'), async (_req, res) => {
  const rows = await query<any[]>(`SELECT u.id,u.open_id openId,u.email,u.display_name displayName,u.active,u.last_login_at lastLoginAt,
    COALESCE(GROUP_CONCAT(DISTINCT r.name), '') roles, COALESCE(GROUP_CONCAT(DISTINCT r.id), '') roleIds
    FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN system_roles r ON r.id=ur.role_id GROUP BY u.id ORDER BY u.display_name`);
  // roleIds is returned as a real array: PATCH expects an array, and the table
  // used to hand-split this string, which silently dropped every role but the first.
  res.json({ data: rows.map((row) => ({ ...row, roleIds: row.roleIds ? String(row.roleIds).split(',').filter(Boolean).map(Number) : [] })) });
});
api.get('/system-roles', requirePermission('users.manage'), async (_req, res) => res.json({ data: await query<any[]>('SELECT id,name FROM system_roles ORDER BY name') }));
api.get('/permissions', requirePermission('users.manage'), async (_req, res) => res.json({ data: await query<any[]>('SELECT id, code, description FROM permissions ORDER BY code') }));
api.get('/role-permissions', requirePermission('users.manage'), async (_req, res) => res.json({ data: await query<any[]>('SELECT rp.role_id roleId, p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id') }));
api.post('/users', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const displayName = String(req.body.displayName ?? '').trim();
    const roleIds = normaliseRoleIds(req.body.roleIds);
    const active = req.body.active === undefined ? true : Boolean(req.body.active);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required for the account.', code: 'VALIDATION_FAILED' });
    if (displayName.length < 2) return res.status(400).json({ error: 'Enter the official\'s full name so the account is identifiable.', code: 'VALIDATION_FAILED' });
    if (!roleIds.length) return res.status(400).json({ error: 'Choose at least one role so the account has access.', code: 'VALIDATION_FAILED' });
    const password = validatePasswordInput(req.body.password);
    const openId = `local:${email}`;
    const existing = await query<{ id: number }[]>('SELECT id FROM users WHERE LOWER(email)=? OR open_id=?', [email, openId]);
    if (existing.length) return res.status(409).json({ error: 'An official account with that email address already exists.', code: 'DUPLICATE_EMAIL' });
    const passwordHash = await hashPassword(password);
    const id = await withTransaction(async (connection) => {
      const [inserted] = await connection.execute('INSERT INTO users (open_id,email,display_name,active,password_hash,password_changed_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', [openId, email, displayName, active ? 1 : 0, passwordHash]);
      const userId = (inserted as ExecuteResult).insertId;
      for (const roleId of roleIds) await connection.execute('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [userId, roleId]);
      return userId;
    });
    await audit(req, 'user.create', 'user', id, { email, displayName, roleIds, active });
    res.status(201).json({ ok: true, id, email, displayName, roleIds, active });
  } catch (error) { next(error); }
});
api.patch('/users/:id', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const id = int(req.params.id);
    const target = await query<{ id: number; displayName: string }[]>('SELECT id,display_name displayName FROM users WHERE id=?', [id]);
    if (!target[0]) return res.status(404).json({ error: 'Account not found.', code: 'USER_NOT_FOUND' });
    // Partial update: only the fields present in the body are written. The previous
    // version always wrote `active`, so a name-only change would have deactivated the account.
    const changes: Record<string, unknown> = {};
    if (typeof req.body.displayName === 'string') {
      const displayName = req.body.displayName.trim();
      if (displayName.length < 2) return res.status(400).json({ error: 'Enter the official\'s full name so the account is identifiable.', code: 'VALIDATION_FAILED' });
      await execute('UPDATE users SET display_name=? WHERE id=?', [displayName, id]);
      changes.displayName = displayName;
    }
    if (typeof req.body.password === 'string' && req.body.password) {
      const passwordHash = await hashPassword(validatePasswordInput(req.body.password));
      // An administrator setting a password is treating it as a reset, so any live
      // sessions for the account are ended rather than left signed in on the old secret.
      await execute('UPDATE users SET password_hash=?,password_changed_at=CURRENT_TIMESTAMP,failed_login_count=0,locked_until=NULL WHERE id=?', [passwordHash, id]);
      await execute('DELETE FROM auth_sessions WHERE user_id=?', [id]);
      changes.passwordReset = true;
    }
    if (typeof req.body.active === 'boolean') {
      if (req.body.active === false && req.user!.id === id) return res.status(400).json({ error: 'You cannot deactivate your own active session.' });
      await execute('UPDATE users SET active=? WHERE id=?', [req.body.active ? 1 : 0, id]);
      changes.active = req.body.active;
    }
    if (Array.isArray(req.body.roleIds)) {
      const roleIds = normaliseRoleIds(req.body.roleIds);
      const known = await query<{ id: number }[]>(`SELECT id FROM system_roles WHERE id IN (${roleIds.length ? roleIds.map(() => '?').join(',') : 'NULL'})`, roleIds);
      if (known.length !== roleIds.length) return res.status(400).json({ error: 'One or more selected roles do not exist.', code: 'VALIDATION_FAILED' });
      // Do not let the last account with account-management access lock everyone out of Settings.
      if (req.user!.id === id) {
        const losingManage = await query<{ id: number }[]>(`SELECT p.id FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id IN (SELECT role_id FROM user_roles WHERE user_id=?) AND p.code='users.manage'`, [id]);
        if (losingManage.length) {
          const keepsManage = roleIds.length ? await query<{ id: number }[]>(`SELECT p.id FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id IN (${roleIds.map(() => '?').join(',')}) AND p.code='users.manage'`, roleIds) : [];
          if (!keepsManage.length) return res.status(400).json({ error: 'You cannot remove your own account-management access. Ask another official who has it to change your roles.', code: 'SELF_LOCKOUT' });
        }
      }
      await withTransaction(async (connection) => {
        await connection.execute('DELETE FROM user_roles WHERE user_id=?', [id]);
        for (const roleId of roleIds) await connection.execute('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [id, roleId]);
      });
      changes.roleIds = roleIds;
    }
    await audit(req, 'user.update', 'user', id, changes);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
api.get('/audit', requirePermission('audit.read'), async (_req, res) => res.json({ data: await query<any[]>('SELECT a.id,a.action,a.entity_type entityType,a.entity_id entityId,a.details,a.created_at createdAt,u.display_name actorName FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100') }));
