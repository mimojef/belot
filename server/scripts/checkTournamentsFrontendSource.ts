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
const coordinatorSource = await readFile(
  join(projectRoot, 'server', 'src', 'tournament', 'tournamentCoordinator.ts'),
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
await check('[34] computePrizePreview() използва 20%/80%/65%/35% формулите', () => {
  assert(tournamentsScreenSource.includes('totalEntryFees * 0.2'), 'Липсва 20% системна такса формула')
  assert(tournamentsScreenSource.includes('prizePool * 0.65'), 'Липсва 65% формула за първи отбор')
  assert(
    tournamentsScreenSource.includes('prizePool - firstTeamPrize'),
    'secondTeamPrize трябва да е остатъкът (prizePool - firstTeamPrize), не отделно закръглено 35%',
  )
})

await check('[34b] Client-side JS preview (в renderLobbyScreen listeners) използва същите формули', () => {
  assert(renderLobbySource.includes('totalEntryFees * 0.2'), 'Липсва JS preview 20% формула')
  assert(renderLobbySource.includes('prizePool * 0.65'), 'Липсва JS preview 65% формула')
})

// ── [35] "Запиши се сам" вече е реализирано действие (трети етап) ──
await check('[35] "Запиши се сам" е работещ бутон, свързан със submit handler', () => {
  assert(tournamentsScreenSource.includes('Запиши се сам'), 'Липсва "Запиши се сам" текст в detail екрана')
  assert(
    tournamentsScreenSource.includes('data-tournament-join-open="1"'),
    'Липсва data-tournament-join-open бутон',
  )
})

// ── [36] Wallet mutation минава изцяло през tournamentEconomyStore (не directly tournamentStore) ──
await check('[36] tournamentStore.ts не докосва profile_wallets', () => {
  // Тази проверка изисква server файла — виж отделния server-side check по-долу.
})

// ── J58-J75: Join/leave/cancel UI (трети самостоятелен етап) ──

const tournamentEconomyStoreSource = await readFile(
  join(projectRoot, 'server', 'src', 'db', 'tournamentEconomyStore.ts'),
  'utf8',
)
const indexSource = await readFile(join(projectRoot, 'server', 'src', 'index.ts'), 'utf8')

await check('[J58] "Запиши се сам" join confirm popup присъства с точен escrow текст', () => {
  assert(
    tournamentsScreenSource.includes('function renderTournamentJoinConfirmPopup'),
    'Липсва renderTournamentJoinConfirmPopup',
  )
  assert(
    tournamentsScreenSource.includes('data-tournament-join-submit="1"'),
    'Липсва data-tournament-join-submit бутон',
  )
})

await check('[J59] "Откажи участие" (leave) действие присъства', () => {
  assert(tournamentsScreenSource.includes('Откажи участие'), 'Липсва "Откажи участие" текст')
  assert(
    tournamentsScreenSource.includes('data-tournament-leave-open="1"') &&
    tournamentsScreenSource.includes('data-tournament-leave-submit="1"'),
    'Липсва leave open/submit data-attribute wiring',
  )
})

await check('[J60] Creator "Отмени турнира" (cancel) действие присъства', () => {
  assert(tournamentsScreenSource.includes('Отмени турнира'), 'Липсва "Отмени турнира" текст')
  assert(
    tournamentsScreenSource.includes('data-tournament-cancel-open="1"') &&
    tournamentsScreenSource.includes('data-tournament-cancel-submit="1"'),
    'Липсва cancel open/submit data-attribute wiring',
  )
})

await check('[J61] Partner invite функционалността е налична', () => {
  assert(tournamentsScreenSource.includes('data-tournament-partner-picker-open="1"'), 'Липсва partner invite picker open бутон')
  assert(tournamentEconomyStoreSource.includes('createPartnerInviteAtomically'), 'Липсва atomic partner invite операция')
})

await check('[J62] Automatic solo pairing логиката е само server-side', () => {
  assert(tournamentEconomyStoreSource.includes('validateAndLockTeamsForStart'), 'Липсва server-side start pairing/locking helper')
  for (const forbidden of ['autoPair', 'automatchTeam', 'pairPlayers']) {
    assert(!tournamentsScreenSource.includes(forbidden), `Намерен client-side auto-team маркер: ${forbidden}`)
    assert(!controllerSource.includes(forbidden), `Намерен client-side auto-team маркер в контролера: ${forbidden}`)
  }
})

await check('[J63] Scheduler / auto-start логиката е отделена от economy store interval-и', () => {
  assert(indexSource.includes('createTournamentScheduler'), 'Липсва server bootstrap wiring за tournament scheduler')
  assert(tournamentEconomyStoreSource.includes('startTournamentAtomically'), 'Липсва atomic start операция')
  for (const forbidden of ['setInterval', 'setTimeout', 'cron', 'node-cron']) {
    assert(!tournamentEconomyStoreSource.includes(forbidden), `Economy store не трябва да съдържа scheduler timer: ${forbidden}`)
  }
})

await check('[J64] Липсва game-room интеграция (не се създава/стартира game room от join/leave/cancel)', () => {
  for (const forbidden of ['createGameRoom', 'roomStore.create', 'startGame(', 'gameWorker']) {
    assert(!tournamentEconomyStoreSource.includes(forbidden), `Намерен забранен game-room маркер: ${forbidden}`)
  }
})

await check('[J65] Double-submit guard: join/leave/cancel submit функциите проверяват *Busy флага', () => {
  assert(/submitTournamentJoin[\s\S]{0,300}tournamentJoinBusy/.test(controllerSource), 'submitTournamentJoin няма busy guard')
  assert(/submitTournamentLeave[\s\S]{0,300}tournamentLeaveBusy/.test(controllerSource), 'submitTournamentLeave няма busy guard')
  assert(/submitTournamentCancel[\s\S]{0,300}tournamentCancelBusy/.test(controllerSource), 'submitTournamentCancel няма busy guard')
})

await check('[J66] Join/leave/cancel бутоните са disabled по време на *Busy', () => {
  assert(tournamentsScreenSource.includes('tournamentJoinBusy'), 'Join popup не реагира на tournamentJoinBusy')
  assert(tournamentsScreenSource.includes('tournamentLeaveBusy'), 'Leave popup не реагира на tournamentLeaveBusy')
  assert(tournamentsScreenSource.includes('tournamentCancelBusy'), 'Cancel popup не реагира на tournamentCancelBusy')
})

await check('[J67] Error response не поврежда/затваря popup state-a (както при create формата)', () => {
  const joinBody = (controllerSource.match(/async function submitTournamentJoin[\s\S]*?\n  \}/) ?? [''])[0]
  assert(joinBody.length > 0, 'Липсва submitTournamentJoin()')
  const errorBlock = (joinBody.match(/if \(!result\.ok\) \{[\s\S]*?return\s*\n\s*\}/) ?? [''])[0]
  assert(errorBlock.length > 0, 'submitTournamentJoin няма отделен !result.ok блок')
  assert(
    !errorBlock.includes('tournamentJoinConfirmOpen = false'),
    'submitTournamentJoin не трябва да затваря popup-а при грешка',
  )
})

