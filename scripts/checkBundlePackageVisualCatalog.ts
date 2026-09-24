/**
 * checkBundlePackageVisualCatalog.ts
 *
 * Shop -> "Пакети" Premium Visual System — frontend catalog regression
 * (audit §14, [7]-[10]). Server-side store/API contract е тестван отделно
 * (server/scripts/checkBundlePackageVisualKeyStore.ts,
 * checkShopBundleCheckoutHttpFlow.ts [3b]-[3d]).
 *
 * [7]  Fallback: null -> coins-medium (DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY)
 * [8]  Fallback: unknown string -> coins-medium
 * [9]  Всичките 8 stable keys resolve-ват към реален, различен catalog entry
 *        (non-empty label, artworkUrl, key match)
 * [10] Asset пътищата (8 artwork + price brush) реално съществуват на диска
 *        (public/assets/shop/bundle-cards/*.webp)
 *
 * Плюс source-of-truth consistency checks: catalog list length/ред следва
 * BUNDLE_PACKAGE_VISUAL_KEYS (shared module), isValidBundlePackageVisualKey
 * поведение за null/undefined/unknown.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BUNDLE_PACKAGE_VISUAL_KEYS,
  DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY,
  isValidBundlePackageVisualKey,
} from '../server/src/shared/bundlePackageVisualKeys'
import {
  BUNDLE_PACKAGE_VISUAL_CATALOG,
  BUNDLE_PACKAGE_VISUAL_CATALOG_LIST,
  PRICE_BRUSH_ASSET_URL,
  resolveBundlePackageVisual,
} from '../src/app/lobby/bundlePackageVisualCatalog'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

/** URL е "/assets/shop/bundle-cards/xxx.webp" -> реален файл под public/. */
function assetUrlToDiskPath(url: string): string {
  return join(REPO_ROOT, 'public', url.replace(/^\//, ''))
}

console.log('\ncheckBundlePackageVisualCatalog\n')

check('[7] Fallback: visualKey=null -> coins-medium', () => {
  const resolved = resolveBundlePackageVisual(null)
  assertEqual(resolved.key, DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY, 'null трябва да resolve-не към default key')
  assertEqual(resolved.key, 'coins-medium', 'default key трябва да е coins-medium')
})

check('[8] Fallback: unknown string -> coins-medium', () => {
  const resolved = resolveBundlePackageVisual('totally-unknown-legacy-key')
  assertEqual(resolved.key, DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY, 'непознат key трябва да resolve-не към default')

  // Допълнителни defensive edge cases — никога crash, никога undefined entry.
  assertEqual(resolveBundlePackageVisual('').key, DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY, 'празен string -> default')
  assertEqual(resolveBundlePackageVisual('COINS-SMALL').key, DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY, 'case-sensitive mismatch -> default (не partial/fuzzy match)')
})

check('[9] Всичките 8 stable keys resolve-ват към реален, различен catalog entry', () => {
  assertEqual(BUNDLE_PACKAGE_VISUAL_KEYS.length, 8, 'трябва да има точно 8 stable keys')
  assertEqual(BUNDLE_PACKAGE_VISUAL_CATALOG_LIST.length, 8, 'catalog list-ът трябва да има точно 8 entries')

  const seenArtworkUrls = new Set<string>()
  for (const key of BUNDLE_PACKAGE_VISUAL_KEYS) {
    const resolved = resolveBundlePackageVisual(key)
    assertEqual(resolved.key, key, `resolveBundlePackageVisual('${key}') трябва да върне entry със същия key`)
    assert(resolved.label.trim().length > 0, `${key}: label не трябва да е празен`)
    assert(resolved.artworkUrl.length > 0, `${key}: artworkUrl не трябва да е празен`)
    assert(!seenArtworkUrls.has(resolved.artworkUrl), `${key}: artworkUrl трябва да е уникален спрямо другите keys (${resolved.artworkUrl})`)
    seenArtworkUrls.add(resolved.artworkUrl)

    assert(isValidBundlePackageVisualKey(key), `${key} трябва да мине isValidBundlePackageVisualKey`)
    assert(BUNDLE_PACKAGE_VISUAL_CATALOG[key] !== undefined, `${key} трябва да има запис в BUNDLE_PACKAGE_VISUAL_CATALOG`)
  }

  assert(!isValidBundlePackageVisualKey(null), 'null НЕ трябва да мине isValidBundlePackageVisualKey')
  assert(!isValidBundlePackageVisualKey(undefined), 'undefined НЕ трябва да мине isValidBundlePackageVisualKey')
  assert(!isValidBundlePackageVisualKey('bogus'), 'непознат string НЕ трябва да мине isValidBundlePackageVisualKey')
  assert(!isValidBundlePackageVisualKey(42), 'non-string НЕ трябва да мине isValidBundlePackageVisualKey')
})

check('[10] Asset пътищата (8 artwork + price brush) реално съществуват на диска', () => {
  for (const key of BUNDLE_PACKAGE_VISUAL_KEYS) {
    const url = BUNDLE_PACKAGE_VISUAL_CATALOG[key].artworkUrl
    const diskPath = assetUrlToDiskPath(url)
    assert(existsSync(diskPath), `artwork за "${key}" трябва да съществува на диска: ${diskPath}`)
    assert(url.endsWith('.webp'), `artwork за "${key}" трябва да е .webp: ${url}`)
  }

  const brushPath = assetUrlToDiskPath(PRICE_BRUSH_ASSET_URL)
  assert(existsSync(brushPath), `price brush asset трябва да съществува на диска: ${brushPath}`)
  assert(PRICE_BRUSH_ASSET_URL.endsWith('.webp'), 'price brush asset трябва да е .webp')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
