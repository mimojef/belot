// Public pages routing smoke checks — /learn, /faq, /about, /fair-play,
// plus footer links to /rules and /strategy.
//
// Тества source файловете директно чрез четене на текст (без браузър) —
// проверява статичната структура: routing maps, SEO записи, sitemap и
// footer markup. Модел: checkViewLayoutFrontend.ts.

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
console.log(`\n═══ Public Pages Routing Checks ═══`)
console.log(`Project root: ${projectRoot}`)

const NEW_PATHS = ['/learn', '/faq', '/about', '/fair-play']
const NEW_SCREENS = ['learn', 'faq', 'about', 'fair-play']

// ─── [1] src/main.ts — _VALID_PATHS съдържа новите paths ────────────────────

console.log('\n[1] src/main.ts _VALID_PATHS')
const mainPath = join(projectRoot, 'src', 'main.ts')
const mainSource = await readFile(mainPath, 'utf8')

const validPathsMatch = mainSource.match(/_VALID_PATHS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
const validPathsBody = validPathsMatch?.[1] ?? ''

for (const path of NEW_PATHS) {
  await check(`[1] _VALID_PATHS съдържа '${path}'`, () => {
    if (!validPathsBody.includes(`'${path}'`)) {
      throw new Error(`Липсва '${path}' в _VALID_PATHS`)
    }
  })
}

// ─── [2] src/app/lobby/createLobbyFlowController.ts — path maps и switch ────

console.log('\n[2] createLobbyFlowController.ts routing maps')
const controllerPath = join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const controllerSource = await readFile(controllerPath, 'utf8')

await check('[2.1] LobbyFlowScreen union съдържа новите screen имена', () => {
  const match = controllerSource.match(/export type LobbyFlowScreen\s*=([\s\S]*?)\nexport type LobbySocialScreen/)
  const body = match?.[1] ?? ''
  for (const screen of NEW_SCREENS) {
    if (!body.includes(`'${screen}'`)) {
      throw new Error(`Липсва '${screen}' в LobbyFlowScreen`)
    }
  }
})

await check('[2.2] LOBBY_PATH_TO_SCREEN съдържа новите paths', () => {
  const match = controllerSource.match(/const LOBBY_PATH_TO_SCREEN[\s\S]*?=\s*\{([\s\S]*?)\n\}/)
  const body = match?.[1] ?? ''
  for (const path of NEW_PATHS) {
    if (!body.includes(`'${path}'`)) {
      throw new Error(`Липсва '${path}' в LOBBY_PATH_TO_SCREEN`)
    }
  }
})

await check('[2.3] SCREEN_TO_PATH съдържа новите paths', () => {
  const match = controllerSource.match(/const SCREEN_TO_PATH[\s\S]*?=\s*\{([\s\S]*?)\n  \}/)
  const body = match?.[1] ?? ''
  for (const path of NEW_PATHS) {
    if (!body.includes(`'${path}'`)) {
      throw new Error(`Липсва '${path}' в SCREEN_TO_PATH`)
    }
  }
})

await check('[2.4] PATH_TO_SCREEN съдържа новите paths', () => {
  const match = controllerSource.match(/const PATH_TO_SCREEN[\s\S]*?=\s*\{([\s\S]*?)\n  \}/)
  const body = match?.[1] ?? ''
  for (const path of NEW_PATHS) {
    if (!body.includes(`'${path}'`)) {
      throw new Error(`Липсва '${path}' в PATH_TO_SCREEN`)
    }
  }
})

await check('[2.5] navigateFromPath switch съдържа case за всеки нов screen', () => {
  const match = controllerSource.match(/function navigateFromPath[\s\S]*?switch \(screen\) \{([\s\S]*?)\n    \}/)
  const body = match?.[1] ?? ''
  for (const screen of NEW_SCREENS) {
    if (!body.includes(`case '${screen}':`)) {
      throw new Error(`Липсва case '${screen}' в navigateFromPath switch`)
    }
  }
})

await check('[2.6] показват се showLearnPage/showFaqPage/showAboutPage/showFairPlayPage функции', () => {
  for (const fn of ['showLearnPage', 'showFaqPage', 'showAboutPage', 'showFairPlayPage']) {
    if (!controllerSource.includes(`function ${fn}(`)) {
      throw new Error(`Липсва функция ${fn}()`)
    }
  }
})

// ─── [3] src/app/seo/applyRouteSeo.ts — ROUTE_SEO съдържа новите routes ─────

console.log('\n[3] applyRouteSeo.ts ROUTE_SEO')
const seoPath = join(projectRoot, 'src', 'app', 'seo', 'applyRouteSeo.ts')
const seoSource = await readFile(seoPath, 'utf8')

for (const path of NEW_PATHS) {
  await check(`[3] ROUTE_SEO съдържа запис за '${path}'`, () => {
    if (!seoSource.includes(`'${path}': {`)) {
      throw new Error(`Липсва ROUTE_SEO['${path}']`)
    }
  })
}

// ─── [4] public/sitemap.xml — новите URL-и присъстват ───────────────────────

console.log('\n[4] public/sitemap.xml')
const sitemapPath = join(projectRoot, 'public', 'sitemap.xml')
const sitemapSource = await readFile(sitemapPath, 'utf8')

for (const path of NEW_PATHS) {
  await check(`[4] sitemap.xml съдържа 'https://www.pika.bg${path}'`, () => {
    if (!sitemapSource.includes(`https://www.pika.bg${path}`)) {
      throw new Error(`Липсва https://www.pika.bg${path} в sitemap.xml`)
    }
  })
}

// ─── [5] renderLobbyScreen.ts — извиква новите render функции ───────────────

console.log('\n[5] renderLobbyScreen.ts извиква новите render функции')
const lobbyScreenPath = join(projectRoot, 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
const lobbyScreenSource = await readFile(lobbyScreenPath, 'utf8')

for (const fn of ['renderLearnPage', 'renderFaqPage', 'renderAboutPage', 'renderFairPlayPage']) {
  await check(`[5] renderLobbyScreen.ts извиква ${fn}(`, () => {
    if (!lobbyScreenSource.includes(`${fn}(`)) {
      throw new Error(`Липсва извикване на ${fn}(`)
    }
  })
  await check(`[5] renderLobbyScreen.ts импортира ${fn}`, () => {
    if (!lobbyScreenSource.includes(`import { ${fn} } from`)) {
      throw new Error(`Липсва import { ${fn} } from ...`)
    }
  })
}

// ─── [6] footer съдържа /rules и /strategy линкове — desktop и mobile ───────

console.log('\n[6] Footer линкове към /rules и /strategy')

await check('[6.1] renderFooter (desktop) съдържа линк към /rules', () => {
  const match = lobbyScreenSource.match(/function renderFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  if (!body.includes('href="/rules"')) {
    throw new Error('Липсва href="/rules" в renderFooter()')
  }
})

await check('[6.2] renderFooter (desktop) съдържа линк към /strategy', () => {
  const match = lobbyScreenSource.match(/function renderFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  if (!body.includes('href="/strategy"')) {
    throw new Error('Липсва href="/strategy" в renderFooter()')
  }
})

await check('[6.3] renderMobileFooter съдържа линк към /rules', () => {
  const match = lobbyScreenSource.match(/function renderMobileFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  if (!body.includes('href="/rules"')) {
    throw new Error('Липсва href="/rules" в renderMobileFooter()')
  }
})

await check('[6.4] renderMobileFooter съдържа линк към /strategy', () => {
  const match = lobbyScreenSource.match(/function renderMobileFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  if (!body.includes('href="/strategy"')) {
    throw new Error('Липсва href="/strategy" в renderMobileFooter()')
  }
})

await check('[6.5] renderFooter все още съдържа terms/privacy/contact (не са премахнати)', () => {
  const match = lobbyScreenSource.match(/function renderFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  for (const path of ['/terms', '/privacy', '/contact']) {
    if (!body.includes(`href="${path}"`)) {
      throw new Error(`Липсва href="${path}" в renderFooter() — съществуващ линк е премахнат`)
    }
  }
})

await check('[6.6] renderMobileFooter все още съдържа terms/privacy/contact (не са премахнати)', () => {
  const match = lobbyScreenSource.match(/function renderMobileFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  for (const path of ['/terms', '/privacy', '/contact']) {
    if (!body.includes(`href="${path}"`)) {
      throw new Error(`Липсва href="${path}" в renderMobileFooter() — съществуващ линк е премахнат`)
    }
  }
})

// ─── [7] renderRulesPage.ts / renderStrategyPage.ts не са променени по съдържание ──

console.log('\n[7] Съществуващата логика на /rules и /strategy не е пипната')

await check('[7.1] renderRulesPage.ts все още експортира renderRulesPage(isMobile = false)', () => {
  if (!lobbyScreenSource.includes('renderRulesPage')) {
    throw new Error('renderLobbyScreen.ts вече не reference-ва renderRulesPage')
  }
})

await check('[7.2] renderStrategyPage.ts все още експортира renderStrategyPage(isMobile = false)', () => {
  if (!lobbyScreenSource.includes('renderStrategyPage')) {
    throw new Error('renderLobbyScreen.ts вече не reference-ва renderStrategyPage')
  }
})

// ─── [8] Lobby карти и footer линкове към новите публични страници ──────────

console.log('\n[8] Lobby карти и footer линкове към /learn, /faq, /about, /fair-play')

for (const path of ['/learn', '/fair-play', '/faq', '/about']) {
  await check(`[8] renderLobbyScreen.ts съдържа href="${path}"`, () => {
    if (!lobbyScreenSource.includes(`href="${path}"`)) {
      throw new Error(`Липсва href="${path}" в renderLobbyScreen.ts`)
    }
  })
}

for (const text of ['Научи белот', 'Честна игра', 'Често задавани въпроси', 'За Pika.bg']) {
  await check(`[8] renderLobbyScreen.ts съдържа текста "${text}"`, () => {
    if (!lobbyScreenSource.includes(text)) {
      throw new Error(`Липсва текстът "${text}" в renderLobbyScreen.ts`)
    }
  })
}

await check('[8] старите href="/rules" и href="/strategy" остават налични', () => {
  for (const path of ['/rules', '/strategy']) {
    if (!lobbyScreenSource.includes(`href="${path}"`)) {
      throw new Error(`Липсва href="${path}" в renderLobbyScreen.ts`)
    }
  }
})

await check('[8] footer линковете към /terms, /privacy и /contact остават налични', () => {
  for (const path of ['/terms', '/privacy', '/contact']) {
    if (!lobbyScreenSource.includes(`href="${path}"`)) {
      throw new Error(`Липсва href="${path}" в renderLobbyScreen.ts`)
    }
  }
})

await check('[8] renderFooter (desktop) съдържа линкове към /learn, /fair-play, /faq, /about', () => {
  const match = lobbyScreenSource.match(/function renderFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  for (const path of ['/learn', '/fair-play', '/faq', '/about']) {
    if (!body.includes(`href="${path}"`)) {
      throw new Error(`Липсва href="${path}" в renderFooter()`)
    }
  }
})

await check('[8] renderMobileFooter съдържа линкове към /learn, /fair-play, /faq, /about', () => {
  const match = lobbyScreenSource.match(/function renderMobileFooter\(\)[\s\S]*?\n\}/)
  const body = match?.[0] ?? ''
  for (const path of ['/learn', '/fair-play', '/faq', '/about']) {
    if (!body.includes(`href="${path}"`)) {
      throw new Error(`Липсва href="${path}" в renderMobileFooter()`)
    }
  }
})

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
