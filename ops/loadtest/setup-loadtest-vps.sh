#!/usr/bin/env bash
# setup-loadtest-vps.sh
#
# Подготвя напълно отделна load-test инстанция на VPS.
# Изпълнява се САМО като root на VPS.
# НЕ променя production директория, PM2 процес, DB или .env.
#
# Употреба:
#   chmod +x setup-loadtest-vps.sh
#   ./setup-loadtest-vps.sh

set -Eeuo pipefail

# ─── Константи ─────────────────────────────────────────────────────────────────
readonly PROD_DIR="/var/www/belot-v2"
readonly LOADTEST_DIR="/var/www/belot-v2-loadtest"
readonly REPO_URL="https://github.com/mimojef/belot.git"
readonly EXACT_COMMIT="98763a69e2b4e87bb033045ae245e89a2619e3e9"
readonly PROD_PORT="3001"
readonly LOADTEST_PORT="3101"
readonly PROD_PM2="belot-v2-server"
readonly LOADTEST_PM2="belot-v2-loadtest"
readonly PROVISION_COUNT="2400"
readonly PROVISION_CONFIRM="CREATE-LOADTEST-PROFILES"
readonly CREDENTIALS_DIR="${LOADTEST_DIR}/credentials"
readonly CREDENTIALS_FILE="${CREDENTIALS_DIR}/loadtest-users.json.local"
readonly SEED_FILE="${CREDENTIALS_DIR}/.loadtest-seed"

# DB paths — hardcoded от сървъра, не са env-configurable
readonly PROD_DB_PATH="${PROD_DIR}/server/database/data/belot-v2.sqlite"
readonly LOADTEST_DB_PATH="${LOADTEST_DIR}/server/database/data/belot-v2.sqlite"

# ─── Error trap ─────────────────────────────────────────────────────────────────
trap 'echo "[ERROR] Провал на ред $LINENO. Команда: ${BASH_COMMAND}" >&2' ERR

# ─── Utility ────────────────────────────────────────────────────────────────────
log() { echo "[setup] $*"; }
die() { echo "[ERROR] $*" >&2; exit 1; }

# Проверява JSON поле от stdin чрез node (без зависимост от python3 или jq)
json_field() {
  local field="$1"
  node --input-type=module -e "
    const c = [];
    process.stdin.on('data', d => c.push(d));
    process.stdin.on('end', () => {
      try {
        const v = JSON.parse(c.join(''));
        const parts = '${field}'.split('.');
        let x = v;
        for (const p of parts) x = x && x[p];
        process.stdout.write(String(x ?? ''));
      } catch { process.stdout.write(''); }
    });
  "
}

# Брои записи в SQLite чрез node:sqlite.
# Подава DB path и SQL query чрез env vars — не вгражда user-controlled стойности в node код.
sqlite_count() {
  local db_path="$1"
  local sql_query="$2"
  SQLITE_DB="${db_path}" SQLITE_SQL="${sql_query}" node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    try {
      const db = new DatabaseSync(process.env.SQLITE_DB);
      const row = db.prepare(process.env.SQLITE_SQL).get();
      db.close();
      process.stdout.write(String(row ? Object.values(row)[0] : 0));
    } catch (e) { process.stdout.write('ERROR: ' + e.message); }
  "
}

# ─── 1. Safety preflight ────────────────────────────────────────────────────────
log "=== 1. Safety preflight ==="

[[ "$(id -u)" -eq 0 ]] || die "Трябва да се изпълни като root."

# Production health
log "Production health (port ${PROD_PORT})..."
PROD_HEALTH=$(curl -sf "http://127.0.0.1:${PROD_PORT}/health" --max-time 10) \
  || die "Production health check провали се. Не продължаваме."
PROD_HEALTH_OK=$(echo "${PROD_HEALTH}" | json_field "ok")
[[ "${PROD_HEALTH_OK}" == "true" ]] \
  || die "Production /health не върна ok=true. Спираме."
log "  Production health: OK"

