#!/usr/bin/env bash
# verify-loadtest-vps.sh
#
# Read-only проверка на load-test и production инстанции.
# Не прави промени. Безопасен за многократно изпълнение.
#
# Употреба:
#   chmod +x verify-loadtest-vps.sh
#   ./verify-loadtest-vps.sh

set -Eeuo pipefail

readonly PROD_DIR="/var/www/belot-v2"
readonly LOADTEST_DIR="/var/www/belot-v2-loadtest"
readonly PROD_PORT="3001"
readonly LOADTEST_PORT="3101"
readonly PROD_PM2="belot-v2-server"
readonly LOADTEST_PM2="belot-v2-loadtest"
readonly PROD_DB_PATH="${PROD_DIR}/server/database/data/belot-v2.sqlite"
readonly LOADTEST_DB_PATH="${LOADTEST_DIR}/server/database/data/belot-v2.sqlite"
readonly CREDENTIALS_FILE="${LOADTEST_DIR}/credentials/loadtest-users.json.local"

log()     { echo "$*"; }
section() { echo ""; echo "══════════════════════════════════════════════"; echo "  $*"; echo "══════════════════════════════════════════════"; }

json_field() {
  local json_val="$1" field="$2"
  # JSON се подава чрез env var — не се вгражда директно в node код (заобикаля shell quoting)
  JSON_DATA="${json_val}" JSON_FIELD="${field}" node --input-type=module -e "
    try {
      const v = JSON.parse(process.env.JSON_DATA || '{}');
      const parts = process.env.JSON_FIELD.split('.');
      let x = v;
      for (const p of parts) x = x && x[p];
      process.stdout.write(x == null ? 'null' : String(x));
    } catch { process.stdout.write('ERROR'); }
  " 2>/dev/null || echo "ERROR"
}

