#!/usr/bin/env bash
#
# deploy-backend-production.sh — production BACKEND deploy worker.
#
# Употреба (НА production сървъра, от production repo checkout-а):
#   cd /var/www/belot-v2
#   bash scripts/deploy-backend-production.sh
#
# Обхват: САМО backend (server/) build + restart на PM2 app "belot-v2-server".
#   НЕ build-ва frontend, НЕ пипа /var/www/belot-v2/current, НЕ публикува
#   frontend assets, НЕ reload/restart-ва nginx, НЕ прави git pull/reset/
#   checkout/merge, НЕ чисти releases. Това е worker, извикван РЪЧНО за
#   сега — по-късен smart controller (scripts/deploy-production.sh) ще го
#   оркестрира заедно с frontend worker-а, но не е предмет на този файл.
#
# Backend build/start факти (изведени от repo кода, не предположения):
#   - server/package.json: "build": "tsc -p tsconfig.json" -> компилира
#     server/src/**/*.ts в server/dist/**/*.js (tsconfig outDir=./dist).
#     Този скрипт build-ва със СЪЩИЯ локален tsc binary (server/node_modules/
#     .bin/tsc, НЕ npx — гарантирано без network fetch) и tsconfig, но с
#     --outDir override към изолиран staging (виж STAGING_DIST_DIR по-долу),
#     НЕ директно върху live server/dist — старият PM2 процес обслужва
#     живия dist/ непрекъснато през целия build/verify/confirmation
#     прозорец. Активацията (staging -> live) е отделна стъпка
#     непосредствено преди restart.
#   - server/package.json: "start": "node dist/index.js" -> PM2 стартира
#     точно server/dist/index.js.
#   - Няма ecosystem.config.* в repo-то — PM2 app "belot-v2-server" се
#     очаква вече да съществува (стартиран отделно, извън този скрипт).
#     Този worker използва `pm2 restart`, НЕ `pm2 start`/`pm2 delete` —
#     никога не пипа PM2 process definition-а.
#   - Migrations се прилагат АВТОМАТИЧНО при startup: server/src/index.ts
#     вика `await ensureServerDatabaseReady()` (server/src/db/
#     ensureServerDatabaseReady.ts) като top-level await ПРЕДИ сървърът да
#     започне да слуша. Няма отделен CLI migration runner — `node
#     dist/index.js` (значи и всеки `pm2 restart`) Е моментът, в който
#     чакащи .sql миграции от server/database/migrations/ се прилагат
#     срещу server/database/data/belot-v2.sqlite и се записват в таблица
#     server_migrations (filename PRIMARY KEY, лексикографски ред).
#     Затова backup + explicit confirmation ТРЯБВА да станат ПРЕДИ
#     restart, не след него.
#
# Изисква: git, npm, node, pm2, flock, curl, sha256sum/shasum (за
# backup verification consistency с останалите production scripts).
# Изпълнява се от /var/www/belot-v2 (production repo checkout).

set -euo pipefail

# ─── Конфигурация ───────────────────────────────────────────────────────────
PROJECT_ROOT="/var/www/belot-v2"
SERVER_DIR="$PROJECT_ROOT/server"
DIST_DIR="$SERVER_DIR/dist"
DB_FILE="$SERVER_DIR/database/data/belot-v2.sqlite"
MIGRATIONS_DIR="$SERVER_DIR/database/migrations"
DIST_BACKUP_ROOT="$SERVER_DIR/database/backups/backend-dist-deploy"
DB_BACKUP_ROOT="$SERVER_DIR/database/backups/backend-deploy-migration"
# Staging build target — build пише ТУК, никога директно върху live
# DIST_DIR, докато старият PM2 процес още го обслужва. Активацията
# (staging -> live) е отделна, контролирана стъпка непосредствено преди
# restart (виж "Dist activation" по-долу) — старият dist е директория,
# която "изчезва" само в самия момент на activation, не по време на build.
# Живее под server/database/backups/ (вече gitignored — виж .gitignore
# "server/database/backups/"), НЕ директно като server/dist.staging — това
# последното НЕ би било gitignored (само bare "dist" pattern е в
# .gitignore, не "dist.staging"), значи post-build "git status --porcelain"
# би виждал staging build-а като untracked и би провалял погрешно
# immutability check-а. Същата файлова система като DIST_DIR (и двете под
# server/), значи финалният mv staging -> dist остава rename, не copy.
STAGING_DIST_DIR="$SERVER_DIR/database/backups/backend-dist-staging"
PM2_APP_NAME="belot-v2-server"
PUBLIC_BASE_URL="https://www.pika.bg"
# Извън Git working tree — single-writer lock, не е repo артефакт. Отделен
# lock file от frontend worker-а (scripts/deploy-frontend-production.sh),
# защото двата deploy-а са независими и не бива да блокират един друг.
LOCK_FILE="/var/lock/belot-v2-backend-production.lock"
# Persistent deployment state за бъдещия smart controller
# (scripts/deploy-production.sh — все още несъздаден). Извън Git working
# tree и извън /var/www/belot-v2 изцяло — не е repo артефакт. Marker-ът се
# пише САМО след успешен PM2 restart + health + migration verification
# (виж края на файла) — никога предварително, никога при частичен/
# неуспешен deploy.
DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"
BACKEND_STATE_FILE="$DEPLOY_STATE_DIR/backend.json"

log() { printf '[deploy-backend] %s\n' "$1"; }
fail() { printf '[deploy-backend] STOP: %s\n' "$1" >&2; exit 1; }

