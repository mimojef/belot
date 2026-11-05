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
  lock, same systemd timer (hourly at
  minute :41 since 2026-11 — see "Backup
  schedule" below).
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

`scripts/deploy-production.sh` (Smart Deploy)
never installs or reloads anything from
`ops/`. It only classifies the exactly
enumerated files here as "non-runtime" so a
change to them does not block a deploy; drop-in
paths (`*.timer.d/*.conf`) stay "unclassified"
and still STOP the deploy.

## Backup schedule

`pikabg-db-backup.timer` is the ONLY source of
the schedule:

```
OnCalendar=*-*-* *:41:00   # every hour at :41
Persistent=true
AccuracySec=1s
```

There is no drop-in in Git and there must be
none on the VPS
(`/etc/systemd/system/pikabg-db-backup.timer.d/`
must not exist). Change the schedule only here,
then install the file (procedure below).

Why minute :41 — it avoids the other periodic
jobs on the VPS:
- `pikabg-ledger-backup.timer` `*:0/5`
  (:00, :05, … :55) — 41 is not a multiple of 5;
- `pikabg-db-retention.timer` daily 03:20;
- `cron.hourly` at :17; `sysstat` at multiples
  of 10; most daily timers at :00;
- `apt-daily.timer` uses
  `RandomizedDelaySec=12h`, so its time changes
  on every activation and no fixed minute can
  avoid it with certainty; :41 avoids the
  observed slot (17:43:43 UTC). Its load (package
  list download) is light.

The minute does not depend on the VPS time zone
(all of them are whole-hour offsets).

History: until 2026-11 the backup ran every 15
minutes, effectively at :07/:22/:37/:52 via a
VPS-only drop-in `schedule.conf` that was never
in Git.

What the hourly schedule changes (no script
change was needed):
- Google Drive retention (`pikabg-db-retention`,
  03:20): ≤24h keeps every backup — now ~24
  instead of ~96; 24h–14d already keeps 1/hour
  (nothing is deleted there any more); 14d–90d
  keeps 1/day. The old 15-minute archives are
  thinned automatically at the next 03:20 runs.
- Local retention (24h, `-mmin +1440`, applied
  at the end of every successful run): ~24 sets
  instead of ~96, so local usage drops to about
  a quarter within ~24h. Do not delete archives
  manually.
- Worst-case data loss window (RPO) becomes
  60 minutes. The deletion ledger keeps its own
  5-minute backup; the pre-migration snapshot in
  `scripts/deploy-backend-production.sh` is
  unaffected.

### Persistent=true and immediate triggering

With `Persistent=true`, when the timer is
reloaded/restarted systemd computes the next
run from the LAST trigger time
(`LastTriggerUSec`, stamp in
`/var/lib/systemd/timers/`). If that next
calendar time is already in the past, the
backup starts IMMEDIATELY. Therefore:

- **Install** only in minutes **:53–:59**,
  after the :52 run (old schedule) has finished:
  the next :41 after :52 is in the next hour —
  no immediate run, and the old :07 slot is not
  reached.
- **Rollback** only in minutes **:42–:51**,
  after the :41 run has finished: the next of
  :07/:22/:37/:52 after :41 is :52 — in the
  future.

Outside these windows an extra backup can start
right after `daemon-reload`/`restart`. It is
harmless (same lock, same checks) but not
desired.

### Installation on the VPS

Run as root, from the production checkout that
already contains this commit
(`/var/www/belot-v2`). Nothing here touches PM2,
the scripts, the archives or Google Drive.

```bash
cd /var/www/belot-v2
SRC=ops/pikabg-backup/systemd/pikabg-db-backup.timer
DST=/etc/systemd/system/pikabg-db-backup.timer
DROPIN=/etc/systemd/system/pikabg-db-backup.timer.d
RB=/root/pikabg-timer-rollback-$(date -u +%Y%m%dT%H%MZ)

# 1. Pre-checks (all must pass)
grep -x 'OnCalendar=\*-\*-\* \*:41:00' "$SRC"
systemd-analyze verify "$SRC"
systemd-analyze calendar '*-*-* *:41:00' --iterations=3
systemctl is-active pikabg-db-backup.service    # expected: inactive
systemctl show pikabg-db-backup.timer -p LastTriggerUSec
#   expected: the :52 run of the CURRENT hour
M=$(date +%M); [ "$M" -ge 53 ] && [ "$M" -le 59 ] \
  && echo "window OK" || echo "STOP: wait for :53-:59"

# 2. Rollback copy (base timer + whole drop-in dir)
install -d -m 0700 "$RB"
cp -a "$DST" "$RB/"
cp -a "$DROPIN" "$RB/"
ls -la "$RB" "$RB/pikabg-db-backup.timer.d"

# 3. Install the base timer, move the drop-in OUT
#    of the active configuration (not deleted)
install -m 0644 "$SRC" "$DST"
mv "$DROPIN/schedule.conf" "$RB/schedule.conf.removed-from-active"
rmdir "$DROPIN"          # fails if anything else is there — then STOP and inspect

# 4. Apply (still inside :53-:59)
systemctl daemon-reload
systemctl restart pikabg-db-backup.timer
systemctl is-active pikabg-db-backup.service    # expected: inactive (no immediate run)
```

### Checks after installation

```bash
# Effective config: one file, no drop-in, one calendar
systemctl cat pikabg-db-backup.timer
systemctl show pikabg-db-backup.timer -p DropInPaths -p TimersCalendar -p NextElapseUSecRealtime
#   DropInPaths= (empty); TimersCalendar contains only *-*-* *:41:00
systemctl list-timers pikabg-db-backup.timer --no-pager   # NEXT = :41 of the next hour
systemctl is-enabled pikabg-db-backup.timer               # enabled

# After the first :41 run
systemctl show pikabg-db-backup.service -p Result -p ExecMainStatus -p ExecMainExitTimestamp
journalctl -u pikabg-db-backup.service --since -30min --no-pager \
  | grep -E 'START|integrity_check|consistency=|archive_validation|local_md5|SUCCESS|ERROR'
ls -lt /var/backups/pikabg-db | head -6
env RCLONE_CONFIG=/root/.config/rclone/rclone.conf \
  rclone lsl "pikabg-drive:PikaBG-Backups/database/$(date -u +%F)/" | sort -k2,3 | tail -3

# After 3 hours: exactly one START/SUCCESS per hour, all at :41
journalctl -u pikabg-db-backup.service --since -3h --no-pager | grep -E '\[backup\] (START|SUCCESS)'

# After ~24h and after the next 03:20
du -sh /var/backups/pikabg-db
journalctl -u pikabg-db-retention.service --since today --no-pager | grep -E 'archives=|ERROR|COMPLETE'
systemctl list-timers pikabg-ledger-backup.timer --no-pager   # unchanged, every 5 min
```

### Rollback to the previous 15-minute schedule

Run only in minutes **:42–:51** (after the :41
run has finished).

```bash
RB=/root/pikabg-timer-rollback-<stamp>          # the directory from step 2
M=$(date +%M); [ "$M" -ge 42 ] && [ "$M" -le 51 ] \
  && echo "window OK" || echo "STOP: wait for :42-:51"
systemctl is-active pikabg-db-backup.service    # expected: inactive

install -m 0644 "$RB/pikabg-db-backup.timer" /etc/systemd/system/pikabg-db-backup.timer
install -d -m 0755 /etc/systemd/system/pikabg-db-backup.timer.d
install -m 0644 "$RB/pikabg-db-backup.timer.d/schedule.conf" \
  /etc/systemd/system/pikabg-db-backup.timer.d/schedule.conf
systemctl daemon-reload
systemctl restart pikabg-db-backup.timer
systemctl show pikabg-db-backup.timer -p TimersCalendar -p DropInPaths
systemctl list-timers pikabg-db-backup.timer --no-pager   # NEXT = :52
```

In Git, revert only the `OnCalendar`/`Description`
change of `pikabg-db-backup.timer`; keep the
`classify_path()` entries. Retention needs no
rollback (unchanged).

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

## Deletion ledger (Етап 4C)

Регистърът на окончателните изтривания на профили
(`server/database/deletion-ledger/`) се архивира
отделно от базата — `scripts/pikabg-ledger-backup`
(собствен timer на 5 минути, същият
`pikabg-drive:` remote, папка
`PikaBG-Backups/deletion-ledger/`), а при restore
`scripts/pikabg-ledger-restore` обединява ВСИЧКИ
външни копия, не копието от датата на backup-а.
Worker-ът за самоизтриване изтрива в базата
само след потвърдено външно копие на записа.
Инсталация, проверки и restore runbook:
[DELETION_LEDGER.md](DELETION_LEDGER.md). Не е
инсталирано на production.

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
guard against `/var/www/*`, `/var/backups/*`
and system directories, checked on the
canonical `realpath -m` of `--target-dir`, so
`..`, relative paths and symlinks cannot
bypass it) and never touches PM2 or the live
database. The target directory must be new or
empty.

Phase 12.1 safety rules (all refuse BEFORE
anything is written to the target):

- a missing `.sha256` sidecar for either
  archive is treated as an incomplete backup
  set and refused (only an explicit
  `--skip-checksum` bypasses checksums);
- the uploads archive may contain only regular
  files and directories under `uploads/` —
  symlinks, hardlinks, devices, absolute paths,
  `..` components and members outside
  `uploads/` are refused;
- after extraction, any non-regular node under
  `uploads/` fails the restore, and the
  DB <-> file consistency check counts only
  real files (symlinks never satisfy a
  database reference). Applying the result to
production is a deliberate, separate, manual
step — copy `<target-dir>/belot-v2.sqlite` and
`<target-dir>/uploads/` over the real
`server/database/data/belot-v2.sqlite` and
`server/uploads/` only after independent
review, with the application stopped for the
duration of the copy.