# belot-v2-server трябва да е online
pm2 describe "${PROD_PM2}" 2>&1 | grep -q "online" \
  || die "PM2 процесът '${PROD_PM2}' не е online. Спираме."
log "  PM2 '${PROD_PM2}': online"

# Port 3101 — свободен или вече е нашият load-test
if ss -ltnp 2>/dev/null | grep -q ":${LOADTEST_PORT}"; then
  if ! pm2 describe "${LOADTEST_PM2}" &>/dev/null; then
    die "Порт ${LOADTEST_PORT} е зает от непознат процес. Спираме."
  fi
  log "  Порт ${LOADTEST_PORT}: зает от '${LOADTEST_PM2}' (ще се update-не)."
else
  log "  Порт ${LOADTEST_PORT}: свободен."
fi

# LOADTEST_DIR не трябва да е symlink
if [[ -L "${LOADTEST_DIR}" ]]; then
  die "${LOADTEST_DIR} е symlink! Отказваме."
fi

# LOADTEST_DIR и PROD_DIR трябва да са различни директории
PROD_REAL=$(realpath -m "${PROD_DIR}" 2>/dev/null || echo "${PROD_DIR}")
LT_REAL=$(realpath -m "${LOADTEST_DIR}" 2>/dev/null || echo "${LOADTEST_DIR}")
[[ "${PROD_REAL}" != "${LT_REAL}" ]] \
  || die "LOADTEST_DIR и PROD_DIR са идентични! Отказваме."
log "  Директориите са различни: OK"

# DB paths трябва да са различни
PROD_DB_REAL=$(realpath -m "${PROD_DB_PATH}" 2>/dev/null || echo "${PROD_DB_PATH}")
LT_DB_REAL=$(realpath -m "${LOADTEST_DB_PATH}" 2>/dev/null || echo "${LOADTEST_DB_PATH}")
[[ "${PROD_DB_REAL}" != "${LT_DB_REAL}" ]] \
  || die "Production и load-test DB paths съвпадат! Отказваме."
log "  Production DB : ${PROD_DB_PATH}"
log "  Load-test DB  : ${LOADTEST_DB_PATH}"
log "  DB paths: различни OK"

log "Preflight: всички проверки преминаха."

# ─── 2. Git checkout ────────────────────────────────────────────────────────────
log ""
log "=== 2. Git checkout ==="

if [[ -d "${LOADTEST_DIR}/.git" ]]; then
  log "Директорията вече съществува. Проверяваме дали е нашата load-test инстанция..."
  EXISTING_REMOTE=$(git -C "${LOADTEST_DIR}" remote get-url origin 2>/dev/null || echo "")
  [[ "${EXISTING_REMOTE}" == "${REPO_URL}" ]] \
    || die "Съществуващата директория има различен remote: '${EXISTING_REMOTE}'. Спираме."
  log "  Remote: OK (${REPO_URL})"
  log "  Fetch origin..."
  git -C "${LOADTEST_DIR}" fetch origin --quiet

elif [[ -d "${LOADTEST_DIR}" ]]; then
  die "${LOADTEST_DIR} съществува, но не е git repo. Спираме — не изтриваме непознати файлове."

else
  log "  Клонираме репото (без checkout)..."
  git clone --no-checkout "${REPO_URL}" "${LOADTEST_DIR}"
fi

log "  Checkout на точен commit: ${EXACT_COMMIT}"
git -C "${LOADTEST_DIR}" checkout --quiet "${EXACT_COMMIT}"

ACTUAL_COMMIT=$(git -C "${LOADTEST_DIR}" rev-parse HEAD)
[[ "${ACTUAL_COMMIT}" == "${EXACT_COMMIT}" ]] \
  || die "Checkout commit не съвпада: очакван=${EXACT_COMMIT} действителен=${ACTUAL_COMMIT}"
log "  Commit verified: ${ACTUAL_COMMIT}"

git -C "${LOADTEST_DIR}" status --short
log "  Работното дърво: ОК"

