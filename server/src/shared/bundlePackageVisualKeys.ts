/**
 * bundlePackageVisualKeys.ts
 *
 * Shop -> "Пакети" Premium Visual System (audit §2 "ЕДИН SOURCE OF TRUTH ЗА
 * KEYS") — единственият canonical списък на стабилни visual identifier-и за
 * bundle package картите. И server-ът (write validation в
 * shopBundlePackageStore.ts), И frontend-ът (visual catalog resolver в
 * src/app/lobby/bundlePackageVisualCatalog.ts) reuse-ват ТОЧНО този списък —
 * не два ръчно поддържани allowlist-а, които могат да се разминат.
 *
 * КРИТИЧНО ЗА МЕСТОПОЛОЖЕНИЕТО (module boundary audit): server/tsconfig.json
 * има `rootDir: "./src"` + strict `include: ["src/**\/*.ts"]` — production
 * build-ът (`tsc -p tsconfig.json` -> dist/) би fail-нал/счупил dist
 * структурата, ако сървърен файл import-ва нещо ФИЗИЧЕСКИ извън server/src/.
 * Обратно, root tsconfig.json (frontend) е `noEmit: true` без rootDir
 * enforcement, а Vite bundler-ът няма file-system jail към src/ — може
 * свободно да resolve-ва произволен relative път в repo-то. Затова: този
 * файл живее ТУК (вътре в server/src/), а frontend-ът го импортира с
 * relative path НАВЪТРЕ в server/src/shared/ (без .js extension, bundler
 * moduleResolution style) — единствената посока, която не изисква
 * реконфигурация на build tooling-а на нито една от двете страни.
 *
 * Файлът е чист (нула Node-specific/browser-specific imports) — безопасен
 * да се bundle-не в клиентския код без странични ефекти.
 *
 * Каталогът расте с код промени (нови визии), НЕ е admin-configurable в DB
 * (виж migration-a коментара за защо няма DB CHECK enum) — визуалните
 * метаданни (label/artwork URL/preview) остават frontend-only (виж
 * bundlePackageVisualCatalog.ts), тук е САМО стабилният списък от keys.
 */

export const BUNDLE_PACKAGE_VISUAL_KEYS = [
  'coins-small',
  'coins-medium',
  'coins-large',
  'gold-bag',
  'treasure-chest',
  'crown',
  'vip-emblem',
  'black-diamond',
] as const

export type BundlePackageVisualKey = (typeof BUNDLE_PACKAGE_VISUAL_KEYS)[number]

/**
 * Deterministic read-time fallback (audit §11) — за legacy редове с
 * visual_key=NULL, ИЛИ бъдещ unknown/renamed key (напр. каталог рефакторинг,
 * който маха стар key). Shop НИКОГА не трябва да crash-не или да рендира
 * празно заради липсваща/невалидна визия.
 */
export const DEFAULT_BUNDLE_PACKAGE_VISUAL_KEY: BundlePackageVisualKey = 'coins-medium'

/**
 * Write-time guard (server) — reuse-ван и от frontend defensive checks.
 * `null`/`undefined` НЕ е "валиден key" тук нарочно (те са легитимни "няма
 * избрана визия" стойности, обработвани отделно от caller-а, не подадени
 * пряко на тази функция) — вижте shopBundlePackageStore.ts upsertPackage()
 * за пълната null-vs-unknown разлика.
 */
export function isValidBundlePackageVisualKey(value: unknown): value is BundlePackageVisualKey {
  return typeof value === 'string' && (BUNDLE_PACKAGE_VISUAL_KEYS as readonly string[]).includes(value)
}
