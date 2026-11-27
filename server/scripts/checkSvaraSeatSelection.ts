/**
 * checkSvaraSeatSelection.ts — избор на конкретно място в чакаща маса на „Свара“.
 *
 *  [1] Двигател: място на създателя, избрано място, първо свободно, заето място,
 *      невалиден номер, напускане, по-стар мач без записани места.
 *  [2] Игровият ред се тегли случайно точно веднъж при старта (2/3/4, авто/ръчен),
 *      равномерно и независимо от местата в чакалнята; раздаване и ред на ходовете.
 *  [3] Валидация при възстановяване: валидни/подправени места.
 *  [4] Лоби: едновременни заявки за едно място (печели първата), seat_taken без
 *      удържане, пълна/започнала маса, баланс („Зареди“) запазен.
 *  [5] Обновяване при всички, които гледат списъка (влизане/напускане).
 *  [6] Рестарт: местата се възстановяват; свободното място остава свободно;
 *      започнал мач — без ново разбъркване след reconnect и рестарт.
 *
 * Само временна база. Пускане (от server/): npx tsx scripts/checkSvaraSeatSelection.ts
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
import { applySvaraMatchCommand, createSvaraMatch, isValidSvaraSeatPositions, SvaraMatchError, type SvaraMatchState } from '../src/games/svara/engine/svaraMatch.js'
import { createSvaraPublicTable } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { parseSvaraLobbyMessage } from '../src/games/svara/protocol/svaraLobbyProtocol.js'
import { createSvaraMatchRuntime, svaraParticipantCommandKey } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { validateSvaraStoredMatch } from '../src/games/svara/runtime/svaraStoredMatchValidation.js'
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
const errorCode = (run: () => unknown): string | null => { try { run(); return null } catch (e) { return e instanceof SvaraMatchError ? e.code : String(e) } }

let serial = 0
const apply = (state: SvaraMatchState, command: Record<string, unknown>) =>
  applySvaraMatchCommand(state, { commandId: `c${++serial}`, ...command } as never, { random: { nextInt: () => 0 } }).state

console.log('\n[1] Двигател')
{
  let s = createSvaraMatch({ tableId: 't1', capacity: 4, entryFee: 5000, startMode: 'auto', creatorId: 'host' })
  check('създателят е на място 1 (0)', s.seatPositions?.host === 0)
  s = apply(s, { type: 'join-seat', playerId: 'a', seat: 3 })
  s = apply(s, { type: 'join-seat', playerId: 'b', seat: 1 })
  check('избрани места 4 и 2 → seats подреден по номера', JSON.stringify(s.seats) === JSON.stringify(['host', 'b', 'a']) && s.seatPositions?.a === 3 && s.seatPositions?.b === 1)
  check('заето място → seat-taken', errorCode(() => apply(s, { type: 'join-seat', playerId: 'c', seat: 3 })) === 'seat-taken')
  for (const seat of [4, -1, 1.5]) check(`невалидно място ${seat} → invalid-command`, errorCode(() => apply(s, { type: 'join-seat', playerId: 'c', seat })) === 'invalid-command')
  const leaveState = apply(s, { type: 'leave-seat', playerId: 'b' })
  check('напускане освобождава мястото', leaveState.seatPositions?.b === undefined && !leaveState.seats.includes('b') && isValidSvaraSeatPositions(leaveState))
  const auto = apply(leaveState, { type: 'join-seat', playerId: 'c' })
  check('без избор → първото свободно (2)', auto.seatPositions?.c === 1 && JSON.stringify(auto.seats) === JSON.stringify(['host', 'c', 'a']))
  const closed = apply(auto, { type: 'leave-seat', playerId: 'host' })
  check('създателят напуска → закрита, местата са празни', closed.phase === 'closed' && closed.seats.length === 0 && Object.keys(closed.seatPositions ?? {}).length === 0)

  // По-стар мач без записани места.
  let legacy = createSvaraMatch({ tableId: 't2', capacity: 3, entryFee: 5000, startMode: 'manual', creatorId: 'h' })
  legacy = apply(legacy, { type: 'join-seat', playerId: 'x' })
  const { seatPositions: _drop, ...withoutPositions } = legacy
  const old = withoutPositions as SvaraMatchState
  check('по-стар мач: публичните места са индексите', JSON.stringify(createSvaraPublicTable('t2', old).players.map((p) => p.seat)) === JSON.stringify([0, 1]))
  check('по-стар мач: заето място по индекс → seat-taken', errorCode(() => apply(old, { type: 'join-seat', playerId: 'y', seat: 1 })) === 'seat-taken')
  const upgraded = apply(old, { type: 'join-seat', playerId: 'y', seat: 2 })
  check('по-стар мач: избор на свободно място работи и записва местата', JSON.stringify(upgraded.seatPositions) === JSON.stringify({ h: 0, x: 1, y: 2 }))
}

console.log('\n[2] Случаен игрови ред при старта (2/3/4, авто и ръчен)')
{
  /** Подредена чакаща маса: p1 (създател, място 1) и останалите на места в обратен ред. */
  const lobby = (capacity: 2 | 3 | 4, startMode: 'auto' | 'manual', random?: { nextInt: (max: number) => number }) => {
    let s = createSvaraMatch({ tableId: `r${capacity}${startMode}`, capacity, entryFee: 5000, startMode, creatorId: 'p1' })
    // Един скриптиран източник и за позициите (seatOrder), и за дилъра; без него — production (криптографски).
    const env = random ? { random, seatOrder: random } : {}
    for (let index = capacity; index >= 2; index -= 1) {
      s = applySvaraMatchCommand(s, { type: 'join-seat', commandId: `j${++serial}`, playerId: `p${index}`, seat: index - 1 }, env).state
    }
    if (startMode === 'manual') s = applySvaraMatchCommand(s, { type: 'start-match', commandId: `s${++serial}`, playerId: 'p1' }, env).state
    return s
  }
  /** Скриптиран източник: дава зададените стойности, после 0 (записва и границите). */
  const scripted = (values: number[]) => {
    const bounds: number[] = []
    return { bounds, nextInt: (max: number) => { bounds.push(max); const value = values.shift() ?? 0; if (value >= max) throw new Error('script out of range'); return value } }
  }
  for (const capacity of [2, 3, 4] as const) for (const startMode of ['auto', 'manual'] as const) {
    // Последователен избор от оставащите [p1..pN] по скрипта [N-1, N-2, …] → обратна подредба.
    const script = Array.from({ length: capacity - 1 }, (_, i) => capacity - 1 - i)
    const random = scripted([...script, 0])
    const s = lobby(capacity, startMode, random)
    const expected = Array.from({ length: capacity }, (_, i) => `p${capacity - i}`)
    check(`${capacity} играчи, ${startMode}: позициите идват от случайния избор, не от местата в чакалнята`, s.phase === 'in-progress' && JSON.stringify(s.seats) === JSON.stringify(expected), s.seats)
    check(`${capacity} играчи, ${startMode}: точно ${capacity - 1} тегления за позициите + 1 за дилъра`, JSON.stringify(random.bounds) === JSON.stringify([...Array.from({ length: capacity - 1 }, (_, i) => capacity - i), capacity]), random.bounds)
    check(`${capacity} играчи, ${startMode}: мястото след старта = игровата позиция; seatPositions валидни`, s.seats.every((id, index) => s.seatPositions?.[id] === index) && isValidSvaraSeatPositions(s)
      && JSON.stringify(createSvaraPublicTable('x', s).players.map((p) => p.seat)) === JSON.stringify(Array.from({ length: capacity }, (_, i) => i)))
    check(`${capacity} играчи, ${startMode}: дилърът е от разбъркания ред (скрипт 0 → първата позиция)`, s.firstDealerId === s.seats[0])
  }

  // Равномерност с истинския (криптографски) източник: всеки играч на всяка позиция ~ 1/n, всички подредби се срещат.
  for (const capacity of [2, 3, 4] as const) {
    const trials = 3000
    const counts = new Map<string, number>()
    const permutations = new Set<string>()
    for (let trial = 0; trial < trials; trial += 1) {
      const s = lobby(capacity, trial % 2 === 0 ? 'auto' : 'manual')
      permutations.add(s.seats.join(','))
      s.seats.forEach((id, index) => counts.set(`${id}@${index}`, (counts.get(`${id}@${index}`) ?? 0) + 1))
    }
    const expected = trials / capacity
    const worst = Math.max(...[...counts.values()].map((count) => Math.abs(count - expected) / expected))
    const factorial = [1, 1, 2, 6, 24][capacity]!
    check(`${capacity} играчи: равномерно (${trials} старта, най-голямо отклонение ${(worst * 100).toFixed(1)}% < 15%)`, counts.size === capacity * capacity && worst < 0.15, Object.fromEntries(counts))
    check(`${capacity} играчи: срещат се всички ${factorial} подредби`, permutations.size === factorial)
  }

  // Runtime както в production (createSvaraLobby не подава random) → реално разбъркване.
  {
    const runtime = createSvaraMatchRuntime()
    let creatorFirst = 0
    for (let i = 0; i < 400; i += 1) {
      runtime.registerMatch({ matchId: `prod-${i}`, creator: { playerId: 'c' }, capacity: 2, entryFee: 5000, startMode: 'auto' })
      runtime.executeParticipantCommand(`prod-${i}`, { playerId: 'j' }, `join-${i}`, { type: 'join-seat', seat: 1 })
      if (runtime.getPublicTable(`prod-${i}`).players[0]!.playerId === 'c') creatorFirst += 1
    }
    check(`production runtime: създателят (място 1) е първи в ~50% от стартовете (${creatorFirst}/400)`, creatorFirst > 140 && creatorFirst < 260)
  }

  // Детерминистична среда (подаден random, без seatOrder) → старите сценарии запазват реда от чакалнята.
  {
    let d = createSvaraMatch({ tableId: 'det', capacity: 3, entryFee: 5000, startMode: 'auto', creatorId: 'p1' })
    for (const [id, seat] of [['p3', 2], ['p2', 1]] as const) d = applySvaraMatchCommand(d, { type: 'join-seat', commandId: `d${++serial}`, playerId: id, seat }, { random: { nextInt: () => 2 } }).state
    check('тестова среда с random без seatOrder → без разбъркване (дилърът ползва random)', JSON.stringify(d.seats) === JSON.stringify(['p1', 'p2', 'p3']) && d.firstDealerId === 'p3')
  }

  // Точно веднъж: следващите команди не пренареждат; раздаване и ред на ходовете по разбъркания ред.
  const random = scripted([3, 0, 1, 2])
  let s = lobby(4, 'auto', random)
  const order = [...s.seats]
  check('разбъркан ред ≠ реда в чакалнята (p4, p1, p3, p2)', JSON.stringify(order) === JSON.stringify(['p4', 'p1', 'p3', 'p2']), order)
  check('дилърът е избран от разбъркания ред (скрипт 2 → p3)', s.firstDealerId === 'p3')
  s = applySvaraMatchCommand(s, { type: 'start-next-round', commandId: `n${++serial}` }, { random: { nextInt: () => 0 } }).state
  const round = s.round as { kind: string; dealerId: string; participants: string[]; hands: Record<string, string[]> }
  const dealerIndex = order.indexOf(round.dealerId)
  const clockwise = [...order.slice(dealerIndex + 1), ...order.slice(0, dealerIndex + 1)]
  check('първото раздаване: дилър = избраният, ред = след дилъра … дилърът (по разбърканите позиции)', round.dealerId === 'p3' && JSON.stringify(round.participants) === JSON.stringify(clockwise), round.participants)
  check('раздаване: по 3 карти на всеки участник', order.every((id) => round.hands[id]?.length === 3))
  check('след команди в мача seats е непроменен (без повторно разбъркване)', JSON.stringify(s.seats) === JSON.stringify(order))
  check('започнала маса → join-seat отказан (wrong-phase)', errorCode(() => apply(s, { type: 'join-seat', playerId: 'z', seat: 0 })) === 'wrong-phase')
  // По-стар започнал мач без записани места остава валиден и продължава.
  const { seatPositions: _gone, ...legacyStarted } = s
  check('по-стар започнал мач без seatPositions: валиден, публичните места = индексите', isValidSvaraSeatPositions(legacyStarted as SvaraMatchState)
    && JSON.stringify(createSvaraPublicTable('x', legacyStarted as SvaraMatchState).players.map((p) => p.seat)) === JSON.stringify([0, 1, 2, 3]))
}

