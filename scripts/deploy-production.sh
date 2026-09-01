#!/usr/bin/env bash
#
# deploy-production.sh — smart production deploy controller.
#
# Употреба (НА production сървъра, от production repo checkout-а):
#   cd /var/www/belot-v2
#   bash scripts/deploy-production.sh
#
# Ролята на този файл е ЧИСТО оркестрация: анализира текущия Git HEAD
# спрямо вече-записаните deployment state marker-и (frontend.json/
# backend.json — виж scripts/deploy-frontend-production.sh и
# scripts/deploy-backend-production.sh), решава кой worker(и) реално трябва
# да се извикат, и ги извиква. Контролерът НИКОГА не build-ва, публикува,
# switch-ва или restart-ва нищо сам — само чете repo/Git/marker състояние и
# вика готовите, вече safety-hardened worker скриптове:
#   bash scripts/deploy-frontend-production.sh
#   bash scripts/deploy-backend-production.sh
# Тези worker-и НЕ са променени от този файл и остават единствената точка,
# в която реален build/publish/switch/restart се случва.
#
# Обхват: САМО оркестрация. НЕ git pull/fetch/reset/checkout/merge (target
# е ВИНАГИ текущия локален HEAD — never fetch-va нищо от remote). НЕ прави
# migrations сам (backend worker-ът прави тава, ако delta-та го изисква).
# НЕ пипа nginx/PM2/current директно.
#
# Изисква: git, node, flock. Изпълнява се от /var/www/belot-v2.

set -euo pipefail

# ─── Конфигурация ───────────────────────────────────────────────────────────
PROJECT_ROOT="/var/www/belot-v2"
CURRENT_LINK="$PROJECT_ROOT/current"
DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"
FRONTEND_STATE_FILE="$DEPLOY_STATE_DIR/frontend.json"
BACKEND_STATE_FILE="$DEPLOY_STATE_DIR/backend.json"
MIGRATIONS_DIR="$PROJECT_ROOT/server/database/migrations"
FRONTEND_WORKER="$PROJECT_ROOT/scripts/deploy-frontend-production.sh"
BACKEND_WORKER="$PROJECT_ROOT/scripts/deploy-backend-production.sh"
# Извън Git working tree — global controller lock, отделен от двата worker
# lock-а (всеки worker пази собствения си lock независимо, значи дори при
# директно ръчно извикване на worker покрай контролера, той пак е защитен).
LOCK_FILE="/var/lock/belot-v2-production.lock"

log() { printf '[deploy-production] %s\n' "$1"; }
fail() { printf '[deploy-production] STOP: %s\n' "$1" >&2; exit 1; }

section() {
  printf '\n[deploy-production] ── %s ──\n' "$1"
}

trap 'exit 130' INT
trap 'exit 143' TERM

# ═══════════════════════════════════════════════════════════════════════════
# Runtime-impact classification (виж §5 в task spec-а)
#
# STRICT allow-list, не deny-list: всеки променен път се проверява срещу
# точни, изведени от репото patterns. Path, който не съвпадне с НИТО ЕДНА
# позната категория, прави целия delta "unclassified" -> STOP (виж §5:
# "Неясна/рискова промяна -> STOP вместо предположение").
#
# Изведено от реалните build inputs (не предположения):
#   - Frontend build: root package.json "build": "tsc && vite build",
#     tsconfig.json (root, noEmit bundler config за src/), vite.config.ts,
#     index.html, src/**, public/** (Vite default static-copy директория,
#     потвърдено съдържание: assets/audio/favicon.* в public/).
#   - Backend build: server/package.json "build": "tsc -p tsconfig.json",
#     server/tsconfig.json (rootDir=./src, include=["src/**/*.ts"] —
#     server/scripts/ е ИЗРИЧНО извън include-а, значи НЕ Е част от
#     runtime build, дори да се промени).
#   - Migrations: server/database/migrations/**/*.sql — отделна категория
#     (не backend code-change), защото задейства различен confirmation
#     flow в backend worker-а (RESTART текст включва migration списъка).
#   - Non-runtime (docs/deploy tooling/reference, никога не build-ва се в
#     нито един от двата dist изхода): docs/**, deploy/**, legacy/** (CLAUDE.md
#     изрично документира legacy/ като "само за визуален reference, не се
#     модифицира"), scripts/** (root — deploy/check tooling скриптове, не
#     компилирани в src/ или server/dist), server/scripts/** (server dev/
#     check tooling, изрично извън server/tsconfig.json include-а),
#     *.md навсякъде, CLAUDE.md, .gitignore, .env.example.
# ═══════════════════════════════════════════════════════════════════════════

