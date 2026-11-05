import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { api } from './routes/api.js';
import { attachUser } from './middleware/auth.js';
import { authLimiter, csrf, errorHandler, requestContext, securityHeaders } from './middleware/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Both layouts (src/server under tsx in dev, dist/server when built) sit two
// levels below the project root, so root resolution is the same either way.
const root = path.resolve(__dirname, '../..');
// .env pins NODE_ENV=development, so the built server opts in explicitly with
// `--production` instead of relying on an env var a local .env may overwrite.
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const app = express();
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
// CORS allowlist. The old `origin: true` reflected ANY Origin back together with
// Access-Control-Allow-Credentials: true, so any website could make credentialed
// cross-site calls to this API. Only the deployed origin and local dev are allowed now;
// everything else receives no CORS headers and the browser blocks it. Override via CORS_ORIGINS.
const allowedOrigins = (process.env.CORS_ORIGINS || 'https://rahulaphotography.vercel.app,http://localhost:3000,http://127.0.0.1:3000').split(',').map((s) => s.trim()).filter(Boolean);
// Behind Vercel's proxy req.ip is the proxy address unless we trust one hop; without this
// every caller would share a single rate-limit bucket.
app.set('trust proxy', 1);
app.use(cors({ origin: allowedOrigins, credentials: true, methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','X-CSRF-Token'] }));
app.use(requestContext); app.use(securityHeaders); app.use(cookieParser()); app.use(express.json({ limit: '1mb' }));
// SameSite=Lax keeps the CSRF cookie off cross-site requests entirely — the API is served
// from this same origin, so Lax never blocks a legitimate call. SameSite=None was sending
// the token cookie cross-site, which weakened the very protection it exists to provide.
app.use((req, res, next) => { if (!req.cookies.rcpas_csrf) res.cookie('rcpas_csrf', cryptoToken(), { httpOnly: false, sameSite: 'lax', secure: true, maxAge: 8 * 60 * 60 * 1000 }); next(); });
app.get('/health', (_req, res) => res.json({ ok: true, service: 'rcpas-portal' }));
// Rate-limit only the credential endpoints. Session reads and logout are not
// credential checks: limiting them would lock out legitimate page loads.
app.use('/api/auth/password/login', authLimiter);
app.use('/api/auth/password/change', authLimiter);
app.use(attachUser);
app.use('/api', csrf, api);

function cryptoToken() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }

// Serve the standalone login page (the exact static HTML) at /login, ahead of
// the SPA fallback, so the login screen renders exactly as authored rather than
// through React. The cookie-seeding middleware above still runs on this request,
// so the page receives the rcpas_csrf cookie it needs for the sign-in POST.
app.get('/login', (_req, res) => res.sendFile(path.join(root, isProduction ? 'dist/client/login.html' : 'public/login.html')));

if (isProduction) {
  app.use(express.static(path.join(root, 'dist/client')));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(root, 'dist/client/index.html')));
  app.use(errorHandler);
  app.listen(port, '0.0.0.0', () => console.log(`RCPAS portal listening on ${port}`));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
  app.use(errorHandler);
  app.listen(port, '0.0.0.0', () => console.log(`RCPAS portal development server listening on ${port}`));
}
