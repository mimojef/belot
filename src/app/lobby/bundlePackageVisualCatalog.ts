/**
 * bundlePackageVisualCatalog.ts
 *
 * Shop -> "Пакети" Premium Visual System (audit §2/§6/§7) — frontend-only
 * визуални метаданни (human label, artwork URL) за всеки stable visual key.
 * Самите keys (списъкът от валидни стойности + default fallback) идват от
 * ЕДИНСТВЕНИЯ shared source of truth
 * (server/src/shared/bundlePackageVisualKeys.ts, reuse-ван и от
 * server-side write validation в shopBundlePackageStore.ts) — този файл
 * НЕ дублира/поддържа отделен allowlist, само добавя presentation слой
 * върху вече established keys.
 *
 * `resolveBundlePackageVisual()` е defensive resolver (audit §11) — Shop
 * НИКОГА не трябва да crash-не или да рендира празно заради
 * `visualKey === null` (legacy пакети преди тази фича) ИЛИ бъдещ unknown key
 * (напр. каталог рефакторинг, преименувал/махнал стар key) — deterministic
 * fallback towards DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY винаги.
 */

import {
  BUNDLE_PACKAGE_VISUAL_KEYS,
  DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY,
  isValidBundlePackageVisualKey,
  type BundlePackageVisualKey,
} from '../../../server/src/shared/bundlePackageVisualKeys'

export type BundlePackageVisualCatalogEntry = {
  key: BundlePackageVisualKey
  label: string
  artworkUrl: string
}

const ASSET_BASE = '/assets/shop/bundle-cards'

export const BUNDLE_PACKAGE_VISUAL_CATALOG: Record<BundlePackageVisualKey, BundlePackageVisualCatalogEntry> = {
  'coins-small': { key: 'coins-small', label: 'Малки монети', artworkUrl: `${ASSET_BASE}/package-art-coins-small.webp` },
  'coins-medium': { key: 'coins-medium', label: 'Средни монети', artworkUrl: `${ASSET_BASE}/package-art-coins-medium.webp` },
  'coins-large': { key: 'coins-large', label: 'Голяма купчина', artworkUrl: `${ASSET_BASE}/package-art-coins-large.webp` },
  'gold-bag': { key: 'gold-bag', label: 'Торба злато', artworkUrl: `${ASSET_BASE}/package-art-gold-bag.webp` },
  'treasure-chest': { key: 'treasure-chest', label: 'Съкровищен сандък', artworkUrl: `${ASSET_BASE}/package-art-treasure-chest.webp` },
  crown: { key: 'crown', label: 'Корона', artworkUrl: `${ASSET_BASE}/package-art-crown.webp` },
  'vip-emblem': { key: 'vip-emblem', label: 'VIP емблема', artworkUrl: `${ASSET_BASE}/package-art-vip-emblem.webp` },
  'black-diamond': { key: 'black-diamond', label: 'Черен диамант', artworkUrl: `${ASSET_BASE}/package-art-black-diamond.webp` },
}

/** Подредба за Admin dropdown-а — стабилен, четим ред (mirror на BUNDLE_PACKAGE_VISUAL_KEYS реда). */
export const BUNDLE_PACKAGE_VISUAL_CATALOG_LIST: BundlePackageVisualCatalogEntry[] =
  BUNDLE_PACKAGE_VISUAL_KEYS.map((key) => BUNDLE_PACKAGE_VISUAL_CATALOG[key])

export const PRICE_BRUSH_ASSET_URL = `${ASSET_BASE}/price-brush-gold.webp`

/**
 * Defensive read-time resolver — единственото място, което Shop render
 * кодът трябва да вика за да получи "какво artwork да покаже" за даден
 * пакет. Покрива: `null` (legacy/"без избрана визия"), непознат string
 * (defense-in-depth дори server вече да е reject-нал unknown при write —
 * виж audit §11 "frontend resolver пак трябва defensive да има fallback").
 */
export function resolveBundlePackageVisual(visualKey: string | null): BundlePackageVisualCatalogEntry {
  if (visualKey !== null && isValidBundlePackageVisualKey(visualKey)) {
    return BUNDLE_PACKAGE_VISUAL_CATALOG[visualKey]
  }

  return BUNDLE_PACKAGE_VISUAL_CATALOG[DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY]
}
