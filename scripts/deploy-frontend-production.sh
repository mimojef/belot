#!/usr/bin/env bash
#
# deploy-frontend-production.sh — permanent production frontend deploy script.
#
# Употреба (НА production сървъра, от production repo checkout-а):
#   cd /var/www/belot-v2
#   bash scripts/deploy-frontend-production.sh
#
# Предотвратява повторение на инцидента от 19.08.2026: release-ът беше
# правилен, но новите hashed JS/CSS assets НЕ бяха копирани в споделената
# /var/www/belot-v2/assets/ директория преди atomic switch на "current".
# Новият index.html поиска /assets/index-B4smC0TV.js, nginx (regex location
# за hashed файлове -> alias /var/www/belot-v2/assets/$1) върна 404, което
# задейства recoveryReload loop и зелен екран при живи потребители.
#
# Този скрипт публикува hashed assets в споделения pool и верифицира и
# локално (checksum), и през реален публичен HTTP (nginx) ПРЕДИ да превключи
# "current" — провал на която и да е проверка спира скрипта БЕЗ switch.
#
# Обхват: САМО frontend release publish + atomic switch.
#   НЕ рестартира PM2, НЕ рестартира backend, НЕ прави DB migrations, НЕ
#   пипа DB, НЕ прави nginx reload/restart. Не чисти стари releases/assets.
#
# Изисква: git, npm, node, sha256sum (или shasum), curl. Изпълнява се от
# /var/www/belot-v2 (production repo checkout == production deploy root).

set -euo pipefail

# ─── Конфигурация ───────────────────────────────────────────────────────────
PROJECT_ROOT="/var/www/belot-v2"
RELEASES_DIR="$PROJECT_ROOT/releases"
SHARED_ASSETS_DIR="$PROJECT_ROOT/assets"
CURRENT_LINK="$PROJECT_ROOT/current"
PUBLIC_BASE_URL="https://www.pika.bg"
# Извън Git working tree — single-writer lock, не е repo артефакт.
LOCK_FILE="/var/lock/belot-v2-frontend-production.lock"
# Persistent deployment state за бъдещия smart controller
# (scripts/deploy-production.sh — все още несъздаден). Извън Git working
# tree и извън /var/www/belot-v2 изцяло — не е repo артефакт, не се пипа
# от build/release/switch логиката по-горе. Marker-ът се пише САМО след
# успешен switch + всички post-switch checks (виж края на файла) — никога
# предварително, никога при частичен/неуспешен deploy.
DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"
FRONTEND_STATE_FILE="$DEPLOY_STATE_DIR/frontend.json"

log() { printf '[deploy-frontend] %s\n' "$1"; }
fail() { printf '[deploy-frontend] STOP: %s\n' "$1" >&2; exit 1; }

section() {
  printf '\n[deploy-frontend] ── %s ──\n' "$1"
}

# ─── Own-temp-file cleanup (shared hashed asset publish) ───────────────────
# Пази пътя на ЕДИНСТВЕНИЯ temp файл, който ТОЗИ процес в момента е
# създал за atomic hashed-asset publish (виж стъпка 3 по-долу). Trap-ът
# чисти САМО него — никога current, releases/ или финални shared assets, и
# никога temp файлове от друг (успешно приключил или все още активен) run.
ACTIVE_TMP_ASSET=""
cleanup() {
  if [ -n "$ACTIVE_TMP_ASSET" ] && [ -f "$ACTIVE_TMP_ASSET" ]; then
    rm -f -- "$ACTIVE_TMP_ASSET"
  fi
}
# EXIT trap винаги чисти (нормален край, fail(), или explicit exit по-долу).
# INT/TERM имат СОБСТВЕНИ traps, които веднага exit-ват със стандартния
# 128+signal код (130/143) — без тях bash би изпълнил cleanup() като INT/TERM
# handler и после ПРОДЪЛЖИЛ скрипта (default поведение при trap на сигнал
# без exit вътре), вместо реално да прекрати изпълнението. exit тук
# гарантирано тригерва EXIT trap-а точно веднъж, значи cleanup не се вика
# двойно.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Hashed Vite/Rollup output filename pattern — трябва да съвпада с nginx
# regex location-а: ^/assets/(.+-[0-9A-Za-z_-]{8,10}\.(?:js|mjs|css))$
is_hashed_asset() {
  [[ "$1" =~ -[0-9A-Za-z_-]{8,10}\.(js|mjs|css)$ ]]
}

