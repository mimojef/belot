/**
 * checkSvaraPaidEconomyStage3V2.ts — целеви проверки за Етап 3В.2:
 * платена „Свара“ (удържане при действителния старт, фиксирани условия,
 * изплащане 80/20, идемпотентност, рестарт, без победител).
 *
 * САМО временна локална база (пълният migration runner). Реален runtime +
 * SQLite persistence на „Свара“ + реален svaraEconomyStore; „рестарт“ = ново
 * lobby върху същата база. Платеният режим е изключен по подразбиране —
 * тестът го включва само за собствените си инстанции.
 *
 * Пускане: npx tsx scripts/checkSvaraPaidEconomyStage3V2.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraEconomyStore, isExactSvaraSplit, type SvaraEconomyStore } from '../src/db/svaraEconomyStore.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createPersistentSvaraLobby } from '../src/games/svara/createPersistentSvaraLobby.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { isSvaraPaidMatchesEnabled, participantsIfCommandStartsMatch, reconcileSvaraPaidMatches, type SvaraPaidEconomy } from '../src/games/svara/svaraPaidEconomy.js'
import { getSvaraTableCreationOptions, SVARA_TEST_ENTRY_FEES } from '../src/games/svara/svaraTableCreationOptions.js'
import { pinGameMatchFinancialTerms, SVARA_DEFAULT_FINANCIAL_CONFIG } from '../src/economy/gameFinancialConfig.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 1500)}`}`) }
}

class Clock implements SvaraClock {
  constructor(public time = 1_800_000_000_000) {}
  jobs: Array<{ at: number; active: boolean; callback: () => void }> = []
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const job = { at: this.time + delay, active: true, callback }; this.jobs.push(job)
    return () => { job.active = false }
  }
  defer = (callback: () => void) => this.schedule(callback, 0)
  advance(ms: number) {
    const end = this.time + ms
    for (let count = 0; count < 5_000; count++) {
      const job = this.jobs.filter((j) => j.active && j.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!job) break
      this.time = job.at; job.active = false; job.callback()
    }
    this.time = end
  }
}

process.env.SVARA_TEST_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'svara-paid-3v2-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const economy = await createSvaraEconomyStore(dbPath)
economy.ensureDefaultConfig()

const START = 1_000_000
const profile = (id: string, balance = START) => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, balance)
}
const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
const ledgerRows = (matchId: string) => raw.prepare(`SELECT match_id, profile_id, entry_type, amount FROM svara_match_economy_ledger WHERE match_id LIKE ? ORDER BY rowid`).all(`${matchId}:a%`) as Array<{ match_id: string; profile_id: string; entry_type: string; amount: number }>
const silenceErrors: unknown[] = []

console.log('\n[1] Конфигурация в базата (водещ източник), без презаписване')
{
  const row = raw.prepare(`SELECT config_version, config_json FROM game_financial_configs WHERE game_key = 'svara'`).get() as { config_version: string; config_json: string }
  check('началната конфигурация е създадена (svara-default-v1, 13 входа, 20%)', row.config_version === 'svara-default-v1' && JSON.parse(row.config_json).entryFees.length === 13 && JSON.parse(row.config_json).defaultCommissionBps === 2_000)
  raw.prepare(`UPDATE game_financial_configs SET config_json = ?, config_version = 'admin-v2' WHERE game_key = 'svara'`).run(JSON.stringify({ ...SVARA_DEFAULT_FINANCIAL_CONFIG, configVersion: 'admin-v2', defaultCommissionBps: 2_500 }))
  economy.ensureDefaultConfig()
  const after = raw.prepare(`SELECT config_version FROM game_financial_configs WHERE game_key = 'svara'`).get() as { config_version: string }
  check('повторно създаване на началните стойности НЕ презаписва по-късна промяна', after.config_version === 'admin-v2')
  const active = economy.getActiveConfig()
  check('активната конфигурация идва от базата (25%)', active.ok && active.config.defaultCommissionBps === 2_500)
  raw.prepare(`UPDATE game_financial_configs SET config_json = '{"broken":' WHERE game_key = 'svara'`).run()
  check('повредена конфигурация → fail closed (без награда, без удържане)', !economy.getActiveConfig().ok && economy.previewPrize(5_000, 2) === null)
  const failedCollect = economy.collectEntries({ matchId: 'cfg-broken', entryFee: 5_000, participantIds: ['x1', 'x2'] })
  check('удържане при повредена конфигурация → отказ', !failedCollect.ok && failedCollect.code === 'config-unavailable')
  raw.prepare(`UPDATE game_financial_configs SET config_json = ?, config_version = ? WHERE game_key = 'svara'`).run(JSON.stringify(SVARA_DEFAULT_FINANCIAL_CONFIG), SVARA_DEFAULT_FINANCIAL_CONFIG.configVersion)
}

console.log('\n[2] Точно 20/80 за всички 13 входа × 2/3/4 участници')
{
  let exact = true
  for (const fee of SVARA_TEST_ENTRY_FEES) for (const n of [2, 3, 4]) {
    const pinned = pinGameMatchFinancialTerms(SVARA_DEFAULT_FINANCIAL_CONFIG, { entryFee: fee, paidEntries: n, pinnedAt: 1 })
    if (!pinned.ok || !isExactSvaraSplit(pinned.terms) || pinned.terms.prizes[0]! * 5 !== fee * n * 4 || pinned.terms.siteCommission * 5 !== fee * n) exact = false
    if (economy.previewPrize(fee, n) !== fee * n * 4 / 5) exact = false
  }
  check('награда = 80% и комисиона = 20% точно (39 комбинации), previewPrize съвпада', exact)
  const inexact = pinGameMatchFinancialTerms({ ...SVARA_DEFAULT_FINANCIAL_CONFIG, defaultCommissionBps: 1_234 }, { entryFee: 5_000, paidEntries: 3, pinnedAt: 1 })
  check('конфигурация с неточно съотношение (12,34% × 15 000) → isExactSvaraSplit=false', inexact.ok && !isExactSvaraSplit(inexact.terms))
}

console.log('\n[3] Атомарно удържане (store)')
{
  for (const id of ['s1', 's2', 's3']) profile(id)
  profile('poor', 4_999)
  const insufficient = economy.collectEntries({ matchId: 'm-poor', entryFee: 5_000, participantIds: ['s1', 's2', 'poor'] })
  check('недостатъчен баланс у ЕДИН → отказ с неговия профил', !insufficient.ok && insufficient.code === 'insufficient-balance' && insufficient.profileId === 'poor')
  check('…и никой не е загубил жълтици, няма ledger и финансов ред', balance('s1') === START && balance('s2') === START && balance('poor') === 4_999 && ledgerRows('m-poor').length === 0 && economy.getFinance('m-poor') === null)
  raw.exec(`CREATE TRIGGER fail_third_debit BEFORE INSERT ON svara_match_economy_ledger WHEN NEW.profile_id = 's3' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`)
  const crashed = economy.collectEntries({ matchId: 'm-crash', entryFee: 5_000, participantIds: ['s1', 's2', 's3'] })
  raw.exec('DROP TRIGGER fail_third_debit;')
  check('грешка в базата на 3-тия участник → db-error, пълно връщане назад', !crashed.ok && crashed.code === 'db-error' && balance('s1') === START && balance('s2') === START && ledgerRows('m-crash').length === 0 && economy.getFinance('m-crash') === null)
  const ok = economy.collectEntries({ matchId: 'm-ok', entryFee: 50_000, participantIds: ['s1', 's2', 's3'] })
  check('успех: всички −50 000, 3 debit реда, статус collected', ok.ok && ['s1', 's2', 's3'].every((p) => balance(p) === START - 50_000) && ledgerRows('m-ok').length === 3 && economy.getFinance('m-ok')?.status === 'collected')
  const again = economy.collectEntries({ matchId: 'm-ok', entryFee: 50_000, participantIds: ['s3', 's1', 's2'] })
  check('повторно удържане за същия мач → alreadyCollected, без второ удържане', again.ok && again.alreadyCollected && balance('s1') === START - 50_000 && ledgerRows('m-ok').length === 3)
  check('неразрешен вход → отказ', (() => { const r = economy.collectEntries({ matchId: 'm-x', entryFee: 7_000, participantIds: ['s1', 's2'] }); return !r.ok && r.code === 'entry-fee-not-allowed' })())

  console.log('\n[4] Изплащане 80/20, идемпотентност, фиксирани условия')
  raw.prepare(`UPDATE game_financial_configs SET config_json = ? WHERE game_key = 'svara'`).run(JSON.stringify({ ...SVARA_DEFAULT_FINANCIAL_CONFIG, configVersion: 'admin-v3', defaultCommissionBps: 3_000 }))
  const settle = economy.settleMatch('m-ok', 's2')
  check('промяна на конфигурацията след старта НЕ засяга мача: победителят получава 120 000 (80% от 150 000)', settle.ok && settle.status === 'paid' && settle.prize === 120_000 && balance('s2') === START - 50_000 + 120_000)
  const totalChange = ['s1', 's2', 's3'].reduce((sum, p) => sum + balance(p) - START, 0)
  check('сайтът задържа точно 30 000 (20%)', totalChange === -30_000)
  const twice = economy.settleMatch('m-ok', 's2')
  const thrice = economy.settleMatch('m-ok', 's1')
  check('повторно уреждане (вкл. с друг „победител“) → alreadySettled, без второ изплащане', twice.ok && twice.alreadySettled && thrice.ok && thrice.alreadySettled && balance('s2') === START - 50_000 + 120_000 && balance('s1') === START - 50_000
    && ledgerRows('m-ok').filter((r) => r.entry_type === 'svara_winner_payout').length === 1)
  const refundPaid = economy.refundEntries('m-ok')
  check('връщане след изплащане → no-op', refundPaid.ok && !refundPaid.refunded && balance('s1') === START - 50_000)
  raw.prepare(`UPDATE game_financial_configs SET config_json = ?, config_version = ? WHERE game_key = 'svara'`).run(JSON.stringify(SVARA_DEFAULT_FINANCIAL_CONFIG), SVARA_DEFAULT_FINANCIAL_CONFIG.configVersion)

  console.log('\n[5] Без победител / невалидни условия → за проверка, без движение')
  for (const id of ['h1', 'h2']) profile(id)
  economy.collectEntries({ matchId: 'm-none', entryFee: 5_000, participantIds: ['h1', 'h2'] })
  const none = economy.settleMatch('m-none', null)
  check('няма победител → held(no-winner), никой не получава, комисиона не се „начислява“', none.ok && none.status === 'held' && none.heldReason === 'no-winner' && balance('h1') === START - 5_000 && balance('h2') === START - 5_000
    && ledgerRows('m-none').every((r) => r.entry_type === 'svara_entry_debit'))
  economy.collectEntries({ matchId: 'm-tamper', entryFee: 5_000, participantIds: ['h1', 'h2'] })
  raw.prepare(`UPDATE svara_match_finance SET terms_json = json_set(terms_json, '$.prizes[0]', 9999999) WHERE match_id = 'm-tamper'`).run()
  const tampered = economy.settleMatch('m-tamper', 'h1')
  check('подправени условия → held(invalid-terms), без изплащане', tampered.ok && tampered.status === 'held' && tampered.heldReason === 'invalid-terms' && balance('h1') === START - 10_000)
  economy.collectEntries({ matchId: 'm-stranger', entryFee: 5_000, participantIds: ['h1', 'h2'] })
  const stranger = economy.settleMatch('m-stranger', 'intruder')
  check('победител извън участниците → held(winner-not-participant)', stranger.ok && stranger.heldReason === 'winner-not-participant')

  console.log('\n[6] Технически неуспешен старт → връщане; нов опит за старт')
  for (const id of ['r1', 'r2']) profile(id)
  economy.collectEntries({ matchId: 'm-retry', entryFee: 8_000, participantIds: ['r1', 'r2'] })
  const refund = economy.refundEntries('m-retry')
  const refundAgain = economy.refundEntries('m-retry')
  check('връщане: всички обратно на 1 000 000; повторното → no-op', refund.ok && refund.refunded && refundAgain.ok && !refundAgain.refunded && balance('r1') === START && balance('r2') === START)
  const retry = economy.collectEntries({ matchId: 'm-retry', entryFee: 8_000, participantIds: ['r1', 'r2'] })
  const f = economy.getFinance('m-retry')
  check('нов опит за старт на същата маса → attempt 2, нов ledger scope', retry.ok && f?.attempt === 2 && f.ledgerScope === 'm-retry:a2' && balance('r1') === START - 8_000)
  const paidRetry = economy.settleMatch('m-retry', 'r1')
  check('изплащане по опит 2 → 12 800', paidRetry.ok && paidRetry.prize === 12_800 && balance('r1') === START - 8_000 + 12_800)
}

// ─── Lobby + runtime + persistence ────────────────────────────────────────
type Frames = Map<string, any[]>
function makeLobby(store: Awaited<ReturnType<typeof createSvaraMatchSnapshotStore>>, paidEconomy: SvaraPaidEconomy | undefined, clock: Clock) {
  const lobby = createSvaraLobby({ persistence: store, clock, hasOtherGameCommitment: () => false, onError: (e) => silenceErrors.push(e), ...(paidEconomy ? { paidEconomy } : {}) })
  const frames: Frames = new Map()
  const attach = (id: string) => {
    const session: SvaraAccessSession = { account: { role: 'admin' }, profile: { profileId: id } } as SvaraAccessSession
    frames.set(id, [])
    lobby.attachConnection(id, { profileId: id, getSession: () => session, send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
  }
  return { lobby, frames, attach }
}
const last = (frames: Frames, id: string, type: string) => frames.get(id)!.findLast((f) => f.type === type)

console.log('\n[7] Lobby: удържане при действителния старт (не при създаване)')
const lobbyStore = await createSvaraMatchSnapshotStore(dbPath)
const clock = new Clock()
let matchA = ''
{
  for (const id of ['L1', 'L2', 'L3']) profile(id)
  profile('LPOOR', 1_000)
  const { lobby, frames, attach } = makeLobby(lobbyStore, economy, clock)
  check('възстановяване ready', lobby.initializeRecovery() === 'ready')
  for (const id of ['L1', 'L2', 'L3', 'LPOOR']) attach(id)
  lobby.handle('L1', { type: 'create_svara_table', requestId: randomUUID(), capacity: 3, entryFee: 20_000, entryPercent: 1, startMode: 'auto' } as never)
  const created = last(frames, 'L1', 'svara_table_updated')
  matchA = created.table.matchId
  check('създаване: нищо не е удържано; масата носи сървърната награда 48 000 и paid=true', balance('L1') === START && created.table.prizeAmount === 48_000 && created.table.paid === true)
  lobby.handle('L2', { type: 'join_svara_table', matchId: matchA, requestId: randomUUID() } as never)
  check('второ сядане (не пълни масата): без удържане', balance('L1') === START && balance('L2') === START && economy.getFinance(matchA) === null)
  lobby.handle('LPOOR', { type: 'join_svara_table', matchId: matchA, requestId: randomUUID() } as never)
  const poorError = last(frames, 'LPOOR', 'svara_lobby_error')
  const tableAfterPoor = lobby.findCommitment('LPOOR')
  check('трети с недостатъчно жълтици → insufficient_coins; мачът не започва; никой не губи', poorError?.code === 'insufficient_coins' && tableAfterPoor === null
    && balance('L1') === START && balance('L2') === START && balance('LPOOR') === 1_000 && economy.getFinance(matchA) === null)
  lobby.handle('L3', { type: 'join_svara_table', matchId: matchA, requestId: randomUUID() } as never)
  const saved = lobbyStore.load(matchA)
  check('пълна маса → удържани 3 × 20 000 и мачът е in-progress (записан)', saved?.state.phase === 'in-progress' && ['L1', 'L2', 'L3'].every((p) => balance(p) === START - 20_000) && economy.getFinance(matchA)?.status === 'collected')
  const terms = JSON.parse(economy.getFinance(matchA)!.termsJson)
  check('фиксирани условия: 60 000 фонд, 48 000 награда, 12 000 комисиона', terms.pot === 60_000 && terms.prizes[0] === 48_000 && terms.siteCommission === 12_000 && terms.paidEntries === 3)
  // Активната конфигурация в базата без 5 000 → нова маса с 5 000 се отказва.
  raw.prepare(`UPDATE game_financial_configs SET config_json = ? WHERE game_key = 'svara'`)
    .run(JSON.stringify({ ...SVARA_DEFAULT_FINANCIAL_CONFIG, configVersion: 'no-5000', entryFees: SVARA_DEFAULT_FINANCIAL_CONFIG.entryFees.filter((fee) => fee !== 5_000) }))
  lobby.handle('LPOOR', { type: 'create_svara_table', requestId: randomUUID(), capacity: 2, entryFee: 5_000, entryPercent: 1, startMode: 'auto' } as never)
  check('създаване с вход, премахнат от конфигурацията в базата → paid_unavailable, без маса', last(frames, 'LPOOR', 'svara_lobby_error')?.code === 'paid_unavailable' && lobby.findCommitment('LPOOR') === null)
  raw.prepare(`UPDATE game_financial_configs SET config_json = ? WHERE game_key = 'svara'`).run(JSON.stringify(SVARA_DEFAULT_FINANCIAL_CONFIG))
  lobby.shutdown()
}

console.log('\n[8] Рестарт по време на финансова операция')
{
  // а) удържано, но стартът не е записан (срив между двете) → при старт: връщане.
  for (const id of ['C1', 'C2']) profile(id)
  const rt = (await import('../src/games/svara/runtime/svaraMatchRuntime.js')).createSvaraMatchRuntime({ persistence: lobbyStore, now: clock.now })
  rt.registerMatch({ matchId: 'crash-before-start', creator: { playerId: 'C1' }, capacity: 2, entryFee: 5_000, startMode: 'manual' })
  rt.executeParticipantCommand('crash-before-start', { playerId: 'C2' }, 'j', { type: 'join-seat' })
  economy.collectEntries({ matchId: 'crash-before-start', entryFee: 5_000, participantIds: ['C1', 'C2'] })
  check('преди рестарта: удържано, мачът е още в лобито', balance('C1') === START - 5_000 && lobbyStore.load('crash-before-start')?.state.phase === 'lobby')

  // б) мачът приключва, но уреждането не стига до базата (срив) → при старт: изплащане.
  const noSettle: SvaraPaidEconomy = { ...economy, settleMatch: () => ({ ok: false, message: 'simulated crash before payout' }) }
  const { lobby: crashLobby, frames, attach } = makeLobby(lobbyStore, noSettle, clock)
  crashLobby.initializeRecovery()
  attach('L1'); attach('L2'); attach('L3')
  for (const id of ['L1', 'L2']) crashLobby.handle(id, { type: 'leave_svara_table', matchId: matchA, requestId: randomUUID() } as never)
  clock.advance(10 * 60_000)
  const ended = lobbyStore.load(matchA)
  check('доброволен изход на двама → мачът приключва с победител L3 (правилата на играта)', ended?.state.phase === 'finished' && ended.state.winnerId === 'L3', ended?.state.phase)
  check('уреждането „се срина“ → статусът е още collected, никой не е платен', economy.getFinance(matchA)?.status === 'collected' && balance('L3') === START - 20_000)
  check('доброволно напускане след старта не връща входа', balance('L1') === START - 20_000 && balance('L2') === START - 20_000)
  crashLobby.shutdown()
  void frames

  // „Рестарт“: ново lobby + реалната икономика.
  const restartStore = await createSvaraMatchSnapshotStore(dbPath)
  const { lobby: restarted } = makeLobby(restartStore, economy, new Clock(clock.time))
  check('рестарт: ready', restarted.initializeRecovery() === 'ready')
  check('а) неначенат мач → входовете върнати', economy.getFinance('crash-before-start')?.status === 'refunded' && balance('C1') === START && balance('C2') === START)
  check('б) приключил мач → победителят L3 е платен точно 48 000', economy.getFinance(matchA)?.status === 'paid' && economy.getFinance(matchA)?.winnerProfileId === 'L3' && balance('L3') === START - 20_000 + 48_000)
  restarted.shutdown()
  const again = await createSvaraMatchSnapshotStore(dbPath)
  const { lobby: second } = makeLobby(again, economy, new Clock(clock.time))
  second.initializeRecovery()
  check('втори рестарт → без второ изплащане/връщане', balance('L3') === START - 20_000 + 48_000 && balance('C1') === START
    && ledgerRows(matchA).filter((r) => r.entry_type === 'svara_winner_payout').length === 1 && ledgerRows('crash-before-start').filter((r) => r.entry_type === 'svara_entry_refund').length === 2)
  second.shutdown()
}

console.log('\n[9] Възстановяване: без победител и нечетим мач (reconcile)')
{
  for (const id of ['N1', 'N2', 'U1', 'U2', 'I1', 'I2']) profile(id)
  economy.collectEntries({ matchId: 'r-none', entryFee: 5_000, participantIds: ['N1', 'N2'] })
  economy.collectEntries({ matchId: 'r-unreadable', entryFee: 5_000, participantIds: ['U1', 'U2'] })
  economy.collectEntries({ matchId: 'r-progress', entryFee: 5_000, participantIds: ['I1', 'I2'] })
  const views: Record<string, any> = {
    'r-none': { kind: 'state', phase: 'finished', winnerId: null },
    'r-unreadable': { kind: 'unreadable' },
    'r-progress': { kind: 'state', phase: 'in-progress', winnerId: null },
  }
  const report = reconcileSvaraPaidMatches(economy, (id) => views[id] ?? { kind: 'state', phase: 'in-progress', winnerId: null })
  check('приключил без победител → held(no-winner), без движение', economy.getFinance('r-none')?.heldReason === 'no-winner' && balance('N1') === START - 5_000 && balance('N2') === START - 5_000)
  check('нечетим мач → held(match-unrecoverable), без автоматично връщане', economy.getFinance('r-unreadable')?.heldReason === 'match-unrecoverable' && balance('U1') === START - 5_000)
  check('мач, който тече → без промяна', economy.getFinance('r-progress')?.status === 'collected' && report.continuing.includes('r-progress'))
}

console.log('\n[10] Флаг, тестови ботове, интерфейс')
{
  const previous = process.env.SVARA_PAID_MATCHES_ENABLED
  delete process.env.SVARA_PAID_MATCHES_ENABLED
  check('платената „Свара“ е ИЗКЛЮЧЕНА по подразбиране', isSvaraPaidMatchesEnabled() === false)
  const off = await createPersistentSvaraLobby({ databaseFilePath: dbPath, hasOtherGameCommitment: () => false, clock: new Clock() })
  check('изключен флаг → виртуален режим (paid=false), сървърна награда 80%', off.lobby.creationPrize.paid === false && off.lobby.creationPrize.prizeFor(5_000, 3) === 12_000)
  off.lobby.shutdown(); off.close()
  process.env.SVARA_PAID_MATCHES_ENABLED = '1'
  const on = await createPersistentSvaraLobby({ databaseFilePath: dbPath, hasOtherGameCommitment: () => false, clock: new Clock() })
  check('включен флаг → paid=true, наградата от базата', on.lobby.creationPrize.paid === true && on.lobby.creationPrize.prizeFor(200_000, 4) === 640_000)
  on.lobby.shutdown(); on.close()
  if (previous === undefined) delete process.env.SVARA_PAID_MATCHES_ENABLED; else process.env.SVARA_PAID_MATCHES_ENABLED = previous

  const options = getSvaraTableCreationOptions({ paid: true, prizeFor: (fee, n) => economy.previewPrize(fee, n) })
  check('HTTP настройки: prizeByCapacity за всеки вход (сървърни стойности)', options.paid === true && options.entries.every((e) => e.prizeByCapacity?.[2] === e.entryFee * 8 / 5 && e.prizeByCapacity?.[4] === e.entryFee * 16 / 5))
  check('без prize → без награди (клиентът не смята сам)', getSvaraTableCreationOptions().entries.every((e) => !('prizeByCapacity' in e)))
  const table = { matchId: 'x', phase: 'lobby', capacity: 3, creatorId: 'a', startMode: 'auto', entryFee: 5_000, entryPercent: 1, startingChips: 500, entryChips: 5, players: [{ playerId: 'a', status: 'active' }, { playerId: 'b', status: 'active' }] } as never
  check('стартира ли командата: третото сядане на auto маса — да; второто — не', participantsIfCommandStartsMatch(table, 'c', 'join-seat')?.length === 3 && participantsIfCommandStartsMatch({ ...(table as object), players: [{ playerId: 'a', status: 'active' }] } as never, 'b', 'join-seat') === null)
  const client = readFileSync(join(import.meta.dirname, '../../src/app/games/svara/createSvaraLobbyController.ts'), 'utf8')
  check('клиентът не смята наградата сам (без „× 4 / 5“)', !client.includes('* 4 / 5') && client.includes('table.prizeAmount') && client.includes('prizeByCapacity'))
  const lobbySrc = readFileSync(join(import.meta.dirname, '../src/games/svara/createSvaraLobby.ts'), 'utf8')
  check('платените маси не приемат тестови ботове', lobbySrc.includes("if (paidMode) { reject('not_allowed'); return } // Етап 3В.2"))
}

console.log('\n[11] Белот / Ludo / турнири — без промени')
{
  const { execFileSync } = await import('node:child_process')
  const diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src/db/matchEconomyStore.ts', 'src/db/ludoEconomyStore.ts', 'src/db/tournamentEconomyStore.ts', 'src/tournament', 'src/economy/gameFinancialConfig.ts', 'src/economy/prizeFormula.ts'],
    { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' }).trim()
  check('икономиките на Белот/Ludo/турнири и формулите — непроменени (двигателят на „Свара“ се променя в 4Б по замисъл)', diff === '', diff)
}

raw.close()
economy.close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows */ }
console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)

export type { SvaraEconomyStore }