# ─── 3. npm install + server build ──────────────────────────────────────────────
log ""
log "=== 3. npm install + server build ==="

# Root npm ci --omit=dev (нужно за sharp — root dependency)
# Frontend (vite) НЕ е нужен за k6 тест → пропускаме root devDeps
log "  Root npm ci --omit=dev (за sharp)..."
cd "${LOADTEST_DIR}"
npm ci --omit=dev --no-audit --prefer-offline

# Server npm ci (включва tsx + typescript за build и provisioning)
log "  Server npm ci..."
cd "${LOADTEST_DIR}/server"
npm ci --no-audit --prefer-offline

# Server TypeScript build
log "  Server TypeScript build..."
npm run build

log "  Build: ОК"

# ─── 4. Load-test .env ──────────────────────────────────────────────────────────
log ""
log "=== 4. Load-test .env ==="

LOADTEST_ENV="${LOADTEST_DIR}/server/.env"

# Никога не копираме production .env
[[ "$(realpath -m "${LOADTEST_ENV}" 2>/dev/null || echo "${LOADTEST_ENV}")" \
  != "$(realpath -m "${PROD_DIR}/server/.env" 2>/dev/null || echo "${PROD_DIR}/server/.env")" ]] \
  || die ".env paths съвпадат с production! Отказваме."

# server/src/index.ts line 1: `import 'dotenv/config'`
# dotenv/config зарежда .env от process.cwd() = /var/www/belot-v2-loadtest/server
# PM2 стартира с --cwd /var/www/belot-v2-loadtest/server → .env се зарежда автоматично.
cat > "${LOADTEST_ENV}" <<ENV_EOF
# Load-test server — автоматично генериран от setup-loadtest-vps.sh
# НЕ добавяй production secrets тук!
# НЕ добавяй Stripe, Brevo, email или друга production конфигурация.

PORT=${LOADTEST_PORT}
BELOT_GAME_WORKER_TICK_MODE=worker-candidate
BELOT_GAME_WORKER_COUNT=4
BELOT_GAME_WORKER_MAX_ROOMS_PER_WORKER=250
ENV_EOF

chmod 600 "${LOADTEST_ENV}"
log "  .env: ${LOADTEST_ENV} (права 600)"
log "  PORT=${LOADTEST_PORT}, mode=worker-candidate, workers=4, maxRooms=250"

# ─── 5. Credentials директория ──────────────────────────────────────────────────
mkdir -p "${CREDENTIALS_DIR}"
chmod 700 "${CREDENTIALS_DIR}"

# ─── 6. DB init → backup → provisioning ─────────────────────────────────────────
# Provisioning скриптът НЕ изпълнява миграции — отваря DB директно.
# Ред: (a) спри PM2 loadtest → (b) init DB migrations → (c) backup → (d) provision
log ""
log "=== 6. DB init + provisioning (преди PM2 start) ==="

# 6a. Спираме load-test PM2 ако работи (гарантира без конкурентен достъп до DB)
if pm2 describe "${LOADTEST_PM2}" &>/dev/null; then
  log "  Спираме '${LOADTEST_PM2}' преди DB операции..."
  pm2 stop "${LOADTEST_PM2}" 2>/dev/null || true
  pm2 delete "${LOADTEST_PM2}" 2>/dev/null || true
fi

# 6b. DB init: изпълнява миграциите без да стартира целия сървър.
#     Ползва компилирания dist файл — import.meta.url вътре определя коректния DB path.
log "  DB init (миграции)..."
cd "${LOADTEST_DIR}/server"
node --input-type=module -e "
  import { ensureServerDatabaseReady } from './dist/db/ensureServerDatabaseReady.js';
  await ensureServerDatabaseReady();
  console.log('[db-init] OK');
" || die "DB init провали се. Провери dist/db/ensureServerDatabaseReady.js."