classify_path() {
  local path="$1"
  case "$path" in
    src/*|index.html|vite.config.ts|tsconfig.json|package.json|package-lock.json)
      echo "frontend" ;;
    server/database/migrations/*.sql)
      echo "migration" ;;
    server/src/*|server/tsconfig.json|server/package.json|server/package-lock.json)
      echo "backend" ;;
    public/*)
      echo "frontend" ;;
    docs/*|deploy/*|legacy/*|scripts/*|server/scripts/*|*.md|CLAUDE.md|.gitignore|.env.example|server/.env.example)
      echo "non-runtime" ;;
    *)
      echo "unclassified" ;;
  esac
}

# ─── 0. Pre-flight ───────────────────────────────────────────────────────────
section "Pre-flight checks"

[ -d "$PROJECT_ROOT/.git" ] || fail "Не съм в production repo — $PROJECT_ROOT/.git липсва."
cd "$PROJECT_ROOT"

CURRENT_DIR="$(pwd -P)"
[ "$CURRENT_DIR" = "$PROJECT_ROOT" ] || fail "Работна директория ($CURRENT_DIR) не съвпада с очаквания production repo ($PROJECT_ROOT)."

command -v git >/dev/null 2>&1 || fail "git не е намерен в PATH."
command -v node >/dev/null 2>&1 || fail "node не е намерен в PATH."
command -v flock >/dev/null 2>&1 || fail "flock не е намерен в PATH (нужен за global controller lock)."
# Worker-ите се извикват като `bash "$WORKER"` (виж §7 по-долу) — executable
# bit-ът е ирелевантен за bash интерпретация на файла, значи НЕ го изискваме
# (двата worker файла реално са 100644 в Git, не executable). Изискваме само
# съществуващ, обикновен, readable файл.
[ -f "$FRONTEND_WORKER" ] && [ -r "$FRONTEND_WORKER" ] || fail "Frontend worker липсва/не е readable файл: $FRONTEND_WORKER"
[ -f "$BACKEND_WORKER" ] && [ -r "$BACKEND_WORKER" ] || fail "Backend worker липсва/не е readable файл: $BACKEND_WORKER"
log "Prerequisites (git, node, flock, двата worker-a): OK"

# ─── Global controller lock ─────────────────────────────────────────────────
# Отделен от двата worker lock-а — предпазва от паралелно ИЗПЪЛНЕНИЕ НА
# КОНТРОЛЕРА (двоен анализ/plan едновременно), докато всеки worker пази
# собствения си lock независимо.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  fail "Друг deploy-production.sh процес вече държи lock-а ($LOCK_FILE) — паралелно изпълнение не е позволено. Изчакай другия да приключи."
fi
log "Controller lock: OK (exclusive, $LOCK_FILE)"

GIT_STATUS="$(git status --porcelain)"
if [ -n "$GIT_STATUS" ]; then
  fail "Git working tree не е clean. Committни или stash-ни промените преди deploy:
$GIT_STATUS"
fi
log "Git working tree: clean"

# Target = текущия локален HEAD. НИКАКЪВ git pull/fetch/reset/checkout/merge
# никъде в този файл — операторът вече трябва да е довел repo-то до желания
# commit преди да стартира контролера.
TARGET_SHA="$(git rev-parse HEAD)"
TARGET_SHORT_SHA="$(git rev-parse --short HEAD)"
log "Target (текущ Git HEAD): $TARGET_SHA"

# ─── 1. Прочети deployment state marker-ите ─────────────────────────────────
section "Reading deployment state markers"

read_state_field() {
  local file="$1" field="$2"
  node -e "
    try {
      const data = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const v = data[process.argv[2]];
      if (typeof v !== 'string' || v.length === 0) { process.exit(1); }
      process.stdout.write(v);
    } catch { process.exit(1); }
  " "$file" "$field" 2>/dev/null
}

if [ ! -f "$FRONTEND_STATE_FILE" ]; then
  fail "Frontend deployment state marker липсва: $FRONTEND_STATE_FILE. Нужен е initial state bootstrap (ръчно потвърди текущия production frontend release и запиши marker-а) преди да можеш да ползваш deploy-production.sh. Не гадая SHA."
fi
if [ ! -f "$BACKEND_STATE_FILE" ]; then
  fail "Backend deployment state marker липсва: $BACKEND_STATE_FILE. Нужен е initial state bootstrap (ръчно потвърди текущия production backend deploy и запиши marker-а) преди да можеш да ползваш deploy-production.sh. Не гадая SHA."
fi

FRONTEND_SHA="$(read_state_field "$FRONTEND_STATE_FILE" gitSha)" \
  || fail "Frontend deployment state marker е невалиден/непълен (липсва или празен gitSha): $FRONTEND_STATE_FILE. Нужен е initial state bootstrap. Не гадая SHA."
FRONTEND_RELEASE_PATH="$(read_state_field "$FRONTEND_STATE_FILE" releasePath)" \
  || fail "Frontend deployment state marker е невалиден/непълен (липсва или празен releasePath): $FRONTEND_STATE_FILE. Нужен е initial state bootstrap."

BACKEND_SHA="$(read_state_field "$BACKEND_STATE_FILE" gitSha)" \
  || fail "Backend deployment state marker е невалиден/непълен (липсва или празен gitSha): $BACKEND_STATE_FILE. Нужен е initial state bootstrap. Не гадая SHA."
BACKEND_PID="$(read_state_field "$BACKEND_STATE_FILE" pm2Pid || echo '')"

log "Frontend marker: gitSha=$FRONTEND_SHA releasePath=$FRONTEND_RELEASE_PATH"
log "Backend marker:  gitSha=$BACKEND_SHA pm2Pid=${BACKEND_PID:-'(липсва)'}"

# ─── 2. Валидирай frontend state ────────────────────────────────────────────
section "Validating frontend state"

git cat-file -e "${FRONTEND_SHA}^{commit}" 2>/dev/null \
  || fail "Frontend marker gitSha ($FRONTEND_SHA) не е валиден commit в този repo. Marker-ът изглежда повреден/от друг repo. Нужен е initial state bootstrap."
log "Frontend marker gitSha е валиден commit: OK"

[ -e "$FRONTEND_RELEASE_PATH" ] || fail "Frontend marker releasePath ($FRONTEND_RELEASE_PATH) не съществува на диска — drift между marker и реалност. STOP."

if [ ! -L "$CURRENT_LINK" ]; then
  fail "$CURRENT_LINK не е symlink (или липсва) — не мога да валидирам frontend state срещу реалния current release. STOP."
fi
CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo '')"
FRONTEND_RELEASE_RESOLVED="$(readlink -f "$FRONTEND_RELEASE_PATH" 2>/dev/null || echo '')"
if [ -z "$CURRENT_TARGET" ] || [ "$CURRENT_TARGET" != "$FRONTEND_RELEASE_RESOLVED" ]; then
  fail "Drift между frontend marker releasePath ($FRONTEND_RELEASE_PATH) и реалния current -> $CURRENT_TARGET. Marker-ът не отразява живото production състояние. STOP — нужна е ръчна проверка/state bootstrap, не автоматично предположение."
fi
log "Frontend state (gitSha + releasePath == readlink -f current): OK, без drift."

# ─── 3. Валидирай backend state ─────────────────────────────────────────────
section "Validating backend state"

git cat-file -e "${BACKEND_SHA}^{commit}" 2>/dev/null \
  || fail "Backend marker gitSha ($BACKEND_SHA) не е валиден commit в този repo. Marker-ът изглежда повреден/от друг repo. Нужен е initial state bootstrap."
log "Backend marker gitSha е валиден commit: OK"

# pm2Pid е ЧИСТО informational (виж §4 в task spec-а) — PID mismatch след
# crash/reboot на самия backend процес НЕ трябва сам по себе си да блокира
# deploy-а. Не правим никаква live PM2 проверка тук — backend worker-ът
# вече прочита реалния текущ PID в собствения си preflight.
if [ -n "$BACKEND_PID" ]; then
  log "Backend marker pm2Pid ($BACKEND_PID): informational, не се верифицира тук."
else
  log "Backend marker pm2Pid: липсва в marker-а — informational поле, не блокира."
fi

# ─── 4. Определи delta (независимо за всеки marker) + classification ───────
section "Computing delta"

# Ancestry validation И git diff extraction се изпълняват TOP-LEVEL (никога
# вътре в process substitution `< <(...)`) — `fail()` вътре в `< <(...)`
# subshell само убива subshell-а, mapfile получава каквото е успяло да
# изпише преди exit-а (обикновено празно), и главният скрипт ПРОДЪЛЖАВА
# вместо реално да STOP-не. Затова: (1) ancestry check директно в main
# shell-а, `fail()` тук реално прекратява скрипта; (2) `git diff` изходът
# се capture-ва в променлива с `if ! output=$(...)`, отделно от array
# conversion-а, за да можем да проверим exit кода на самата git команда
# ПРЕДИ да продължим — не само дали изходът е празен.
require_ancestor() {
  local from_sha="$1" label="$2"
  [ "$from_sha" = "$TARGET_SHA" ] && return 0
  if ! git merge-base --is-ancestor "$from_sha" "$TARGET_SHA" 2>/dev/null; then
    fail "$label marker SHA ($from_sha) НЕ Е ancestor на target ($TARGET_SHA) — history diverge, не мога безопасно да определя delta. STOP. (Възможни причини: force-push, ръчен reset, счупен marker.)"
  fi
}

fetch_changed_files_output() {
  local from_sha="$1"
  if [ "$from_sha" = "$TARGET_SHA" ]; then
    printf ''
    return 0
  fi
  git diff --name-only "$from_sha" "$TARGET_SHA"
}

require_ancestor "$FRONTEND_SHA" "Frontend"
if ! FRONTEND_DELTA_OUTPUT="$(fetch_changed_files_output "$FRONTEND_SHA")"; then
  fail "git diff --name-only се провали за frontend marker ($FRONTEND_SHA -> $TARGET_SHA) — STOP, не продължавам с непълна/невалидна delta."
fi

require_ancestor "$BACKEND_SHA" "Backend"
if ! BACKEND_DELTA_OUTPUT="$(fetch_changed_files_output "$BACKEND_SHA")"; then
  fail "git diff --name-only се провали за backend marker ($BACKEND_SHA -> $TARGET_SHA) — STOP, не продължавам с непълна/невалидна delta."
fi

mapfile -t FRONTEND_DELTA_FILES < <(printf '%s' "$FRONTEND_DELTA_OUTPUT")
mapfile -t BACKEND_DELTA_FILES < <(printf '%s' "$BACKEND_DELTA_OUTPUT")

# Обединен, дедуплициран списък от промени спрямо ДВАТА marker-а — всеки
# файл се класифицира ЕДНОКРАТНО, resultатите се прилагат към съответната
# delta принадлежност по-долу.
mapfile -t ALL_CHANGED_FILES < <(
  { printf '%s\n' "${FRONTEND_DELTA_FILES[@]}" "${BACKEND_DELTA_FILES[@]}"; } \
    | grep -v '^$' | sort -u
)

FRONTEND_IMPACT=0
BACKEND_IMPACT=0
HAS_MIGRATIONS=0
declare -a UNCLASSIFIED_FILES=()
declare -a MIGRATION_FILES=()
declare -a FRONTEND_IMPACT_FILES=()
declare -a BACKEND_IMPACT_FILES=()
declare -a NON_RUNTIME_FILES=()

# "migration" category тук се използва САМО за unclassified-guard-а по-долу
# (всеки .sql под migrations/ трябва да е разпознаваем path) — реалният
# MIGRATION_FILES/HAS_MIGRATIONS източник е ИЗКЛЮЧИТЕЛНО §Migration safety
# блокът по-долу (BACKEND_SHA -> TARGET_SHA, git diff --name-status), не
# union-ът с frontend delta-та.
for f in "${ALL_CHANGED_FILES[@]}"; do
  [ -z "$f" ] && continue
  category="$(classify_path "$f")"
  case "$category" in
    frontend) FRONTEND_IMPACT_FILES+=("$f") ;;
    backend) BACKEND_IMPACT_FILES+=("$f") ;;
    migration) : ;;
    non-runtime) NON_RUNTIME_FILES+=("$f") ;;
    unclassified) UNCLASSIFIED_FILES+=("$f") ;;
  esac
done

if [ "${#UNCLASSIFIED_FILES[@]}" -gt 0 ]; then
  log "Неразпознати (unclassified) променени файлове:"
  for f in "${UNCLASSIFIED_FILES[@]}"; do
    log "  - $f"
  done
  fail "${#UNCLASSIFIED_FILES[@]} променен(и) файл(ове) не съвпадат с нито една позната runtime-impact категория (виж списъка по-горе). Не предполагам безопасност — STOP. Ако тези файлове реално не влияят на runtime build-овете, разшири classify_path() explicit, вместо да пропускаш проверката."
fi

# ─── Migration safety (СТРИКТНО BACKEND_SHA -> TARGET_SHA, не union) ───────
# Migration анализът е НАРОЧНО изолиран от общата frontend/backend union
# delta по-горе — migrations са backend-specific concept, и трябва да
# отразяват точно каквото backend worker-ът реално ще приложи при своя
# следващ restart (той пък сравнява target срещу текущата DB ledger, не
# срещу frontend marker-а). git diff --name-status (не --name-only) е
# нужен, за да различим "нов .sql файл" (A) от "промяна/трие/rename на
# СЪЩЕСТВУВАЩ historical migration" (M/D/R/C) — второто е забранено (виж
# коментара на fail() по-долу): вече-приложена migration НИКОГА не бива да
# се редактира/трие/премества автоматично, само нови файлове са валиден
# forward-миграция flow.
section "Migration safety check (backend marker -> target)"

# Top-level capture (не process substitution) — `git diff --name-status`
# failure (напр. невалиден SHA, corrupt object) трябва реално да STOP-не
# скрипта. Никакъв `|| true` тук: `grep -v '^$'` връща non-zero, само ако
# НЕ намери нито един match (изцяло празен git diff изход — легитимен "няма
# промени" случай, не грешка), докато самата `git diff` команда се проверява
# ОТДЕЛНО, ПРЕДИ да мине през grep.
declare -a MIGRATION_NAME_STATUS=()
if [ "$BACKEND_SHA" != "$TARGET_SHA" ]; then
  if ! MIGRATION_DIFF_RAW="$(git diff --name-status "$BACKEND_SHA" "$TARGET_SHA" -- "server/database/migrations/")"; then
    fail "git diff --name-status се провали за backend marker ($BACKEND_SHA -> $TARGET_SHA) на server/database/migrations/ — STOP, не мога безопасно да определя migration delta-та."
  fi
  MIGRATION_DIFF_FILTERED="$(printf '%s' "$MIGRATION_DIFF_RAW" | grep -v '^$' || true)"
  mapfile -t MIGRATION_NAME_STATUS < <(printf '%s' "$MIGRATION_DIFF_FILTERED")
fi

for entry in "${MIGRATION_NAME_STATUS[@]}"; do
  [ -z "$entry" ] && continue
  status_code="${entry%%$'\t'*}"
  rest="${entry#*$'\t'}"
  case "$status_code" in
    A)
      # Нов migration файл — единственият приет случай.
      case "$rest" in
        *.sql) MIGRATION_FILES+=("$rest"); HAS_MIGRATIONS=1 ;;
        *) UNCLASSIFIED_FILES+=("$rest") ;;
      esac
      ;;
    M|D|R*|C*)
      # Промяна/изтриване/rename/copy на СЪЩЕСТВУВАЩ historical migration
      # файл — никога не се приема автоматично. Rename/copy status кодовете
      # от git идват като "R100 old\tnew" / "C100 old\tnew" (score suffix),
      # затова R*/C* patterns тук, не голи R/C.
      log "Забранена промяна на historical migration: [$status_code] $rest"
      fail "Migration safety: [$status_code] $rest — редакция/изтриване/rename/copy на СЪЩЕСТВУВАЩ migration файл между backend marker и target. Не се допуска автоматично. Разследвай ръчно (git log -- server/database/migrations/) преди какъвто и да е deploy."
      ;;
    *)
      fail "Migration safety: непознат git status код \"$status_code\" за $rest — STOP вместо предположение."
      ;;
  esac
