import express from 'express';
import cookieParser from 'cookie-parser';
import { api } from './routes/api.js';
import { attachUser } from './middleware/auth.js';
import { authLimiter, csrf, errorHandler, requestContext, securityHeaders, CSRF_COOKIE } from './middleware/security.js';
import { provisionDatabase } from './provision.js';
import { query, usingTurso } from './db.js';

const app = express();
app.disable('x-powered-by');
// CORS allowlist — see src/server/index.ts for the rationale. `origin: true` used to
// reflect any Origin together with credentials, letting arbitrary sites call this API.
const allowedOrigins = (process.env.CORS_ORIGINS || 'https://rahulaphotography.vercel.app,http://localhost:3000,http://127.0.0.1:3000').split(',').map((s) => s.trim()).filter(Boolean);
app.set('trust proxy', 1); // real client IP behind Vercel's proxy, so rate limiting is per-user
// Both CORS headers are set inside the same allow-list branch. The `cors` package emits
// Access-Control-Allow-Credentials unconditionally, so a foreign Origin saw the credentials
// header with no matching allow-origin: harmless today, but one origin misconfiguration
// away from a credentialed cross-origin read. This is the same allow-list, stated once.
const allowedOriginSet = new Set(allowedOrigins);
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOriginSet.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token'); res.status(204).end(); return; }
  next();
});
app.use(requestContext); app.use(securityHeaders); app.use(cookieParser()); app.use(express.json({ limit: '1mb' }));
// Seed the CSRF cookie the same way the long-running server does, otherwise every
// POST/DELETE would fail the csrf middleware (the client echoes this cookie back
// as the X-CSRF-Token header). One-hour lifetime, matching the long-running server.
app.use((req, res, next) => { if (!req.cookies[CSRF_COOKIE]) res.cookie(CSRF_COOKIE, cryptoToken(), { httpOnly: false, sameSite: 'lax', secure: true, path: '/', maxAge: 60 * 60 * 1000 }); next(); });
// Boot/provisioning status, surfaced by /api/health/detail so a failing cold start is
// diagnosable from the browser (a hard crash here would make every /api request return a
// gateway error).
const boot = { provisioned: false, error: null as string | null, at: new Date().toISOString() };

app.get('/health', (_req, res) => res.json({ ok: true, service: 'rcpas-portal' }));
// Liveness only. The body that used to live here disclosed the deployed commit, the
// runtime version, the database engine, provisioning state and which administrative
// secrets are configured - to any unauthenticated caller, which is exactly the
// reconnaissance an attacker wants before choosing a target. Diagnostics moved to
// /api/health/detail, behind a signed-in session.
app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
// Rate-limit the credential endpoints before the API mounts. This was missing from the
// Vercel entrypoint entirely, which is why the deployed site accepted unlimited failed
// login attempts. Session reads and logout are not credential checks, so they stay
// unthrottled (throttling them would lock out legitimate page loads).
app.use('/api/auth/password/login', authLimiter);
app.use('/api/auth/password/change', authLimiter);
app.use(attachUser);
// Full diagnostics - commit, driver, provisioning state, a live ping and which secrets are
// configured - for a signed-in operator only. This is the body that used to be public.
app.get('/api/health/detail', async (_req, res) => {
  if (!_req.user) return res.status(401).json({ error: 'Official authentication is required.', code: 'AUTH_REQUIRED' });
  const db: Record<string, unknown> = { driver: usingTurso ? 'turso' : 'local', provisioned: boot.provisioned, error: boot.error, provisionedAt: boot.at };
  try { await query('SELECT 1 AS ok'); db.ping = 'ok'; } catch (e) { db.ping = `failed: ${e instanceof Error ? e.message : String(e)}`; }
  res.json({ ok: true, service: 'rcpas-portal', commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7), node: process.version, db, env: {
    tursoUrl: Boolean(process.env.TURSO_DATABASE_URL?.trim()),
    tursoToken: Boolean(process.env.TURSO_AUTH_TOKEN?.trim()),
    adminEmail: Boolean(process.env.SETUP_ADMIN_EMAIL?.trim()),
    adminPassword: Boolean(process.env.SETUP_ADMIN_PASSWORD),
  } });
});
app.use('/api', csrf, api); app.use(errorHandler);

// Bootstrap the database at cold start (schema → reference data → optional admin). This is
// idempotent, but we deliberately do NOT let a failure kill the function: a thrown top-level
// await aborts module load, so every /api request would return a non-JSON gateway error and
// the client would show a generic "Sign in failed". Instead we log the error, keep serving
// requests, and expose the failure via /api/health/detail for a signed-in operator.
try {
  await provisionDatabase();
  boot.provisioned = true;
} catch (error) {
  boot.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error('[boot] Database provisioning failed:', boot.error);
}

function cryptoToken() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }

export default app;