# Използва вече избрания $CHECKSUM_TOOL (виж Pre-flight checks по-долу) —
# НЕ прави тук fallback detection и НЕ вика fail(). Тази функция винаги се
# извиква през command substitution ($(sha256_of ...)) — exit вътре в
# command substitution subshell спира само subshell-а, не родителския
# скрипт, значи safety fail тук би бил тих no-op, а не реален STOP.
# Затова липсата на checksum tool се проверява ЕДНОКРАТНО, top-level, преди
# build/deploy изобщо да започнат.
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

# ─── 0. Pre-flight: repo/tree/prerequisites checks ─────────────────────────
section "Pre-flight checks"

[ -d "$PROJECT_ROOT/.git" ] || fail "Не съм в production repo — $PROJECT_ROOT/.git липсва."
cd "$PROJECT_ROOT"

CURRENT_DIR="$(pwd -P)"
[ "$CURRENT_DIR" = "$PROJECT_ROOT" ] || fail "Работна директория ($CURRENT_DIR) не съвпада с очаквания production repo ($PROJECT_ROOT)."
log "Repo: $PROJECT_ROOT (OK)"

command -v git >/dev/null 2>&1 || fail "git не е намерен в PATH."
command -v npm >/dev/null 2>&1 || fail "npm не е намерен в PATH."
command -v node >/dev/null 2>&1 || fail "node не е намерен в PATH."
command -v curl >/dev/null 2>&1 || fail "curl не е намерен в PATH (нужен за public HTTP verification)."
command -v flock >/dev/null 2>&1 || fail "flock не е намерен в PATH (нужен за single-writer concurrency lock)."

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM_TOOL="shasum"
else
  fail "нито sha256sum, нито shasum е наличен в PATH — не мога да verify-на checksum-и."
fi
log "Prerequisites (git, npm, node, curl, flock, $CHECKSUM_TOOL): OK"

# ─── Concurrency lock ───────────────────────────────────────────────────────
# Exclusive non-blocking lock на отделен fd (200), държан извън repo-то.
# Освобождава се автоматично при exit (нормален или fail()) — затварянето на
# fd 200, когато процесът приключи, автоматично maka flock unlock, без нужда
# от explicit trap/rm. Ако друг deploy вече държи lock-а, спираме веднага,
# ПРЕДИ build/release/publish да са пипнали каквото и да е.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  fail "Друг deploy процес вече държи lock-а ($LOCK_FILE) — паралелен frontend deploy не е позволен. Изчакай другия да приключи."
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

[ -d "$RELEASES_DIR" ] || fail "releases/ директорията липсва: $RELEASES_DIR"
[ -d "$SHARED_ASSETS_DIR" ] || fail "assets/ директорията липсва: $SHARED_ASSETS_DIR"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  fail "$CURRENT_LINK съществува, но НЕ е symlink — очаквана е Capistrano-style structure (current -> releases/<id>)."
fi
if [ -e "$CURRENT_LINK.new" ] && [ ! -L "$CURRENT_LINK.new" ]; then
  fail "$CURRENT_LINK.new съществува, но НЕ е symlink — отказвам atomic switch."
fi

OLD_RELEASE=""
if [ -L "$CURRENT_LINK" ]; then
  OLD_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo '')"
  [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ] || fail "current symlink сочи към невалидна/несъществуваща директория: $OLD_RELEASE"
  log "Текущ (стар) release: $OLD_RELEASE"
else
  log "ПРЕДУПРЕЖДЕНИЕ: current symlink не съществува все още (изглежда като първи deploy)."
fi

# ─── Deployment state directory preflight ───────────────────────────────────
# Проверява ПРЕДИ build/release/switch, че DEPLOY_STATE_DIR реално позволява
# create + atomic rename + delete на temp файл — точно операциите, нужни за
# marker write-а накрая (виж "Persistent deployment state" по-долу). Никога
# не създава frontend.json тук — само собствен preflight-специфичен temp
# файл, изтрит веднага след теста. Ако тук се провали, спираме ПРЕДИ deploy
# да е започнал, вместо да открием проблема чак след успешен switch.
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
log "Deployment state директория ($DEPLOY_STATE_DIR): create + rename + delete OK (frontend.json НЕ е пипнат)."

# ─── 1. Build ────────────────────────────────────────────────────────────────
section "Build"

log "npm run build (tsc + vite build)..."
npm run build
log "Build статус: OK"