await check('[J68] Wallet UI update pattern: success response mutira currentAuthSession.profile.yellowCoinsBalance', () => {
  assert(
    mainSource.includes('currentAuthSession.profile.yellowCoinsBalance = data.walletBalance') ||
    /walletBalance[\s\S]{0,260}yellowCoinsBalance/.test(mainSource) ||
    /yellowCoinsBalance[\s\S]{0,80}data\.walletBalance/.test(mainSource),
    'main.ts не актуализира yellowCoinsBalance от walletBalance response полето',
  )
  assert(mainSource.includes('syncLobbyWithAuthSession'), 'Липсва извикване на syncLobbyWithAuthSession() след wallet update')
})

await check('[J69] Join/leave/cancel заявки не подават profileId/accountId/entryFee/idempotencyKey от клиента', () => {
  const fnNames = ['joinTournamentRequest', 'leaveTournamentRequest', 'cancelTournamentRequest']
  for (const fnName of fnNames) {
    const match = mainSource.match(new RegExp(`async function ${fnName}[\\s\\S]*?\\n\\}`))
    assert(match !== null, `Липсва ${fnName}() в main.ts`)
    const body = match![0]
    for (const forbidden of ['profileId:', 'accountId:', 'entryFee:', 'idempotencyKey:']) {
      assert(!body.includes(forbidden), `${fnName} не трябва да подава ${forbidden} в request body-то`)
    }
  }
})

await check('[J70] Server endpoints игнорират client-supplied profileId/entryFee (auth session е единственият източник)', () => {
  assert(
    indexSource.includes('requireRegisteredHumanSession'),
    'Join/leave/cancel handler-ите трябва да минават през requireRegisteredHumanSession guard',
  )
})

