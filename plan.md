# RCPAS Portal Implementation Plan

## Product scope

Build the Rahula College Photographic Art Society internal administration portal from the supplied static HTML design pack. The existing blue-and-white editorial dashboard is the visual source of truth: deep navy sidebar, cobalt interaction accents, pale archival canvas, bordered white cards, compact data tables, Manrope headings, and DM Sans/Hanken Grotesk body styling where each supplied screen uses it. The application is for authorized society officials only; ordinary members are stored as records but do not receive application accounts.

## Architecture and platform decisions

- **Frontend:** React + TypeScript with client-side routing and shared shell components. The existing screen layouts will be migrated into reusable page sections instead of replaced with a generic admin template.
- **Backend:** Node.js + Express + TypeScript in the same deployable service. JSON APIs will enforce authentication, authorization, validation, CSRF protection, safe errors, and audit logging server-side.
- **Database:** Managed MySQL-compatible database provided by the initialized Webdev project, accessed with Drizzle ORM. Schema migrations are committed under `drizzle/` and run through a deterministic migration command. The shared managed database is treated as persistent across restarts and deployments.
- **Authentication:** Manus OAuth is the platform default and is already enabled. The app will preserve the required `webdev_app_session` cookie contract and validate the platform session, then resolve the identity against an application `users` record. There is no public registration and no application password store. An initial-admin setup command will create or promote the first authorized official from an explicit OAuth identity/email supplied at setup time; unlisted or inactive identities are denied. Role/permission changes remain application-admin-only and are audited.
- **Deployment:** Vercel-compatible build output and environment-variable usage are kept in the codebase, while the managed Webdev runtime remains the working Preview/deployment path. `PORT` is honored, `/health` is unauthenticated, and `/manus-routes.json` enumerates page routes.

## Data model

Normalized tables will include: `users`, `system_roles`, `permissions`, `role_permissions`, `user_roles`, `members`, `creative_roles`, `member_roles`, `equipment_categories`, `equipment`, `equipment_allocations`, `events`, `event_assignments`, `event_equipment_requirements`, `audit_logs`, `society_settings`, plus migration metadata. Members, equipment, and events use archival/soft-delete status so historical foreign keys remain valid. Unique constraints cover user OAuth identity, member ID, equipment ID, asset ID when present, and duplicate event/member/responsibility assignments. Date-range indexes support event and allocation conflict checks.

## Application routes

- `/login` — logged-out landing with official-only access explanation and OAuth entry point.
- `/` — dashboard overview backed by aggregate queries and recent activity.
- `/members` — member CRUD, search/filter/sort/pagination, CSV export, detail drawer, multi-role editing.
- `/creative-team` — role directory, role filters, skills/availability, distribution and workload summaries.
- `/events` — lifecycle management, list/calendar views, status transitions, duplication, history and team/equipment summaries.
- `/event-assignments` — conflict-aware member assignment and workload views with permission-controlled overrides.
- `/equipment` — inventory CRUD/archive, ownership, member association, availability and allocation/return workflows.
- `/reports` — date-filtered membership, roles, participation, events, staffing, inventory, allocations and workload reports with permission-aware CSV.
- `/settings` — society settings, official user/role administration, password-provider guidance, audit log access, and backup/export instructions.
- `/not-found` and permission/error states as applicable.

## Shared UI and interaction approach

- Retain the supplied fixed navy navigation, top search/header, breadcrumbs, page headings, metric cards, filter bars, table rows, status chips, dialogs, and responsive breakpoints. Shared shell navigation changes the active route rather than using placeholder `#` links.
- Replace hardcoded metrics with loading/error/empty states and database responses. Dashboard cards navigate to their modules.
- Implement one reusable modal/form system with field validation, dirty-state protection, confirmation for destructive operations, toasts only after server confirmation, and permission-denied states.
- Keep visible controls functional: search, filters, sort, pagination, tabs, calendar navigation, dropdowns, profile/logout, exports, row actions, assignment/allocation controls, and settings saves. Unavailable features are clearly disabled rather than simulated.
- Use responsive stacked layouts at tablet/mobile widths while preserving the supplied visual hierarchy. Avoid additional decorative imagery; the source designs are an internal operations tool.