section() {
  printf '\n[deploy-backend] ── %s ──\n' "$1"
}

# ─── Own-temp/backup cleanup on interrupt ───────────────────────────────────
# Пази пътя на текущата DB backup temp операция, ако е в процес — trap-ът
# чисти САМО собствен temp файл, никога валиден краен backup, dist/,
# release-и или PM2 състояние.
ACTIVE_TMP_FILE=""

# ─── Dist activation auto-restore guard (виж стъпка 6 "Dist activation") ───
# ACTIVATION_ARMED е "true" само в тесния прозорец между "старият dist е
# преместен в DIST_BACKUP_DIR" и "PM2 restart е потвърдено стартирал
# успешно". Ако скриптът бъде прекъснат (EXIT/INT/TERM) точно в този
# прозорец — независимо от причина (Ctrl+C, kill, неочакван вътрешен fail,
# неуспешен staging->dist mv, ИЛИ post-activation index.js verify failure)
# — cleanup() автоматично връща стария dist обратно, ПРИ УСЛОВИЕ че PM2
# restart ОЩЕ НЕ е стартирал (RESTART_STARTED все още "false"). Два случая:
#   A) DIST_DIR липсва (вторият mv никога не е успял) -> директно
#      mv ACTIVATION_DIST_BACKUP_DIR -> DIST_DIR.
#   B) DIST_DIR вече съществува с новия, но НЕПОТВЪРДЕН build (вторият mv
#      е успял, но post-activation verify е провалил се ПРЕДИ guard-ът да
#      се демонтира) -> първо безопасно премести встрани непотвърдения
#      нов dist (никога rm -rf — запазва се за диагностика), после
#      mv ACTIVATION_DIST_BACKUP_DIR -> DIST_DIR.
# След успешна активация (staging -> dist И index.js verify) guard-ът се
# демонтира explicit — тогава DIST_DIR вече Е потвърденият нов код и
# auto-restore никога не бива да го презапише. След PM2 restart guard-ът е
# вече демонтиран, значи migrations/DB състояние никога не се засягат тук
# — само dist/ файловете, и само преди restart.
ACTIVATION_ARMED="false"
RESTART_STARTED="false"
ACTIVATION_DIST_BACKUP_DIR=""

cleanup() {
  if [ -n "$ACTIVE_TMP_FILE" ] && [ -f "$ACTIVE_TMP_FILE" ]; then
    rm -f -- "$ACTIVE_TMP_FILE"
  fi
  if [ "$ACTIVATION_ARMED" = "true" ] && [ "$RESTART_STARTED" = "false" ]; then
    if [ -n "$ACTIVATION_DIST_BACKUP_DIR" ] && [ -d "$ACTIVATION_DIST_BACKUP_DIR" ]; then
      if [ -e "$DIST_DIR" ]; then
        # Сценарий B: DIST_DIR съдържа непотвърден нов build (вторият mv
        # е успял, но verify е провалил се ПРЕДИ demontиране на guard-а).
        # Премести го встрани (не изтривай) — после освободи мястото за
        # стария dist.
        UNVERIFIED_DIST_SIDECAR="${DIST_DIR}.unverified-$(date -u +%Y%m%d%H%M%S)"
        mv "$DIST_DIR" "$UNVERIFIED_DIST_SIDECAR" 2>/dev/null \
          && printf '[deploy-backend] cleanup: непотвърден нов dist преместен настрани в %s\n' "$UNVERIFIED_DIST_SIDECAR" >&2
      fi
      if [ ! -e "$DIST_DIR" ]; then
        mv "$ACTIVATION_DIST_BACKUP_DIR" "$DIST_DIR" 2>/dev/null \
          && printf '[deploy-backend] cleanup: автоматично възстановен стария server/dist (прекъснато преди PM2 restart).\n' >&2
      fi
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sha256_of() {
  case "$CHECKSUM_TOOL" in
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    shasum) shasum -a 256 "$1" | awk '{print $1}' ;;
  esac
}

http_status_for() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo '000'
}

cache_bust_query() {
  printf '_cb=%s-%s' "$(date +%s%N 2>/dev/null || date +%s)" "$RANDOM"
}

# ─── 0. Pre-flight ───────────────────────────────────────────────────────────
section "Pre-flight checks"

[ -d "$PROJECT_ROOT/.git" ] || fail "Не съм в production repo — $PROJECT_ROOT/.git липсва."
cd "$PROJECT_ROOT"

CURRENT_DIR="$(pwd -P)"
[ "$CURRENT_DIR" = "$PROJECT_ROOT" ] || fail "Работна директория ($CURRENT_DIR) не съвпада с очаквания production repo ($PROJECT_ROOT)."
log "Repo: $PROJECT_ROOT (OK)"

command -v git >/dev/null 2>&1 || fail "git не е намерен в PATH."
command -v npm >/dev/null 2>&1 || fail "npm не е намерен в PATH."
command -v node >/dev/null 2>&1 || fail "node не е намерен в PATH."
command -v pm2 >/dev/null 2>&1 || fail "pm2 не е намерен в PATH."
command -v curl >/dev/null 2>&1 || fail "curl не е намерен в PATH (нужен за /health verification)."
command -v flock >/dev/null 2>&1 || fail "flock не е намерен в PATH (нужен за single-writer concurrency lock)."

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM_TOOL="shasum"
else
  fail "нито sha256sum, нито shasum е наличен в PATH — не мога да verify-на backup checksum-и."
fi
log "Prerequisites (git, npm, node, pm2, curl, flock, $CHECKSUM_TOOL): OK"

