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
#     assets/                    <- СПОДЕЛЕН, кумулативен pool — САМО
#                                   доказано content-hashed build артефакти
#                                   (Vite/Rollup изход: index-HASH.js,
#                                   index-HASH.css, workbox-window-HASH.js).
#                                   Само добавяне, никога изтриване тук —
#                                   еднакво име == еднакво съдържание.
#     releases/<release-id>/
#       index.html, sw.js, manifest.webmanifest, icons/, audio/, ...
#       assets/                  <- RELEASE-SPECIFIC mutable assets (avatars,
#                                   изображения, лого и т.н. — стабилни
#                                   имена БЕЗ hash, копирани от build/assets/
#                                   подпапки като avatars/, lobby/,
#                                   landing-page/ и т.н.). Презаписват се
#                                   свободно при всеки deploy; rollback
#                                   автоматично връща и тяхната версия,
#                                   защото живеят вътре в release-а.
#     current -> releases/<release-id>   (атомарен symlink)
#
# КРИТИЧНО разграничение (виж is_hashed_asset() по-долу и diagnostic
# отчета): dist/assets/ съдържа И двете категории смесени — само файловете
# на върха с Vite content-hash в името (обикновено 3: index-*.js,
# index-*.css, workbox-window-*.js) са реално content-addressed. Остатъкът
# (169-3=166 в реалния build) идва verbatim от public/assets/** (avatars/,
# animated-emoji/, game-icons/, landing-page/, lobby/) — стабилни имена,
# МОГАТ да сменят съдържанието си между releases без hash в URL-а, значи
# НЕ могат да живеят в immutable shared pool-а нито да се третират с cp -n
# (което би спряло да ги обновява завинаги след първия deploy).
#
# nginx трябва да има ОТДЕЛЕН route само за hashed файловете (regex location
# по hash-pattern, immutable cache) към $DEPLOY_ROOT/assets/, докато
# останалите /assets/... заявки падат към CURRENT_LINK/assets/... с умерен
# (не immutable) cache — виж deploy/nginx-frontend-cache-headers.conf.example.
#
# Употреба:
#   scripts/deployFrontendAtomic.sh [--keep N] [--dry-run]
#   scripts/deployFrontendAtomic.sh --rollback
#   scripts/deployFrontendAtomic.sh --list
#   scripts/deployFrontendAtomic.sh --gc-assets     (конзервативен cleanup на assets/ пула)
#   scripts/deployFrontendAtomic.sh --adopt <dist>  (еднократна baseline миграция
#                                                     от вече работещ, ръчно build-нат
#                                                     dist — виж deploy/PRODUCTION_DEPLOY_PLAN.md)
#
# Изисква: node, npm, git. Предназначен за изпълнение НА production сървъра.
# Production checkout-ът Е /var/www/belot-v2 директно (НЕ .../repo подпапка
# — backend/PM2 също разчита на тази структура, скриптът не мести repo-то).
# PROJECT_ROOT по подразбиране се извежда от местоположението на самия
# скрипт (../ спрямо scripts/), значи съвпада правилно с /var/www/belot-v2
# без нужда от explicit override там.

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
ADOPT_DIST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP_RELEASES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ACTION="rollback"; shift ;;
    --list) ACTION="list"; shift ;;
    --adopt) ACTION="deploy"; ADOPT_DIST="$2"; shift 2 ;;
    --gc-assets) ACTION="gc-assets"; shift ;;
    *) echo "Непознат аргумент: $1" >&2; exit 1 ;;
  esac
done

log() { printf '[deploy] %s\n' "$1"; }
fail() { printf '[deploy] FAIL: %s\n' "$1" >&2; exit 1; }

# Vite/Rollup content-hash filename pattern: <name>-<hash>.<js|mjs|css>, с
# hash от 8-10 alphanumeric/_/- символа непосредствено преди разширението.
# Умишлено ограничено до js/mjs/css (не /-разчита само на разширението/ —
# mutable assets в този проект никога нямат тези разширения, hashed Vite
# bundle output винаги ги има; комбинацията "hash suffix" + "bundle
# extension" е двойна проверка, не само едната). Тествано срещу реалната
# build структура (169 assets/ файла, 0 несъответствия спрямо public/
# ground truth — виж diagnostic отчета) — идентичен regex се ползва и в
# scripts/validatePrecacheClosure.mjs и в nginx location-а, за да остане
# класификацията консистентна навсякъде, където се прилага.
is_hashed_asset() {
  [[ "$1" =~ -[0-9A-Za-z_-]{8,10}\.(js|mjs|css)$ ]]
}

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
  log "Hashed assets: споделеният pool не се пипа при rollback (hash-овете,"
  log "нужни на $PREV_ID, вече би трябвало да са в него)."
  log "Mutable assets (avatars/images/audio): живеят вътре в $PREV_ID/assets/,"
  log "значи rollback автоматично връща и тяхната стара версия."
  exit 0
