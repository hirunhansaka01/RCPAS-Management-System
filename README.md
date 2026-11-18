# Rahula College Photographic Art Society Portal

This repository is the functional RCPAS internal administration portal. It preserves the supplied HTML design pack under `reference-ui/` and migrates the navy/cobalt administrative shell, cards, tables, filters, dialogs, and responsive layouts into a React/TypeScript application backed by Express APIs and a file-based SQLite database.

## Local setup

1. Install Node 20+ and pnpm 10.12.4.
2. Copy `.env.example` to `.env`. Data lives in a single SQLite file whose path is set by `DATABASE_URL` (default `./data/rcpas.sqlite`), so no MySQL server or external database is required; the file is created on first run.
3. Run `pnpm install`.
4. Apply the schema and reference data with `pnpm db:migrate && pnpm db:seed`.
5. Start the app with `pnpm dev` and open the configured port (3000 by default).
6. Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before delivery.

There are no default credentials. Run `SETUP_ADMIN_EMAIL=... SETUP_ADMIN_PASSWORD=... pnpm db:setup-admin` with the values supplied securely in the deployment environment. This creates an active System Administrator record and stores only a password hash; `SETUP_ADMIN_OPEN_ID` is optional legacy metadata. President and Chief Organizer roles must be granted deliberately; System Administrator does not automatically become President.

## Authentication and permissions

The app uses database-backed password sessions for active official accounts. Ordinary society members do not have accounts and there is no public registration. Passwords are scrypt-hashed, sessions are secure and expiring, and administrators can activate accounts or assist with password resets.

Permissions are enforced in Express middleware on every protected API route. Important overrides (for example scheduling conflicts) require the appropriate permission, an explicit reason, and an audit entry. Members, equipment, and events are archived rather than hard-deleted when historical references exist.

## Database operations and backup/restore

The committed migrations are `src/server/migrations/0001_initial.sql` and `0002_password_auth.sql`; they are idempotent and safe to re-run. The database is a single SQLite file, so a backup is a file copy while the server is stopped (or a consistent snapshot via the CSV export endpoints):

```powershell
Copy-Item data/rcpas.sqlite rcpas-backup.sqlite
Copy-Item rcpas-backup.sqlite data/rcpas.sqlite
```

Never place the administrator password in source control. Keep `.env.example` as the only committed environment template.

## Deployment

The project includes `vercel.json` with a Vite build, API serverless entrypoint, and SPA rewrites. Set `DATABASE_URL` and the administrator setup variables in the deployment environment. The managed Webdev runtime uses `pnpm dev` for Preview and `health` as its unauthenticated readiness endpoint; production honors `PORT` and serves the built client from `dist/client`.

## Completed implementation areas

The implemented application includes official-only custom email/password authentication, role/permission middleware, scrypt password hashing, persistent secure sessions, failed-login lockout, password setup/change, member CRUD/archive/search/filter/CSV, many-to-many creative roles, equipment inventory/archive/search/CSV, event create/list/status/duplicate/cancel flows, conflict-aware assignments with override auditing, dashboard live metrics, report tables and formula-safe CSV export endpoints, society settings, audit log viewing, responsive states, database migrations, seed/setup commands, and automated domain tests.

## Known limitations

The managed database contract intentionally shares development and published data and does not expose a separate disposable test database. Password recovery is administrator-assisted rather than email-based: an authorized official can set or change a password from Settings, while a disabled or locked account must be restored by an administrator. Allocation and assignment screens expose the core API workflows; richer calendar drag/drop and bulk allocation UI can be added without changing the normalized schema.
