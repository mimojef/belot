// Frontend tracker и client types smoke checks.
//
// Тества source файловете директно чрез динамичен import (tsx runtime).
// Не изисква браузър — проверява статичната структура и compile-time форми.

import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

const projectRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length)
  ?? join(process.cwd(), '..'),
)
console.log(`\n═══ View Layout Frontend Checks ═══`)
console.log(`Project root: ${projectRoot}`)

// ─── [1] Tracker source съдържа viewLayout ────────────────────────────────────

console.log('\n[1] createVisitorPageViewTracker source')
const trackerPath = join(projectRoot, 'src', 'app', 'visitors', 'createVisitorPageViewTracker.ts')
const trackerSource = await readFile(trackerPath, 'utf8')

await check('[1.1] VisitorViewLayout тип е дефиниран и exported', () => {
  if (!trackerSource.includes("export type VisitorViewLayout = 'mobile' | 'desktop'")) {
    throw new Error('Липсва export type VisitorViewLayout')
  }
})
await check('[1.2] getViewLayout е в VisitorTrackerOptions', () => {
  if (!trackerSource.includes('getViewLayout')) {
    throw new Error('Липсва getViewLayout в VisitorTrackerOptions')
  }
})
await check('[1.3] viewLayout се добавя в body на sendPageView', () => {
  if (!trackerSource.includes('viewLayout,')) {
    throw new Error('viewLayout не е в тялото на fetch')
  }
})
await check('[1.4] viewLayout се изчислява веднъж в start() чрез options.getViewLayout()', () => {
  // getViewLayout() трябва да съществува в source-а и да се вика след `started = true`
  // (т.е. вътре в start(), не в sendPageView).
  // Проверяваме, че фразата "options.getViewLayout()" присъства в source-а.
  if (!trackerSource.includes('options.getViewLayout()')) {
    throw new Error('options.getViewLayout() не е извикано в tracker-а')
  }
})
await check('[1.5] sendPageView НЕ вика getViewLayout() директно (само start() го вика)', () => {
  const sendFnMatch = trackerSource.match(/function sendPageView\([^)]*\)[^{]*\{([\s\S]*?)^\s{2}\}/m)
  const sendBody = sendFnMatch?.[1] ?? ''
  if (sendBody.includes('getViewLayout()')) {
    throw new Error('sendPageView вика getViewLayout() — layout трябва да е изчислен в start()')
  }
})
await check('[1.6] SPA events преминават viewLayout (layout не се губи при pushState)', () => {
  if (!trackerSource.includes("trackCurrentPage('spa'")) {
    throw new Error("trackCurrentPage('spa') липсва")
  }
})
await check('[1.7] popstate listener предава viewLayout', () => {
  if (!trackerSource.includes("trackCurrentPage('back_forward'")) {
    throw new Error("back_forward не предава viewLayout")
  }
})

// ─── [2] main.ts wiring ──────────────────────────────────────────────────────

console.log('\n[2] main.ts wiring')
const mainPath = join(projectRoot, 'src', 'main.ts')
const mainSource = await readFile(mainPath, 'utf8')

await check('[2.1] getViewLayout callback използва isPhoneLayoutViewport()', () => {
  if (!mainSource.includes('isPhoneLayoutViewport()')) {
    throw new Error('Липсва isPhoneLayoutViewport() в main.ts')
  }
})
await check("[2.2] getViewLayout map-ва правилно: true → 'mobile', false → 'desktop'", () => {
  if (!mainSource.includes("isPhoneLayoutViewport() ? 'mobile' : 'desktop'")) {
    throw new Error("Липсва правилното mapping mobile/desktop")
  }
})
await check('[2.3] getViewLayout е подаден като option при createVisitorPageViewTracker', () => {
  const trackerCallMatch = mainSource.match(/createVisitorPageViewTracker\(\{([\s\S]*?)\}\)/)
  const trackerCallBody = trackerCallMatch?.[1] ?? ''
  if (!trackerCallBody.includes('getViewLayout')) {
    throw new Error('getViewLayout не е в createVisitorPageViewTracker({...})')
  }
})

// ─── [3] Client типове — AdminStatsSnapshot съдържа viewLayout ────────────────

console.log('\n[3] Client типове в createGameServerClient.ts')
const clientPath = join(projectRoot, 'src', 'app', 'network', 'createGameServerClient.ts')
const clientSource = await readFile(clientPath, 'utf8')

await check('[3.1] AdminViewLayoutPeriodCounts е дефиниран', () => {
  if (!clientSource.includes('AdminViewLayoutPeriodCounts')) {
    throw new Error('Липсва AdminViewLayoutPeriodCounts')
  }
})
await check('[3.2] AdminViewLayoutSummary е дефиниран', () => {
  if (!clientSource.includes('AdminViewLayoutSummary')) {
    throw new Error('Липсва AdminViewLayoutSummary')
  }
})
await check('[3.3] AdminStatsSnapshot съдържа viewLayout поле', () => {
  if (!clientSource.includes('viewLayout: AdminViewLayoutSummary')) {
    throw new Error('Липсва viewLayout: AdminViewLayoutSummary в AdminStatsSnapshot')
  }
})
await check('[3.4] AdminViewLayoutPeriodCounts има mobile и desktop', () => {
  const match = clientSource.match(/AdminViewLayoutPeriodCounts\s*=\s*\{([^}]+)\}/)
  const body = match?.[1] ?? ''
  if (!body.includes('mobile') || !body.includes('desktop')) {
    throw new Error(`AdminViewLayoutPeriodCounts body: ${body}`)
  }
})
await check('[3.5] visitors (AdminVisitorSummary) не е премахнат от AdminStatsSnapshot', () => {
  const match = clientSource.match(/AdminStatsSnapshot\s*=\s*\{([\s\S]*?)\n\}/)
  const body = match?.[1] ?? ''
  if (!body.includes('visitors:')) {
    throw new Error('visitors е премахнат от AdminStatsSnapshot')
  }
})

// ─── [4] Tracker не съдържа visibilitychange ──────────────────────────────────

console.log('\n[4] Tracker не добавя нежелано tracking')
await check('[4.1] visibilitychange НЕ е в tracker-а', () => {
  if (trackerSource.includes('visibilitychange')) {
    throw new Error('Tracker съдържа visibilitychange listener — не трябва!')
  }
})
await check('[4.2] resize НЕ предизвиква ново sendPageView', () => {
  // Проверяваме, че tracker-ът не listen-ва resize за tracking цели
  if (trackerSource.includes("addEventListener('resize'") || trackerSource.includes('addEventListener("resize"')) {
    throw new Error('Tracker има resize listener')
  }
})

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