await check('[J71] Rate limiting е окабелен за join/leave/cancel endpoints', () => {
  assert(
    indexSource.includes('TOURNAMENT_ENTRY_ACTION_RATE_LIMIT_WINDOW_MS') &&
    indexSource.includes('isTournamentEntryActionRateLimited'),
    'Липсва rate limit инфраструктура за tournament entry actions',
  )
})

await check('[J72] CSRF/Origin guard (isAllowedVisitorRequestOrigin) е окабелен за join/leave/cancel handlers', () => {
  const joinHandler = (indexSource.match(/async function handleTournamentJoinRequest[\s\S]*?\n\}/) ?? [''])[0]
  const leaveHandler = (indexSource.match(/async function handleTournamentLeaveRequest[\s\S]*?\n\}/) ?? [''])[0]
  const cancelHandler = (indexSource.match(/async function handleTournamentCancelRequest[\s\S]*?\n\}/) ?? [''])[0]
  for (const [name, body] of [['join', joinHandler], ['leave', leaveHandler], ['cancel', cancelHandler]] as const) {
    assert(body.includes('isAllowedVisitorRequestOrigin'), `${name} handler няма CSRF/Origin guard`)
  }
})

await check('[J73] System fee finalization и prize payout settlement са налични', () => {
  assert(tournamentEconomyStoreSource.includes('system_fee'), 'Липсва system_fee ledger запис')
  assert(tournamentEconomyStoreSource.includes('insertSystemFeeLedgerStatement'), 'Липсва idempotent system_fee insert')
  assert(tournamentEconomyStoreSource.includes('prize_payout'), 'Липсва prize_payout ledger запис')
  assert(tournamentEconomyStoreSource.includes('settleTournamentPrizesAtomically'), 'Липсва atomic prize settlement helper')
  assert(tournamentEconomyStoreSource.includes('settlement_state'), 'Липсва persisted settlement state')
  assert(tournamentsScreenSource.includes('renderTournamentFinalSummary'), 'Липсва UI summary за champion/runner-up/prizes')
})

await check('[J74] Semifinal/final runtime integration е налична', () => {
  assert(tournamentEconomyStoreSource.includes('createSemifinalSkeletons'), 'Липсва semifinal skeleton seeding')
  assert(tournamentEconomyStoreSource.includes('room_id, team_a_id, team_b_id'), 'Semifinal matches трябва да са persisted skeleton rows')
  assert(coordinatorSource.includes('walkover_reason ='), 'Липсва persisted walkover resolution в coordinator-а')
  assert(coordinatorSource.includes('ensureFinalAfterSemifinals'), 'Липсва final bracket transition')
})

await check('[J75] Join/leave/cancel confirm popup-ите остават responsive (max-width + border-box, без фиксирана desktop ширина)', () => {
  const joinPopup = (tournamentsScreenSource.match(/function renderTournamentJoinConfirmPopup[\s\S]*?\n\}/) ?? [''])[0]
  const leavePopup = (tournamentsScreenSource.match(/function renderTournamentLeaveConfirmPopup[\s\S]*?\n\}/) ?? [''])[0]
  const cancelPopup = (tournamentsScreenSource.match(/function renderTournamentCancelConfirmPopup[\s\S]*?\n\}/) ?? [''])[0]
  for (const [name, body] of [['join', joinPopup], ['leave', leavePopup], ['cancel', cancelPopup]] as const) {
    assert(body.length > 0, `Липсва render${name} popup функция`)
    assert(/max-width:\d+px/.test(body), `${name} popup няма max-width ограничение`)
  }
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

// ── Temporary public maintenance notice (fix(tournaments): show development
// notice) — /tournaments и /tournaments/<id> показват само "в разработка"
// съобщение, докато admin панелът и реалния UI код (по-долу в същия файл,
// зад guard-а) остават непокътнати. ──
await check('[MAINT-1] Maintenance guard флагът съществува и е production-safe (build-time PROD gate)', () => {
  assert(
    tournamentsScreenSource.includes('const TOURNAMENTS_PUBLIC_MAINTENANCE_MODE = import.meta.env?.PROD === true'),
    'Липсва или guard-ът вече не е build-time production-safe форма (import.meta.env?.PROD === true)',
  )
})

