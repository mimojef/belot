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
 * Логика на резолюция за всеки precache URL:
 *   - ако е URL, започващ с "assets/" → трябва да съществува в
 *     SHARED_ASSETS_DIR (споделения, кумулативен pool) под същото
 *     относително име (без "assets/" префикса).
 *   - иначе → трябва да съществува в RELEASE_STATIC_DIR (release
 *     директорията, на мястото, където вече са копирани всички
 *     не-hashed public/ файлове — ПРЕДИ index.html/sw.js/manifest да
 *     бъдат копирани там, т.е. извикваме тази проверка точно в тази
 *     междинна точка на deploy pipeline-а).
 *
 * Употреба:
 *   node validatePrecacheClosure.mjs <sw.js-path> <sharedAssetsDir> <releaseStaticDir>
 *
 * Exit code 0 = всички precache URL-и са resolvable. Exit code 1 = липсва
 * поне един (изредени в stderr).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
for (const url of urls) {
  const isAssetsUrl = url.startsWith('assets/')
  const resolvedPath = isAssetsUrl
    ? join(sharedAssetsDir, url.slice('assets/'.length))
    : join(releaseStaticDir, url)

  if (!existsSync(resolvedPath)) {
    missing.push({ url, resolvedPath, pool: isAssetsUrl ? 'assets pool' : 'release static' })
  }
}

console.log(`Precache manifest: ${urls.length} URL-а общо (${urls.filter((u) => u.startsWith('assets/')).length} под assets/, ${urls.filter((u) => !u.startsWith('assets/')).length} други).`)

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