# 6c. Задължителна повторна проверка на DB paths преди provisioning
LT_DB_CHECK=$(realpath -m "${LOADTEST_DB_PATH}" 2>/dev/null || echo "${LOADTEST_DB_PATH}")
PROD_DB_CHECK=$(realpath -m "${PROD_DB_PATH}" 2>/dev/null || echo "${PROD_DB_PATH}")
[[ "${LT_DB_CHECK}" != "${PROD_DB_CHECK}" ]] \
  || die "CRITICAL: DB paths съвпадат преди provisioning! Отказваме."
log "  Load-test DB : ${LOADTEST_DB_PATH}"
log "  Production DB: ${PROD_DB_PATH}"

# 6d. Seed — при повторно изпълнение ползваме съществуващия (idempotent)
if [[ -f "${SEED_FILE}" ]]; then
  log "  Seed файл съществува — ползваме го (idempotent re-run)."
else
  log "  Генерираме нов LOADTEST_PASSWORD_SEED (96 hex chars)..."
  openssl rand -hex 48 > "${SEED_FILE}"
  chmod 600 "${SEED_FILE}"
fi
LOADTEST_PASSWORD_SEED=$(cat "${SEED_FILE}")

# 6e. Backup на load-test DB (сървърът е спрян → безопасно копие без WAL конфликт)
if [[ -f "${LOADTEST_DB_PATH}" ]]; then
  BACKUP_PATH="${LOADTEST_DB_PATH}.backup.$(date +%Y%m%d_%H%M%S)"
  log "  Backup на load-test DB → ${BACKUP_PATH}"
  cp "${LOADTEST_DB_PATH}" "${BACKUP_PATH}"
fi

# 6f. Provisioning (сървърът е спрян → BEGIN IMMEDIATE без конкуренция)
log "  Стартираме provisioning (${PROVISION_COUNT} профила)..."
cd "${LOADTEST_DIR}/server"
LOADTEST_PASSWORD_SEED="${LOADTEST_PASSWORD_SEED}" \
  npx tsx scripts/provision-load-test-profiles.ts \
    --count "${PROVISION_COUNT}" \
    --confirm="${PROVISION_CONFIRM}" \
    --out="${CREDENTIALS_FILE}"

chmod 600 "${CREDENTIALS_FILE}"
log "  Credentials: ${CREDENTIALS_FILE} (права 600)"

# ─── 7. Provisioning verification ────────────────────────────────────────────────
log ""
log "=== 7. Provisioning verification ==="

ACCOUNT_COUNT=$(sqlite_count "${LOADTEST_DB_PATH}" \
  "SELECT COUNT(*) FROM accounts WHERE email LIKE '%@loadtest.pika.bg'")
log "  accounts (loadtest): ${ACCOUNT_COUNT}"
[[ "${ACCOUNT_COUNT}" -eq "${PROVISION_COUNT}" ]] \
  || die "Очаквани ${PROVISION_COUNT} accounts, намерени ${ACCOUNT_COUNT}."

PROFILE_COUNT=$(sqlite_count "${LOADTEST_DB_PATH}" \
  "SELECT COUNT(*) FROM profiles WHERE profile_kind='human' AND username LIKE 'loadtest%'")
log "  profiles (human/loadtest): ${PROFILE_COUNT}"
[[ "${PROFILE_COUNT}" -eq "${PROVISION_COUNT}" ]] \
  || die "Очаквани ${PROVISION_COUNT} profiles, намерени ${PROFILE_COUNT}."

WALLET_COUNT=$(sqlite_count "${LOADTEST_DB_PATH}" \
  "SELECT COUNT(*) FROM profile_wallets pw JOIN profiles p ON p.profile_id=pw.profile_id WHERE p.username LIKE 'loadtest%' AND pw.yellow_coins_balance >= 100000")
log "  wallets (balance >= 100000): ${WALLET_COUNT}"
[[ "${WALLET_COUNT}" -eq "${PROVISION_COUNT}" ]] \
  || die "Очаквани ${PROVISION_COUNT} wallets, намерени ${WALLET_COUNT}."

