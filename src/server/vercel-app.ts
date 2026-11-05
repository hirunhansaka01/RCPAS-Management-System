import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { api } from './routes/api.js';
import { attachUser } from './middleware/auth.js';
import { authLimiter, csrf, errorHandler, requestContext, securityHeaders } from './middleware/security.js';
import { provisionDatabase } from './provision.js';
import { query, usingTurso } from './db.js';

const app = express();
app.disable('x-powered-by');
// CORS allowlist — see src/server/index.ts for the rationale. `origin: true` used to
// reflect any Origin together with credentials, letting arbitrary sites call this API.
const allowedOrigins = (process.env.CORS_ORIGINS || 'https://rahulaphotography.vercel.app,http://localhost:3000,http://127.0.0.1:3000').split(',').map((s) => s.trim()).filter(Boolean);
app.set('trust proxy', 1); // real client IP behind Vercel's proxy, so rate limiting is per-user
app.use(cors({ origin: allowedOrigins, credentials: true, methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','X-CSRF-Token'] }));
app.use(requestContext); app.use(securityHeaders); app.use(cookieParser()); app.use(express.json({ limit: '1mb' }));
// Seed the CSRF cookie the same way the long-running server does, otherwise every
// POST/DELETE would fail the csrf middleware (the client echoes this cookie back
// as the X-CSRF-Token header).
app.use((req, res, next) => { if (!req.cookies.rcpas_csrf) res.cookie('rcpas_csrf', cryptoToken(), { httpOnly: false, sameSite: 'lax', secure: true, maxAge: 8 * 60 * 60 * 1000 }); next(); });
// Boot/provisioning status, surfaced by /api/health so a failing cold start is diagnosable
// from the browser (a hard crash here would make every /api request return a gateway error).
const boot = { provisioned: false, error: null as string | null, at: new Date().toISOString() };

app.get('/health', (_req, res) => res.json({ ok: true, service: 'rcpas-portal' }));
// Diagnostic endpoint: reports function liveness, active DB driver, cold-start provisioning
// result, and a live DB ping — env values are reported as booleans only (never leaked).
app.get('/api/health', async (_req, res) => {
  const db: Record<string, unknown> = { driver: usingTurso ? 'turso' : 'local', provisioned: boot.provisioned, error: boot.error, provisionedAt: boot.at };
  try { await query('SELECT 1 AS ok'); db.ping = 'ok'; } catch (e) { db.ping = `failed: ${e instanceof Error ? e.message : String(e)}`; }
  res.json({ ok: true, service: 'rcpas-portal', commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7), node: process.version, db, env: {
    tursoUrl: Boolean(process.env.TURSO_DATABASE_URL?.trim()),
    tursoToken: Boolean(process.env.TURSO_AUTH_TOKEN?.trim()),
    adminEmail: Boolean(process.env.SETUP_ADMIN_EMAIL?.trim()),
    adminPassword: Boolean(process.env.SETUP_ADMIN_PASSWORD),
  } });
});
// Rate-limit the credential endpoints before the API mounts. This was missing from the
// Vercel entrypoint entirely, which is why the deployed site accepted unlimited failed
// login attempts. Session reads and logout are not credential checks, so they stay
// unthrottled (throttling them would lock out legitimate page loads).
app.use('/api/auth/password/login', authLimiter);
app.use('/api/auth/password/change', authLimiter);
app.use(attachUser); app.use('/api', csrf, api); app.use(errorHandler);

// Bootstrap the database at cold start (schema → reference data → optional admin). This is
// idempotent, but we deliberately do NOT let a failure kill the function: a thrown top-level
// await aborts module load, so every /api request would return a non-JSON gateway error and
// the client would show a generic "Sign in failed". Instead we log the error, keep serving
// requests, and expose the failure via /api/health for diagnosis.
try {
  await provisionDatabase();
  boot.provisioned = true;
} catch (error) {
  boot.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error('[boot] Database provisioning failed:', boot.error);
}

function cryptoToken() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }

export default app;