# ─── Concurrency lock ───────────────────────────────────────────────────────
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  fail "Друг backend deploy процес вече държи lock-а ($LOCK_FILE) — паралелен backend deploy не е позволен. Изчакай другия да приключи."
fi
log "Concurrency lock: OK (exclusive, $LOCK_FILE)"

GIT_STATUS="$(git status --porcelain)"
if [ -n "$GIT_STATUS" ]; then
  fail "Git working tree не е clean. Committни или stash-ни промените преди deploy:
$GIT_STATUS"
fi
log "Git working tree: clean"

GIT_SHA="$(git rev-parse HEAD)"
GIT_SHORT_SHA="$(git rev-parse --short HEAD)"
log "Git SHA: $GIT_SHA"

[ -d "$SERVER_DIR" ] || fail "server/ директорията липсва: $SERVER_DIR"
[ -f "$SERVER_DIR/package.json" ] || fail "server/package.json липсва: $SERVER_DIR/package.json"
[ -d "$MIGRATIONS_DIR" ] || fail "server/database/migrations/ директорията липсва: $MIGRATIONS_DIR"
[ -f "$DB_FILE" ] || fail "Production DB файлът липсва: $DB_FILE"
log "server/, server/package.json, migrations/, DB файл: OK"

if ! pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  fail "PM2 app \"$PM2_APP_NAME\" не съществува. Този скрипт прави restart на СЪЩЕСТВУВАЩ процес — не създава нов (pm2 start не се използва тук)."
fi

OLD_PID="$(pm2 jlist | node -e "
  const apps = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const app = apps.find(a => a.name === '$PM2_APP_NAME');
  process.stdout.write(app && app.pid ? String(app.pid) : '');
")"
[ -n "$OLD_PID" ] || fail "Не успях да прочета PID за PM2 app \"$PM2_APP_NAME\" преди deploy — STOP преди каквато и да е промяна."
log "PM2 app \"$PM2_APP_NAME\" съществува, текущ PID: $OLD_PID"

# Backend/build reference marker: НЯМАМЕ надежден persistent deployment
# marker (файл/env var), който записва КОЙ Git SHA реално е build-нал
# текущия server/dist/index.js, който PM2 в момента изпълнява. GIT_SHA по-
# горе е HEAD на repo-то В МОМЕНТА, не доказателство какво PM2 изпълнява
# точно сега — те могат да се различават (напр. ако dist е бил build-нат
# при по-стар checkout и оттогава е имало git промени без нов backend
# deploy). Затова НЕ твърдим "OLD backend SHA" — вместо това пазим физически
# backup на текущия dist/ (виж стъпка 6 "Dist activation" по-долу), който е
# единственото надеждно rollback evidence, с което разполагаме в момента.
log "ЗАБЕЛЕЖКА: няма persistent marker за това какъв Git SHA е build-нал текущия PM2-изпълняван dist/. Rollback evidence = физически dist backup (виж по-долу), не Git SHA reference."

# /health преди deploy — известният tournament ledger_mismatch advisory в
# тялото НЕ се третира като failure, докато HTTP статус кодът е 200 (тук
# проверяваме само статус кода, не тялото).
PRE_HEALTH_URL="${PUBLIC_BASE_URL%/}/health?$(cache_bust_query)"
PRE_HEALTH_CODE="$(http_status_for "$PRE_HEALTH_URL")"
log "GET $PRE_HEALTH_URL -> $PRE_HEALTH_CODE"
[ "$PRE_HEALTH_CODE" = "200" ] || fail "/health преди deploy връща HTTP $PRE_HEALTH_CODE вместо 200 — не продължавам с deploy върху вече нездрав backend."
log "/health (pre-deploy): OK"

# ─── Deployment state directory preflight ───────────────────────────────────
# Проверява ПРЕДИ build/activation/restart, че DEPLOY_STATE_DIR реално
# позволява create + atomic rename + delete на temp файл — точно
# операциите, нужни за marker write-а накрая (виж "Persistent deployment
# state" по-долу). Никога не създава backend.json тук — само собствен
# preflight-специфичен temp файл, изтрит веднага след теста. Ако тук се
# провали, спираме ПРЕДИ deploy да е започнал, вместо да открием проблема
# чак след успешен restart.
mkdir -p "$DEPLOY_STATE_DIR" || fail "Не успях да създам deployment state директорията: $DEPLOY_STATE_DIR"
DEPLOY_STATE_PREFLIGHT_TMP="$DEPLOY_STATE_DIR/.preflight-write-test.$$.$RANDOM"
if ! printf 'preflight-write-test\n' > "$DEPLOY_STATE_PREFLIGHT_TMP" 2>/dev/null; then
  fail "Deployment state директорията ($DEPLOY_STATE_DIR) не позволява create на файл — провери permissions преди deploy."
fi
DEPLOY_STATE_PREFLIGHT_RENAMED="$DEPLOY_STATE_DIR/.preflight-write-test-renamed.$$.$RANDOM"
if ! mv -f "$DEPLOY_STATE_PREFLIGHT_TMP" "$DEPLOY_STATE_PREFLIGHT_RENAMED" 2>/dev/null; then
  rm -f "$DEPLOY_STATE_PREFLIGHT_TMP"
  fail "Deployment state директорията ($DEPLOY_STATE_DIR) не позволява atomic rename — провери filesystem/permissions преди deploy."
fi
if ! rm -f "$DEPLOY_STATE_PREFLIGHT_RENAMED" 2>/dev/null; then
  fail "Deployment state директорията ($DEPLOY_STATE_DIR) не позволява delete на файл — провери permissions преди deploy."
