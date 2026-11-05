import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

// Brute-force protection on the credential endpoints. Only FAILED attempts count toward the
// budget (skipSuccessfulRequests), so a user who signs in successfully is never throttled,
// while password guessing is capped at 5 tries per IP per 15 minutes, then 429.
export const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.', code: 'RATE_LIMITED' } });

// Shared policy so the Express responses and vercel.json (which covers the static HTML
// shell that Express never sees on Vercel) cannot drift apart. frame-ancestors 'none' +
// X-Frame-Options: DENY close the clickjacking gap on the login page.
export const csp = "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; connect-src 'self' https:";
export function securityHeaders(_req: Request, res: Response, next: NextFunction) { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'); res.setHeader('Content-Security-Policy', csp); next(); }
export function requestContext(req: Request, res: Response, next: NextFunction) { req.requestId = crypto.randomUUID(); res.setHeader('X-Request-Id', req.requestId); next(); }
export function csrf(req: Request, res: Response, next: NextFunction) { if (['GET','HEAD','OPTIONS'].includes(req.method)) return next(); const expected = req.cookies?.rcpas_csrf; const provided = req.get('x-csrf-token'); if (!expected || !provided || expected !== provided) return res.status(403).json({ error: 'Security token missing or invalid.', code: 'CSRF_FAILED' }); next(); }
/** Maps known database/driver failures to a safe, actionable message so a 500 on the login
 *  page tells the operator what to fix instead of a generic "operation could not be completed".
 *  Deliberately never echoes SQL, credentials, or the connection string. */
function dbErrorHint(message?: string): string | null {
  const m = message || '';
  if (/invalid url/i.test(m)) return 'Database URL is invalid. Set TURSO_DATABASE_URL to the full libsql://… address.';
  if (/readonly|read-only|attempt to write/i.test(m)) return 'The database token is read-only and cannot create tables. Regenerate a full (non-read-only) Turso token.';
  if (/401|403|unauthorized|forbidden|auth.?token|invalid token|jwt/i.test(m)) return 'Database authentication failed. Regenerate TURSO_AUTH_TOKEN and update it in Vercel.';
  if (/fetch failed|econnrefused|enotfound|getaddrinfo|network|socket|timeout|certificate|ENETUNREACH/i.test(m)) return 'Cannot reach the database. Check TURSO_DATABASE_URL and try again.';
  if (/no such table|no such column|has no column|does not exist/i.test(m)) return 'The database schema is missing — migrations did not complete. Visit /api/health for details.';
  return null;
}
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) { console.error(`[${req.requestId ?? 'no-request-id'}]`, error); if (res.headersSent) return; const err = error as { name?: string; status?: number; statusCode?: number; message?: string; code?: string; issues?: unknown[]; flatten?: () => { fieldErrors: Record<string, string[]> } };
// Schema violations are client errors: surface the field messages so forms can show them.
if (err && (err.name === 'ZodError' || Array.isArray(err.issues))) { const flat = typeof err.flatten === 'function' ? err.flatten() : { fieldErrors: {} }; return res.status(400).json({ error: 'Some fields need attention. Check the highlighted values.', code: 'VALIDATION_FAILED', details: flat.fieldErrors }); }
const status = err?.status ?? err?.statusCode;
if (typeof status === 'number' && status >= 400 && status < 600) return res.status(status).json({ error: err?.message || 'The request could not be processed.', code: err?.code });
res.status(500).json({ error: dbErrorHint(err?.message) || 'The operation could not be completed. Try again or contact an administrator.', code: 'INTERNAL_ERROR', requestId: req.requestId }); }
