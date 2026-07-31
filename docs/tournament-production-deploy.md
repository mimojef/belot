# Tournament Production Deploy Runbook

No deploy is performed by this checklist. Use it only when you are ready to deploy a commit that is already reviewed, pushed, and selected for release.

## Scope

This runbook covers the community tournament admin/operations release for Pika.bg:

- admin/subadmin read-only tournament list and detail screens
- admin-only safe `reconcile` and `cancel-open` operations
- tournament integrity analyzer and production health aggregates
- existing 8-player community tournament lifecycle, scheduler, coordinator, Stage 8, and settlement checks

This release must not introduce official tournament creation, new tournament sizes, third-place matches, force winner, force prize, force payout, or tournament delete operations.

## Preflight

Run from a clean checkout of the selected branch:

```powershell
git fetch origin v2-clean-architecture
git checkout v2-clean-architecture
git pull --ff-only origin v2-clean-architecture
git status --short --branch
git rev-parse HEAD
```

Expected: clean working tree and the commit hash intended for release.

## Build

```powershell
cd D:\PROJECT\Belot-V2\server
npm ci
npm run build
npm run build:scripts

cd D:\PROJECT\Belot-V2
npm ci
npm run build
```

Do not commit `dist/`, `dist-scripts/`, temporary DBs, logs, or backup files unless a separate release process explicitly tracks them.

## Required Checks

Run server checks:

```powershell
cd D:\PROJECT\Belot-V2\server
npm run check:tournament-persistence
npm run check:tournament-end-to-end
npm run check:tournament-concurrency
npm run check:migration-runner-crash-recovery
npm run check:tournament-scheduler-start
npm run check:tournament-coordinator-source
npm run check:tournament-stage8-behavior
npm run check:tournament-settlement-behavior
npm run check:tournament-finished-list-ui
npm run check:tournament-http-api
npm run check:tournament-entry-http-api
npm run check:tournament-partner-invites-source
npm run check:tournament-partner-invite-notifications
npm run check:tournaments-frontend-source
npm run check:subadmin-http-authorization
npm run check:admin-tournament-api
npm run check:tournament-integrity
npm run check:admin-tournament-frontend
npm run check:tournament-production-readiness
```

Run frontend build:

```powershell
cd D:\PROJECT\Belot-V2
npm run build
```

Expected: all checks pass. Treat Vite chunk-size warnings as non-blocking only if the generated bundle is otherwise successful and there are no new tracked build artifacts.

## Production Backup

Before migration or service restart, create and verify a production DB backup:

```powershell
cd D:\PROJECT\Belot-V2\server
npm run backup:db:prod
npm run verify:db:prod
```

Record the backup path and the verified migration count in the release notes.

## Migration Safety

On service startup, `ensureServerDatabaseReady` applies pending SQL files from `server/database/migrations` and records them in `server_migrations`.

Before restarting production, confirm:

```powershell
cd D:\PROJECT\Belot-V2\server
npm run check:tournament-persistence
npm run check:migration-runner-crash-recovery
npm run check:tournament-production-readiness
```

After startup, inspect `/health` and confirm:

- `ok: true`
- scheduler/coordinator health is present
- `tournamentOperations` contains aggregate counts only
- no tournament IDs, profile IDs, session IDs, connection IDs, wallet balances, or tokens are exposed

## Smoke Test

After deployment to the target environment:

1. Login as full admin.
2. Open Admin Info, then Admin tournaments.
3. Verify list filters, pagination, status badges, settlement state, and integrity state.
4. Open a tournament detail page and verify teams, bracket, finance aggregate, safe events, and integrity issues.
5. Login as subadmin and verify read-only access only.
6. Login as regular player and verify `/api/admin/tournaments` returns 403.
7. For an open test tournament only, use `cancel-open` and confirm entry refunds and admin audit event. Do not use this on active or started tournaments.
8. Use `reconcile` only when integrity is healthy or warning and the UI shows the action as available.

## ROLLBACK

If the release fails before migrations are applied:

```powershell
git checkout <previous-known-good-commit>
npm run build
npm run build:scripts
```

If migrations were applied, do not edit the production SQLite file manually. Stop the service, preserve the failing DB for investigation, restore the verified backup from the `backup:db:prod` step, then start the previous known-good commit.

After rollback, verify:

```powershell
cd D:\PROJECT\Belot-V2\server
npm run verify:db:prod
```

Then inspect `/health` and run the admin tournament smoke path again if the admin UI is reachable.
