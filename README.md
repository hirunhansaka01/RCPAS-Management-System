# RCPAS Management System

The user interface of an internal administration portal for a photographic art
society — members and the gear they own, events and the crew assigned to them,
reports, and a role-based permission model.

**Original website:** <https://rahulaphotography.vercel.app>

> **This is the public edition, and it is front end only.** It ships with no
> server, no API, no database layer, no authentication code, no deployment
> configuration and no credentials of any kind. No demo or sample data is
> included either. Nothing here matches a private deployment.

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

| Layer    | Choice                          |
|----------|---------------------------------|
| Client   | React 18 + TypeScript + Vite    |
| Styling  | Plain CSS                       |
| Tooling  | pnpm 10.12.4, Node 22.x         |

## Quick start

```bash
pnpm install
pnpm dev      # http://localhost:5173
```

The interface talks to a REST API that is **not** part of this repository, so
data-driven screens will not populate when the UI is run on its own.

## Project structure

```
public/            static assets, including the standalone login page
src/client/        React application (pages, shell, styles)
src/shared/        shared types and member-code helpers
```

## Credits

Developed by **Hirun Hansaka**.