done

if [ "$HAS_MIGRATIONS" -eq 1 ]; then
  log "Нови migration файлове (backend marker -> target): ${#MIGRATION_FILES[@]}"
  for f in "${MIGRATION_FILES[@]}"; do log "  - $f"; done
else
  log "Няма нови migration файлове между backend marker и target."
fi

# Определяме кой FRONTEND/BACKEND delta списък реално да покажем в PLAN-а —
# файловете от FRONTEND_DELTA_FILES/BACKEND_DELTA_FILES (спрямо СЪОТВЕТНИЯ
# marker), класифицирани по-горе, но пазим отделно fронтенд-specific и
# backend-specific списъци за яснота на PLAN-а.
declare -a FRONTEND_RELEVANT=()
for f in "${FRONTEND_DELTA_FILES[@]}"; do
  [ -z "$f" ] && continue
  cat="$(classify_path "$f")"
  [ "$cat" = "frontend" ] && FRONTEND_RELEVANT+=("$f")
done

declare -a BACKEND_CODE_RELEVANT=()
for f in "${BACKEND_DELTA_FILES[@]}"; do
  [ -z "$f" ] && continue
  cat="$(classify_path "$f")"
  [ "$cat" = "backend" ] && BACKEND_CODE_RELEVANT+=("$f")