DIST_DIR="$PROJECT_ROOT/dist"
[ -d "$DIST_DIR" ] || fail "dist/ директорията липсва след build: $DIST_DIR"
[ -f "$DIST_DIR/index.html" ] || fail "index.html липсва в dist/ след build."
[ -d "$DIST_DIR/assets" ] || fail "dist/assets/ липсва след build."
[ -n "$(ls -A "$DIST_DIR/assets" 2>/dev/null)" ] || fail "dist/assets/ е празна след build."

# ─── 1b. Post-build git immutability check ─────────────────────────────────
# npm run build отнема време — гарантираме, че HEAD и working tree НЕ са се
# променили междувременно (напр. паралелен ръчен git push/checkout извън
# lock-а), преди RELEASE_ID/release-ът да се обвържат с $GIT_SHA. Ако тук се
# провали, dist/ вече е build-нат, но release/publish/switch НЕ се случват.
POST_BUILD_GIT_SHA="$(git rev-parse HEAD)"
[ "$POST_BUILD_GIT_SHA" = "$GIT_SHA" ] || fail "HEAD се е променил по време на build (беше $GIT_SHA, сега $POST_BUILD_GIT_SHA) — release НЕ се създава за несъответстващ Git state."

POST_BUILD_GIT_STATUS="$(git status --porcelain)"
if [ -n "$POST_BUILD_GIT_STATUS" ]; then
  fail "Working tree вече не е clean след build:
$POST_BUILD_GIT_STATUS"
fi
log "Post-build git immutability check: OK (HEAD непроменен, working tree clean)"

# ─── 2. Нов release: копирай целия dist/ (без rsync — cp -a) ────────────────
section "Create release"

RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-${GIT_SHORT_SHA}"
NEW_RELEASE="$RELEASES_DIR/$RELEASE_ID"
[ ! -e "$NEW_RELEASE" ] || fail "Release директорията вече съществува: $NEW_RELEASE"

log "Нов release: $NEW_RELEASE"
mkdir -p "$NEW_RELEASE"
cp -a "$DIST_DIR"/. "$NEW_RELEASE"/
log "dist/ копиран в release-а (cp -a): OK"

[ -f "$NEW_RELEASE/index.html" ] || fail "index.html липсва в новия release след копиране."

# ─── 3. Публикувай hashed JS/CSS в споделения assets/ pool, ПРЕДИ switch ────
section "Publish shared hashed assets"

HASHED_PUBLISHED=0
HASHED_ALREADY_PRESENT_SAME=0
declare -a PUBLISHED_HASHED_FILES=()