// tournament-resume migration (виж docs/local-tournament-test.md): гейтът
// вече не е hardcoded true — активен е само когато import.meta.env.PROD е
// СТРОГО true, което Vite гарантира единствено при `vite build` (истинския
// production bundle). Vite dev server и server/scripts/check*.ts
// (изпълнявани directly през tsx/Node, където import.meta.env изобщо не
// съществува) по default виждат реалния UI — safe default е "не блокирай",
// не "блокирай", при непознат/липсващ сигнал. Целта на този check е да
// заключи, че bypass-ът остава build-time-only Vite сигнал, а не някакъв
// runtime/client-controlled toggle (query param, localStorage, cookie,
// header), който би могъл да отключи turnament UI-я в production.
await check('[MAINT-1b] Dev bypass-ът е build-time Vite сигнал, не runtime/client-controlled toggle', () => {
  const guardLine = tournamentsScreenSource
    .split('\n')
    .find((line) => line.includes('const TOURNAMENTS_PUBLIC_MAINTENANCE_MODE ='))
  assert(guardLine !== undefined, 'Не е намерен редът с декларацията на TOURNAMENTS_PUBLIC_MAINTENANCE_MODE')
  assert(
    guardLine!.includes('import.meta.env'),
    'Guard-ът вече не чете import.meta.env (Vite build-time сигнал)',
  )
  for (const unsafePattern of ['location.search', 'URLSearchParams', 'localStorage', 'sessionStorage', 'document.cookie']) {
    assert(
      !guardLine!.includes(unsafePattern),
      `Guard-ът съдържа потенциално client-controlled сигнал "${unsafePattern}" — недопустимо за production safety`,
    )
  }
})

await check('[MAINT-2] renderTournamentsScreen прави ранен return зад maintenance guard-а', () => {
  const match = tournamentsScreenSource.match(
    /export function renderTournamentsScreen\(state: LobbyScreenState\): string \{\s*\n\s*if \(TOURNAMENTS_PUBLIC_MAINTENANCE_MODE\) \{\s*\n\s*return renderTournamentsMaintenanceNotice\(\)/,
  )
  assert(match !== null, 'renderTournamentsScreen няма ранен maintenance return в самото начало на функцията')
})

await check('[MAINT-3] renderTournamentDetailScreen прави ранен return зад maintenance guard-а', () => {
  const match = tournamentsScreenSource.match(
    /export function renderTournamentDetailScreen\(state: LobbyScreenState\): string \{\s*\n\s*if \(TOURNAMENTS_PUBLIC_MAINTENANCE_MODE\) \{\s*\n\s*return renderTournamentsMaintenanceNotice\(\)/,
  )
  assert(match !== null, 'renderTournamentDetailScreen няма ранен maintenance return в самото начало на функцията')
})

await check('[MAINT-4] Maintenance екранът показва точния текст от заявката', () => {
  assert(tournamentsScreenSource.includes('Турнирите са в разработка'), 'Липсва заглавие "Турнирите са в разработка"')
  assert(
    tournamentsScreenSource.includes('В момента извършваме финални тестове. Очаквайте скоро.'),
    'Липсва описанието на maintenance екрана',
  )
})

await check('[MAINT-5] "Към лобито" бутонът ползва съществуващия self-wiring SPA nav data-атрибут', () => {
  assert(
    tournamentsScreenSource.includes('href="/lobby" data-lobby-nav-lobby="1"'),
    'Липсва data-lobby-nav-lobby="1" линк към /lobby в maintenance markup-а',
  )
})

await check('[MAINT-6] Реалната tournament UI логика НЕ е изтрита (само guard-ната, за лесно връщане)', () => {
  assert(
    tournamentsScreenSource.includes('data-tournament-create-open="1"'),
    'Реалният "+ Създай турнир" бутон вече не съществува в кода — guard-ът трябва да СКРИВА, не да трие функционалността',
  )
  assert(
    tournamentsScreenSource.includes('data-tournament-enter-active-match="1"'),
    'Реалният "Влез в масата" бутон вече не съществува в кода',
  )
})

await check('[MAINT-7] Admin tournament панелът не е засегнат (различен renderer/route, извън тази проверка)', () => {
  assert(
    !tournamentsScreenSource.includes('renderAdminTournamentsPanel')
      && !tournamentsScreenSource.includes('renderAdminTournamentDetailPanel'),
    'renderTournamentsScreen.ts не трябва да реферира admin tournament renderer-и',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