fi
log "Deployment state директория ($DEPLOY_STATE_DIR): create + rename + delete OK (backend.json НЕ е пипнат)."

# ─── 1. Backend build — В STAGING, НИКОГА директно върху live dist/ ───────
section "Backend build (staging, live dist непокътнат)"

# Изчиствай евентуален stale staging от прекъснат предишен run — гарантира,
# че staging build-ът е ЧИСТ (не съдържа .js файлове от source, изтрит
# междувременно; tsc без --build/incremental не чисти stale output сам).
if [ -e "$STAGING_DIST_DIR" ]; then
  log "Изтривам stale staging dist от прекъснат предишен run: $STAGING_DIST_DIR"
  rm -rf "$STAGING_DIST_DIR"
fi

cd "$SERVER_DIR"
# Директен path до локалния tsc binary (server/node_modules/.bin/tsc,
# devDependency в server/package.json) — НЕ npx. npx би могъл да опита
# network fetch, ако пакетът не е локално инсталиран; директният binary
# path гарантира, че build-ът НИКОГА не тегли нищо от интернет — или
# binary-то съществува локално, или скриптът STOP-ва веднага (виж проверката
# по-долу), никога тих network fetch на production сървъра.
TSC_BIN="$SERVER_DIR/node_modules/.bin/tsc"
[ -x "$TSC_BIN" ] || fail "Локален TypeScript binary липсва: $TSC_BIN — пусни 'npm ci' в server/ първо. НЕ ползвам network fetch за build tool-и."
log "tsc -p tsconfig.json --outDir dist.staging (локален $TSC_BIN, build в изолиран staging, live dist/ непипнат)..."
if ! "$TSC_BIN" -p tsconfig.json --outDir "$STAGING_DIST_DIR"; then
  cd "$PROJECT_ROOT"
  rm -rf "$STAGING_DIST_DIR"
  log "Build FAILED. Live server/dist е НАПЪЛНО непипнат (build-ът никога не пише в него) — НИКАКЪВ PM2 restart няма да се направи."
  fail "tsc build се провали в $SERVER_DIR — виж build изхода по-горе. Staging build директорията е изчистена."
fi
cd "$PROJECT_ROOT"
log "Build статус: OK (staging: $STAGING_DIST_DIR)"

# ─── 1b. Verify staging build резултат ПРЕДИ каквато и да е активация ──────
[ -f "$STAGING_DIST_DIR/index.js" ] || { rm -rf "$STAGING_DIST_DIR"; fail "$STAGING_DIST_DIR/index.js липсва след build — build изглежда непълен. Staging изчистен, live dist непипнат."; }
if ! node --check "$STAGING_DIST_DIR/index.js"; then
  rm -rf "$STAGING_DIST_DIR"
  fail "node --check на $STAGING_DIST_DIR/index.js се провали (синтактично невалиден изход) — staging изчистен, live dist непипнат, НИКАКЪВ restart."
fi
log "Staging build verify: OK (index.js съществува, синтактично валиден)"

# ─── 2. Post-build git immutability check ──────────────────────────────────
POST_BUILD_GIT_SHA="$(git rev-parse HEAD)"
if [ "$POST_BUILD_GIT_SHA" != "$GIT_SHA" ]; then
  rm -rf "$STAGING_DIST_DIR"
  fail "HEAD се е променил по време на build (беше $GIT_SHA, сега $POST_BUILD_GIT_SHA) — restart НЕ се прави за несъответстващ Git state. Staging build изчистен, live dist непипнат."
fi

POST_BUILD_GIT_STATUS="$(git status --porcelain)"
if [ -n "$POST_BUILD_GIT_STATUS" ]; then
  rm -rf "$STAGING_DIST_DIR"
  fail "Working tree вече не е clean след build (staging build изчистен, live dist непипнат):
$POST_BUILD_GIT_STATUS"
fi
log "Post-build git immutability check: OK (HEAD непроменен, working tree clean)"

# ─── 3. Migration detection (read-only, БЕЗ прилагане) ─────────────────────
section "Migration detection"

# Read-only сравнение на .sql файлове в MIGRATIONS_DIR срещу server_migrations
# ledger-а в реалната production DB — НЕ извиква ensureServerDatabaseReady()
# и не прилага нищо. Единствената точка, в която migrations реално се
# прилагат, е `node dist/index.js` startup (виж бележката в началото на
# файла) — т.е. предстоящият PM2 restart, не този скрипт.
PENDING_MIGRATIONS="$(node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'
import { readdir } from 'node:fs/promises'
const migrationsDir = process.argv[1]
const dbFile = process.argv[2]
const files = (await readdir(migrationsDir, { withFileTypes: true }))
  .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
  .map(e => e.name)
  .sort((a, b) => a.localeCompare(b, 'en'))
const db = new DatabaseSync(dbFile, { open: true, readOnly: true })
try {
  const applied = new Set(
    db.prepare('SELECT filename FROM server_migrations').all().map(r => r.filename)
  )
  const pending = files.filter(f => !applied.has(f))
  process.stdout.write(pending.join('\n'))
} finally {
  db.close()
}
" "$MIGRATIONS_DIR" "$DB_FILE")"

