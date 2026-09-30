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
#     restart, не след него. Ред при pending migrations: confirmation
#     ПЪРВО, после live consistent DB snapshot (sqlite3 VACUUM INTO) ДОКАТО
#     старият backend е ONLINE, после snapshot verification (integrity_check,
#     foreign_key_check, SHA256), чак тогава `pm2 stop` -> dist activation ->
#     финалният `pm2 restart` (apply-ва migrations). Backup времето НЕ е част
#     от downtime-а.
#
# Изисква: git, npm, node, pm2, flock, curl, timeout, sha256sum/shasum (за
# backup verification consistency с останалите production scripts); при
# pending migrations още sqlite3 CLI >= 3.27.0 (VACUUM INTO), nice и
# (по избор) ionice.
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
# Per-run DB backup директория (server/database/backups/backend-deploy-
# migration/<id>/) — предварително декларирана "" тук (не само вътре в
# pending-migrations клона по-долу), за да е safe reference под `set -u` в
# cleanup() дори когато няма чакащи migrations (клонът, който я присвоява,
# никога не изпълнява). cleanup() премахва тази директория САМО ако е
# останала празна (rmdir, никога rm -rf) — виж cleanup() по-долу.
DB_BACKUP_DIR=""

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

# ─── PM2 quiesce-for-backup auto-recovery guard (виж "Backend quiesce" /
# "DB backup" стъпките по-долу) ───────────────────────────────────────────
# PM2_QUIESCED_FOR_BACKUP е "true" само в прозореца между потвърден "pm2
# stop $PM2_APP_NAME" (стъпка 5c — вече СЛЕД verified live DB snapshot;
# старият writer трябва да е спрян преди dist activation и migrations) и
# момента, в който
# RESTART_STARTED става "true" (непосредствено преди РЕАЛНИЯ финален "pm2
# restart" с новия dist, стъпка 7). Snapshot/verify failure-ите са ПРЕДИ
# stop-а (флагът е още "false" — backend-ът просто остава ONLINE). Ако
# скриптът бъде прекъснат ИЛИ провали се по каквато и да е причина СЛЕД
# stop-а (stop verify timeout, Ctrl+C/SIGINT, SIGTERM, dist activation
# failure) докато е "true" —
# cleanup() автоматично връща backend-а online (pm2 restart, best-effort)
# ПРЕДИ да излезе, точно както ACTIVATION_ARMED автоматично връща стария
# dist. Двата guard-а работят заедно (dist restore ПЪРВО, после PM2 online),
# не като отделни/конкуриращи се trap механизми. RESTART_STARTED="false"
# гарантира, че веднъж РЕАЛНИЯТ restart (с потенциално вече мигрирана DB)
# е стартирал, тази recovery логика никога повече не се задейства —
# идентична забрана като established "никакъв auto-rollback след PM2
# restart/migrations" политиката.
PM2_QUIESCED_FOR_BACKUP="false"