while IFS= read -r -d '' file; do
  base="$(basename "$file")"
  is_hashed_asset "$base" || continue

  dest="$SHARED_ASSETS_DIR/$base"
  PUBLISHED_HASHED_FILES+=("$base")

  if [ -e "$dest" ]; then
    src_sum="$(sha256_of "$file")"
    dest_sum="$(sha256_of "$dest")"
    if [ "$src_sum" = "$dest_sum" ]; then
      HASHED_ALREADY_PRESENT_SAME=$((HASHED_ALREADY_PRESENT_SAME + 1))
      log "  съвпада (checksum еднакъв, пропускам copy): $base"
    else
      fail "Hashed asset $base вече съществува в $SHARED_ASSETS_DIR с РАЗЛИЧЕН checksum (src=$src_sum dest=$dest_sum). Immutable asset conflict — не презаписвам. Разследвай ръчно преди повторен опит."
    fi
  else
    # Atomic NO-OVERWRITE publish: copy към уникален temp В СЪЩАТА
    # директория, verify checksum, после `ln` (hard link) към финалното
    # hashed име. `ln` създава финалния path АТОМАРНО и се проваля, ако
    # той вече съществува — за разлика от `mv -f`/`cp -f`, никога не
    # презаписва вече наличен immutable asset, дори ако друг процес/ръчна
    # операция е създала $dest точно между [ -e "$dest" ] по-горе и този
    # момент (TOCTOU race — виж обяснението накрая на файла/отчета).
    tmp_dest="$SHARED_ASSETS_DIR/.tmp.$base.$$.$RANDOM"
    rm -f "$tmp_dest"
    ACTIVE_TMP_ASSET="$tmp_dest"
    cp "$file" "$tmp_dest"
    tmp_sum="$(sha256_of "$tmp_dest")"
    src_sum="$(sha256_of "$file")"
    if [ "$tmp_sum" != "$src_sum" ]; then
      rm -f "$tmp_dest"
      ACTIVE_TMP_ASSET=""
      fail "Checksum mismatch веднага след copy към temp файл: $base (source=$src_sum temp=$tmp_sum). Публикуването е прекратено, temp файлът е изтрит."
    fi

    LN_ERROR=""
    if LN_ERROR="$(ln "$tmp_dest" "$dest" 2>&1)"; then
      # ln успя -> ние сме единственият автор на $dest, temp вече не е нужен.
      rm -f "$tmp_dest"
      ACTIVE_TMP_ASSET=""
      HASHED_PUBLISHED=$((HASHED_PUBLISHED + 1))
      log "  публикуван (atomic no-overwrite, checksum-verified): $base"
    elif [ -e "$dest" ]; then
      # ln се провали И $dest реално съществува -> вероятен race (друг
      # процес го е създал между първоначалния [ -e "$dest" ] guard и
      # тук). НЕ презаписваме — само checksum-базирано accept/STOP.
      race_dest_sum="$(sha256_of "$dest")"
      rm -f "$tmp_dest"
      ACTIVE_TMP_ASSET=""
      if [ "$race_dest_sum" = "$src_sum" ]; then
        HASHED_ALREADY_PRESENT_SAME=$((HASHED_ALREADY_PRESENT_SAME + 1))
        log "  race: $base вече публикуван от друг процес междувременно, checksum съвпада — приемам като OK."
      else
        fail "Race condition при публикуване на $base: друг процес го е създал междувременно в $SHARED_ASSETS_DIR с РАЗЛИЧЕН checksum (source=$src_sum dest=$race_dest_sum). Immutable asset conflict — не презаписвам."
      fi
    else
      # ln се провали, НО $dest не съществува -> НЕ е race (файлова
      # система/permissions проблем и т.н.). Не гадаем причината — просто
      # STOP с реалната ln грешка за диагностика, без overwrite опит.
      rm -f "$tmp_dest"
      ACTIVE_TMP_ASSET=""
      fail "Atomic hard-link publish failed за $base, destination не е създаден; investigate filesystem/permissions. ln грешка: $LN_ERROR"
    fi
  fi
done < <(find "$NEW_RELEASE/assets" -maxdepth 1 -type f -print0)

log "Shared asset publish статус: $HASHED_PUBLISHED нови, $HASHED_ALREADY_PRESENT_SAME вече налични (checksum match), 0 конфликта."

# ─── 4. Verify checksum source <-> shared destination за всеки публикуван файл ──
section "Pre-switch checks: checksum verification"

for base in "${PUBLISHED_HASHED_FILES[@]}"; do
  src="$NEW_RELEASE/assets/$base"
  dest="$SHARED_ASSETS_DIR/$base"
  [ -e "$dest" ] || fail "Post-publish: $dest липсва (очаквах да е публикуван на предната стъпка)."
  src_sum="$(sha256_of "$src")"
  dest_sum="$(sha256_of "$dest")"
  [ "$src_sum" = "$dest_sum" ] || fail "Checksum mismatch след publish: $base (release=$src_sum shared=$dest_sum)."
done
log "Checksum verification (release assets/ <-> shared assets/): OK за ${#PUBLISHED_HASHED_FILES[@]} hashed файла."

# ─── 5. Verify всички hashed JS/CSS, реферирани от новия index.html, съществуват ──
section "Pre-switch checks: index.html reference closure"

mapfile -t ENTRY_ASSETS < <(grep -oE 'assets/[A-Za-z0-9._-]+-[0-9A-Za-z_-]{8,10}\.(js|mjs|css)' "$NEW_RELEASE/index.html" | sort -u)
[ "${#ENTRY_ASSETS[@]}" -gt 0 ] || fail "Новият index.html не реферира нито един hashed JS/MJS/CSS entry файл — вероятно счупен build."

for entry in "${ENTRY_ASSETS[@]}"; do
  base="$(basename "$entry")"
  is_hashed_asset "$base" || continue
  dest="$SHARED_ASSETS_DIR/$base"
  [ -f "$dest" ] || fail "index.html реферира $entry, но $dest липсва от shared assets pool-а. Switch спрян."
  log "  референциран и наличен в shared assets: $base"
done
log "index.html reference closure: OK — всички hashed entry файлове са в shared assets pool-а."

# ─── 6. Public HTTP pre-switch check (реален nginx, cache-busting) ──────────
section "Pre-switch checks: public HTTP verification"

