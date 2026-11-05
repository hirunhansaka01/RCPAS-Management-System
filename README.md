# RCPAS Management System

An internal administration portal for a photographic art society — members and the
gear they own, events and the crew assigned to them, reports, and a role-based
permission model, all behind an official-only login.

**Original website:** <https://rahulaphotography.vercel.app>

> **This is the public edition.** It ships with no credentials, no personal
> records and no deployment configuration. Everything specific to a deployment
> is supplied through environment variables — see
> [Configuration](#configuration). Nothing here matches a private deployment.

## Features

- **Members** — registration with auto-generated member codes, many-to-many
  creative roles, structured search and filters, contact masking, CSV export,
  archive instead of hard delete.
- **Gear directory** — member-owned equipment with auto-generated internal IDs,
  one record per physical item, structured search (brand, model, focal length,
  mount, keywords, category), owner cards, per-event status workflow.
- **Event planning workspace** — eight tabs covering requirements, discussion
  (officials only), team assignment, live readiness, contact sheets and
  activity; same-date conflict detection; waiving requires a reason.
- **Assignments** — search members *by the gear they own*, assign, confirm,
  and soft-cancel while preserving history.
- **Reports** — live metrics and formula-safe CSV exports.
- **Settings** — officials, roles, society settings, audit log.
- **Unified search** — one bar across members, events and gear.

## Tech stack

| Layer      | Choice                                             |
|------------|----------------------------------------------------|
| Client     | React 19 + TypeScript + Vite                       |
| Server     | Express + TypeScript                               |
| Database   | SQLite locally (`node:sqlite`), Turso/libSQL in production |
| Auth       | scrypt password hashing, session cookies, CSRF     |
| Deploy     | Vercel (serverless) — see `vercel.json`            |
| Tooling    | pnpm 10.12.4, Node 22.x                            |

## Quick start

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env

# 3. Apply schema and reference data
pnpm db:migrate
pnpm db:seed

# 4. Start
pnpm dev          # http://localhost:3000
```

No MySQL server or external database is required locally — the database is a
single SQLite file created on first run at `DATABASE_URL`
(default `./data/rcpas.sqlite`).

### Create your administrator

There are **no default credentials**. Create the first System Administrator
account with your own values:

```bash
SETUP_ADMIN_EMAIL=you@example.com \
SETUP_ADMIN_PASSWORD='choose-a-strong-password' \
SETUP_ADMIN_NAME='Your Name' \
pnpm db:setup-admin
```

Or set `SETUP_ADMIN_*` in `.env` and run `pnpm db:setup-admin`. Only a scrypt
hash is stored; the password itself is never written to the database or to source
control. System Administrator does **not** automatically become President —
roles are granted deliberately.

## Configuration

Copy `.env.example` to `.env`. Every value is optional and deployment-specific.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Local SQLite file path. Used only when `TURSO_DATABASE_URL` is unset. |
| `TURSO_DATABASE_URL` | Hosted Turso/libSQL URL for production. Leave blank for local SQLite. |
| `TURSO_AUTH_TOKEN` | Turso auth token (`turso db tokens create rcpas`). Must **not** be read-only if migrations run at boot. |
| `APP_ORIGIN` | Origin the app is served from — checked on CORS preflights and used to scope cookies. |
| `PORT` | Dev server port (default `3000`). |
| `SETUP_ADMIN_EMAIL` / `SETUP_ADMIN_PASSWORD` / `SETUP_ADMIN_NAME` | First-run admin provisioning. |
| `TEST_ADMIN_PASSWORD` etc. | Credentials for the end-to-end suites — see [Testing](#testing). |
| `CORS_ORIGINS` | Override the CORS allowlist (comma-separated). Defaults to the deployment origin plus `localhost:3000`. |

**Never commit `.env`.** It is gitignored; only `.env.example` (which contains no
secrets) is tracked.

## Testing

Unit tests:

```bash
pnpm test
```

End-to-end suites sign in as real accounts, so they need passwords **you** supply.
Nothing in this repository contains a working one.

```bash
# 1. Choose your own passwords in .env
TEST_ADMIN_PASSWORD=...
TEST_PRESIDENT_PASSWORD=...
TEST_CHIEF_PASSWORD=...
TEST_ORGANIZER_PASSWORD=...

# 2. Create the administrator (see above) using TEST_ADMIN_PASSWORD as its value
# 3. Create the other three accounts
pnpm db:setup-test-accounts

# 4. Run
pnpm test:e2e
node tests/stage1b-workspace.mjs
node tests/accounts-smoke.mjs
```

The suites read the same variables through `tests/creds.mjs`, so the accounts
created and the accounts signed into always agree. If a variable is missing the
suite stops with a clear message instead of failing obscurely.

> **Run end-to-end suites only against a database you are happy to modify.**
> They create and clean up their own fixtures, but they do touch live tables.

## Database

Migrations live in `src/server/migrations/` and are numbered:

```
0001_initial.sql                          core schema
0002_password_auth.sql                    password sessions
0003_core_upgrade.sql                     event planning columns, gear search fields
0004_event_requirements_discussion.sql    requirements + discussion
```

They are idempotent — safe to re-run on every cold start, which is how the
serverless deployment provisions a fresh database. Statements that fail only
because a column or index already exists are skipped rather than treated as
errors.

The database is a single file, so a backup is a file copy:

```bash
cp data/rcpas.sqlite rcpas-backup.sqlite   # back up (server stopped)
cp rcpas-backup.sqlite data/rcpas.sqlite   # restore
```

CSV exports on the report and list screens give a consistent snapshot without
stopping the server.

## Deployment

`vercel.json` defines the Vite build, the serverless API entrypoint, SPA
rewrites (including `/login` → the static login page), the security headers and
the migrations bundle.

To deploy your own instance:

1. Fork this repository.
2. Create a project on [Vercel](https://vercel.com) from the fork.
3. Create a database: `turso db create rcpas` then
   `turso db tokens create rcpas --expiration never`.
4. Add the environment variables `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   `SETUP_ADMIN_*` and `APP_ORIGIN` (your Vercel URL) — **and redeploy**, since
   Vercel only applies environment variables to new deployments.
5. On the first cold start the schema, reference data and administrator are
   provisioned automatically. Check `GET /api/health` if anything looks wrong.

## Security

Enforced on every protected read, write and export:

- **Rate limiting** on authentication (5 attempts / 15 minutes, successful
  logins not counted).
- **CORS allowlist** — origins are never reflected; the deployment origin plus
  `localhost` are allowed, everything else is refused.
- **Cookies** are `HttpOnly`, `Secure` and `SameSite=Lax`, with a CSRF token
  required on every non-GET request.
- **Security headers** — CSP, `X-Frame-Options: DENY`, HSTS,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`.
  They are set both in Express and in `vercel.json`, because the platform's edge
  serves static HTML without passing through Express.
- **Permissions** enforced in middleware on every route, not in the UI.
- **Passwords** scrypt-hashed; sessions expire; failed logins are throttled.
- **Audit log** records real successes only — never optimistic entries.
- **Destructive actions** require confirmation; members and records are archived
  rather than hard-deleted when history references them.

### Known limitations

- Password recovery is administrator-assisted (no self-service email reset).
- The rate limiter is in-memory, so it resets when a serverless instance cold
  starts — it is a speed bump, not a perimeter.
- No two-factor authentication.
- Conflicts are detected on date overlap only.

## Project structure

```
public/            static assets including the standalone login page
src/client/        React application (pages, shell, styles)
src/server/        Express app, routes, middleware, migrations, DB drivers
src/shared/        types shared by client and server
tests/             unit, smoke and workflow suites
vercel.json        build, rewrites and security headers
```

## Credits

Developed by **Hirun Hansaka**.