console.log('\n[3] Валидация при възстановяване')
{
  // Истински ключ на команда на участник (както runtime-ът ги записва).
  let s = createSvaraMatch({ tableId: 'v1', capacity: 3, entryFee: 5000, startMode: 'manual', creatorId: 'h' })
  s = applySvaraMatchCommand(s, { type: 'join-seat', commandId: svaraParticipantCommandKey('x', 'r1'), playerId: 'x', seat: 2 }).state
  const stored = (state: SvaraMatchState) => ({ formatVersion: 1, matchId: 'v1', revision: Object.keys(state.processedCommands).length, state: structuredClone(state), deadlines: [], deadlineSequence: 0 })
  const valid = (value: unknown) => { try { validateSvaraStoredMatch(value); return true } catch { return false } }
  check('валидни места → приет', valid(stored(s)))
  check('без места (по-стар запис) → приет', valid((() => { const v = stored(s); delete (v.state as Partial<SvaraMatchState>).seatPositions; return v })()))
  check('дублирани места → отхвърлен', !valid((() => { const v = stored(s); v.state.seatPositions = { h: 0, x: 0 }; return v })()))
  check('място извън капацитета → отхвърлен', !valid((() => { const v = stored(s); v.state.seatPositions = { h: 0, x: 3 }; return v })()))
  check('seats не е по местата → отхвърлен', !valid((() => { const v = stored(s); v.state.seatPositions = { h: 2, x: 0 }; return v })()))
  check('място за несъществуващ играч → отхвърлен', !valid((() => { const v = stored(s); v.state.seatPositions = { h: 0, x: 2, ghost: 1 }; return v })()))
}