DB_BACKUP_PATH=""
if [ -n "$PENDING_MIGRATIONS" ]; then
  PENDING_COUNT="$(printf '%s\n' "$PENDING_MIGRATIONS" | grep -c . || true)"
  log "Открити $PENDING_COUNT чакащи migration(и), които следващият PM2 restart ще приложи автоматично при startup:"
  printf '%s\n' "$PENDING_MIGRATIONS" | while IFS= read -r m; do
    log "  - $m"
  done

  # ─── 4b. SQLite backup ПРЕДИ restart (защото restart == migration apply) ──
  section "DB backup (pending migrations present — required before restart)"

  mkdir -p "$DB_BACKUP_ROOT"
  DB_BACKUP_ID="$(date -u +%Y%m%d%H%M%S)-${GIT_SHORT_SHA}"
  DB_BACKUP_DIR="$DB_BACKUP_ROOT/$DB_BACKUP_ID"
  mkdir -p "$DB_BACKUP_DIR"
  DB_BACKUP_PATH="$DB_BACKUP_DIR/belot-v2.sqlite"
  DB_BACKUP_TMP="$DB_BACKUP_PATH.tmp"

  ACTIVE_TMP_FILE="$DB_BACKUP_TMP"
  # node:sqlite `backup()` — същият online-backup механизъм, ползван от
  # server/src/db/backupHelpers.ts (runDatabaseBackup) за production daily
  # backups. Пише в .tmp, verify-ва, чак тогава атомарен rename.
  node --input-type=module -e "
    import { DatabaseSync, backup } from 'node:sqlite'
    const src = new DatabaseSync(process.argv[1], { open: true, readOnly: true })
    try {
      await backup(src, process.argv[2])
    } finally {
      src.close()
    }
  " "$DB_FILE" "$DB_BACKUP_TMP"

  INTEGRITY_RESULT="$(node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1], { open: true, readOnly: true })
    try {
      const row = db.prepare('PRAGMA integrity_check').get()
      process.stdout.write(row && row.integrity_check ? row.integrity_check : '')
    } finally {
      db.close()
    }
  " "$DB_BACKUP_TMP")"

  if [ "$INTEGRITY_RESULT" != "ok" ]; then
    rm -f "$DB_BACKUP_TMP"
    ACTIVE_TMP_FILE=""
    rm -rf "$STAGING_DIST_DIR"
    fail "DB backup integrity_check върна \"$INTEGRITY_RESULT\" вместо \"ok\" — backup-ът е изтрит, restart НЕ продължава. Staging build изчистен, live dist непипнат."
  fi

  mv -f "$DB_BACKUP_TMP" "$DB_BACKUP_PATH"
  ACTIVE_TMP_FILE=""
  log "DB backup: $DB_BACKUP_PATH (integrity_check: ok)"
else
  log "Няма чакащи migrations. Обикновен backend code deploy — DB backup не се прави (не е нужен за нормален deploy без schema промени)."
fi

# ─── 5. Explicit restart confirmation ───────────────────────────────────────
section "Restart confirmation"

printf '\n'
printf 'BACKEND RESTART REQUIRED\n'
printf 'Active WebSocket/game sessions may disconnect.\n'
if [ -n "$PENDING_MIGRATIONS" ]; then
  printf '\n'
  printf 'PENDING MIGRATIONS will be applied automatically at startup:\n'
  printf '%s\n' "$PENDING_MIGRATIONS" | while IFS= read -r m; do
    printf '  - %s\n' "$m"
  done
  printf 'DB backup already taken: %s\n' "$DB_BACKUP_PATH"
fi
printf '\n'
printf 'Type exactly RESTART to proceed, anything else (or empty) STOPs without restart.\n'
printf '> '
read -r CONFIRMATION || CONFIRMATION=""

if [ "$CONFIRMATION" != "RESTART" ]; then
  rm -rf "$STAGING_DIST_DIR"
  fail "Restart confirmation не е получено (получих: \"$CONFIRMATION\"). Backend НЕ е рестартиран. Live server/dist е непипнат (staging build изчистен)."
fi
log "Restart потвърден от оператор."

# ─── 6. Dist activation — staging -> live, НЕПОСРЕДСТВЕНО преди restart ────
# Единствената точка, в която live DIST_DIR реално се променя. До тук
# build-ът е седял изолирано в STAGING_DIST_DIR — старият PM2 процес е
# обслужвал живия dist/ непрекъснато и непроменено през целия build/verify/
# confirmation прозорец.
#
# Безопасна activation (НЕ rm -rf преди успешен mv на staging):
#   1) mv DIST_DIR -> DIST_BACKUP_DIR (rename, старият dist е физически
#      преместен/запазен, никога изтрит на тази стъпка)
#   2) mv STAGING_DIST_DIR -> DIST_DIR (rename, новият код става live)
#   3) ако стъпка 2 се провали — DIST_DIR вече не съществува (беше
#      преместен в стъпка 1), значи автоматично го връщаме обратно
#      (mv DIST_BACKUP_DIR -> DIST_DIR) ПРЕДИ PM2 restart. DB все още не е
#      мигрирана (restart не е станал), значи връщането на стария dist тук
#      е напълно безопасно — не е "rollback след migrations", а просто
#      "activation никога не е успяла".
section "Dist activation (staging -> live)"

mkdir -p "$DIST_BACKUP_ROOT"
DIST_BACKUP_ID="$(date -u +%Y%m%d%H%M%S)-${GIT_SHORT_SHA}"
DIST_BACKUP_DIR="$DIST_BACKUP_ROOT/$DIST_BACKUP_ID"