done

[ "${#FRONTEND_RELEVANT[@]}" -gt 0 ] && FRONTEND_IMPACT=1
# Backend impact = backend code промени (backend marker -> target) ИЛИ нови
# migration файлове (dedicated §Migration safety анализ по-горе) — двете са
# независими backend-relevant източници, но и двете произвеждат "backend
# трябва да се deploy-не".
{ [ "${#BACKEND_CODE_RELEVANT[@]}" -gt 0 ] || [ "$HAS_MIGRATIONS" -eq 1 ]; } && BACKEND_IMPACT=1

# ─── 5. Решение ──────────────────────────────────────────────────────────────
if [ "$FRONTEND_IMPACT" -eq 1 ] && [ "$BACKEND_IMPACT" -eq 1 ]; then
  DECISION="FULL"
elif [ "$FRONTEND_IMPACT" -eq 1 ]; then
  DECISION="FRONTEND ONLY"
elif [ "$BACKEND_IMPACT" -eq 1 ]; then
  DECISION="BACKEND ONLY"
else
  DECISION="NO RUNTIME DEPLOY"
fi

# ─── 6. PLAN ──────────────────────────────────────────────────────────────────
section "PLAN"

log "Target SHA:              $TARGET_SHA ($TARGET_SHORT_SHA)"
log "Frontend deployed SHA:   $FRONTEND_SHA"
log "Backend deployed SHA:    $BACKEND_SHA"
log ""
if [ "${#FRONTEND_RELEVANT[@]}" -gt 0 ]; then
  log "Frontend-impact файлове (frontend marker -> target):"
  for f in "${FRONTEND_RELEVANT[@]}"; do log "  - $f"; done
