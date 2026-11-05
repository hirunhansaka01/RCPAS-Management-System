import type { NextFunction, Request, Response } from 'express';
import { query, execute } from '../db.js';
import type { Permission, SessionUser, AppRole } from '../../shared/types.js';

declare global { namespace Express { interface Request { user?: SessionUser | null; requestId?: string; } } }

export async function resolveUser(req: Request): Promise<SessionUser | null> {
  const passwordSession = req.cookies?.rcpas_session;
  if (passwordSession) {
    const sessionRows = await query<any[]>(`SELECT u.id, u.open_id as openId, u.email, u.display_name as displayName, u.active,
      GROUP_CONCAT(DISTINCT r.name) AS roleNames, GROUP_CONCAT(p.code) AS permissionCodes
      FROM auth_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN system_roles r ON r.id=ur.role_id
      LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
      WHERE s.id=? AND s.expires_at > datetime('now') AND u.active=1 GROUP BY u.id`, [passwordSession]);
    if (sessionRows[0]) {
      await execute('UPDATE auth_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?', [passwordSession]);
      const user = sessionRows[0];
      return { id: user.id, openId: user.openId, email: user.email, displayName: user.displayName, active: Boolean(user.active), roles: (user.roleNames ? [...new Set(String(user.roleNames).split(','))] : []) as AppRole[], permissions: (user.permissionCodes ? [...new Set(String(user.permissionCodes).split(','))] : []) as Permission[] };
    }
  }
  return null;
}

export async function attachUser(req: Request, _res: Response, next: NextFunction) { try { req.user = await resolveUser(req); } catch { req.user = null; } next(); }

export function requireAuth(req: Request, res: Response, next: NextFunction) { if (!req.user) return res.status(401).json({ error: 'Official authentication is required.', code: 'AUTH_REQUIRED' }); next(); }
export function requirePermission(permission: Permission) { return (req: Request, res: Response, next: NextFunction) => { if (!req.user) return res.status(401).json({ error: 'Official authentication is required.', code: 'AUTH_REQUIRED' }); if (!req.user.permissions.includes(permission)) return res.status(403).json({ error: 'Your official role does not permit this action.', code: 'FORBIDDEN' }); next(); }; }
export async function audit(req: Request, action: string, entityType: string, entityId: string | number | null, details: unknown = {}) { if (req.user) await execute('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)', [req.user.id, action, entityType, entityId === null ? null : String(entityId), JSON.stringify(details), req.ip]); }