for entry in "${ENTRY_ASSETS[@]}"; do
  url="${PUBLIC_BASE_URL%/}/${entry}?$(cache_bust_query)"
  code="$(http_status_for "$url")"
  log "  GET $url -> $code"
  if [ "$code" != "200" ]; then
    fail "Public HTTP pre-switch проверка неуспешна: $entry връща HTTP $code (очаквах 200) през $url. current НЕ е превключен. Старият release ($OLD_RELEASE) остава активен без промяна."
  fi
done
log "Pre-switch checks: build OK, shared asset publish OK, checksum OK, reference closure OK, public HTTP OK."

# ─── 7. Atomic switch ────────────────────────────────────────────────────────
section "Atomic switch"

log "OLD_RELEASE: ${OLD_RELEASE:-'(none — first deploy)'}"
log "NEW_RELEASE: $NEW_RELEASE"

ln -sfn "$NEW_RELEASE" "$CURRENT_LINK.new"
mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"

SWITCHED_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo '')"
if [ "$SWITCHED_TARGET" != "$NEW_RELEASE" ]; then
  fail "Switch verification неуспешна: readlink -f current ($SWITCHED_TARGET) != $NEW_RELEASE. РЪЧНА проверка е нужна незабавно."
fi
log "Switch резултат: OK — current -> $RELEASE_ID (readlink -f потвърден)"

# ─── 8. Post-switch checks ──────────────────────────────────────────────────
section "Post-deploy checks"

# Shell-safe quoting (printf %q) — за принтиране/ръчно копиране, никога
# автоматично изпълнявана.
QUOTED_OLD_RELEASE="$(printf '%q' "$OLD_RELEASE")"
QUOTED_CURRENT_NEW="$(printf '%q' "$CURRENT_LINK.new")"
QUOTED_CURRENT_LINK="$(printf '%q' "$CURRENT_LINK")"
ROLLBACK_CMD="ln -sfn $QUOTED_OLD_RELEASE $QUOTED_CURRENT_NEW && mv -Tf $QUOTED_CURRENT_NEW $QUOTED_CURRENT_LINK"

post_switch_fail() {
  printf '[deploy-frontend] STOP (post-switch): %s\n' "$1" >&2
  printf '[deploy-frontend] current вече сочи към НОВИЯ release (switch не е автоматично отменен).\n' >&2
  printf '[deploy-frontend] Стар release (rollback point): %s\n' "$OLD_RELEASE" >&2
  if [ -n "$OLD_RELEASE" ]; then
    printf '[deploy-frontend] Ръчна rollback команда:\n  %s\n' "$ROLLBACK_CMD" >&2
  else
    printf '[deploy-frontend] Няма стар release за rollback (първи deploy) — нужна е ръчна намеса.\n' >&2
  fi
  exit 1
}

ROOT_URL="${PUBLIC_BASE_URL%/}/?$(cache_bust_query)"
ROOT_CODE="$(http_status_for "$ROOT_URL")"
log "GET $ROOT_URL -> $ROOT_CODE"
[ "$ROOT_CODE" = "200" ] || post_switch_fail "Публичният / връща HTTP $ROOT_CODE вместо 200."

for entry in "${ENTRY_ASSETS[@]}"; do
  url="${PUBLIC_BASE_URL%/}/${entry}?$(cache_bust_query)"
  code="$(http_status_for "$url")"
  log "  GET $url -> $code"
  [ "$code" = "200" ] || post_switch_fail "Entry asset $entry връща HTTP $code вместо 200 след switch."
done
log "Public entry JS/CSS (post-switch): OK"

HEALTH_URL="${PUBLIC_BASE_URL%/}/health?$(cache_bust_query)"
HEALTH_CODE="$(http_status_for "$HEALTH_URL")"
log "GET $HEALTH_URL -> $HEALTH_CODE"
# Забележка: /health може да съдържа известния tournament ledger_mismatch
# advisory в тялото си — това НЕ е frontend deploy failure, докато HTTP
# статус кодът е 200. Тук проверяваме САМО статус кода, не тялото.
[ "$HEALTH_CODE" = "200" ] || post_switch_fail "/health връща HTTP $HEALTH_CODE вместо 200."
log "/health (post-switch, HTTP status само): OK"

log "Post-deploy checks: ВСИЧКИ минаха (/, entry JS/CSS, /health)."

# ─── 9. Persistent deployment state (само след успешен deploy) ─────────────
# Точката тук е ДОСТИГНАТА само след: успешен build, successful atomic
# switch (readlink -f потвърден), И всички post-switch HTTP checks (/,
# entry JS/CSS, /health) успешни по-горе. Marker-ът НЕ се пише по-рано —
# не гадаем/предполагаме успех, записваме факт.
section "Persistent deployment state"