if [ -d "$DIST_DIR" ]; then
  [ ! -e "$DIST_BACKUP_DIR" ] || fail "dist backup директорията вече съществува: $DIST_BACKUP_DIR"
  # mv (rename), не cp — старият dist е ПРЕМЕСТЕН, не копиран+изтрит.
  # DIST_DIR физически не съществува между тази стъпка и следващия mv, но
  # съдържанието му е изцяло запазено в DIST_BACKUP_DIR през целия
  # прозорец — няма момент, в който кодът е загубен.
  mv "$DIST_DIR" "$DIST_BACKUP_DIR"
  log "Текущият (стар) server/dist преместен (rollback evidence) в: $DIST_BACKUP_DIR"

  # Въоръжаваме auto-restore guard-а веднага СЛЕД успешния mv по-горе —
  # от този момент DIST_DIR липсва физически, значи ВСЯКО прекъсване
  # (EXIT/INT/TERM, включително явния fail() при неуспешен mv по-долу)
  # трябва автоматично да върне стария dist обратно, докато PM2 restart
  # още не е стартирал (виж cleanup() дефиницията по-горе).
  ACTIVATION_DIST_BACKUP_DIR="$DIST_BACKUP_DIR"
  ACTIVATION_ARMED="true"
else
  log "ПРЕДУПРЕЖДЕНИЕ: server/dist не съществува все още (изглежда като първи backend build) — няма какво да се backup-не."
  DIST_BACKUP_DIR=""
fi

if ! mv "$STAGING_DIST_DIR" "$DIST_DIR"; then
  # Втория mv се провали (staging -> live). PM2 restart ОЩЕ НЕ Е станал —
  # DB не е мигрирана. cleanup() trap-ът (ACTIVATION_ARMED=true,
  # RESTART_STARTED=false) автоматично ще върне стария dist обратно при
  # изхода от fail() по-долу — не дублираме тази логика ръчно тук.
  fail "Dist activation (staging -> live) се провали — cleanup ще възстанови стария server/dist автоматично (ако DIST_BACKUP_DIR е наличен). Staging build-ът остава в $STAGING_DIST_DIR за ръчен преглед. НИКАКЪВ PM2 restart няма да се направи."
fi

if [ ! -f "$DIST_DIR/index.js" ]; then
  # Post-activation verify се провали ПРЕДИ PM2 restart — cleanup() ще
  # възстанови стария dist автоматично (ACTIVATION_ARMED все още "true",
  # RESTART_STARTED все още "false").
  fail "server/dist/index.js липсва след activation — неочаквано състояние. cleanup ще възстанови стария server/dist автоматично (ако наличен). Ръчна проверка нужна незабавно."
fi

# Успешна активация — демонтираме guard-а ПРЕДИ PM2 restart стъпката.
# DIST_DIR вече Е новият код; auto-restore никога не бива да го презапише
# оттук нататък, дори при неочаквано прекъсване по-долу.
ACTIVATION_ARMED="false"
log "Dist activation: OK — live server/dist вече е новият build (staging директорията вече не съществува)."

# ─── 7. PM2 restart ──────────────────────────────────────────────────────────
section "PM2 restart"

ROLLBACK_HINT() {
  printf '[deploy-backend] Стар server/dist backup: %s\n' "${DIST_BACKUP_DIR:-'(няма — първи build, няма backup за връщане)'}" >&2
  printf '[deploy-backend] Нов Git SHA: %s\n' "$GIT_SHA" >&2
  printf '[deploy-backend] Стар PID: %s   Нов PID: %s\n' "$OLD_PID" "$NEW_PID" >&2

  if [ -z "$DIST_BACKUP_DIR" ]; then
    printf '[deploy-backend] Няма dist backup за rollback (първи build) — нужна е ръчна намеса.\n' >&2
    return
  fi

  if [ -n "$PENDING_MIGRATIONS" ]; then
    # Migrations вероятно вече са приложени (restart стигна дотук, значи
    # node dist/index.js -> ensureServerDatabaseReady() е изпълнен). Старият
    # dist/ очаква СТАРАТА schema — връщането му директно срещу вече
    # напреднала DB може да чупи по неочакван начин. НЕ показваме
    # copy-paste изпълнима команда тук — само STOP + двете реални опции.
    printf '[deploy-backend] STOP — migrations са БИЛИ ПРИЛОЖЕНИ при този restart.\n' >&2
    printf '[deploy-backend] НЕ връщай стария server/dist автоматично/copy-paste — старият код очаква СТАРАТА DB schema,\n' >&2
    printf '[deploy-backend] а DB вече е мигрирана напред. Автоматичен DB rollback НЕ се прави от този скрипт.\n' >&2
    printf '[deploy-backend] Първо оцени ръчно:\n' >&2
    printf '[deploy-backend]   1) DB backup (СЛЕД ръчна оценка на schema съвместимост, ако решиш да върнеш DB):\n' >&2
    printf '[deploy-backend]      %s\n' "${DB_BACKUP_PATH:-'(няма DB backup path — виж лога по-горе)'}" >&2
    printf '[deploy-backend]   2) Стар dist backup (само след като DB съвместимостта е потвърдена или DB е възстановена):\n' >&2
    printf '[deploy-backend]      %s\n' "$DIST_BACKUP_DIR" >&2
    printf '[deploy-backend] Нито една от двете НЕ се прилага автоматично — изисква се ръчна преценка на оператор.\n' >&2
  else
    printf '[deploy-backend] Няма приложени migrations при този deploy — директен rollback е безопасен:\n' >&2
    printf '[deploy-backend] Ръчен MANUAL rollback (изпълни на VPS, само след преценка):\n' >&2
    printf '  rm -rf %q\n' "$DIST_DIR" >&2
    printf '  cp -a %q %q\n' "$DIST_BACKUP_DIR" "$DIST_DIR" >&2
    printf '  pm2 restart %q\n' "$PM2_APP_NAME" >&2
  fi
}