cleanup() {
  if [ -n "$ACTIVE_TMP_FILE" ]; then
    # Собствени DB backup temp artifacts — base .tmp файл + SQLite-ните
    # rollback-journal/WAL/SHM sidecar-и, които backup() дестинацията може
    # да остави, ако бъде прекъсната по средата (доказан production
    # артефакт: belot-v2.sqlite.tmp-journal, останал след прекъснат run).
    # rm -f е no-op за несъществуващ файл — безопасно да "опитаме" и 4-те,
    # дори само базовият да реално съществува.
    rm -f -- "$ACTIVE_TMP_FILE" "${ACTIVE_TMP_FILE}-journal" "${ACTIVE_TMP_FILE}-wal" "${ACTIVE_TMP_FILE}-shm"
  fi
  if [ -n "$DB_BACKUP_DIR" ] && [ -d "$DB_BACKUP_DIR" ]; then
    # Безопасно само защото rmdir отказва да изтрие НЕпразна директория —
    # никога rm -rf, никога wildcard. При успешен backup тази директория
    # съдържа готовия belot-v2.sqlite файл (непразна, rmdir е no-op). При
    # failure/interrupt (tmp+sidecars вече премахнати по-горе) директорията
    # е празна и safe да се премахне, вместо да остава като празен stub.
    rmdir "$DB_BACKUP_DIR" 2>/dev/null || true
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
  # Backend е бил спрян (стъпка 5c, след verified snapshot), но РЕАЛНИЯТ
  # финален restart (стъпка 7, с новия dist) никога не е стартирал — dist/
  # вече е възстановен (клонът точно над този, ако е било армирано) или
  # изобщо не е бил пипнат (stop стъпката е ПРЕДИ dist activation), значи
  # връщането на backend-а online тук е безопасно "activation/migration
  # никога не са се случили", НЕ "rollback след restart/migrations" —
  # последното си остава изрично забранено (виж ROLLBACK_HINT по-долу).
  if [ "$PM2_QUIESCED_FOR_BACKUP" = "true" ] && [ "$RESTART_STARTED" = "false" ]; then
    printf '[deploy-backend] cleanup: backend беше спрян за activation/restart, но финалният restart никога не стартира (прекъсване/failure ПРЕДИ migrations) — връщам стария backend online.\n' >&2
    if pm2 restart "$PM2_APP_NAME" >/dev/null 2>&1; then
      printf '[deploy-backend] cleanup: pm2 restart %s -> OK, backend е върнат online (стар dist, DB немигрирана).\n' "$PM2_APP_NAME" >&2
    else
      printf '[deploy-backend] cleanup: ВНИМАНИЕ — pm2 restart %s се провали при recovery опит. РЪЧНА намеса нужна НЕЗАБАВНО (pm2 status/restart %s ръчно).\n' "$PM2_APP_NAME" "$PM2_APP_NAME" >&2
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

# ─── Post-restart health warm-up retry loop ─────────────────────────────────
# PM2 "online" НЕ гарантира, че nginx/upstream веднага сервира трафик —
# доказан production инцидент: PM2 online, но първата /health заявка веднага
# след restart получи временен 502 (nginx/upstream все още установяват
# връзка), докато локален + public /health бяха 200 ~2 минути по-късно.
# Единичен fail-fast check тук би STOP-нал деплой, който реално е успешен.
# Bounded retry с cache-busted заявки на всеки опит (никакъв shared HTTP/DNS
# кеш между опитите) — първи HTTP 200 е успех, НИКАКЪВ blind sleep преди
# първия опит (retry loop-ът сам осигурява warm-up прозореца).
POST_RESTART_HEALTH_RETRY_MAX_SECONDS="${POST_RESTART_HEALTH_RETRY_MAX_SECONDS:-30}"
POST_RESTART_HEALTH_RETRY_INTERVAL_SECONDS="${POST_RESTART_HEALTH_RETRY_INTERVAL_SECONDS:-2}"

# Извежда финалния HTTP статус код на stdout (последният наблюдаван опит).
# Вика http_status_for() с ПРЕСЕН cache-busted URL при ВСЕКИ опит (не
# преизползва URL между опити) — echo-va прогреса на stderr, за да не се
# смеси с captured stdout резултата от caller-а.
wait_for_public_health_200() {
  local base_url="$1"
  local deadline elapsed status url attempt
  deadline=$SECONDS
  deadline=$((deadline + POST_RESTART_HEALTH_RETRY_MAX_SECONDS))
  attempt=0
  status='000'

  while :; do
    attempt=$((attempt + 1))
    url="${base_url%/}/health?$(cache_bust_query)"
    status="$(http_status_for "$url")"
    printf '[deploy-backend] Post-restart /health опит #%s: GET %s -> %s\n' "$attempt" "$url" "$status" >&2

    if [ "$status" = "200" ]; then
      break
    fi

    if [ "$SECONDS" -ge "$deadline" ]; then
      break
    fi

    sleep "$POST_RESTART_HEALTH_RETRY_INTERVAL_SECONDS"
  done

  printf '%s' "$status"
}

# ─── Bounded migration DB snapshot config ───────────────────────────────────
# История: доказан production инцидент — node:sqlite backup() (online backup
# API) е извикван, докато старият PM2 процес ОЩЕ пишеше активно в SQLite;
# backup API-то рестартира копирането при всяка промяна на source-а, WAL
# постоянно се променяше — на ~369MB DB това доведе до ~99% CPU, >24min без
# завършване, ~1TB logical read I/O. Временният fix беше pm2 stop ПРЕДИ
# backup-а (backup времето влизаше в downtime-а).
#
# Сега: live consistent snapshot чрез sqlite3 VACUUM INTO (стъпка 5) —
# ЕДНА read транзакция (WAL snapshot isolation), без рестартиране/
# догонване при паралелни writes, докато backend-ът остава ONLINE; pm2 stop
# е СЛЕД verified snapshot. DB_BACKUP_TIMEOUT_SECONDS е горна граница за
# самия VACUUM INTO (при timeout — abort, backend остава ONLINE);
# DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS е горна граница за integrity_check +
# foreign_key_check върху snapshot файла (също преди pm2 stop).
DB_BACKUP_TIMEOUT_SECONDS="${DB_BACKUP_TIMEOUT_SECONDS:-300}"
DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS="${DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS:-600}"

# ─── PM2 stop verification (bounded) ────────────────────────────────────────
# След "pm2 stop $PM2_APP_NAME" потвърждаваме И PM2-регистрирания статус, И
# че старият OS процес (OLD_PID) реално вече не тече — pm2 stop обичайно е
# синхронен, но bounded retry е defensive срещу бавно spindown (graceful
# shutdown handlers и т.н.), вместо fail-fast единичен check.
PM2_STOP_VERIFY_MAX_SECONDS="${PM2_STOP_VERIFY_MAX_SECONDS:-15}"
PM2_STOP_VERIFY_INTERVAL_SECONDS="${PM2_STOP_VERIFY_INTERVAL_SECONDS:-1}"

# Връща 0 (success) веднага щом pm2 status="stopped" И kill -0 на стария PID
# се провали (процесът вече не съществува); 1 при timeout. Echo-va прогреса
# на stderr, mirror на wait_for_public_health_200 по-горе.
wait_for_pm2_stopped() {
  local app_name="$1" old_pid="$2"
  local deadline status pid_alive attempt
  deadline=$SECONDS
  deadline=$((deadline + PM2_STOP_VERIFY_MAX_SECONDS))
  attempt=0

  while :; do
    attempt=$((attempt + 1))
    status="$(pm2 jlist | node -e "
      const apps = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const app = apps.find(a => a.name === '$app_name');
      process.stdout.write(app && app.pm2_env && app.pm2_env.status ? app.pm2_env.status : '');
    ")"
    pid_alive="false"
    if kill -0 "$old_pid" 2>/dev/null; then
      pid_alive="true"
    fi
    printf '[deploy-backend] PM2 stop verify опит #%s: status=%s pid_alive=%s\n' "$attempt" "$status" "$pid_alive" >&2

    if [ "$status" = "stopped" ] && [ "$pid_alive" = "false" ]; then
      return 0
    fi

    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi

    sleep "$PM2_STOP_VERIFY_INTERVAL_SECONDS"
  done
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
command -v timeout >/dev/null 2>&1 || fail "timeout не е намерен в PATH (нужен за bounded migration DB backup — виж DB_BACKUP_TIMEOUT_SECONDS)."

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM_TOOL="shasum"
else
  fail "нито sha256sum, нито shasum е наличен в PATH — не мога да verify-на backup checksum-и."
fi
log "Prerequisites (git, npm, node, pm2, curl, flock, timeout, $CHECKSUM_TOOL): OK"

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

  # Live consistent snapshot (стъпка 5) изисква sqlite3 CLI с VACUUM INTO
  # (SQLite >= 3.27.0). Проверява се ТУК — преди confirmation, pm2 stop или
  # каквато и да е промяна — само когато реално има pending migrations
  # (обикновен code deploy не зависи от sqlite3).
  if ! command -v sqlite3 >/dev/null 2>&1; then
    rm -rf "$STAGING_DIST_DIR"
    fail "sqlite3 CLI не е намерен в PATH — нужен за live VACUUM INTO DB snapshot при pending migrations. Backend е ONLINE и непипнат, staging build изчистен."
  fi
  SQLITE3_VERSION="$(sqlite3 -version 2>/dev/null | awk '{print $1}')"
  if [ -z "$SQLITE3_VERSION" ] || [ "$(printf '%s\n3.27.0\n' "$SQLITE3_VERSION" | sort -V | head -n 1)" != "3.27.0" ]; then
    rm -rf "$STAGING_DIST_DIR"
    fail "sqlite3 CLI версия \"$SQLITE3_VERSION\" не поддържа VACUUM INTO (нужна >= 3.27.0). Backend е ONLINE и непипнат, staging build изчистен."
  fi
  log "sqlite3 CLI за live snapshot: $SQLITE3_VERSION (VACUUM INTO: OK)"
else
  log "Няма чакащи migrations. Обикновен backend code deploy — без DB backup, без quiesce, без допълнителен downtime."
fi

# ─── 4. Explicit restart confirmation (ПРЕДИ каквато и да е PM2/DB операция) ─
# Confirmation-ът е ПРЕДИ live DB snapshot/pm2 stop по конструкция —
# snapshot-ът натоварва production DB-то, затова започва само след изрично
# съгласие на оператора. Ако операторът НЕ потвърди — backend остава online,
# DB snapshot НИКОГА не започва, dist НЕ се активира, migrations НЕ се прилагат.
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
  printf 'A live consistent DB snapshot (SQLite VACUUM INTO) will be taken FIRST, while the backend stays ONLINE.\n'
  printf 'Only after the snapshot passes verification (integrity_check, foreign_key_check, SHA256) will the backend be\n'
  printf 'STOPPED briefly for dist activation + restart; pending migrations run at startup. This is NOT zero downtime.\n'
fi
printf '\n'
printf 'Type exactly RESTART to proceed, anything else (or empty) STOPs without restart.\n'
printf '> '
read -r CONFIRMATION || CONFIRMATION=""

if [ "$CONFIRMATION" != "RESTART" ]; then
  rm -rf "$STAGING_DIST_DIR"
  fail "Restart confirmation не е получено (получих: \"$CONFIRMATION\"). Backend НЕ е спрян, DB backup НЕ е направен, dist НЕ е активиран, migrations НЕ са приложени. Live server/dist е непипнат (staging build изчистен)."
fi
log "Restart потвърден от оператор."

# ─── 5. Live consistent DB snapshot -> verify -> backend stop (САМО при pending migrations) ─
# Ред: live SQLite snapshot чрез VACUUM INTO, ДОКАТО старият PM2 backend Е
# ONLINE (bounded timeout, nice/ionice, busy_timeout) ->
# verify (файлът съществува и е non-zero, integrity_check = "ok",
# foreign_key_check = 0 реда, SHA256) -> mv към финалния backup път ->
# ЧАК ТОГАВА pm2 stop -> bounded verify че старият процес реално е спрян ->
# dist activation -> финален pm2 restart (apply-ва migrations при startup).
# Времето за backup вече НЕ е част от downtime-а.
#
# Всеки failure/timeout/прекъсване в snapshot/verify частта е ПРЕДИ pm2 stop:
# backend-ът остава ONLINE и непокътнат (PM2_QUIESCED_FOR_BACKUP още
# "false" — cleanup() НЕ прави restart), live dist не е пипнат (activation
# е стъпка 6), deployment marker не е пипнат (пише се само в стъпка 10),
# migrations не са приложени, собствените temp артефакти се чистят.
# Failure/прекъсване СЛЕД pm2 stop, но ПРЕДИ финалния restart —
# PM2_QUIESCED_FOR_BACKUP="true" && RESTART_STARTED="false" кара cleanup()
# автоматично да върне стария backend online (непроменено поведение).
if [ -n "$PENDING_MIGRATIONS" ]; then
  section "Live DB snapshot (backend ONLINE, VACUUM INTO, bounded timeout ${DB_BACKUP_TIMEOUT_SECONDS}s)"

  mkdir -p "$DB_BACKUP_ROOT"
  DB_BACKUP_ID="$(date -u +%Y%m%d%H%M%S)-${GIT_SHORT_SHA}"
  DB_BACKUP_DIR_CANDIDATE="$DB_BACKUP_ROOT/$DB_BACKUP_ID"
  # mkdir БЕЗ -p — отказва съществуваща директория: гарантира уникален,
  # собствен per-run път. DB_BACKUP_DIR (ползван от cleanup() за rmdir-
  # ако-празна) се присвоява САМО след успешно създаване — никога чужда
  # директория.
  if ! mkdir "$DB_BACKUP_DIR_CANDIDATE" 2>/dev/null; then
    rm -rf "$STAGING_DIST_DIR"
    fail "DB backup директорията вече съществува или не може да бъде създадена: $DB_BACKUP_DIR_CANDIDATE. Backend остава ONLINE (PM2 НЕ е спиран), live dist и deployment marker НЕ са пипнати, migrations НЕ са приложени."
  fi
  DB_BACKUP_DIR="$DB_BACKUP_DIR_CANDIDATE"
  DB_BACKUP_PATH="$DB_BACKUP_DIR/belot-v2.sqlite"
  DB_BACKUP_TMP="$DB_BACKUP_PATH.tmp"
  DB_BACKUP_CHECKSUM_FILE="$DB_BACKUP_PATH.sha256"

  # Abort ПРЕДИ pm2 stop: чисти само собствените temp артефакти (tmp +
  # SQLite sidecar-и) и празната per-run директория (rmdir, никога rm -rf),
  # чисти staging build-а и спира. PM2_QUIESCED_FOR_BACKUP е "false" —
  # cleanup() НЕ пипа PM2; backend-ът просто продължава да работи.
  snapshot_abort_backend_online() {
    rm -f -- "$DB_BACKUP_TMP" "${DB_BACKUP_TMP}-journal" "${DB_BACKUP_TMP}-wal" "${DB_BACKUP_TMP}-shm"
    ACTIVE_TMP_FILE=""
    rmdir "$DB_BACKUP_DIR" 2>/dev/null || true
    rm -rf "$STAGING_DIST_DIR"
    fail "$1 Backend остава ONLINE (PM2 НЕ е спиран), live dist и deployment marker НЕ са пипнати, migrations НЕ са приложени."
  }

  for DB_BACKUP_TARGET in "$DB_BACKUP_TMP" "${DB_BACKUP_TMP}-journal" "${DB_BACKUP_TMP}-wal" "${DB_BACKUP_TMP}-shm" "$DB_BACKUP_PATH" "$DB_BACKUP_CHECKSUM_FILE"; do
    if [ -e "$DB_BACKUP_TARGET" ]; then
      # Не наш файл — НЕ го трием; спираме без cleanup на чужди артефакти.
      rm -rf "$STAGING_DIST_DIR"
      fail "Snapshot target вече съществува: $DB_BACKUP_TARGET — отказвам да го презапиша. Backend остава ONLINE (PM2 НЕ е спиран), live dist и deployment marker НЕ са пипнати."
    fi
  done

  ACTIVE_TMP_FILE="$DB_BACKUP_TMP"

  # VACUUM INTO (SQLite >= 3.27.0) пише transactionally consistent snapshot:
  # цялото копиране върви в ЕДНА read транзакция срещу live DB-то (WAL
  # snapshot isolation) — паралелните writes на live backend-а продължават
  # и НЕ влизат в snapshot-а; няма "догонване" на растящ WAL (за разлика от
  # online backup API-то, което рестартира при всяка промяна на source-а —
  # доказаната причина за >24min/~99% CPU инцидента). VACUUM INTO само чете
  # source DB-то. БЕЗ -readonly: production A/B тест върху един и същ
  # замразен source — normal връзка 6s срещу 54s с -readonly, при
  # идентичен .sha3sum --schema (source = fast = readonly snapshot),
  # integrity_check ok и foreign_key_check 0 и за двата. Snapshot файлът се
  # проверява read-only в 5b. busy_timeout покрива
  # кратки lock-ове (напр. checkpoint). nice + ionice (ако е наличен)
  # намаляват CPU/IO натиска върху live backend-а; timeout налага горна
  # граница. Никакъв cp на live .sqlite файла.
  SNAPSHOT_PRIORITY=(nice -n 10)
  if command -v ionice >/dev/null 2>&1; then
    SNAPSHOT_PRIORITY=(ionice -c 2 -n 7 nice -n 10)
  fi
  DB_BACKUP_TMP_SQL="${DB_BACKUP_TMP//\'/\'\'}"
  log "VACUUM INTO snapshot на live DB (backend ONLINE, ${SNAPSHOT_PRIORITY[*]}, timeout ${DB_BACKUP_TIMEOUT_SECONDS}s) -> $DB_BACKUP_TMP"
  SNAPSHOT_STARTED_AT=$SECONDS
  SNAPSHOT_EXIT_CODE=0
  printf "PRAGMA busy_timeout=10000;\nVACUUM INTO '%s';\n" "$DB_BACKUP_TMP_SQL" \
    | timeout "${DB_BACKUP_TIMEOUT_SECONDS}s" "${SNAPSHOT_PRIORITY[@]}" sqlite3 -bail -batch "$DB_FILE" >/dev/null \
    || SNAPSHOT_EXIT_CODE=$?

  if [ "$SNAPSHOT_EXIT_CODE" -ne 0 ]; then
    if [ "$SNAPSHOT_EXIT_CODE" -eq 124 ]; then
      snapshot_abort_backend_online "DB snapshot TIMEOUT след ${DB_BACKUP_TIMEOUT_SECONDS}s (DB_BACKUP_TIMEOUT_SECONDS) — sqlite3 е прекратен, temp файлове изчистени."
    fi
    snapshot_abort_backend_online "VACUUM INTO snapshot се провали (sqlite3 exit code $SNAPSHOT_EXIT_CODE) — temp файлове изчистени."
  fi
  log "Snapshot готов за $((SECONDS - SNAPSHOT_STARTED_AT))s (backend беше ONLINE през цялото време)."

  # ─── 5b. Snapshot verification — ЗАДЪЛЖИТЕЛНО преди pm2 stop ─────────────
  [ -s "$DB_BACKUP_TMP" ] || snapshot_abort_backend_online "Snapshot файлът липсва или е празен след VACUUM INTO: $DB_BACKUP_TMP."

  VERIFY_EXIT_CODE=0
  VERIFY_OUTPUT="$(timeout "${DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS}s" node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1], { open: true, readOnly: true })
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join('; ')
      const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length
      process.stdout.write(integrity + '\n' + foreignKeyViolations)
    } finally {
      db.close()
    }
  " "$DB_BACKUP_TMP")" || VERIFY_EXIT_CODE=$?

  if [ "$VERIFY_EXIT_CODE" -ne 0 ]; then
    snapshot_abort_backend_online "Snapshot verification (integrity_check/foreign_key_check) не завърши (exit code $VERIFY_EXIT_CODE; 124 = timeout ${DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS}s) — невалидният snapshot е изтрит."
  fi
  INTEGRITY_RESULT="$(printf '%s\n' "$VERIFY_OUTPUT" | head -n 1)"
  FOREIGN_KEY_VIOLATIONS="$(printf '%s\n' "$VERIFY_OUTPUT" | tail -n 1)"
  if [ "$INTEGRITY_RESULT" != "ok" ]; then
    snapshot_abort_backend_online "Snapshot integrity_check върна \"$INTEGRITY_RESULT\" вместо \"ok\" — невалидният snapshot е изтрит."
  fi
  if [ "$FOREIGN_KEY_VIOLATIONS" != "0" ]; then
    snapshot_abort_backend_online "Snapshot foreign_key_check върна \"$FOREIGN_KEY_VIOLATIONS\" реда вместо 0 — snapshot-ът е изтрит."
  fi

  DB_BACKUP_SHA256="$(sha256_of "$DB_BACKUP_TMP")"
  if ! printf '%s' "$DB_BACKUP_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
    snapshot_abort_backend_online "Не успях да изчисля SHA256 на snapshot-а (получих \"$DB_BACKUP_SHA256\")."
  fi

  mv -f "$DB_BACKUP_TMP" "$DB_BACKUP_PATH"
  ACTIVE_TMP_FILE=""
  if ! printf '%s  %s\n' "$DB_BACKUP_SHA256" "belot-v2.sqlite" > "$DB_BACKUP_CHECKSUM_FILE"; then
    rm -rf "$STAGING_DIST_DIR"
    fail "Не успях да запиша SHA256 файла $DB_BACKUP_CHECKSUM_FILE. Snapshot-ът е валиден и запазен ($DB_BACKUP_PATH, SHA256 $DB_BACKUP_SHA256). Backend остава ONLINE (PM2 НЕ е спиран), live dist и deployment marker НЕ са пипнати."
  fi
  log "DB snapshot: $DB_BACKUP_PATH (integrity_check: ok, foreign_key_check: 0 реда, SHA256: $DB_BACKUP_SHA256 -> $DB_BACKUP_CHECKSUM_FILE)"

  # ─── 5c. Backend stop — ЧАК СЛЕД verified snapshot ─────────────────────────
  # Оттук downtime-ът е само: pm2 stop -> dist activation -> pm2 restart ->
  # migrations/startup. Без изкуствено изчакване — wait_for_pm2_stopped
  # връща веднага щом старият процес реално е спрян.
  section "Backend stop (СЛЕД verified snapshot — само за activation/restart/migrations)"

  log "pm2 stop $PM2_APP_NAME (snapshot вече е verified; старият writer трябва да е спрян преди dist activation и migrations)..."
  if ! pm2 stop "$PM2_APP_NAME"; then
    rm -rf "$STAGING_DIST_DIR"
    fail "pm2 stop $PM2_APP_NAME се провали — backend може да е в неопределено състояние. РЪЧНА проверка нужна НЕЗАБАВНО (pm2 status $PM2_APP_NAME). Verified DB snapshot: $DB_BACKUP_PATH"
  fi
  # Въоръжаваме recovery guard-а ВЕДНАГА след успешния stop команда — дори
  # ако последващия bounded verify по-долу timeout-не (неясно дали реално е
  # спрян), recovery действието (pm2 restart) е идемпотентно безопасно и в
  # двата случая.
  PM2_QUIESCED_FOR_BACKUP="true"

  if ! wait_for_pm2_stopped "$PM2_APP_NAME" "$OLD_PID"; then
    fail "Не успях да потвърдя, че $PM2_APP_NAME е спрян (status=stopped И старият PID $OLD_PID вече не работи) в рамките на ${PM2_STOP_VERIFY_MAX_SECONDS}s. cleanup ще опита да върне backend-а online."
  fi
  log "PM2 stop потвърден: status=stopped, старият PID ($OLD_PID) вече не работи."
fi

# ─── 6. Dist activation — staging -> live, НЕПОСРЕДСТВЕНО преди restart ────
# Единствената точка, в която live DIST_DIR реално се променя. До тук
# build-ът е седял изолирано в STAGING_DIST_DIR. При обикновен code deploy
# (без pending migrations) старият PM2 процес е обслужвал живия dist/
# непрекъснато и непроменено през целия build/verify/confirmation прозорец.
# При pending migrations backend-ът вече Е спрян (стъпка 5c, СЛЕД verified
# live DB snapshot) — dist активацията тук се случва, докато PM2 е stopped,
# ПРЕДИ финалния restart по-долу, който го връща online с новия код.
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

log "Post-restart /health warm-up: до ${POST_RESTART_HEALTH_RETRY_MAX_SECONDS}s bounded retry (интервал ${POST_RESTART_HEALTH_RETRY_INTERVAL_SECONDS}s, cache-busted всеки опит, успех при първия HTTP 200)..."
# Забележка: /health може да съдържа известния tournament ledger_mismatch
# advisory в тялото си — това НЕ е deploy failure, докато HTTP статус кодът
# е 200. Тук проверяваме САМО статус кода, не тялото.
POST_HEALTH_CODE="$(wait_for_public_health_200 "$PUBLIC_BASE_URL")"
[ "$POST_HEALTH_CODE" = "200" ] || post_restart_fail "/health след restart не върна HTTP 200 в рамките на ${POST_RESTART_HEALTH_RETRY_MAX_SECONDS}s (последен наблюдаван статус: $POST_HEALTH_CODE)."
log "/health (post-restart, HTTP status само): OK (HTTP $POST_HEALTH_CODE)"

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
  log "DB backup path:          $DB_BACKUP_PATH (live VACUUM INTO snapshot, backend ONLINE по време на backup-а)"
  log "DB backup SHA256:        $DB_BACKUP_SHA256 ($DB_BACKUP_CHECKSUM_FILE)"
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
