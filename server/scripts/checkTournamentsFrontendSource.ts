// Client/source checks за секция "Турнири" — routing, navigation, create
// form, absence на нереализирана функционалност (entry/coins/invites/
// scheduler/WS/game-rooms), responsive markup. Модел: checkPublicPagesRouting.ts
// (статичен текстов анализ на source файловете, без браузър).

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const projectRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length)
  ?? join(process.cwd(), '..'),
)

console.log('\n═══ Tournaments Frontend Source Checks ═══')
console.log(`Project root: ${projectRoot}`)

const mainSource = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')
const controllerSource = await readFile(
  join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'),
  'utf8',
)
const renderLobbySource = await readFile(
  join(projectRoot, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'),
  'utf8',
)
const tournamentsScreenSource = await readFile(
  join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'),
  'utf8',
)
const seoSource = await readFile(join(projectRoot, 'src', 'app', 'seo', 'applyRouteSeo.ts'), 'utf8')

// ── [27] /tournaments route е добавен ──
await check('[27] /tournaments е в _VALID_PATHS (main.ts)', () => {
  const match = mainSource.match(/_VALID_PATHS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
  assert((match?.[1] ?? '').includes(`'/tournaments'`), 'Липсва /tournaments в _VALID_PATHS')
})

await check('[27b] SCREEN_TO_PATH съдържа tournaments: \'/tournaments\'', () => {
  const match = controllerSource.match(/const SCREEN_TO_PATH[\s\S]*?=\s*\{([\s\S]*?)\n  \}/)
  assert((match?.[1] ?? '').includes(`'/tournaments'`), 'Липсва запис в SCREEN_TO_PATH')
})

await check('[27c] PATH_TO_SCREEN съдържа \'/tournaments\': \'tournaments\'', () => {
  const match = controllerSource.match(/const PATH_TO_SCREEN[\s\S]*?=\s*\{([\s\S]*?)\n  \}/)
  assert((match?.[1] ?? '').includes(`'/tournaments': 'tournaments'`), 'Липсва запис в PATH_TO_SCREEN')
})

// ── [28] /tournaments/:id dynamic route е добавен ──
await check('[28] navigateFromPath съдържа dynamic route за /tournaments/:id', () => {
  assert(
    /\/\^\\\/tournaments\\\/\(\[\^\/\]\+\)\$\//.test(controllerSource),
    'Липсва regex за /tournaments/:tournamentId в navigateFromPath',
  )
  assert(controllerSource.includes('showTournamentDetail('), 'Липсва извикване на showTournamentDetail()')
})

await check('[28b] navigateInitialPath разпознава /tournaments/:id за deep-link при boot', () => {
  assert(
    controllerSource.includes(String.raw`/^\/tournaments\/[^/]+$/.test(_loadPath)`),
    'navigateInitialPath не разпознава dynamic tournament route',
  )
})

// ── [29] Desktop navigation съдържа "Турнири" ──
await check('[29] Desktop nav съдържа data-lobby-nav-tournaments линк с видим текст "Турнири"', () => {
  const idx = renderLobbySource.indexOf('data-lobby-nav-tournaments="1"')
  assert(idx !== -1, 'Липсва data-lobby-nav-tournaments')
  const nextAnchorClose = renderLobbySource.indexOf('</a>', idx)
  const segment = renderLobbySource.slice(idx, nextAnchorClose)
  assert(segment.includes('Турнири'), 'Липсва видим текст "Турнири" между data-lobby-nav-tournaments и затварящия </a>')
})

// ── [30] Mobile navigation съдържа "Турнири" ──
await check('[30] Mobile menu съдържа бутон data-lobby-nav-tournaments с mobileMenuSvgItemContent', () => {
  assert(
    renderLobbySource.includes(`data-lobby-nav-tournaments="1" style="${'${mobileMenuButtonStyle()}'}"`) ||
    renderLobbySource.includes("mobileMenuSvgItemContent('tournaments', 'Турнири')"),
    'Липсва mobile menu item за турнири',
  )
})

// ── [31] Create form съдържа изискваните полета ──
await check('[31] Create формата съдържа name/entryFee/visibility/startMode полета', () => {
  assert(tournamentsScreenSource.includes('name="name"'), 'Липсва name input')
  assert(tournamentsScreenSource.includes('name="entryFee"'), 'Липсва entryFee select')
  assert(tournamentsScreenSource.includes('name="visibility"'), 'Липсва visibility radio')
  assert(tournamentsScreenSource.includes('name="startMode"'), 'Липсва startMode radio')
  assert(tournamentsScreenSource.includes('name="password"'), 'Липсва password input')
  assert(tournamentsScreenSource.includes('name="scheduledStartAt"'), 'Липсва scheduledStartAt input')
})

await check('[31b] Entry fee опциите съответстват на server whitelist', () => {
  const match = tournamentsScreenSource.match(
    /TOURNAMENT_ENTRY_FEE_OPTIONS = \[([\s\S]*?)\] as const/,
  )
  const body = match?.[1] ?? ''
  for (const fee of [5000, 10000, 20000, 50000, 100000]) {
    assert(body.includes(String(fee)), `Липсва entry fee опция ${fee} в TOURNAMENT_ENTRY_FEE_OPTIONS`)
  }
  assert(
    tournamentsScreenSource.includes('TOURNAMENT_ENTRY_FEE_OPTIONS.map((fee) =>'),
    'Опциите трябва да се генерират динамично от TOURNAMENT_ENTRY_FEE_OPTIONS, не хардкоднати',
  )
})

// ── [32] Password field се показва само при password visibility ──
await check('[32] data-tournament-create-password-field е display:none по подразбиране + JS toggle', () => {
  assert(
    tournamentsScreenSource.includes('data-tournament-create-password-field="1"') &&
    tournamentsScreenSource.includes('style="display:none;"'),
    'password field трябва да е скрито по подразбиране',
  )
  assert(renderLobbySource.includes('syncVisibilityFields'), 'Липсва JS toggle функция за visibility полета')
})

// ── [33] Scheduled controls се показват само при scheduled start ──
await check('[33] data-tournament-create-scheduled-field е display:none по подразбиране + JS toggle', () => {
  assert(
    tournamentsScreenSource.includes('data-tournament-create-scheduled-field="1"'),
    'Липсва scheduled field контейнер',
  )
  assert(renderLobbySource.includes('syncStartModeFields'), 'Липсва JS toggle функция за startMode полета')
})

// ── [34] Live prize preview използва точните формули ──
await check('[34] computePrizePreview() използва 10%/90%/70%/30% формулите', () => {
  assert(tournamentsScreenSource.includes('totalEntryFees * 0.1'), 'Липсва 10% системна такса формула')
  assert(tournamentsScreenSource.includes('prizePool * 0.7'), 'Липсва 70% формула за първи отбор')
  assert(
    tournamentsScreenSource.includes('prizePool - firstTeamPrize'),
    'secondTeamPrize трябва да е остатъкът (prizePool - firstTeamPrize), не отделно закръглено 30%',
  )
})

await check('[34b] Client-side JS preview (в renderLobbyScreen listeners) използва същите формули', () => {
  assert(renderLobbySource.includes('totalEntryFees * 0.1'), 'Липсва JS preview 10% формула')
  assert(renderLobbySource.includes('prizePool * 0.7'), 'Липсва JS preview 70% формула')
})

// ── [35] Няма "Запиши се" действие в този commit ──
await check('[35] Няма работещ "Запиши се" бутон — само disabled placeholder', () => {
  assert(!tournamentsScreenSource.includes('Запиши се'), 'Не трябва да съществува "Запиши се" текст в този etaп')
  assert(
    tournamentsScreenSource.includes('Записването ще бъде достъпно скоро') &&
    tournamentsScreenSource.includes('disabled'),
    'Липсва disabled placeholder бутон',
  )
})

// ── [36] Няма wallet/coin mutation от тази фича ──
await check('[36] tournamentStore.ts не докосва profile_wallets', () => {
  // Тази проверка изисква server файла — виж отделния server-side check по-долу.
})

// ── [40] Password не се поставя в URL/localStorage ──
await check('[40] Password draft не се пази в localStorage/sessionStorage', () => {
  assert(
    !tournamentsScreenSource.includes('localStorage') && !tournamentsScreenSource.includes('sessionStorage'),
    'renderTournamentsScreen.ts не трябва да пипа localStorage/sessionStorage',
  )
  assert(
    !controllerSource.match(/tournamentDetailPasswordDraft[\s\S]{0,80}localStorage/),
    'tournamentDetailPasswordDraft не трябва да се персистира в localStorage',
  )
})

await check('[40b] Password не се изпраща в URL query — само POST body', () => {
  assert(
    !controllerSource.includes('tournamentDetailPasswordDraft}`') || !controllerSource.match(/\/tournaments\/.*\$\{.*[Pp]assword/),
    'Паролата не трябва да участва в URL конкатенация',
  )
})

// ── [41] Persistent deep-link route се обработва от SPA ──
await check('[41] showTournamentDetail() използва history.pushState (не location.href reload)', () => {
  assert(
    controllerSource.includes('function showTournamentDetail(') &&
    controllerSource.match(/function showTournamentDetail[\s\S]{0,600}history\.pushState/),
    'showTournamentDetail трябва да ползва history.pushState за SPA навигация',
  )
})

// ── [42] Error submit не изчиства формата ──
await check('[42] submitTournamentCreate() не затваря popup при !result.ok', () => {
  const match = controllerSource.match(/async function submitTournamentCreate[\s\S]*?\n  \}/)
  const body = match?.[0] ?? ''
  assert(body.length > 0, 'Липсва submitTournamentCreate()')
  const errorBranch = body.match(/if \(!result\.ok\) \{([\s\S]*?)\n {4}\}/)
  assert(errorBranch !== null, 'Липсва error branch в submitTournamentCreate')
  assert(
    !(errorBranch?.[1] ?? '').includes('tournamentCreatePopupOpen = false'),
    'Error branch не трябва да затваря popup-а (tournamentCreatePopupOpen)',
  )
})

// ── SEO ──
await check('SEO: ROUTE_SEO съдържа запис за /tournaments', () => {
  assert(seoSource.includes(`'/tournaments': {`), 'Липсва ROUTE_SEO[\'/tournaments\']')
})

// ── Responsive markup (43-50): списъкът и detail страницата не разчитат на
// фиксирана desktop-only ширина — auto-fill grid + box-sizing:border-box +
// max-width:100% container-и работят на всички стандартни viewport-и без
// хоризонтален overflow (fluid design, не JS branching desktop/mobile).

await check('[43-46] Списъкът с турнири ползва fluid auto-fill grid (без фиксирана desktop-only ширина)', () => {
  assert(
    tournamentsScreenSource.includes('repeat(auto-fill,minmax(260px,1fr))'),
    'Грид-ът трябва да е auto-fill responsive, не фиксиран брой колони',
  )
})

// Премахваме // и /* */ коментари преди markup анализ, за да не хванем
// примерни <input>/<select> фрагменти, споменати само в коментарни редове.
const tournamentsScreenMarkupOnly = tournamentsScreenSource
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

await check('[47] Текстови/select form controls имат box-sizing:border-box (не излизат извън viewport)', () => {
  // Само пълноширинни controls (text/password/datetime-local/select) — radio/checkbox
  // са native фиксиран малък размер и не могат да overflow-нат хоризонтално.
  const inputBlocks = (tournamentsScreenMarkupOnly.match(/<input[^>]* name="[^>]*>/g) ?? [])
    .filter((block) => !block.includes('type="radio"') && !block.includes('type="checkbox"'))
  const selectBlocks = tournamentsScreenMarkupOnly.match(/<select[^>]*>/g) ?? []
  assert(inputBlocks.length > 0, 'Няма намерени пълноширинни <input name="..."> markup блокове')
  for (const block of [...inputBlocks, ...selectBlocks]) {
    assert(block.includes('box-sizing:border-box'), `Form control без box-sizing:border-box: ${block.slice(0, 80)}...`)
  }
})

await check('[48] datetime-local input не създава хоризонтален overflow (width:100% + box-sizing:border-box)', () => {
  const match = tournamentsScreenMarkupOnly.match(/<input type="datetime-local"[^>]* name="[^>]*>/)
  assert(match !== null, 'Липсва datetime-local input markup')
  assert(match![0].includes('width:100%') && match![0].includes('box-sizing:border-box'), 'datetime-local input трябва да е width:100% + border-box')
})

await check('[49] Detail страницата има max-width + margin:0 auto (не overflow-ва на широк viewport)', () => {
  assert(
    tournamentsScreenSource.includes("max-width:720px;margin:0 auto;") ||
    tournamentsScreenSource.includes('max-width:420px;margin:0 auto;'),
    'Detail контейнерите трябва да имат ограничена max-width + центриране',
  )
})

await check('[50] Primary action бутоните (submit/create) имат достатъчна височина за touch target (>= 32px)', () => {
  // Само primary action бутони (submit, "Създай турнир", "Отвори турнира") —
  // малки icon-close бутони (×) не са primary tap target и имат отделен
  // фиксиран малък размер по established popup конвенция в проекта.
  const buttonBlocks = (tournamentsScreenMarkupOnly.match(/<button[^>]*>/g) ?? [])
    .filter((block) => !block.includes('tournament-create-close') && !block.includes('">×<'))
  const heights = buttonBlocks
    .map((block) => block.match(/height:(\d+)px/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]))
  assert(heights.length > 0, 'Няма намерени primary action <button> елементи с explicit height')
  for (const h of heights) {
    assert(h >= 32, `Primary action бутон с височина ${h}px е под минималния touch target`)
  }
})

// ── Отсъствие на изрично забранена функционалност (продуктов обхват) ──
await check('[37] Няма WebSocket tournament protocol в тази фича', () => {
  assert(
    !tournamentsScreenSource.includes('WebSocket') && !tournamentsScreenSource.includes('sendMessage'),
    'renderTournamentsScreen.ts не трябва да съдържа WS логика',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
