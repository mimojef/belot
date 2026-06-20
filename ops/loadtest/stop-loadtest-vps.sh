#!/usr/bin/env bash
# stop-loadtest-vps.sh
#
# Безопасно спира САМО 'belot-v2-loadtest' PM2 процеса.
# НЕ изтрива DB, checkout или production процеса.
# НЕ изпълнява pm2 save.
#
# Употреба:
#   chmod +x stop-loadtest-vps.sh
#   ./stop-loadtest-vps.sh

set -Eeuo pipefail

readonly ALLOWED_PM2="belot-v2-loadtest"
readonly PROD_PM2="belot-v2-server"
readonly PROD_PORT="3001"
readonly LOADTEST_PORT="3101"

die() { echo "[ERROR] $*" >&2; exit 1; }
log() { echo "[stop] $*"; }

[[ "$(id -u)" -eq 0 ]] || die "Трябва да се изпълни като root."

log "Ще бъде спрян САМО: ${ALLOWED_PM2}"
log "НЕ се засяга: ${PROD_PM2}, DB, checkout."

# Проверка: production е online
pm2 describe "${PROD_PM2}" 2>&1 | grep -q "online" \
  || { log "WARNING: '${PROD_PM2}' не е online преди stop операцията."; }

# Проверка: процесът съществува
if ! pm2 describe "${ALLOWED_PM2}" &>/dev/null; then
  log "'${ALLOWED_PM2}' не е намерен в PM2. Няма какво да се спре."
  exit 0
fi

log "Спираме '${ALLOWED_PM2}'..."
pm2 stop "${ALLOWED_PM2}"

# Verify: порт 3101 е освободен
sleep 2
if ss -ltnp 2>/dev/null | grep -q ":${LOADTEST_PORT}"; then
  log "WARNING: Порт ${LOADTEST_PORT} все още е зает след stop."
else
  log "Порт ${LOADTEST_PORT}: освободен. OK."
fi

# НЕ изпълняваме pm2 save — не искаме да засегнем production boot конфигурацията

# Production regression guard
log ""
log "Production regression guard..."
PROD_HEALTH=$(curl -sf "http://127.0.0.1:${PROD_PORT}/health" --max-time 10 2>/dev/null || echo "")
if [[ -z "${PROD_HEALTH}" ]]; then
  log "WARNING: Production health не отговаря след stop операцията!"
else
  HEALTH_JSON="${PROD_HEALTH}" node --input-type=module -e "
    try {
      const h = JSON.parse(process.env.HEALTH_JSON || '{}');
      console.log('[production] ok=' + h.ok + ' activeRooms=' + (h.gameRuntime || {}).activeRooms);
    } catch { console.log('[production] parse error'); }
  " 2>/dev/null || log "Production health parse error."
fi

pm2 describe "${PROD_PM2}" 2>/dev/null | grep -E "(status|pid|uptime|restarts)" || true

log ""
log "Stop completed. '${ALLOWED_PM2}' е спрян."
log "DB, checkout и production не са засегнати."
log "НЕ е изпълнен pm2 save."
