# RCPAS roles and permissions

| Role | Scope | Notes |
|---|---|---|
| President | Full society operations and oversight | Explicitly assigned; not implied by technical administration. |
| Chief Organizer | Operational member, creative, equipment, event, assignment, report actions | Cannot manage system users unless separately granted. |
| Authorized Organizer | Scoped day-to-day member, creative, equipment, event, assignment, and report actions | Cannot override warnings or change access roles unless separately granted. |
| System Administrator | Technical configuration, users, roles, audit logs, and all system permissions | Does not automatically act as President or receive society authority by title alone. |

Permission codes are stored in `permissions` and linked through `role_permissions`. Server middleware checks these codes; hiding a button in React is not treated as authorization. User activation/deactivation and role changes are audited. A user cannot deactivate their own active session.
