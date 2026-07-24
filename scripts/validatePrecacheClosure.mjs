#!/usr/bin/env node
/**
 * validatePrecacheClosure.mjs
 *
 * Проверява, че ВСЕКИ URL от precache manifest-а, инжектиран в build-натия
 * sw.js (workbox injectManifest, self.__WB_MANIFEST), реално е достъпен във
 * финалната publish структура — ПРЕДИ atomic swap-а на "current".
 *
 * Извиква се от scripts/deployFrontendAtomic.sh. Отделен Node процес, не
 * bash string processing — прецаch пътищата могат да съдържат интервали,
 * кирилица и специални символи (напр. реален запис в manifest-а:
 * "images/cards – Копие/card-back.png"), които bash word-splitting/regex
 * би трошил.
 *
 * Логика на резолюция за всеки precache URL (3 категории, виж
 * scripts/deployFrontendAtomic.sh за пълния коментар за произхода на
 * разделянето):
 *
 *   1. URL под "assets/" с Vite/Rollup content-hash в името (index-HASH.js,
 *      index-HASH.css, workbox-window-HASH.js) → трябва да съществува в
 *      SHARED_ASSETS_DIR (споделения, immutable, кумулативен pool).
 *   2. URL под "assets/" БЕЗ hash в името (avatars/, lobby/, landing-page/
 *      и т.н. — verbatim от public/assets/**, стабилни имена, mutable
 *      съдържание между releases) → трябва да съществува в
 *      RELEASE_STATIC_DIR/assets/... (release-specific, не в pool-а).
 *   3. Всеки друг URL (root/статични файлове — icons/, audio/, favicon.*,
 *      manifest.webmanifest и т.н.) → трябва да съществува директно в
 *      RELEASE_STATIC_DIR/...
 *
 * Употреба:
 *   node validatePrecacheClosure.mjs <sw.js-path> <sharedAssetsDir> <releaseStaticDir>
 *
 * Exit code 0 = всички precache URL-и са resolvable. Exit code 1 = липсва
 * поне един (изредени в stderr).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ИДЕНТИЧЕН regex на is_hashed_asset() в scripts/deployFrontendAtomic.sh —
// умишлено дублиран (bash и Node не си споделят код), но двата трябва да
// класифицират еднакво всеки файл, иначе validator-ът би проверявал грешно
// място спрямо това, което deploy стъпката реално е копирала. Тествано
// срещу реалната build структура (169 assets/ файла, 0 несъответствия
// спрямо public/ ground truth — виж diagnostic отчета).
const HASHED_ASSET_PATTERN = /-[0-9A-Za-z_-]{8,10}\.(?:js|mjs|css)$/

function classifyUrl(url) {
  if (!url.startsWith('assets/')) {
    return { category: 'root', label: 'release root' }
  }
  const rel = url.slice('assets/'.length)
  if (HASHED_ASSET_PATTERN.test(rel)) {
    return { category: 'hashed', label: 'shared hashed pool', rel }
  }
  return { category: 'mutable', label: 'release mutable assets', rel }
}

const [, , swJsPath, sharedAssetsDir, releaseStaticDir] = process.argv

if (!swJsPath || !sharedAssetsDir || !releaseStaticDir) {
  console.error('Употреба: node validatePrecacheClosure.mjs <sw.js> <sharedAssetsDir> <releaseStaticDir>')
  process.exit(2)
}

if (!existsSync(swJsPath)) {
  console.error(`sw.js не е намерен: ${swJsPath}`)
  process.exit(2)
}

const swSource = readFileSync(swJsPath, 'utf8')

// Инжектираният precache manifest е литерален JS/JSON масив от
// {"url":"...","revision":"..."} обекти (workbox injectManifest формат) —
// извличаме url стойностите директно с regex, без да зависим от точната
// структура/минификация на заобикалящия workbox library код.
const urlPattern = /"url":"((?:[^"\\]|\\.)*)"/g
const urls = []
let match
while ((match = urlPattern.exec(swSource)) !== null) {
  // JSON string escape decode (напр. \\", \\\\, \\uXXXX) — реалните пътища
  // тук не би трябвало да съдържат escape-нати кавички, но сме коректни.
  urls.push(JSON.parse(`"${match[1]}"`))
}

if (urls.length === 0) {
  console.error('Нула precache URL-и открити в sw.js — injectManifest вероятно е неуспешен или sw.js е невалиден.')
  process.exit(2)
}

const missing = []
let hashedCount = 0
let mutableCount = 0
let rootCount = 0

for (const url of urls) {
  const info = classifyUrl(url)
  const resolvedPath = info.category === 'hashed'
    ? join(sharedAssetsDir, info.rel)
    : info.category === 'mutable'
      ? join(releaseStaticDir, 'assets', info.rel)
      : join(releaseStaticDir, url)

  if (info.category === 'hashed') hashedCount++
  else if (info.category === 'mutable') mutableCount++
  else rootCount++

  if (!existsSync(resolvedPath)) {
    missing.push({ url, resolvedPath, pool: info.label })
  }
}

console.log(
  `Precache manifest: ${urls.length} URL-а общо `
  + `(${hashedCount} hashed под assets/, ${mutableCount} mutable под assets/, ${rootCount} root/static).`,
)

if (missing.length > 0) {
  console.error(`\nЛИПСВАЩИ precache ресурси (${missing.length}):`)
  for (const m of missing.slice(0, 50)) {
    console.error(`  [${m.pool}] ${m.url}  ->  ${m.resolvedPath}`)
  }
  if (missing.length > 50) {
    console.error(`  ... и още ${missing.length - 50}`)
  }
  process.exit(1)
}

console.log('Всички precache URL-и са resolvable във финалната publish структура.')
process.exit(0)
