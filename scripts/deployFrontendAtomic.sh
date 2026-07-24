#!/usr/bin/env bash
#
# deployFrontendAtomic.sh — atomic frontend release publish.
#
# Заменя директния "npm run build" в live /var/www/belot-v2/dist, който
# empty-ва dist-а (Vite emptyOutDir default) в самата обслужвана директория —
# доказан ~60ms+ прозорец с изтрити стари hashed assets и липсващ/непълен
# index.html, докато build-ът тече (виж diagnostic отчета).
#
# Модел (Capistrano-style releases + shared content-addressed asset pool):
#
#   $DEPLOY_ROOT/
#     assets/                 <- СПОДЕЛЕН, кумулативен pool. Само добавяне,
#                                никога цялостно изтриване — Vite hashed
#                                имена са content-addressed (index-HASH.js),
#                                значи еднакво име == еднакво съдържание,
#                                копирането е идемпотентно и безопасно.
#     releases/<release-id>/  <- САМО стабилните entry файлове (index.html,
#                                sw.js, manifest.webmanifest + дребните
#                                public/ статични файлове, презаписвани
#                                всеки път — не са content-hashed, нямат
#                                нужда от retention).
#     current -> releases/<release-id>   (атомарен symlink)
#
# nginx трябва да сочи root към CURRENT_LINK за всичко ОСВЕН /assets/, и
# отделен location за /assets/ директно към $DEPLOY_ROOT/assets/ (виж
# deploy/nginx-frontend-cache-headers.conf.example) — иначе старите hashed
# assets НЕ биха останали достъпими след смяна на "current" (те не са част
# от новия release directory).
#
# Употреба:
#   scripts/deployFrontendAtomic.sh [--keep N] [--dry-run]
#   scripts/deployFrontendAtomic.sh --rollback
#   scripts/deployFrontendAtomic.sh --list
#   scripts/deployFrontendAtomic.sh --gc-assets   (пести конзервативен cleanup на assets/ пула)
#
# Изисква: node, npm, git. Предназначен за изпълнение НА production сървъра,
# с cwd в repo checkout-а (напр. /var/www/belot-v2/repo или еквивалент).

set -euo pipefail

# ─── Конфигурация (пригоди към реалната production директория) ──────────────
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/belot-v2}"
RELEASES_DIR="${RELEASES_DIR:-$DEPLOY_ROOT/releases}"
CURRENT_LINK="${CURRENT_LINK:-$DEPLOY_ROOT/current}"
SHARED_ASSETS_DIR="${SHARED_ASSETS_DIR:-$DEPLOY_ROOT/assets}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
DRY_RUN=0

# ─── Аргументи ────────────────────────────────────────────────────────────
ACTION="deploy"
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP_RELEASES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ACTION="rollback"; shift ;;
    --list) ACTION="list"; shift ;;
    --gc-assets) ACTION="gc-assets"; shift ;;
    *) echo "Непознат аргумент: $1" >&2; exit 1 ;;
  esac
done

log() { printf '[deploy] %s\n' "$1"; }
fail() { printf '[deploy] FAIL: %s\n' "$1" >&2; exit 1; }

