# Pika.bg production backup system

These files are source copies of the working
production backup configuration.

They are NOT installed or activated by Git,
npm install, npm run dev, npm run build,
or any local development workflow.

Do not execute these scripts on development
computers (except the isolated, stub-driven
test harness described in "Test methodology"
below, which never touches real credentials
or production paths).

## Scope (Фаза 10.1)

As of Фаза 10.1, this system backs up BOTH:

1. The SQLite database (as before).
2. The entire `server/uploads/` directory —
   avatars, profile gallery, ad-campaign
   banners, gift-item images, and the
   per-campaign theme assets introduced in
   Фаза 10 (`campaign-themes/<campaignId>/
   icons|tables|card-backs/`).

Previously only the database was backed up.
`server/uploads/` was not covered by any
backup, which meant a server loss would have
permanently destroyed every uploaded image —
including campaign GIF icons, table
backgrounds and card backs with no way to
restore them.

## Production scripts

- `scripts/pikabg-db-backup`
  Extended (not replaced) to also archive
  `server/uploads/` in the same run, same
  lock, same 15-minute systemd schedule.
  Order per run:
  1. Disk space check (aborts cleanly,
     touching nothing, if insufficient).
  2. Archive `server/uploads/` to
     `.tar.zst` (tar first — see "Consistency
     between DB and files" below).
  3. `VACUUM INTO` a live SQLite snapshot
     (second, same as before).
  4. Integrity + foreign-key checks on the
     snapshot (same as before).
  5. Consistency check between the DB
     snapshot and the uploads archive (new —
     see below); retries the whole attempt
     (fresh tar + fresh snapshot) up to 3
     times on mismatch.
  6. Compress the DB snapshot, validate both
     archives, write SHA-256 sidecars and a
     JSON manifest, upload both to Google
     Drive, verify the remote copy by MD5,
     apply 24h local retention to both
     categories.
  A failed run (disk space, integrity,
  persistent inconsistency after 3 attempts)
  exits non-zero and **never touches a
  previously succeeded backup** — only its
  own `*.attempt.N` temp files, which are
  never renamed to a final name until fully
  validated.

- `scripts/pikabg-db-retention`
  Extended to apply the exact same tiered
  retention (keep everything ≤24h, 1/hour for
  24h–14d, 1/day for 14d–90d, delete beyond
  90d) to the new `uploads/` remote folder, in
  addition to the pre-existing `database/`
  folder. Same daily 03:20 systemd schedule,
  unchanged.
  Rewritten from Python to Node (CommonJS,
  same extensionless filename, same
  `/usr/local/sbin/pikabg-db-retention`
  install path, same `ExecStart` — zero
  systemd changes) — see "Test methodology."

- `scripts/pikabg-backup-verify-consistency.mjs`
  New, shared by both the backup script (retry
  loop) and the restore script (post-restore
  check). Scans every `*_url` column in the
  SQLite snapshot for values starting with
  `/uploads/`, plus the 3 known
  `storage_filename`-referencing attachment
  tables (chat/support/topic — private,
  filename-only, checked as a non-fatal
  warning, not a retry trigger — see
  "Consistency" below), and confirms every one
  resolves to a real entry in the uploads
  archive (`--uploads-archive`, by listing the
  tar without extracting it) or a real
  extracted directory (`--uploads-dir`, used by
  restore).

- `scripts/pikabg-restore`
  New. Decompresses a DB archive + uploads
  archive into a scratch target directory
  (never a production path — hard-refuses any
  `--target-dir` under `/var/www/` or
  `/var/backups/`), verifies archive
  checksums and `zstd -t` integrity, restores
  the database and runs its own
  `integrity_check`, extracts `uploads/`
  (preserving the full `campaign-themes/
  <campaignId>/icons|tables|card-backs/`
  structure), and runs the same
  consistency-check helper against the
  extracted files to confirm every DB URL
  resolves to a real restored file. Applying
  the result to production is a separate,
  manual, reviewed step this script
  deliberately does not perform.

## Consistency between the DB and the uploads archive

Every upload route in this codebase (avatars,
gift items, campaign themes) writes the NEW
file and commits the new DB row **before**
deleting the OLD file. Combined with archiving
uploads/ **first** and the DB snapshot
**second** within the same attempt, the only
way a backup can end up inconsistent is "the DB
row already points at a brand-new file that
didn't exist yet when the tar was taken" — an
old, already-superseded file sitting harmlessly
in the tar is never flagged, since it isn't
"missing," it's just unreferenced.
`pikabg-backup-verify-consistency.mjs` detects
exactly that one dangerous case and the backup
script retries (fresh tar, fresh snapshot) up to
3 times. This is the mechanism Фаза 10.1 §3
asked for ("reliable check + retry on detected
inconsistency") instead of pausing writes or
stopping PM2, which §3 explicitly forbids.

## Production installation paths

Scripts:
  /usr/local/sbin/

Systemd units:
  /etc/systemd/system/

These files must be installed and enabled
manually on the production VPS only. No
systemd unit file changed in Фаза 10.1 — same
filenames, same `ExecStart` paths, same
`OnCalendar` schedules as before; only the
script *contents* behind those names changed.

## Local backup retention

Compressed backups (both the database and the
uploads archive) are kept locally for 24
hours, same as before.

## Offsite backup (Фаза 10.1 §5)

Offsite storage already existed for the
database — every backup round has always
uploaded to Google Drive via the pre-configured
`pikabg-drive:` rclone remote
(`PikaBG-Backups/database/<day>/`). Фаза 10.1
extends this to the uploads archive too, using
the **same** existing remote and credentials
(`PikaBG-Backups/uploads/<day>/`) — no new
service, no new credentials, no new upload
mechanism, per the explicit instruction not to
introduce any of those without separate
approval.

What is left for a human decision (not changed
in this phase):
- **Volume growth.** `server/uploads/` will
  likely grow faster than the SQLite database
  over time (every avatar/gift-item/campaign
  image). Google Drive quota usage should be
  watched; the existing 90-day daily-tier cap
  already bounds the worst case, but the
  absolute size per snapshot is now much
  larger than a DB-only backup.
- **Access protection.** The rclone
  credentials already in place on the VPS
  govern both categories equally; no new
  secret was introduced, so no new exposure
  surface was created — but a review of who
  can read `PikaBG-Backups/` on Drive is a
  reasonable one-time check now that it holds
  user-identifying image content (avatars,
  gift images), not just anonymized DB rows.
- A **second, independent offsite copy**
  (e.g. a different provider/region) was not
  added — the current design has exactly one
  offsite destination (Google Drive). This is
  a legitimate future hardening step, not
  something this phase introduces.

## Test methodology

Two of the four scripts
(`pikabg-backup-verify-consistency.mjs`,
`pikabg-db-retention`) were rewritten from
Python to Node specifically so this phase's
test suite could execute their real logic: the
dev machine used for this phase had no Python
interpreter and no WSL/Docker available, while
Node is already a hard dependency of this
entire project (the server itself depends on
`node:sqlite`). The tiered-retention arithmetic
and the URL/file consistency logic are
unchanged, 1:1 translations — only the runtime
changed. `pikabg-db-retention` keeps its exact
pre-existing extensionless filename and
`/usr/local/sbin/pikabg-db-retention`
`ExecStart` path (CommonJS, `#!/usr/bin/env
node` shebang — Linux does not care about file
extensions for shebang execution), so no
systemd unit needed to change.

The bash scripts (`pikabg-db-backup`,
`pikabg-restore`) accept `PIKABG_*` environment
variable overrides for every production path
(`PIKABG_DB_PATH`, `PIKABG_UPLOADS_DIR`,
`PIKABG_LOCAL_ROOT`, `PIKABG_LOCK_FILE`,
`PIKABG_REMOTE_DB_ROOT`,
`PIKABG_REMOTE_UPLOADS_ROOT`,
`PIKABG_HEALTH_URL`) and a
`PIKABG_BACKUP_LOCAL_ONLY=1` flag that skips
the `curl` health check and the `rclone`
upload/verify steps. None of these are ever
set by the production systemd units, so
production behavior is unchanged; they exist
solely so this phase's isolated test run could
exercise the real scripts against a scratch
directory instead of `/var/www/belot-v2` and
`/var/backups/pikabg-db`.

`zstd`, `sqlite3`, `ionice` and `flock` were not
installed on the Windows dev machine used for
this phase (confirmed absent; only
Git-for-Windows' internal `libzstd.dll`
existed, with no CLI). Minimal same-contract
stub executables (compress/decompress as a
byte-for-byte passthrough, `VACUUM INTO` as a
real `node:sqlite` copy, `PRAGMA
integrity_check`/`foreign_key_check` executed
for real via `node:sqlite`, `ionice`/`flock` as
pass-through/always-succeed no-ops) were used
*only* via a prepended `PATH` for this test
session — never committed, never referenced by
the production scripts. They let the
*surrounding* bash logic (disk space guard, the
tar-then-snapshot ordering, the retry loop,
atomic finalize via `mv`, the manifest, local
retention) run for real and be asserted on,
while the actual compression/locking tools
remain exactly what they always were on the
real Linux VPS (genuine `zstd`, `sqlite3`,
`flock`, `ionice` binaries — this phase changed
none of that).

A dedicated `PIKABG_TEST_RACE_INJECT_CMD` /
`PIKABG_TEST_RACE_INJECT_ON_ATTEMPT` hook
(bash-eval of a given command, right after a
given attempt's tar step, never set in
production) made the "image replaced during
backup" race deterministically reproducible
instead of depending on real timing luck — it
was used to prove the retry mechanism actually
recovers.

## Security

Never commit rclone.conf, OAuth credentials,
tokens, passwords, database files, uploaded
images, or backup archives.

The production rclone configuration is managed
separately and securely on the VPS.

## Recovery

Restoring the backup automation on a new VPS
requires manual installation, systemd setup,
rclone authentication, and verification of a
restored database and uploads tree (see
`scripts/pikabg-restore`).

Do not activate the timers before validating
the new server configuration.

To restore data (not the automation) onto a
scratch/staging location for inspection:

```
scripts/pikabg-restore \
  --db-archive  /path/to/belot-v2-<stamp>.sqlite.zst \
  --uploads-archive /path/to/belot-v2-<stamp>-uploads.tar.zst \
  --target-dir  /some/scratch/directory
```

This never writes to a production path (hard
guard against `/var/www/*` and `/var/backups/*`
target directories) and never touches PM2 or
the live database. Applying the result to
production is a deliberate, separate, manual
step — copy `<target-dir>/belot-v2.sqlite` and
`<target-dir>/uploads/` over the real
`server/database/data/belot-v2.sqlite` and
`server/uploads/` only after independent
review, with the application stopped for the
duration of the copy.