sqlite_count() {
  local db="$1" sql="$2"
  if [[ ! -f "${db}" ]]; then echo "DB_NOT_FOUND"; return; fi
  node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    try {
      const db = new DatabaseSync('${db}');
      const row = db.prepare(\"${sql}\").get();
      db.close();
      process.stdout.write(String(row ? Object.values(row)[0] : 0));
    } catch (e) { process.stdout.write('ERROR: ' + e.message); }
  " 2>/dev/null || echo "ERROR"
}

# ─── 1. System resources ────────────────────────────────────────────────────────
section "1. System resources"
echo "CPU cores  : $(nproc 2>/dev/null || echo '?')"
free -h 2>/dev/null || echo "free not available"
df -h / 2>/dev/null || echo "df not available"
echo "Load avg   : $(cat /proc/loadavg 2>/dev/null || echo '?')"

# ─── 2. Port listeners ──────────────────────────────────────────────────────────
section "2. Port listeners (3001 / 3101)"
ss -ltnp 2>/dev/null | grep -E ":(${PROD_PORT}|${LOADTEST_PORT})\b" || echo "(няма слушащи процеси на тези портове)"

# ─── 3. PM2 status ──────────────────────────────────────────────────────────────
section "3. PM2 — двата процеса"
pm2 list 2>/dev/null | grep -E "(${PROD_PM2}|${LOADTEST_PM2}|App name)" || echo "pm2 list: няма изход"

echo ""
echo "--- ${PROD_PM2} (production) ---"
pm2 describe "${PROD_PM2}" 2>/dev/null | grep -E "(status|pid|uptime|restarts|memory|exec mode|cwd)" \
  || echo "Не е намерен."

echo ""
echo "--- ${LOADTEST_PM2} ---"
pm2 describe "${LOADTEST_PM2}" 2>/dev/null | grep -E "(status|pid|uptime|restarts|memory|exec mode|cwd)" \
  || echo "Не е намерен."

# ─── 4. Production health ────────────────────────────────────────────────────────
section "4. Production health (port ${PROD_PORT})"
PROD_HEALTH=$(curl -sf "http://127.0.0.1:${PROD_PORT}/health" --max-time 10 2>/dev/null || echo "")
if [[ -z "${PROD_HEALTH}" ]]; then
  echo "FAIL: Production health не отговаря."
else
  PROD_OK=$(json_field "${PROD_HEALTH}" "ok")
  PROD_ACTIVE=$(json_field "${PROD_HEALTH}" "gameRuntime.activeRooms")
  PROD_MODE=$(json_field "${PROD_HEALTH}" "gameWorkerTick.mode")
  echo "ok           : ${PROD_OK}"
  echo "activeRooms  : ${PROD_ACTIVE}"
  echo "mode         : ${PROD_MODE}"
fi

# ─── 5. Load-test health ─────────────────────────────────────────────────────────
section "5. Load-test health (port ${LOADTEST_PORT})"
LT_HEALTH=$(curl -sf "http://127.0.0.1:${LOADTEST_PORT}/health" --max-time 10 2>/dev/null || echo "")
if [[ -z "${LT_HEALTH}" ]]; then
  echo "FAIL: Load-test health не отговаря на port ${LOADTEST_PORT}."
else
  LT_OK=$(json_field "${LT_HEALTH}" "ok")
  LT_MODE=$(json_field "${LT_HEALTH}" "gameWorkerTick.mode")
  POOL_STATE=$(json_field "${LT_HEALTH}" "gameWorkerPool.state")
  POOL_WORKER_COUNT=$(json_field "${LT_HEALTH}" "gameWorkerPool.workerCount")
  POOL_READY=$(json_field "${LT_HEALTH}" "gameWorkerPool.readyWorkers")
  POOL_FAILED=$(json_field "${LT_HEALTH}" "gameWorkerPool.failedWorkers")
  POOL_ASSIGNED=$(json_field "${LT_HEALTH}" "gameWorkerPool.totalAssignedRooms")
  POOL_MAX_ROOMS=$(json_field "${LT_HEALTH}" "gameWorkerPool.maxRoomsPerWorker")
  LT_ACTIVE=$(json_field "${LT_HEALTH}" "gameRuntime.activeRooms")
  LT_SHADOW_OK=$(json_field "${LT_HEALTH}" "roomShadowSync.isConsistent")
  LT_SHADOW_ERR=$(json_field "${LT_HEALTH}" "roomShadowSync.lastError")
  LIFECYCLE_OK=$(json_field "${LT_HEALTH}" "gameWorkerLifecycle.ok")

  echo "ok                  : ${LT_OK}"
  echo "mode                : ${LT_MODE}"
  echo "pool.state          : ${POOL_STATE}"
  echo "pool.workerCount    : ${POOL_WORKER_COUNT}"
  echo "pool.readyWorkers   : ${POOL_READY}"
  echo "pool.failedWorkers  : ${POOL_FAILED}"
  echo "pool.totalAssigned  : ${POOL_ASSIGNED}"
  echo "pool.maxRoomsPerW   : ${POOL_MAX_ROOMS}"
  echo "gameRuntime.active  : ${LT_ACTIVE}"
  echo "roomShadowSync.ok   : ${LT_SHADOW_OK} (null=pool mode)"
  echo "roomShadowSync.err  : ${LT_SHADOW_ERR}"
  echo "lifecycle.ok        : ${LIFECYCLE_OK}"

  # Per-worker shadow health
  echo ""
  echo "Per-worker shadow:"
  HEALTH_JSON="${LT_HEALTH}" node --input-type=module -e "
    const h = JSON.parse(process.env.HEALTH_JSON || '{}');
    const workers = (h.gameWorkerPool || {}).workers || [];
    for (const w of workers) {
      const s = w.shadow || {};
      console.log('  worker=' + w.workerId
        + ' assigned=' + w.assignedRooms
        + ' maxRooms=' + w.maxRooms
        + ' shadow.consistent=' + s.isConsistent
        + ' shadow.lastError=' + (s.lastError || 'null'));
    }
    if (workers.length === 0) console.log('  (no workers)');
  " 2>/dev/null || echo "  (parse error)"
fi

# ─── 6. Load-test Git commit ─────────────────────────────────────────────────────
section "6. Load-test Git commit"
if [[ -d "${LOADTEST_DIR}/.git" ]]; then
  echo "Commit  : $(git -C "${LOADTEST_DIR}" rev-parse HEAD 2>/dev/null || echo '?')"
  echo "Branch  : $(git -C "${LOADTEST_DIR}" branch --show-current 2>/dev/null || echo 'detached HEAD')"
  echo "Status  :"
  git -C "${LOADTEST_DIR}" status --short 2>/dev/null || echo "(error)"
else
  echo "Не е git repo: ${LOADTEST_DIR}"
fi

# ─── 7. Load-test DB ────────────────────────────────────────────────────────────
section "7. Load-test DB"
if [[ -f "${LOADTEST_DB_PATH}" ]]; then
  LT_DB_SIZE=$(du -h "${LOADTEST_DB_PATH}" | awk '{print $1}')
  echo "Path : ${LOADTEST_DB_PATH}"
  echo "Size : ${LT_DB_SIZE}"

  LT_ACCOUNTS=$(sqlite_count "${LOADTEST_DB_PATH}" \
    "SELECT COUNT(*) FROM accounts WHERE email LIKE '%@loadtest.pika.bg'")
  LT_PROFILES=$(sqlite_count "${LOADTEST_DB_PATH}" \
    "SELECT COUNT(*) FROM profiles WHERE profile_kind='human' AND username LIKE 'loadtest%'")
  LT_WALLETS=$(sqlite_count "${LOADTEST_DB_PATH}" \
    "SELECT COUNT(*) FROM profile_wallets pw JOIN profiles p ON p.profile_id=pw.profile_id WHERE p.username LIKE 'loadtest%' AND pw.yellow_coins_balance >= 100000")
  LT_PROGRESS=$(sqlite_count "${LOADTEST_DB_PATH}" \
    "SELECT COUNT(*) FROM profile_progress pp JOIN profiles p ON p.profile_id=pp.profile_id WHERE p.username LIKE 'loadtest%'")

  echo "accounts   (loadtest): ${LT_ACCOUNTS}"
  echo "profiles   (loadtest): ${LT_PROFILES}"
  echo "wallets    (>=100000): ${LT_WALLETS}"
  echo "progress   (loadtest): ${LT_PROGRESS}"
else
  echo "DB не съществува: ${LOADTEST_DB_PATH}"
fi

# ─── 8. Credentials JSON ─────────────────────────────────────────────────────────
section "8. Credentials file"
if [[ -f "${CREDENTIALS_FILE}" ]]; then
  CRED_PERMS=$(stat -c "%a" "${CREDENTIALS_FILE}" 2>/dev/null || echo "?")
  CRED_COUNT=$(node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    try {
      const d = JSON.parse(readFileSync('${CREDENTIALS_FILE}', 'utf8'));
      process.stdout.write(String(Array.isArray(d.users) ? d.users.length : 0));
    } catch (e) { process.stdout.write('ERROR: ' + e.message); }
  " 2>/dev/null || echo "ERROR")
  echo "Path   : ${CREDENTIALS_FILE}"
  echo "Perms  : ${CRED_PERMS} (expected 600)"
  echo "Count  : ${CRED_COUNT}"
  [[ "${CRED_COUNT}" == "2400" ]] && echo "Count  : OK (2400)" || echo "Count  : WARN (expected 2400)"
else
  echo "Credentials файлът не съществува: ${CREDENTIALS_FILE}"
fi

# ─── 9. Production DB contamination check ────────────────────────────────────────
section "9. Production DB contamination check"
if [[ -f "${PROD_DB_PATH}" ]]; then
  PROD_LT_COUNT=$(sqlite_count "${PROD_DB_PATH}" \
    "SELECT COUNT(*) FROM accounts WHERE email LIKE '%@loadtest.pika.bg'" 2>/dev/null || echo "CHECK_FAILED")
  echo "Production DB loadtest accounts: ${PROD_LT_COUNT}"
  [[ "${PROD_LT_COUNT}" == "0" ]] && echo "  Clean. OK." || echo "  WARNING: намерени loadtest accounts в production!"
else
  echo "Production DB не е намерена на очаквания path (нормално за verify-only)."
fi

# ─── 10. Load-test PM2 logs (само errors) ────────────────────────────────────────
section "10. Load-test recent errors (последните 50 реда)"
if pm2 describe "${LOADTEST_PM2}" &>/dev/null; then
  echo "--- pm2 logs ${LOADTEST_PM2} --nostream --lines 50 ---"
  pm2 logs "${LOADTEST_PM2}" --nostream --lines 50 2>/dev/null \
    | grep -iE "(error|SQLITE|BUSY|LOCKED|timeout|compute_failed|not_assigned|tick)" \
    || echo "  (няма red-flag редове в последните 50 реда)"
else
  echo "Процесът '${LOADTEST_PM2}' не е намерен в PM2."
fi

echo ""
echo "Verify complete. Не са направени промени."