# ─── --list: покажи налични release-и ────────────────────────────────────
if [ "$ACTION" = "list" ]; then
  [ -d "$RELEASES_DIR" ] || fail "Няма releases директория: $RELEASES_DIR"
  CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo '(none)')"
  log "Текущ (current -> $CURRENT_TARGET):"
  for dir in "$RELEASES_DIR"/*/; do
    id="$(basename "$dir")"
    marker=""
    [ "$dir" = "$CURRENT_TARGET/" ] && marker=" <- CURRENT"
    printf '  %s%s\n' "$id" "$marker"
  done
  exit 0
fi

# ─── --rollback: превключи current към предишния release ────────────────
if [ "$ACTION" = "rollback" ]; then
  [ -d "$RELEASES_DIR" ] || fail "Няма releases директория: $RELEASES_DIR"
  CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo '')"
  CURRENT_ID="$(basename "${CURRENT_TARGET:-}")"

  mapfile -t ALL_RELEASES < <(ls -1 "$RELEASES_DIR" | sort)
  PREV_ID=""
  for i in "${!ALL_RELEASES[@]}"; do
    if [ "${ALL_RELEASES[$i]}" = "$CURRENT_ID" ] && [ "$i" -gt 0 ]; then
      PREV_ID="${ALL_RELEASES[$((i - 1))]}"
    fi
  done

  [ -n "$PREV_ID" ] || fail "Няма предишен release за rollback (текущ: $CURRENT_ID)."
  [ -d "$RELEASES_DIR/$PREV_ID" ] || fail "Release директория липсва: $RELEASES_DIR/$PREV_ID"

  log "Rollback: $CURRENT_ID -> $PREV_ID"
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run — не се прилага)"
    exit 0
  fi
  ln -sfn "$RELEASES_DIR/$PREV_ID" "$CURRENT_LINK.tmp"
  mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
  log "Rollback завършен. current -> $PREV_ID"
  log "Забележка: assets/ пулът е споделен и не се пипа при rollback — hashed"
  log "файловете, нужни на $PREV_ID, вече би трябвало да са в него."
  exit 0
fi

# ─── --gc-assets: консервативен cleanup на споделения assets pool ────────
# Трие от $SHARED_ASSETS_DIR само hash-ове, които НЕ се реферират от НИТО
# ЕДИН запазен release (index.html/sw.js на всички директории в releases/).
# Никога не се вика автоматично от deploy стъпката — отделна, explicit
# команда, за да остане поведението лесно за одит.
if [ "$ACTION" = "gc-assets" ]; then
  [ -d "$SHARED_ASSETS_DIR" ] || fail "Няма assets директория: $SHARED_ASSETS_DIR"
  [ -d "$RELEASES_DIR" ] || fail "Няма releases директория: $RELEASES_DIR"

  REFERENCED_TMP="$(mktemp)"
  trap 'rm -f "$REFERENCED_TMP"' EXIT

  for f in "$RELEASES_DIR"/*/index.html "$RELEASES_DIR"/*/sw.js; do
    [ -f "$f" ] || continue
    grep -oE 'assets/[A-Za-z0-9._-]+' "$f" 2>/dev/null | sed 's#^assets/##' >> "$REFERENCED_TMP" || true
  done
  sort -u -o "$REFERENCED_TMP" "$REFERENCED_TMP"

  REMOVED=0
  for asset in "$SHARED_ASSETS_DIR"/*; do
    [ -f "$asset" ] || continue
    name="$(basename "$asset")"
    if ! grep -qxF "$name" "$REFERENCED_TMP"; then
      log "gc-assets: премахвам $name (не се реферира от нито един запазен release)"
      if [ "$DRY_RUN" != "1" ]; then
        rm -f "$asset"
      fi
      REMOVED=$((REMOVED + 1))
    fi
  done
  log "gc-assets: $REMOVED файла($ъл) премахнати(о)."
  exit 0
fi

# ─── deploy (default) ──────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "node не е намерен в PATH."
command -v npm >/dev/null 2>&1 || fail "npm не е намерен в PATH."

cd "$PROJECT_ROOT"

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"
# Позволява explicit override (напр. regression тестове, hotfix re-deploy на
# същия commit) — по подразбиране пада към git SHA както преди.
BUILD_ID="${VITE_BUILD_ID:-$GIT_SHA}"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-${BUILD_ID}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/belot-frontend-build-XXXXXX")"

cleanup_build_dir() {
  rm -rf "$BUILD_DIR"
}
trap cleanup_build_dir EXIT

log "Release: $RELEASE_ID"
log "Build в изолирана временна директория: $BUILD_DIR (НЕ в live dist)"

# ─── 1. Build извън live dist, с явен build id (за __PWA_BUILD_ID__ и debugging) ──
VITE_BUILD_ID="$BUILD_ID" npx tsc
VITE_BUILD_ID="$BUILD_ID" npx vite build --outDir "$BUILD_DIR" --emptyOutDir

# ─── 2. Валидация на build резултата ──────────────────────────────────────
[ -f "$BUILD_DIR/index.html" ] || fail "index.html липсва след build."
[ -f "$BUILD_DIR/sw.js" ] || fail "sw.js липсва след build (injectManifest failed?)."
[ -f "$BUILD_DIR/manifest.webmanifest" ] || fail "manifest.webmanifest липсва след build."
[ -d "$BUILD_DIR/assets" ] || fail "assets/ директорията липсва след build."
[ -n "$(ls -A "$BUILD_DIR/assets" 2>/dev/null)" ] || fail "assets/ е празна след build."

grep -q '<script[^>]*type="module"' "$BUILD_DIR/index.html" \
  || fail "index.html не съдържа module script tag — вероятно счупен build."
grep -q 'assets/index-' "$BUILD_DIR/index.html" \
  || fail "index.html не реферира hashed entry chunk — вероятно счупен build."
grep -q 'precacheController' "$BUILD_DIR/sw.js" \
  || fail "sw.js не съдържа workbox precache код — вероятно build на service worker-а е неуспешен."

MAIN_ASSET_COUNT="$(find "$BUILD_DIR/assets" -maxdepth 1 -type f | wc -l)"
[ "$MAIN_ASSET_COUNT" -ge 1 ] || fail "Нула файла в assets/ след build."

log "Build валиден: index.html, sw.js, manifest.webmanifest, $MAIN_ASSET_COUNT assets."

# ─── 2b. Precache closure self-check (срещу самия BUILD_DIR, преди split) ──
# sw.js precache-ва СТОТИЦИ ресурси (не само hashed JS/CSS — икони,
# изображения, audio, manifest.webmanifest и т.н., виж
# scripts/validatePrecacheClosure.mjs). Тук BUILD_DIR все още е неразделен
# (assets/ + всичко останало заедно), значи "assets pool" и "release static"
# съвпадат с BUILD_DIR — валидно самостоятелно свидетелство, че build-ът
# сам по себе си е self-consistent, дори при --dry-run (без да пипаме
# живите release/assets директории).
log "Проверявам precache closure (self-check срещу build изхода)..."
node "$PROJECT_ROOT/scripts/validatePrecacheClosure.mjs" \
  "$BUILD_DIR/sw.js" "$BUILD_DIR/assets" "$BUILD_DIR" \
  || fail "Precache manifest реферира ресурс(и), липсващ(и) от самия build изход — вижте списъка по-горе."

if [ "$DRY_RUN" = "1" ]; then
  log "(dry-run — build-ът е валидиран, но НЕ се публикува)"
  exit 0
fi

# ─── 3. Публикувай hashed assets в СПОДЕЛЕНИЯ pool ПЪРВО ──────────────────
# Никога не се трие/презаписва съществуващ файл тук (content-addressed —
# еднакво име гарантирано означава еднакво съдържание). Новите hash-ове
# стават достъпими на своя финален URL, ПРЕДИ index.html/sw.js, които ги
# реферират, да бъдат публикувани — точно обратното на текущия production
# дефект, доказан в диагностиката.
mkdir -p "$SHARED_ASSETS_DIR"
log "Публикувам hashed assets в споделения pool ($SHARED_ASSETS_DIR)..."
# -r: assets/ съдържа и под-директории с невhashed статични изображения
# (напр. avatars/, landing-page/) наред с hashed JS/CSS файлове на върха.
# -n: content-addressed hashed файлове никога не се презаписват; за
# под-директориите -n действа per-file по време на рекурсията.
cp -rn "$BUILD_DIR"/assets/* "$SHARED_ASSETS_DIR/"

# ─── 4. Подготви нова release директория (само стабилни/дребни файлове) ──
mkdir -p "$RELEASES_DIR"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
[ ! -e "$RELEASE_DIR" ] || fail "Release директорията вече съществува: $RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# public/ статичните файлове, ВКЛЮЧИТЕЛНО manifest.webmanifest — то е част
# от precache closure-а (реферирано от sw.js), затова се третира като
# "static dependency", не като "entry файл". Единствените ДЕЙСТВИТЕЛНО
# гейтвани зад precache validation-а файлове са sw.js/sw.js.map/index.html.
log "Копирам дребните статични public/ файлове (не content-hashed, презаписват се свободно)..."
find "$BUILD_DIR" -mindepth 1 -maxdepth 1 \
  ! -name 'index.html' ! -name 'sw.js' ! -name 'sw.js.map' ! -name 'assets' \
  -exec cp -r {} "$RELEASE_DIR/" \;

# ─── 4b. ПЪЛНА precache closure проверка срещу РЕАЛНАТА publish структура ──
# Едва сега SHARED_ASSETS_DIR и RELEASE_DIR отразяват точно това, което би
# видял production request след atomic swap-а. Ако липсва дори един
# precache-нат ресурс тук, index.html/sw.js НЕ се копират и current НЕ се
# пипа — старият release остава напълно непроменен и живо обслужван.
log "Проверявам precache closure срещу реалната publish структура (assets pool + release)..."
if ! node "$PROJECT_ROOT/scripts/validatePrecacheClosure.mjs" \
  "$BUILD_DIR/sw.js" "$SHARED_ASSETS_DIR" "$RELEASE_DIR"; then
  # Release директорията никога не е станала "current" — трием я, за да не
  # оставяме частично публикувана debris директория на диска.
  rm -rf "$RELEASE_DIR"
  fail "Precache closure непълна във финалната publish структура — index.html/sw.js НЕ са публикувани, current остава непроменен."
fi

# Стабилните entry файлове — последни в самата release директория (все още
# невидима за нищо, докато current symlink-ът не бъде превключен).
log "Публикувам index.html, sw.js в release директорията..."
cp "$BUILD_DIR/sw.js" "$RELEASE_DIR/sw.js"
[ -f "$BUILD_DIR/sw.js.map" ] && cp "$BUILD_DIR/sw.js.map" "$RELEASE_DIR/sw.js.map" || true
cp "$BUILD_DIR/index.html" "$RELEASE_DIR/index.html"

# ─── 5. Атомарен switch на "current" symlink-а ────────────────────────────
# Създай нов symlink с временно име, после rename (mv) — rename е атомарна
# операция на едно и също файлова система (POSIX), значи нито един request
# никога не вижда "полу-сменено" състояние.
log "Атомарно превключвам current -> $RELEASE_ID..."
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"

log "Публикувано: current -> $RELEASE_ID"

# ─── 6. Retention cleanup — пази последните KEEP_RELEASES release ДИРЕКТОРИИ ──
# Забележка: това трие само малките release-entry директории (index.html/
# sw.js/manifest + дребни статични файлове), НЕ пипа $SHARED_ASSETS_DIR —
# hashed assets се чистят отделно, explicit, чрез --gc-assets, само след
# като вече не се реферират от НИТО ЕДИН запазен release.
mapfile -t ALL_RELEASES < <(ls -1 "$RELEASES_DIR" | sort)
TOTAL="${#ALL_RELEASES[@]}"
if [ "$TOTAL" -gt "$KEEP_RELEASES" ]; then
  TO_REMOVE=$((TOTAL - KEEP_RELEASES))
  log "Retention: премахвам $TO_REMOVE стар(и) release(а) (пазя последните $KEEP_RELEASES)..."
  for i in $(seq 0 $((TO_REMOVE - 1))); do
    OLD_ID="${ALL_RELEASES[$i]}"
    OLD_DIR="$RELEASES_DIR/$OLD_ID"
    # Никога не пипай текущия live release, дори ако retention аритметиката
    # някога се обърка — defense in depth.
    CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo '')"
    if [ "$OLD_DIR" = "$CURRENT_TARGET" ]; then
      log "  прескачам $OLD_ID (е текущият live release)"
      continue
    fi
    log "  премахвам $OLD_ID"
    rm -rf "$OLD_DIR"
  done
fi

log "Готово. Release $RELEASE_ID е публикуван."
log "За rollback: $0 --rollback"
log "За почистване на неизползвани hashed assets: $0 --gc-assets"
