/**
 * checkSvaraEntryBalanceSeat.ts — недостатъчен баланс за входа в платена „Свара“.
 *
 *  [1] Създаване / сядане без достатъчно жълтици → отказ, без място и без удържане.
 *  [2] Загуба на жълтици по време на чакане, автоматичен старт: освобождава се
 *      точно този играч, новият сяда, никой не е таксуван, масата не блокира.
 *  [3] Същото при ръчен старт.
 *  [4] Създателят остава без жълтици → масата се закрива (авто и ръчен), всички са уведомени.
 *  [5] DB грешки / неизвестна причина → никой не се освобождава.
 *  [6] Конкурентни заявки: последното място, повторен старт — едно удържане.
 *
 * Само временна база (пълният migration runner). Реален runtime + SQLite
 * persistence + реален svaraEconomyStore; платеният режим само за тази инстанция.
 *
 * Пускане (от server/): npx tsx scripts/checkSvaraEntryBalanceSeat.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraEconomyStore } from '../src/db/svaraEconomyStore.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import type { SvaraPaidEconomy } from '../src/games/svara/svaraPaidEconomy.js'
import { SVARA_TEST_ENTRY_FEES } from '../src/games/svara/svaraTableCreationOptions.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 1500)}`}`) }
}

class Clock implements SvaraClock {
  time = 1_800_000_000_000
  now = () => this.time
  schedule = (_callback: () => void, _delay: number) => () => {}
  defer = (callback: () => void) => this.schedule(callback, 0)
}

process.env.SVARA_TEST_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'svara-entry-balance-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const economy = await createSvaraEconomyStore(dbPath)
const store = await createSvaraMatchSnapshotStore(dbPath)
for (const fee of SVARA_TEST_ENTRY_FEES) {
  raw.prepare('INSERT OR IGNORE INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled, site_commission_bps) VALUES (?, 1, ?, 1, 2000)').run(fee, fee * 8 / 5)
}
const FEE = 8_000
const RICH = 100_000
const profile = (id: string, balance = RICH) => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, balance)
}
const setBalance = (id: string, balance: number) => raw.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(balance, id)
const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
const ledgerCount = (matchId: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM svara_match_economy_ledger WHERE match_id LIKE ?`).get(`${matchId}:a%`) as { n: number }).n
const errors: unknown[] = []

type Frames = Map<string, any[]>
function makeLobby(paidEconomy: SvaraPaidEconomy = economy) {
  const lobby = createSvaraLobby({ persistence: store, clock: new Clock(), hasOtherGameCommitment: () => false, onError: (e) => errors.push(e), paidEconomy })
  if (lobby.initializeRecovery() !== 'ready') throw new Error('recovery not ready')
  const frames: Frames = new Map()
  const attach = (id: string, balanceValue = RICH) => {
    profile(id, balanceValue)
    const session = { account: { role: 'admin' }, profile: { profileId: id } } as SvaraAccessSession
    frames.set(id, [])
    lobby.attachConnection(id, { profileId: id, getSession: () => session, send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
  }
  const create = (id: string, capacity: 2 | 3 | 4, startMode: 'auto' | 'manual') => {
    lobby.handle(id, { type: 'create_svara_table', requestId: randomUUID(), capacity, entryFee: FEE, entryPercent: 1, startMode } as never)
    return lobby.findCommitment(id)?.matchId ?? null
  }
  const join = (id: string, matchId: string) => lobby.handle(id, { type: 'join_svara_table', matchId, requestId: randomUUID() } as never)
  const start = (id: string, matchId: string) => lobby.handle(id, { type: 'start_svara_table', matchId, requestId: randomUUID() } as never)
  const seatOf = (id: string) => lobby.findCommitment(id)?.matchId ?? null
  const lastError = (id: string) => frames.get(id)!.findLast((f) => f.type === 'svara_lobby_error')
  const errorCodes = (id: string) => frames.get(id)!.filter((f) => f.type === 'svara_lobby_error').map((f) => f.code)
  const clear = () => { for (const list of frames.values()) list.length = 0 }
  const table = (matchId: string) => (store.load(matchId)?.state ?? null)
  return { lobby, frames, attach, create, join, start, seatOf, lastError, errorCodes, clear, table }
}

try {
  console.log('\n[1] Създаване и сядане без достатъчно жълтици')
  {
    const t = makeLobby()
    t.attach('poor-creator', 7_000)
    check('създаване с 7 000 при вход 8 000 → insufficient_entry_balance, без маса',
      t.create('poor-creator', 3, 'auto') === null && t.lastError('poor-creator')?.code === 'insufficient_entry_balance'
      && t.lastError('poor-creator')?.message === 'Нямаш достатъчно жълтици за входа на тази маса.' && balance('poor-creator') === 7_000)
    t.attach('host1'); t.attach('poor-joiner', 7_999)
    const m = t.create('host1', 3, 'auto')!
    t.join('poor-joiner', m)
    check('сядане с 7 999 → insufficient_entry_balance, без място', t.seatOf('poor-joiner') === null && t.lastError('poor-joiner')?.code === 'insufficient_entry_balance')
    check('…масата остава с 1 участник, нищо не е удържано', t.table(m)?.seats.length === 1 && balance('host1') === RICH && economy.getFinance(m) === null && ledgerCount(m) === 0)
    t.attach('exact', FEE)
    t.join('exact', m)
    check('точно 8 000 → сяда (входът НЕ се удържа при сядане)', t.seatOf('exact') === m && balance('exact') === FEE && economy.getFinance(m) === null)
  }

  console.log('\n[2] Загуба на жълтици по време на чакане — автоматичен старт')
  {
    const t = makeLobby()
    for (const id of ['a-host', 'a-short', 'a-new', 'a-fourth']) t.attach(id)
    const m = t.create('a-host', 3, 'auto')!
    t.join('a-short', m)
    setBalance('a-short', 7_000) // похарчено, докато чака
    t.clear()
    t.join('a-new', m)
    check('новият (с достатъчно) запазва мястото си', t.seatOf('a-new') === m && !t.errorCodes('a-new').includes('insufficient_coins'))
    check('освободен е точно a-short', t.seatOf('a-short') === null && t.table(m)?.phase === 'lobby'
      && JSON.stringify([...t.table(m)!.seats].sort()) === JSON.stringify(['a-host', 'a-new']))
    const shortFrames = t.frames.get('a-short')!
    const leftIndex = shortFrames.findIndex((f) => f.type === 'svara_table_left' && f.matchId === m)
    const noticeIndex = shortFrames.findIndex((f) => f.type === 'svara_lobby_error' && f.code === 'insufficient_entry_balance')
    check('a-short получава svara_table_left и после уведомлението за баланса', leftIndex >= 0 && noticeIndex > leftIndex)
    check('създателят е уведомен (seat_released_insufficient_balance) и седи', t.errorCodes('a-host').includes('seat_released_insufficient_balance') && t.seatOf('a-host') === m)
    check('мачът не започна, никой не е таксуван (без частично удържане)', economy.getFinance(m) === null && ledgerCount(m) === 0
      && balance('a-host') === RICH && balance('a-new') === RICH && balance('a-short') === 7_000)
    t.join('a-fourth', m)
    check('масата не блокира: следващият пълни и мачът започва с 3 × 8 000', t.table(m)?.phase === 'in-progress'
      && ['a-host', 'a-new', 'a-fourth'].every((id) => balance(id) === RICH - FEE) && economy.getFinance(m)?.status === 'collected' && ledgerCount(m) === 3 && balance('a-short') === 7_000)
  }

  console.log('\n[3] Загуба на жълтици по време на чакане — ръчен старт')
  {
    const t = makeLobby()
    for (const id of ['m-host', 'm-short', 'm-other', 'm-late']) t.attach(id)
    const m = t.create('m-host', 3, 'manual')!
    t.join('m-short', m); t.join('m-other', m)
    setBalance('m-short', 1_000)
    t.clear()
    t.start('m-host', m)
    check('старт → освободен е само m-short; масата е в лоби с m-host и m-other', t.seatOf('m-short') === null && t.table(m)?.phase === 'lobby'
      && JSON.stringify([...t.table(m)!.seats].sort()) === JSON.stringify(['m-host', 'm-other']))
    check('m-short: уведомление за баланса; останалите: seat_released', t.errorCodes('m-short').includes('insufficient_entry_balance')
      && t.errorCodes('m-host').includes('seat_released_insufficient_balance') && t.errorCodes('m-other').includes('seat_released_insufficient_balance'))
    check('никой не е таксуван', economy.getFinance(m) === null && ledgerCount(m) === 0 && balance('m-host') === RICH && balance('m-other') === RICH && balance('m-short') === 1_000)
    t.join('m-late', m); t.start('m-host', m)
    check('нов участник + старт → мачът започва, 3 удържания', t.table(m)?.phase === 'in-progress' && ledgerCount(m) === 3 && balance('m-late') === RICH - FEE)
  }

  console.log('\n[4] Създателят остава без жълтици → масата се закрива')
  {
    const t = makeLobby()
    for (const id of ['c-host', 'c-seated', 'c-new']) t.attach(id)
    const m = t.create('c-host', 3, 'auto')!
    t.join('c-seated', m)
    setBalance('c-host', 500)
    t.clear()
    t.join('c-new', m)
    check('авто: масата е закрита, никой не седи', t.table(m)?.phase === 'closed' && t.seatOf('c-host') === null && t.seatOf('c-seated') === null && t.seatOf('c-new') === null)
    check('създателят: insufficient_entry_balance; седналият: table_closed; новият: table_closed',
      t.errorCodes('c-host').includes('insufficient_entry_balance') && t.errorCodes('c-seated').includes('table_closed_insufficient_balance')
      && t.lastError('c-new')?.code === 'table_closed_insufficient_balance')
    check('седналият е изведен от масата (svara_table_left)', t.frames.get('c-seated')!.some((f) => f.type === 'svara_table_left' && f.matchId === m))
    check('никой не е таксуван', economy.getFinance(m) === null && ledgerCount(m) === 0 && balance('c-seated') === RICH && balance('c-new') === RICH && balance('c-host') === 500)

    for (const id of ['cm-host', 'cm-seated']) t.attach(id)
    const m2 = t.create('cm-host', 2, 'manual')!
    t.join('cm-seated', m2)
    setBalance('cm-host', 0)
    t.clear()
    t.start('cm-host', m2)
    check('ръчен: масата е закрита, останалият е уведомен, никой не е таксуван', t.table(m2)?.phase === 'closed' && t.seatOf('cm-seated') === null
      && t.errorCodes('cm-seated').includes('table_closed_insufficient_balance') && t.errorCodes('cm-host').includes('insufficient_entry_balance')
      && economy.getFinance(m2) === null && ledgerCount(m2) === 0 && balance('cm-seated') === RICH)
  }

  console.log('\n[5] DB грешки / неизвестна причина → никой не се освобождава')
  {
    const dbError: SvaraPaidEconomy = { ...economy, collectEntries: () => ({ ok: false, code: 'db-error', message: 'simulated' }) }
    const t = makeLobby(dbError)
    for (const id of ['d-host', 'd-seated', 'd-new']) t.attach(id)
    const m = t.create('d-host', 3, 'auto')!
    t.join('d-seated', m)
    t.join('d-new', m)
    check('db-error при старт → paid_unavailable за новия; седналите остават, без удържане', t.lastError('d-new')?.code === 'paid_unavailable'
      && t.seatOf('d-new') === null && t.seatOf('d-host') === m && t.seatOf('d-seated') === m && ledgerCount(m) === 0 && balance('d-new') === RICH)

    const anonymous: SvaraPaidEconomy = { ...economy, collectEntries: () => ({ ok: false, code: 'insufficient-balance', message: 'без профил' }) }
    const u = makeLobby(anonymous)
    for (const id of ['u-host', 'u-seated', 'u-new']) u.attach(id)
    const m2 = u.create('u-host', 3, 'auto')!
    u.join('u-seated', m2); u.join('u-new', m2)
    check('недостатъчен баланс без потвърден профил → insufficient_coins, никой не се освобождава', u.lastError('u-new')?.code === 'insufficient_coins'
      && u.seatOf('u-host') === m2 && u.seatOf('u-seated') === m2 && u.seatOf('u-new') === null)

    const foreign: SvaraPaidEconomy = { ...economy, collectEntries: () => ({ ok: false, code: 'insufficient-balance', message: 'чужд', profileId: 'not-at-table' }) }
    const f = makeLobby(foreign)
    for (const id of ['f-host', 'f-seated', 'f-new']) f.attach(id)
    const m3 = f.create('f-host', 3, 'auto')!
    f.join('f-seated', m3); f.join('f-new', m3)
    check('профил извън участниците → без освобождаване (insufficient_coins)', f.lastError('f-new')?.code === 'insufficient_coins' && f.seatOf('f-host') === m3 && f.seatOf('f-seated') === m3)

    const readFails: SvaraPaidEconomy = { ...economy, hasEnoughBalance: () => { throw new Error('simulated read failure') } }
    const r = makeLobby(readFails)
    r.attach('r-host')
    check('грешка при четене на баланса при създаване → server_unavailable, без маса', r.create('r-host', 3, 'auto') === null && r.lastError('r-host')?.code === 'server_unavailable')
    const ok = makeLobby()
    ok.attach('r-owner')
    const m4 = ok.create('r-owner', 3, 'auto')!
    r.lobby.shutdown()
    const r2 = makeLobby(readFails) // нова инстанция над същата база — масата е възстановена
    r2.attach('r-joiner')
    r2.join('r-joiner', m4)
    check('грешка при четене при сядане → server_unavailable, без място', r2.seatOf('r-joiner') === null && r2.lastError('r-joiner')?.code === 'server_unavailable')
    ok.lobby.shutdown(); r2.lobby.shutdown()
  }

  console.log('\n[6] Конкурентни заявки')
  {
    const t = makeLobby()
    for (const id of ['k-host', 'k-seated', 'k-x', 'k-y']) t.attach(id)
    const m = t.create('k-host', 3, 'auto')!
    t.join('k-seated', m)
    t.join('k-x', m); t.join('k-y', m) // две заявки за последното място
    check('първият пълни и стартира; вторият е отказан без удържане', t.table(m)?.phase === 'in-progress' && t.seatOf('k-x') === m && t.seatOf('k-y') === null
      && ledgerCount(m) === 3 && balance('k-y') === RICH)

    for (const id of ['s-host', 's-seated']) t.attach(id)
    const m2 = t.create('s-host', 2, 'manual')!
    t.join('s-seated', m2)
    t.start('s-host', m2); t.start('s-host', m2)
    check('повторен старт → едно удържане на участник', t.table(m2)?.phase === 'in-progress' && ledgerCount(m2) === 2 && balance('s-host') === RICH - FEE && balance('s-seated') === RICH - FEE)

    // Освобождаване + нов опит веднага след това: втори беден → освобождава се и той, без частично удържане.
    for (const id of ['z-host', 'z-p1', 'z-p2', 'z-new', 'z-new2']) t.attach(id)
    const m3 = t.create('z-host', 4, 'auto')!
    t.join('z-p1', m3); t.join('z-p2', m3)
    setBalance('z-p1', 10); setBalance('z-p2', 10)
    t.join('z-new', m3)
    const firstReleased = ['z-p1', 'z-p2'].filter((id) => t.seatOf(id) === null)
    check('двама бедни: при първия опит се освобождава точно един', firstReleased.length === 1 && t.seatOf('z-new') === m3 && ledgerCount(m3) === 0)
    const other = ['z-p1', 'z-p2'].find((id) => t.seatOf(id) !== null)!
    t.join('z-new2', m3)
    check('следващият опит освобождава и втория; масата продължава, без удържане', t.seatOf(other) === null && t.seatOf('z-new2') === m3 && t.table(m3)?.phase === 'lobby' && ledgerCount(m3) === 0
      && balance('z-p1') === 10 && balance('z-p2') === 10)
  }

  check('няма неочаквани грешки в onError (освен симулираните)', errors.every((e) => /simulated|db-error|entry collection failed/.test(String((e as Error)?.message ?? e))), errors.map(String))
} finally {
  store.close(); economy.close(); raw.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${passed} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