PROGRESS_COUNT=$(sqlite_count "${LOADTEST_DB_PATH}" \
  "SELECT COUNT(*) FROM profile_progress pp JOIN profiles p ON p.profile_id=pp.profile_id WHERE p.username LIKE 'loadtest%'")
log "  progress records: ${PROGRESS_COUNT}"
[[ "${PROGRESS_COUNT}" -eq "${PROVISION_COUNT}" ]] \
  || die "Очаквани ${PROVISION_COUNT} progress records, намерени ${PROGRESS_COUNT}."

# Проверка: production DB не трябва да съдържа load-test accounts
if [[ -f "${PROD_DB_PATH}" ]]; then
  PROD_CONTAMINATION=$(sqlite_count "${PROD_DB_PATH}" \
    "SELECT COUNT(*) FROM accounts WHERE email LIKE '%@loadtest.pika.bg'" 2>/dev/null || echo "ERROR")
  if [[ "${PROD_CONTAMINATION}" == "0" ]]; then
    log "  Production DB: без load-test accounts. Clean."
  elif [[ "${PROD_CONTAMINATION}" =~ ^[0-9]+$ ]]; then
    die "CRITICAL: ${PROD_CONTAMINATION} load-test accounts намерени в production DB!"
  else
    log "  WARNING: Не можахме да проверим production DB: ${PROD_CONTAMINATION}"
  fi
fi