post_restart_fail() {
  printf '[deploy-backend] STOP (post-restart): %s\n' "$1" >&2
  printf '[deploy-backend] Backend вече е рестартиран (PM2 restart не се отменя автоматично).\n' >&2
  ROLLBACK_HINT
  exit 1
}

NEW_PID=""

# RESTART_STARTED="true" ПРЕДИ самото извикване — веднъж PM2 restart
# започне (независимо дали накрая успее), auto-restore guard-ът трябва
# окончателно да спре да пипа dist/: migrations може вече да текат/да са
# приложени вътре в новия процес, значи връщането на стария dist код тук
# вече не е безопасна "activation never happened" операция, а точно
# забраненият "rollback след PM2 restart/migrations".
RESTART_STARTED="true"

log "pm2 restart $PM2_APP_NAME ..."
if ! pm2 restart "$PM2_APP_NAME"; then
  printf '[deploy-backend] STOP: pm2 restart %s се провали.\n' "$PM2_APP_NAME" >&2
  ROLLBACK_HINT
  exit 1
fi

NEW_PID="$(pm2 jlist | node -e "
  const apps = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const app = apps.find(a => a.name === '$PM2_APP_NAME');
  process.stdout.write(app && app.pid ? String(app.pid) : '');
")"
if [ -z "$NEW_PID" ]; then
  printf '[deploy-backend] STOP: не успях да прочета нов PID за %s след restart.\n' "$PM2_APP_NAME" >&2
  ROLLBACK_HINT
  exit 1
fi
log "PM2 restart резултат: OK — стар PID=$OLD_PID, нов PID=$NEW_PID"

PM2_STATUS="$(pm2 jlist | node -e "
  const apps = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const app = apps.find(a => a.name === '$PM2_APP_NAME');
  process.stdout.write(app && app.pm2_env && app.pm2_env.status ? app.pm2_env.status : '');
")"
if [ "$PM2_STATUS" != "online" ]; then
  printf '[deploy-backend] STOP: PM2 app "%s" статус е "%s" вместо "online" след restart.\n' "$PM2_APP_NAME" "$PM2_STATUS" >&2
  ROLLBACK_HINT
  exit 1
fi
log "PM2 process status: online"

# ─── 8. Post-restart verification ───────────────────────────────────────────
section "Post-restart verification"

POST_HEALTH_URL="${PUBLIC_BASE_URL%/}/health?$(cache_bust_query)"
POST_HEALTH_CODE="$(http_status_for "$POST_HEALTH_URL")"
log "GET $POST_HEALTH_URL -> $POST_HEALTH_CODE"
# Забележка: /health може да съдържа известния tournament ledger_mismatch
# advisory в тялото си — това НЕ е deploy failure, докато HTTP статус кодът
# е 200. Тук проверяваме САМО статус кода, не тялото.
[ "$POST_HEALTH_CODE" = "200" ] || post_restart_fail "/health след restart връща HTTP $POST_HEALTH_CODE вместо 200."
log "/health (post-restart, HTTP status само): OK"

log "Post-restart checks: PID валиден, PM2 status online, /health 200."

# ─── 9. Migration verification (само ако е имало pending) ──────────────────
APPLIED_MIGRATIONS_AFTER=""
if [ -n "$PENDING_MIGRATIONS" ]; then
  section "Migration verification (post-restart)"

  DB_INTEGRITY_AFTER="$(node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1], { open: true, readOnly: true })
    try {
      const row = db.prepare('PRAGMA integrity_check').get()
      process.stdout.write(row && row.integrity_check ? row.integrity_check : '')
    } finally {
      db.close()
    }
  " "$DB_FILE")"
  [ "$DB_INTEGRITY_AFTER" = "ok" ] || post_restart_fail "DB integrity_check след restart връща \"$DB_INTEGRITY_AFTER\" вместо \"ok\"."
  log "DB integrity_check (post-restart): ok"

  APPLIED_MIGRATIONS_AFTER="$(node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1], { open: true, readOnly: true })
    try {
      const rows = db.prepare('SELECT filename FROM server_migrations').all().map(r => r.filename)
      const applied = new Set(rows)
      const pending = process.argv[2].split('\n').filter(Boolean)
      process.stdout.write(pending.filter(p => applied.has(p)).join('\n'))
    } finally {
      db.close()
    }
  " "$DB_FILE" "$PENDING_MIGRATIONS")"

  STILL_PENDING_COUNT=0
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    if ! printf '%s\n' "$APPLIED_MIGRATIONS_AFTER" | grep -qxF "$m"; then
      STILL_PENDING_COUNT=$((STILL_PENDING_COUNT + 1))
      log "  ВСЕ ОЩЕ НЕ Е ПРИЛОЖЕНА: $m"
    fi
  done <<< "$PENDING_MIGRATIONS"

  if [ "$STILL_PENDING_COUNT" -gt 0 ]; then
    post_restart_fail "$STILL_PENDING_COUNT migration(и) все още не са приложени след restart — виж списъка по-горе."
  fi

  log "Приложени migrations след restart:"
  printf '%s\n' "$APPLIED_MIGRATIONS_AFTER" | while IFS= read -r m; do
    [ -n "$m" ] && log "  - $m"
  done
fi