else
  log "Frontend-impact файлове (frontend marker -> target): няма"
fi
log ""
if [ "${#BACKEND_CODE_RELEVANT[@]}" -gt 0 ]; then
  log "Backend code-impact файлове (backend marker -> target):"
  for f in "${BACKEND_CODE_RELEVANT[@]}"; do log "  - $f"; done
else
  log "Backend code-impact файлове (backend marker -> target): няма"
fi
log ""
if [ "${#NON_RUNTIME_FILES[@]}" -gt 0 ]; then
  log "Non-runtime промени (docs/tooling, не влияят на build): ${#NON_RUNTIME_FILES[@]} файл(а)"
fi
log ""
log "Migration файлове в delta-та: $([ "$HAS_MIGRATIONS" -eq 1 ] && echo "ДА (${#MIGRATION_FILES[@]})" || echo "не")"
if [ "$HAS_MIGRATIONS" -eq 1 ]; then
  for f in "${MIGRATION_FILES[@]}"; do log "  - $f"; done
fi
log ""
log "РЕШЕНИЕ: $DECISION"

# ─── 7+8. Изпълнение ──────────────────────────────────────────────────────────

assert_target_immutable() {
  # Извиква се НЕПОСРЕДСТВЕНО преди всеки worker call — гарантира, че не
  # deploy-ваме различен HEAD от този, за който PLAN-ът беше изчислен
  # (между PLAN и изпълнение може да мине време: оператор чете PLAN-а,
  # migration/RESTART confirmation prompts чакат вход и т.н.).
  local current_head
  current_head="$(git rev-parse HEAD)"
  if [ "$current_head" != "$TARGET_SHA" ]; then
    fail "Target immutability: HEAD се е променил от изчисляването на PLAN-а (беше $TARGET_SHA, сега $current_head) — STOP преди worker. Никой не бива да пипа repo-то, докато deploy-production.sh тече."
  fi
  local current_status
  current_status="$(git status --porcelain)"
  if [ -n "$current_status" ]; then
    fail "Target immutability: working tree вече не е clean преди worker call:
$current_status"
  fi
}

verify_marker_matches_target() {
  local state_file="$1" label="$2"
  local sha_after
  sha_after="$(read_state_field "$state_file" gitSha)" \
    || fail "STATE ERROR: не успях да прочета $state_file след успешен $label worker — marker-ът изглежда невалиден веднага след запис."
  if [ "$sha_after" != "$TARGET_SHA" ]; then
    fail "STATE ERROR: $label marker gitSha след deploy ($sha_after) != target ($TARGET_SHA). Worker-ът приключи успешно, но state marker-ът не отразява очаквания target. Ръчна проверка нужна незабавно."
  fi
  log "$label marker потвърден: gitSha == target ($TARGET_SHA)."
}

require_migrate_confirmation() {
  section "Migration confirmation required"
  printf '\n'
  printf 'MIGRATIONS DETECTED IN DELTA\n'
  printf 'The following migration file(s) will be applied by the backend worker:\n'
  for f in "${MIGRATION_FILES[@]}"; do
    printf '  - %s\n' "$f"
  done
  printf '\n'
  printf 'Type exactly MIGRATE to proceed with the backend worker, anything else (or empty) STOPs.\n'
  printf 'NOTE: the backend worker itself keeps its OWN separate RESTART confirmation after this.\n'
  printf '> '
  local confirmation
  read -r confirmation || confirmation=""
  if [ "$confirmation" != "MIGRATE" ]; then
    fail "Migration confirmation не е получено (получих: \"$confirmation\"). Нищо не е изпълнено."
  fi
  log "Migration confirmation получено от оператор (MIGRATE)."
}

case "$DECISION" in
  "NO RUNTIME DEPLOY")
    section "No runtime deploy"
    log "Delta-та между двата marker-а и target съдържа само non-runtime промени (docs/tooling/config, виж PLAN по-горе)."
    log "Нито един worker няма да бъде извикан."
    log "DEPLOY-PRODUCTION: NOTHING TO DO."
    ;;

  "FRONTEND ONLY")
    section "Executing: FRONTEND ONLY"
    assert_target_immutable
    log "bash $FRONTEND_WORKER"
    bash "$FRONTEND_WORKER"
    verify_marker_matches_target "$FRONTEND_STATE_FILE" "Frontend"
    log "DEPLOY-PRODUCTION SUCCESS (frontend only)."
    ;;

  "BACKEND ONLY")
    section "Executing: BACKEND ONLY"
    [ "$HAS_MIGRATIONS" -eq 1 ] && require_migrate_confirmation
    assert_target_immutable
    log "bash $BACKEND_WORKER"
    bash "$BACKEND_WORKER"
    verify_marker_matches_target "$BACKEND_STATE_FILE" "Backend"
    log "DEPLOY-PRODUCTION SUCCESS (backend only)."
    ;;

  "FULL")
    section "Executing: FULL (backend first, frontend only if backend succeeds)"
    [ "$HAS_MIGRATIONS" -eq 1 ] && require_migrate_confirmation
    assert_target_immutable
    log "bash $BACKEND_WORKER"
    if ! bash "$BACKEND_WORKER"; then
      fail "Backend worker се провали — frontend worker НЕ се стартира. Виж backend worker изхода по-горе за детайли/rollback инструкции."
    fi
    verify_marker_matches_target "$BACKEND_STATE_FILE" "Backend"

    log "Backend worker успешен — продължавам с frontend worker."
    assert_target_immutable
    log "bash $FRONTEND_WORKER"
    bash "$FRONTEND_WORKER"
    verify_marker_matches_target "$FRONTEND_STATE_FILE" "Frontend"
    log "DEPLOY-PRODUCTION SUCCESS (full: backend + frontend)."
    ;;
esac