# Credentials JSON count
CRED_COUNT=$(CRED_FILE="${CREDENTIALS_FILE}" node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  try {
    const d = JSON.parse(readFileSync(process.env.CRED_FILE, 'utf8'));
    process.stdout.write(String(Array.isArray(d.users) ? d.users.length : 0));
  } catch (e) { process.stdout.write('ERROR: ' + e.message); }
")
log "  Credentials JSON entries: ${CRED_COUNT}"
[[ "${CRED_COUNT}" -eq "${PROVISION_COUNT}" ]] \
  || die "Credentials JSON има ${CRED_COUNT} entries, очаквани ${PROVISION_COUNT}."

# ─── 8. PM2 процес ──────────────────────────────────────────────────────────────
log ""
log "=== 8. PM2 load-test процес ==="

# Provisioning е завършено — стартираме сървъра
# dotenv/config в server/src/index.ts зарежда .env от --cwd (server/) автоматично
log "  Стартираме '${LOADTEST_PM2}'..."
pm2 start \
  "${LOADTEST_DIR}/server/dist/index.js" \
  --name "${LOADTEST_PM2}" \
  --cwd "${LOADTEST_DIR}/server" \
  --interpreter node

# НЕ изпълняваме pm2 save — не искаме да засегнем production boot конфигурацията

log "  Изчакваме worker pool да е ready (до 60 секунди)..."
POOL_READY=false
POOL_STATE=""
READY_W=""
for i in $(seq 1 30); do
  sleep 2
  HEALTH_RAW=$(curl -sf "http://127.0.0.1:${LOADTEST_PORT}/health" --max-time 5 2>/dev/null || echo "")
  if [[ -n "${HEALTH_RAW}" ]]; then
    POOL_STATE=$(echo "${HEALTH_RAW}" | json_field "gameWorkerPool.state")
    READY_W=$(echo "${HEALTH_RAW}" | json_field "gameWorkerPool.readyWorkers")
    if [[ "${POOL_STATE}" == "ready" && "${READY_W}" == "4" ]]; then
      log "  Server ready след $((i * 2))s."
      POOL_READY=true
      break
    fi
  fi
  log "  Изчакваме... (${i}/30) state=${POOL_STATE:-?} readyWorkers=${READY_W:-?}"
done

[[ "${POOL_READY}" == "true" ]] \
  || die "Load-test server не стана ready след 60s. Провери: pm2 logs ${LOADTEST_PM2}"

# ─── 9. Health verification ──────────────────────────────────────────────────────
log ""
log "=== 9. Health verification ==="

LT_HEALTH=$(curl -sf "http://127.0.0.1:${LOADTEST_PORT}/health" --max-time 10) \
  || die "Health check към port ${LOADTEST_PORT} провали се."

# JSON се подава чрез env var — не се вгражда директно в node код (заобикаля shell quoting)
HEALTH_JSON="${LT_HEALTH}" node --input-type=module -e "
  const h = JSON.parse(process.env.HEALTH_JSON || '{}');
  const pool = h.gameWorkerPool || {};
  const tick = h.gameWorkerTick || {};
  const rt = h.gameRuntime || {};
  const errors = [];

  if (!h.ok)                           errors.push('health.ok != true');
  if (tick.mode !== 'worker-candidate') errors.push('mode=' + tick.mode + ' (expected worker-candidate)');
  if (pool.state !== 'ready')           errors.push('pool.state=' + pool.state + ' (expected ready)');
  if (pool.readyWorkers !== 4)          errors.push('readyWorkers=' + pool.readyWorkers + ' (expected 4)');
  if (pool.failedWorkers !== 0)         errors.push('failedWorkers=' + pool.failedWorkers + ' (expected 0)');
  if (rt.activeRooms !== 0)             errors.push('activeRooms=' + rt.activeRooms + ' (expected 0)');
  if (pool.totalAssignedRooms !== 0)    errors.push('totalAssignedRooms=' + pool.totalAssignedRooms + ' (expected 0)');

  if (errors.length > 0) {
    console.error('[HEALTH FAIL]', errors.join('; '));
    process.exit(1);
  }

  console.log('[health] OK mode=' + tick.mode + ' state=' + pool.state
    + ' readyWorkers=' + pool.readyWorkers + ' failedWorkers=' + pool.failedWorkers
    + ' activeRooms=' + rt.activeRooms + ' totalAssignedRooms=' + pool.totalAssignedRooms
    + ' maxRoomsPerWorker=' + pool.maxRoomsPerWorker);
" || die "Health validation провали се."

# ─── 10. Production regression guard ─────────────────────────────────────────────
log ""
log "=== 10. Production regression guard ==="

PROD_HEALTH_AFTER=$(curl -sf "http://127.0.0.1:${PROD_PORT}/health" --max-time 10) \
  || die "Production health check провали се след setup!"
PROD_OK_AFTER=$(echo "${PROD_HEALTH_AFTER}" | json_field "ok")
[[ "${PROD_OK_AFTER}" == "true" ]] \
  || die "Production /health не е ok след setup!"
pm2 describe "${PROD_PM2}" 2>&1 | grep -q "online" \
  || die "Production PM2 '${PROD_PM2}' не е online след setup!"
log "  Production: still OK."

# ─── 11. Финален отчет ────────────────────────────────────────────────────────────
log ""
log "════════════════════════════════════════════════════════"
log "  SETUP COMPLETED"
log "════════════════════════════════════════════════════════"
log "  Load-test dir       : ${LOADTEST_DIR}"
log "  Branch              : load-testing-multicore"
log "  Exact commit        : ${ACTUAL_COMMIT}"
log "  Load-test DB        : ${LOADTEST_DB_PATH}"
log "  Production DB       : ${PROD_DB_PATH}"
log "  DB paths различни   : YES"
log "  Port                : ${LOADTEST_PORT} (SSH tunnel препоръчан за smoke)"
log "  PM2 process         : ${LOADTEST_PM2}"
log "  Workers             : 4 × 250 rooms = 1000 capacity"
log "  Accounts            : ${ACCOUNT_COUNT}"
log "  Profiles            : ${PROFILE_COUNT}"
log "  Credentials (SCP)   : ${CREDENTIALS_FILE}"
log ""
log "  SCP команда за теглене:"
log "  scp root@185.203.117.14:${CREDENTIALS_FILE} \\"
log "    D:\\Project\\Belot-V2-LoadTest\\load-tests\\k6\\loadtest-users.json.local"
log ""
log "  НЕ са изпълнени: git commit, git push, npm audit fix, pm2 save."
log "════════════════════════════════════════════════════════"