# ─── 10. Persistent deployment state (само след успешен deploy) ────────────
# Точката тук е ДОСТИГНАТА само след: успешен build/activation, успешен PM2
# restart (PID + status "online" потвърдени), успешен post-restart /health,
# И (ако е имало pending migrations) успешна migration verification
# (integrity_check ok + всички миграции реално приложени). Marker-ът НЕ се
# пише по-рано — не гадаем/предполагаме успех, записваме факт.
section "Persistent deployment state"

DEPLOYED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$DEPLOY_STATE_DIR"

state_write_failed() {
  # Deploy-ът вече Е успешен (restart + health + migrations минаха) — това
  # е чисто state-tracking failure, не deploy failure. Отчитаме го ясно
  # като отделен STOP клас (STATE ERROR), без да твърдим, че backend-ът
  # някак не работи (той работи — PID $NEW_PID е online). Best-effort
  # премахваме съществуващ (стар/частичен) marker — по-добре липсващ файл
  # (smart controller-ът STOP-ва при липса), отколкото стар marker,
  # погрешно приет за актуален.
  printf '[deploy-backend] STATE ERROR: %s\n' "$1" >&2
  printf '[deploy-backend] deploy-ът самият е УСПЕШЕН — PM2 %s работи с PID %s.\n' "$PM2_APP_NAME" "$NEW_PID" >&2
  if [ -e "$BACKEND_STATE_FILE" ]; then
    if rm -f "$BACKEND_STATE_FILE" 2>/dev/null; then
      printf '[deploy-backend] Стар/частичен %s премахнат (best-effort) — няма да бъде погрешно приет за актуален.\n' "$BACKEND_STATE_FILE" >&2
    else
      printf '[deploy-backend] ПРЕДУПРЕЖДЕНИЕ: не успях да премахна стар/частичен %s — ръчно провери го преди да разчиташ на deployment state.\n' "$BACKEND_STATE_FILE" >&2
    fi
  fi
  printf '[deploy-backend] Ръчно провери/поправи %s преди следващия deploy, за да остане deployment state достоверен за бъдещия smart controller.\n' "$BACKEND_STATE_FILE" >&2
  fail "Persistent deployment state запис се провали — виж STATE ERROR по-горе. Backend deploy-ът остава успешен, но state marker-ът не е актуален."
}

BACKEND_STATE_TMP="$BACKEND_STATE_FILE.tmp.$$.$RANDOM"
ACTIVE_TMP_FILE="$BACKEND_STATE_TMP"
if ! cat > "$BACKEND_STATE_TMP" <<EOF_STATE
{
  "gitSha": "$GIT_SHA",
  "deployedAtUtc": "$DEPLOYED_AT_UTC",
  "pm2Pid": "$NEW_PID"
}
EOF_STATE
then
  ACTIVE_TMP_FILE=""
  rm -f "$BACKEND_STATE_TMP"
  state_write_failed "temp файл write се провали ($BACKEND_STATE_TMP)."
fi

if [ ! -s "$BACKEND_STATE_TMP" ]; then
  ACTIVE_TMP_FILE=""
  rm -f "$BACKEND_STATE_TMP"
  state_write_failed "temp файлът е празен след write ($BACKEND_STATE_TMP) — вероятен диск/quota проблем."
fi

if ! mv -f "$BACKEND_STATE_TMP" "$BACKEND_STATE_FILE"; then
  ACTIVE_TMP_FILE=""
  rm -f "$BACKEND_STATE_TMP"
  state_write_failed "atomic rename се провали ($BACKEND_STATE_TMP -> $BACKEND_STATE_FILE)."
fi
ACTIVE_TMP_FILE=""
log "Deployment state: OK — $BACKEND_STATE_FILE (gitSha=$GIT_SHA, pm2Pid=$NEW_PID)"

# ─── 11. Summary ─────────────────────────────────────────────────────────────
section "Summary"

log "GIT_SHA:                 $GIT_SHA"
log "OLD_PID:                 $OLD_PID"
log "NEW_PID:                 $NEW_PID"
log "Server build status:     OK"
if [ -n "$PENDING_MIGRATIONS" ]; then
  log "Migration status:        приложени ($(printf '%s\n' "$PENDING_MIGRATIONS" | grep -c . || true) миграция/и, виж списъка по-горе)"
  log "DB backup path:          $DB_BACKUP_PATH"
else
  log "Migration status:        няма чакащи миграции (обикновен code deploy)"
  log "DB backup path:          (няма — не е било нужно)"
fi
log "Health pre-deploy:        HTTP $PRE_HEALTH_CODE"
log "Health post-restart:      HTTP $POST_HEALTH_CODE"
log "server/dist backup path:  ${DIST_BACKUP_DIR:-'(няма — първи build)'}"
if [ -z "$DIST_BACKUP_DIR" ]; then
  log "Rollback information:     няма dist backup (първи build)"
elif [ -n "$PENDING_MIGRATIONS" ]; then
  log "Rollback information:     migrations са приложени — НЕ връщай стария dist автоматично/copy-paste."
  log "                          Старият код очаква старата DB schema; DB вече е мигрирана напред."
  log "                          Оцени ръчно schema съвместимост или възстанови DB backup ($DB_BACKUP_PATH) първо."
  log "                          Dist backup (само след тази оценка): $DIST_BACKUP_DIR"
else
  log "Rollback (няма migrations — директен manual rollback е безопасен):"
  log "  rm -rf $DIST_DIR && cp -a $DIST_BACKUP_DIR $DIST_DIR && pm2 restart $PM2_APP_NAME"
fi

log "BACKEND DEPLOY SUCCESS"