## Business rules

- Member deletion is blocked when historical events or assignments reference the record; archive/status change remains available.
- A member may have many creative roles without duplicate member records.
- Equipment ownership is independent from event availability; personal gear must link to its responsible member and society gear remains separate.
- Allocation and assignment date/time overlaps are rejected unless the current official has an explicit override permission. Overrides require a reason and create an audit entry.
- Event cancellation preserves the event and its history. Status transitions are validated. Assignment duplication is rejected.
- CSV values beginning with `=`, `+`, `-`, or `@` are prefixed safely to prevent spreadsheet formula injection.
- Only server-authorized roles can perform writes/exports/admin actions; UI visibility is never the security boundary.

## Security and reliability

Use parameterized ORM queries, allow-listed payload fields, Zod request schemas, secure cross-site session cookie handling for embedded Preview (`SameSite=None; Secure`), fixed callback redirects, CSRF tokens for state-changing browser requests, strict CORS, authentication rate limiting, safe error messages, and audit records for authentication, role/user changes, member/equipment/event archival, assignment/allocation overrides, and settings changes. Add request IDs and structured server logging without secrets. Support session-expired and not-found responses.

## Testing and documentation

- Unit tests cover validation, permissions, CSV sanitization, event status rules, assignment duplicate/conflict detection, and equipment allocation overlap logic.
- Integration tests cover OAuth/session resolution, protected routes, role enforcement, member/equipment/event/assignment CRUD, reports, exports, and audit logs using a test database/migration flow.
- Add a minimal end-to-end smoke suite for login guard, navigation, major forms, destructive confirmations, and responsive rendering.
- Deliver `.env.example`, installation/local development instructions, initial administrator setup, database migration/backup/restore/export instructions, Vercel-compatible deployment notes, role matrix, completed feature list, known limitations, and executed test results.

## Project structure

```text
app.config.ts              # Webdev project metadata
package.json               # pinned scripts and dependencies
src/client/                # React entry, router, shell, pages, components, API client, styles
src/server/                # Express app, auth, middleware, routes, services, reports, CSV helpers
src/shared/                # shared types, Zod schemas, enums and permission constants
db/                        # Drizzle schema, migrations, seed/setup utilities
tests/                     # unit, integration and smoke tests
public/manus-routes.json   # route manifest required by Webdev
public/                    # favicon and static assets
reference-ui/              # preserved copies of the supplied HTML design references
README.md                  # setup, deployment and operations guide
ROLES.md                   # role/permission documentation
TODO.md                    # acceptance outcomes and delivery status
```

## Build workflow

1. Create the plan and acceptance TODO, then scaffold the pinned Node/TypeScript/React/Express/Drizzle project.
2. Migrate the shared visual shell and supplied navigation/page structures before wiring data.
3. Implement migrations, seed/setup commands, OAuth identity resolution, authorization middleware, and audit services.
4. Implement dashboard, members, creative team, equipment, events, assignments, reports, and settings APIs/pages in dependency order.
5. Add route manifest, environment example, health endpoint, build scripts, and Vercel-compatible runtime configuration.
6. Run migrations against the managed test/development database, execute automated tests and type/lint/build checks, inspect responsive output, and fix confirmed failures.
7. Commit the finished application as a Webdev checkpoint; publishing remains separate unless explicitly requested.

## Known requirement trade-off

The prompt asks for password change and secure recovery. Because the initialized platform contract uses Manus OAuth by default and forbids a second password store unless a different provider is explicitly requested, the portal will provide identity-provider sign-in, account activation/deactivation, official allow-list management, and clear password/recovery guidance through Manus OAuth rather than storing or changing passwords locally. All other permissions, data, and workflows are application-owned and enforced server-side.