DEPLOYED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$DEPLOY_STATE_DIR"

state_write_failed() {
  # Deploy-ът вече Е успешен (switch + post-checks минаха) — това е чисто
  # state-tracking failure, не deploy failure. Отчитаме го ясно като
  # отделен STOP клас (STATE ERROR), без да твърдим, че current/switch-ът
  # някак е невалиден. Best-effort премахваме съществуващ (стар/частичен)
  # marker — по-добре липсващ файл (smart controller-ът STOP-ва при липса),
  # отколкото стар marker, погрешно приет за актуален.
  printf '[deploy-frontend] STATE ERROR: %s\n' "$1" >&2
  printf '[deploy-frontend] deploy-ът самият е УСПЕШЕН — current вече сочи към %s.\n' "$RELEASE_ID" >&2
  if [ -e "$FRONTEND_STATE_FILE" ]; then
    if rm -f "$FRONTEND_STATE_FILE" 2>/dev/null; then
      printf '[deploy-frontend] Стар/частичен %s премахнат (best-effort) — няма да бъде погрешно приет за актуален.\n' "$FRONTEND_STATE_FILE" >&2
    else
      printf '[deploy-frontend] ПРЕДУПРЕЖДЕНИЕ: не успях да премахна стар/частичен %s — ръчно провери го преди да разчиташ на deployment state.\n' "$FRONTEND_STATE_FILE" >&2
    fi
  fi
  printf '[deploy-frontend] Ръчно провери/поправи %s преди следващия deploy, за да остане deployment state достоверен за бъдещия smart controller.\n' "$FRONTEND_STATE_FILE" >&2
  fail "Persistent deployment state запис се провали — виж STATE ERROR по-горе. Frontend deploy-ът остава успешен, но state marker-ът не е актуален."
}

FRONTEND_STATE_TMP="$FRONTEND_STATE_FILE.tmp.$$.$RANDOM"
ACTIVE_TMP_ASSET="$FRONTEND_STATE_TMP"
if ! cat > "$FRONTEND_STATE_TMP" <<EOF_STATE
{
  "gitSha": "$GIT_SHA",
  "deployedAtUtc": "$DEPLOYED_AT_UTC",
  "releasePath": "$NEW_RELEASE"
}
EOF_STATE
then
  ACTIVE_TMP_ASSET=""
  rm -f "$FRONTEND_STATE_TMP"
  state_write_failed "temp файл write се провали ($FRONTEND_STATE_TMP)."
fi

if [ ! -s "$FRONTEND_STATE_TMP" ]; then
  ACTIVE_TMP_ASSET=""
  rm -f "$FRONTEND_STATE_TMP"
  state_write_failed "temp файлът е празен след write ($FRONTEND_STATE_TMP) — вероятен диск/quota проблем."
fi

if ! mv -f "$FRONTEND_STATE_TMP" "$FRONTEND_STATE_FILE"; then
  ACTIVE_TMP_ASSET=""
  rm -f "$FRONTEND_STATE_TMP"
  state_write_failed "atomic rename се провали ($FRONTEND_STATE_TMP -> $FRONTEND_STATE_FILE)."
fi
ACTIVE_TMP_ASSET=""
log "Deployment state: OK — $FRONTEND_STATE_FILE (gitSha=$GIT_SHA, releasePath=$NEW_RELEASE)"

# ─── 10. Summary ─────────────────────────────────────────────────────────────
section "Summary"

log "OLD_RELEASE:            ${OLD_RELEASE:-'(none — first deploy)'}"
log "NEW_RELEASE:             $NEW_RELEASE"
log "GIT_SHA:                 $GIT_SHA"
log "Build status:             OK"
log "Shared asset publish:     OK ($HASHED_PUBLISHED нови, $HASHED_ALREADY_PRESENT_SAME съвпадащи по checksum)"
log "Pre-switch checks:        OK (checksum, reference closure, public HTTP)"
log "Switch result:            OK (current -> $RELEASE_ID)"
log "Post-deploy checks:       OK (/, entry JS/CSS, /health)"
log "Rollback command (ако е нужно по-късно):"
if [ -n "$OLD_RELEASE" ]; then
  log "  $ROLLBACK_CMD"
else
  log "  (няма — това беше първи deploy, нямаше стар release)"
fi

log "Готово. Frontend deploy завършен успешно."