fi

# ─── --gc-assets: консервативен cleanup на споделения HASHED assets pool ──
# Трие от $SHARED_ASSETS_DIR само hash-ове, които НЕ се реферират от НИТО
# ЕДИН запазен release (index.html/sw.js на всички директории в releases/).
# Никога не се вика автоматично от deploy стъпката — отделна, explicit
# команда, за да остане поведението лесно за одит.
#
# $SHARED_ASSETS_DIR трябва да съдържа САМО hashed файлове (по дизайн на
# deploy стъпката по-долу) — is_hashed_asset() тук е defense-in-depth: ако
# по някаква причина (стар/ръчен deploy отпреди тази поправка) в пула се
# озове mutable файл, gc-assets НИКОГА не го пипа (не е негова отговорност —
# такъв файл трябва да се мигрира ръчно, не да бъде трит мълчаливо).
# Рекурсивен find (не само top-level *) — коректно обработва hashed файлове
# в под-директории, ако някога се появят.
if [ "$ACTION" = "gc-assets" ]; then
  [ -d "$SHARED_ASSETS_DIR" ] || fail "Няма assets директория: $SHARED_ASSETS_DIR"
  [ -d "$RELEASES_DIR" ] || fail "Няма releases директория: $RELEASES_DIR"

  REFERENCED_TMP="$(mktemp)"
  trap 'rm -f "$REFERENCED_TMP"' EXIT

  for f in "$RELEASES_DIR"/*/index.html "$RELEASES_DIR"/*/sw.js; do
    [ -f "$f" ] || continue
    grep -oE 'assets/[A-Za-z0-9._/-]+' "$f" 2>/dev/null | sed 's#^assets/##' >> "$REFERENCED_TMP" || true
  done
  sort -u -o "$REFERENCED_TMP" "$REFERENCED_TMP"

  REMOVED=0
  SKIPPED_NON_HASHED=0
  while IFS= read -r -d '' asset; do
    rel="${asset#"$SHARED_ASSETS_DIR"/}"
    base="$(basename "$asset")"
    if ! is_hashed_asset "$base"; then
      # Не е наша отговорност — виж коментара по-горе.
      SKIPPED_NON_HASHED=$((SKIPPED_NON_HASHED + 1))
      continue
    fi
    if ! grep -qxF "$rel" "$REFERENCED_TMP"; then
      log "gc-assets: премахвам $rel (не се реферира от нито един запазен release)"
      if [ "$DRY_RUN" != "1" ]; then
        rm -f "$asset"
      fi
      REMOVED=$((REMOVED + 1))
    fi
  done < <(find "$SHARED_ASSETS_DIR" -type f -print0)

  log "gc-assets: $REMOVED hashed файла($ъл) премахнати(о). $SKIPPED_NON_HASHED non-hashed файла($ъл) пропуснати(о) (не е отговорност на gc-assets)."
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
if [ -n "$ADOPT_DIST" ]; then
  BUILD_ID="baseline-${BUILD_ID}"
fi
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-${BUILD_ID}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/belot-frontend-build-XXXXXX")"

cleanup_build_dir() {
  rm -rf "$BUILD_DIR"
}
trap cleanup_build_dir EXIT

log "Release: $RELEASE_ID"

if [ -n "$ADOPT_DIST" ]; then
  # ─── 1 (adopt режим). Еднократна baseline миграция от ВЕЧЕ работещ dist ──
  # НЕ build-ва нищо — приема съществуващ, вече обслужван от nginx dist
  # (виж deploy/PRODUCTION_DEPLOY_PLAN.md). Копира (НЕ мести/линква) в
  # BUILD_DIR — cleanup trap-ът по-долу трие само тази временна копия,
  # никога оригиналния $ADOPT_DIST (все още живо обслужван от nginx по
  # време на цялата миграция).
  [ -d "$ADOPT_DIST" ] || fail "--adopt директорията не съществува: $ADOPT_DIST"
  log "Adopt режим: копирам съществуващия dist от $ADOPT_DIST (НЕ build, НЕ пипам оригинала)..."
  cp -r "$ADOPT_DIST"/. "$BUILD_DIR"/