console.log('\n[4] Протокол')
{
  const rid = randomUUID()
  check('join без място → без seat', JSON.stringify(parseSvaraLobbyMessage({ type: 'join_svara_table', matchId: 'm', requestId: rid })) === JSON.stringify({ type: 'join_svara_table', matchId: 'm', requestId: rid }))
  check('join с място 2 → seat 2', (parseSvaraLobbyMessage({ type: 'join_svara_table', matchId: 'm', requestId: rid, seat: 2 }) as { seat?: number } | null)?.seat === 2)
  for (const seat of [-1, 4, 1.5, '1', null]) check(`join с място ${JSON.stringify(seat)} → отхвърлено`, parseSvaraLobbyMessage({ type: 'join_svara_table', matchId: 'm', requestId: rid, seat }) === null)
}

class Clock implements SvaraClock {
  time = 1_800_000_000_000
  now = () => this.time
  schedule = (_callback: () => void, _delay: number) => () => {}
  defer = (callback: () => void) => this.schedule(callback, 0)
}
process.env.SVARA_TEST_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'svara-seat-selection-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const economy = await createSvaraEconomyStore(dbPath)
const store = await createSvaraMatchSnapshotStore(dbPath)
for (const fee of SVARA_TEST_ENTRY_FEES) {
  raw.prepare('INSERT OR IGNORE INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled, site_commission_bps) VALUES (?, 1, ?, 1, 2000)').run(fee, fee * 8 / 5)
}
const FEE = 8_000
const profile = (id: string, balance = 100_000) => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, `Ник ${id}`, id)
  raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, balance)
}
const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
const ledgerCount = (matchId: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM svara_match_economy_ledger WHERE match_id LIKE ?`).get(`${matchId}:a%`) as { n: number }).n

function makeLobby(paidEconomy: SvaraPaidEconomy = economy) {
  const lobby = createSvaraLobby({
    persistence: store, clock: new Clock(), hasOtherGameCommitment: () => false, paidEconomy,
    getPublicProfile: (id) => ({ displayName: `Ник ${id}`, avatarUrl: `/uploads/avatars/${id}.webp` }),
  })
  if (lobby.initializeRecovery() !== 'ready') throw new Error('recovery not ready')
  const frames = new Map<string, any[]>()
  const attach = (id: string, balanceValue = 100_000) => {
    profile(id, balanceValue)
    const session = { account: { role: 'admin' }, profile: { profileId: id } } as SvaraAccessSession
    frames.set(id, [])
    lobby.attachConnection(id, { profileId: id, getSession: () => session, send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
  }
  const create = (id: string, capacity: 2 | 3 | 4, startMode: 'auto' | 'manual') => {
    lobby.handle(id, { type: 'create_svara_table', requestId: randomUUID(), capacity, entryFee: FEE, entryPercent: 1, startMode } as never)
    return lobby.findCommitment(id)?.matchId ?? null
  }
  const join = (id: string, matchId: string, seat?: number) =>
    lobby.handle(id, { type: 'join_svara_table', matchId, requestId: randomUUID(), ...(seat === undefined ? {} : { seat }) } as never)
  const lastError = (id: string) => frames.get(id)!.findLast((f) => f.type === 'svara_lobby_error')
  const listed = (id: string, matchId: string) => frames.get(id)!.findLast((f) => f.type === 'svara_tables_list')?.tables.find((t: any) => t.matchId === matchId) ?? null
  return { lobby, frames, attach, create, join, lastError, listed }
}

try {
  console.log('\n[5] Лоби: едновременни заявки, удържане, баланс')
  {
    const t = makeLobby()
    for (const id of ['h', 'x', 'y', 'z']) t.attach(id)
    const m = t.create('h', 3, 'auto')!
    t.join('x', m, 2); t.join('y', m, 2) // две заявки за едно и също място
    check('първата заема място 3; втората → seat_taken', t.lobby.findCommitment('x')?.matchId === m && t.lobby.findCommitment('y') === null && t.lastError('y')?.code === 'seat_taken'
      && t.lastError('y')?.message === 'Мястото вече е заето. Избери друго свободно място.')
    check('seat_taken не опитва старт: без финансов запис и удържане', economy.getFinance(m) === null && ledgerCount(m) === 0 && balance('y') === 100_000)
    t.join('y', m, 1)
    const started = store.load(m)!.state
    check('свободно място 2 → масата се пълни и стартира (игровите позиции са случайни)', started.phase === 'in-progress' && JSON.stringify([...started.seats].sort()) === JSON.stringify(['h', 'x', 'y'])
      && started.seats.every((id, index) => started.seatPositions?.[id] === index) && ledgerCount(m) === 3)
    t.join('z', m, 0)
    check('започнала маса → отказ без място и удържане', t.lobby.findCommitment('z') === null && balance('z') === 100_000)

    const m2 = t.create('z', 2, 'manual')!
    t.attach('poor', 7_000)
    t.join('poor', m2, 1)
    check('недостатъчен баланс при избрано място → insufficient_entry_balance (прозорецът „Зареди“)', t.lastError('poor')?.code === 'insufficient_entry_balance' && t.lobby.findCommitment('poor') === null)
    t.attach('w')
    t.join('w', m2, 5)
    check('място извън капацитета → invalid_input', t.lastError('w')?.code === 'invalid_input' && t.lobby.findCommitment('w') === null)
    t.join('w', m2, 1)
    t.attach('late')
    t.join('late', m2, 0)
    check('пълна маса → table_full', t.lastError('late')?.code === 'table_full')
  }

  console.log('\n[6] Обновяване при всички, които гледат списъка')
  {
    const t = makeLobby()
    for (const id of ['viewer', 'host2', 'guest']) t.attach(id)
    t.lobby.handle('viewer', { type: 'request_svara_tables_list' } as never)
    const m = t.create('host2', 4, 'manual')!
    t.join('guest', m, 3)
    const afterJoin = t.listed('viewer', m)
    check('зрителят вижда новия участник с място, ник и снимка', afterJoin !== null && afterJoin.players.some((p: any) => p.playerId === 'guest' && p.seat === 3 && p.displayName === 'Ник guest' && p.avatarUrl === '/uploads/avatars/guest.webp'))
    t.lobby.handle('guest', { type: 'leave_svara_table', matchId: m, requestId: randomUUID() } as never)
    const afterLeave = t.listed('viewer', m)
    check('напускане → мястото е свободно при зрителя', afterLeave !== null && afterLeave.players.length === 1 && afterLeave.players[0].seat === 0)
    check('без ботове: всички участници са реални профили', afterJoin.players.every((p: any) => !p.isBot))
  }

  console.log('\n[7] Рестарт')
  {
    const t = makeLobby()
    for (const id of ['rh', 'rg']) t.attach(id)
    const m = t.create('rh', 4, 'manual')!
    t.join('rg', m, 2)
    t.lobby.shutdown()
    const r = makeLobby()
    r.attach('rn')
    const table = r.lobby.findCommitment('rg')
    check('след рестарт участникът е на същата маса', table?.matchId === m)
    r.join('rn', m, 2)
    check('заетото място остава заето след рестарт', r.lastError('rn')?.code === 'seat_taken')
    r.join('rn', m, 1)
    check('свободно място след рестарт → заема се', store.load(m)!.state.seatPositions?.rn === 1 && JSON.stringify(store.load(m)!.state.seats) === JSON.stringify(['rh', 'rn', 'rg']))

    // Започнал мач: позициите се теглят веднъж и остават след reconnect и рестарт.
    r.attach('rl'); r.attach('rh')
    r.join('rl', m, 3)
    r.lobby.handle('rh', { type: 'start_svara_table', matchId: m, requestId: randomUUID() } as never)
    const afterStart = store.load(m)!
    const order = [...afterStart.state.seats]
    check('ръчен старт през лобито → започнал, позициите са записани', afterStart.state.phase === 'in-progress' && order.every((id, index) => afterStart.state.seatPositions?.[id] === index))
    const seatOrder = (frames: any[]) => frames.findLast((f) => f.type === 'svara_match_snapshot')?.seats?.map((seat: any) => seat.playerId) ?? null
    r.lobby.disconnect('rg'); r.attach('rg'); r.lobby.reconnect('rg')
    check('reconnect → същите игрови позиции в снимката', JSON.stringify(seatOrder(r.frames.get('rg')!)) === JSON.stringify(order), seatOrder(r.frames.get('rg')!))
    r.lobby.shutdown()
    const restarted = makeLobby()
    restarted.attach('rh')
    restarted.lobby.reconnect('rh')
    check('рестарт → seats/seatPositions непроменени (без ново разбъркване)', JSON.stringify(store.load(m)!.state.seats) === JSON.stringify(order)
      && JSON.stringify(store.load(m)!.state.seatPositions) === JSON.stringify(afterStart.state.seatPositions))
    check('рестарт → снимката на играча е със същия ред', JSON.stringify(seatOrder(restarted.frames.get('rh')!)) === JSON.stringify(order), seatOrder(restarted.frames.get('rh')!))
    restarted.lobby.shutdown()
  }
} finally {
  store.close(); economy.close(); raw.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${passed} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
