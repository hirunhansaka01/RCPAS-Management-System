# RCPAS Portal Delivery TODO

All core outcomes below are implemented in the current working tree. The project remains intentionally official-only: an administrator must activate the first identity with `pnpm db:setup-admin`; no default credentials or public registration are created.

## 1. Preserved interface and application shell — complete
- [x] Retain the supplied blue-and-white editorial UI, deep navy sidebar, cobalt accents, existing page layouts, typography, cards, tables, filters, modals, responsive behavior, and shared navigation.
- [x] Replace placeholder links and demo handlers with route-aware navigation, loading/error/empty/permission states, notifications, confirmations, and real server outcomes.

## 2. Authentication, authorization, and security — complete
- [x] Use server-side email/password application sessions with no public registration or ordinary member accounts; password login uses scrypt hashes, secure persistent sessions, rate limiting, and temporary lockout.
- [x] Enforce active official allow-list records, President/Chief Organizer/Authorized Organizer/System Administrator roles, permission checks on every protected API route, secure logout/session expiry handling, CSRF protection, rate limiting, safe errors, secure cookies, strict CORS, and audit logging.
- [x] Provide initial administrator setup and role/user activation/deactivation controls; prevent unauthorized role changes.

## 3. Member and creative-team management — complete
- [x] Persist members with unique IDs, identity/grade/class/dates/status/contact/experience/skills/interests/availability/notes/timestamps.
- [x] Implement CRUD/archive, search, grade/class/role/status filtering, sorting, pagination, edit forms, duplicate-ID validation, historical-reference protection, and permission-aware formula-safe CSV export.
- [x] Implement many-to-many creative roles, configurable roles, directory/search/filtering, role distribution, skills/availability, and workload reporting without duplicate member records.

## 4. Equipment inventory and allocations — complete
- [x] Persist categories and equipment records for required gear types with IDs/asset IDs, brand/model/quantity, ownership/member responsibility, condition, availability, notes, and archive status.
- [x] Implement CRUD/archive, search/filtering, member-associated gear, event-date availability checks, reservations/allocations, conflict prevention, issue/return tracking, and available/allocated/unavailable reports.

## 5. Event lifecycle and assignments — complete
- [x] Persist event fields, requirements, organizer, status, notes, timestamps, and history; implement create/view/edit/duplicate/cancel/complete, search/filtering, list/calendar views, staffing/equipment summaries, and cancelled-record retention.
- [x] Implement member assignments with responsibilities, statuses, notes, edit/cancel APIs, by-event/by-member navigation, duplicate prevention, scheduling/unavailable/equipment warnings, workload tracking, permission-controlled overrides, and override audit records.

## 6. Dashboard and reports — complete
- [x] Connect every dashboard metric, schedule, distribution, availability panel, activity feed, and recent assignment to database queries with navigation cards.
- [x] Implement membership, grade/class, role, participation, assignment, event, staffing, inventory, availability, allocation, and workload reports with date ranges and permission-aware CSV exports.

## 7. Database, deployment, and documentation — complete
- [x] Commit normalized schema, foreign keys, indexes, unique constraints, migrations, seed/setup utilities, environment example, backup/restore/export instructions, Vercel-compatible deployment notes, role matrix, feature list, and known limitations.
- [x] Provide `/health`, `/manus-routes.json`, reproducible install/build/test scripts, and runtime configuration.

## 8. Verification evidence — complete
- [x] Applied the idempotent migration and reference seed against the configured managed MySQL database.
- [x] `pnpm test`: 4 domain tests passed; `pnpm typecheck`: passed; `pnpm build`: passed; `pnpm ignored-builds`: none.
- [x] Authenticated smoke suite passed session, dashboard, roles, members, equipment, events, assignments, reports, settings, audit, three CSV exports, and temporary member/equipment/event/assignment creation with cleanup.
- [x] `/health` returned 200, route manifest validated with 9 declared pages, malformed IDs returned safe 400 responses, and the supplied visual shell was inspected in Preview at 1280×720.

## Remaining platform notes

The managed platform shares development and published database data and does not expose a separate disposable test database. The current calendar view is a responsive agenda-card view rather than a drag-and-drop month grid; the normalized event dates and APIs are ready for that enhancement. Password recovery is administrator-assisted rather than email-based.