else
  log "Build в изолирана временна директория: $BUILD_DIR (НЕ в live dist)"
  # ─── 1. Build извън live dist, с явен build id (за __PWA_BUILD_ID__ и debugging) ──
  VITE_BUILD_ID="$BUILD_ID" npx tsc
  VITE_BUILD_ID="$BUILD_ID" npx vite build --outDir "$BUILD_DIR" --emptyOutDir
fi

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

# ─── 3+4. Класифицирай и публикувай assets/ съдържанието ──────────────────
# ПЪРВО hashed → споделен pool, ПРЕДИ index.html/sw.js да бъдат публикувани
# (точно обратното на доказания production дефект). Mutable файлове отиват
# в НОВАТА release директория (все още невидима, докато current не се
# превключи) — виж is_hashed_asset() и коментара в началото на файла.
mkdir -p "$SHARED_ASSETS_DIR"
mkdir -p "$RELEASES_DIR"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
[ ! -e "$RELEASE_DIR" ] || fail "Release директорията вече съществува: $RELEASE_DIR"
mkdir -p "$RELEASE_DIR/assets"

log "Класифицирам и публикувам assets/ съдържанието (hashed pool vs release-specific mutable)..."
HASHED_PUBLISHED=0
MUTABLE_PUBLISHED=0
while IFS= read -r -d '' file; do
  rel="${file#"$BUILD_DIR"/assets/}"
  base="$(basename "$rel")"
  if is_hashed_asset "$base"; then
    dest="$SHARED_ASSETS_DIR/$rel"
    mkdir -p "$(dirname "$dest")"
    # Content-addressed — еднакво име гарантирано означава еднакво
    # съдържание, никога не презаписваме съществуващ hash.
    [ -e "$dest" ] || cp "$file" "$dest"
    HASHED_PUBLISHED=$((HASHED_PUBLISHED + 1))
  else
    dest="$RELEASE_DIR/assets/$rel"
    mkdir -p "$(dirname "$dest")"
    # Mutable — винаги копираме свежата версия в НОВИЯ release (не е
    # content-addressed, стабилно име може да носи ново съдържание между
    # releases, напр. подменен avatar placeholder).
    cp "$file" "$dest"
    MUTABLE_PUBLISHED=$((MUTABLE_PUBLISHED + 1))
  fi
done < <(find "$BUILD_DIR/assets" -type f -print0)

log "assets/: $HASHED_PUBLISHED hashed файла в споделения pool, $MUTABLE_PUBLISHED mutable файла в release-а."

# public/ статичните файлове НА ВЪРХА (icons/, audio/, favicon.*,
# manifest.webmanifest и т.н.) — не са content-hashed, презаписват се
# свободно. manifest.webmanifest Е част от precache closure-а (реферирано
# от sw.js), затова се третира като "static dependency", не като "entry
# файл". Единствените ДЕЙСТВИТЕЛНО гейтвани зад precache validation-а
# файлове са sw.js/sw.js.map/index.html.
log "Копирам дребните статични public/ файлове (не content-hashed, презаписват се свободно)..."
find "$BUILD_DIR" -mindepth 1 -maxdepth 1 \
  ! -name 'index.html' ! -name 'sw.js' ! -name 'sw.js.map' ! -name 'assets' \
  -exec cp -r {} "$RELEASE_DIR/" \;

# ─── 4b. ПЪЛНА precache closure проверка срещу РЕАЛНАТА publish структура ──
# Едва сега SHARED_ASSETS_DIR (hashed) и RELEASE_DIR/RELEASE_DIR/assets
# (root static + mutable) отразяват точно това, което би видял production
# request след atomic swap-а — validatePrecacheClosure.mjs прави 3-пътна
# резолюция (hashed → pool, mutable /assets/... → release/assets/, друго →
# release root). Ако липсва дори един precache-нат ресурс от КОЯТО и да е
# категория, index.html/sw.js НЕ се копират и current НЕ се пипа.
log "Проверявам precache closure срещу реалната publish структура (hashed pool + release root + release/assets)..."
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
