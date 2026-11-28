/**
 * checkSvaraMatchProgression.ts — „Свара“ в общата система за нива и рангове.
 *
 *  [0] Стар мач (преди интеграцията) — не се начислява нито при старта, нито
 *      по-късно (без възстановяване със задна дата).
 *  [1] Живо приключване (платен мач): победител +1 игра +1 победа; напусналите
 *      +1 игра; ниво/ранг в profiles; записът е преди финалното
 *      svara_table_updated; напусналите получават svara_progress_updated;
 *      reconnect / повторна заявка / излизане от резултата → без второ +1;
 *      уреждането е 'paid'; ELO не се пипа; незавършен мач не се брои.
 *  [2] Временна грешка (false / изключение) → уреждането не е засегнато,
 *      повторен опит дописва само липсващото, без двойно начисляване.
 *  [3] Рестарт преди повторния опит → записът се довършва при старта;
 *      повторен рестарт → без промяна.
 *  [4] Отпадане (без чипове): +1 игра без победа; победителят +1 победа.
 *  [5] Мач без победител (всички отсъстват, приключва при възстановяване) → само игри.
 *  [6] Закрита незапочната маса → нищо.
 *  [7] Извличане на участниците.
 *
 * Само временна база (пълният migration runner). Реален runtime + SQLite
 * persistence + реален playerProgressStore и svaraEconomyStore.
 *
 * Пускане (от server/): npx tsx scripts/checkSvaraMatchProgression.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createSvaraEconomyStore } from '../src/db/svaraEconomyStore.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraLobby, SVARA_PROGRESSION_RETRY_MS } from '../src/games/svara/createSvaraLobby.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { createSvaraMatchRuntime, type SvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { SVARA_PRESENCE_WAIT_MS } from '../src/games/svara/runtime/svaraDeadlines.js'
import { SVARA_TEST_ENTRY_FEES } from '../src/games/svara/svaraTableCreationOptions.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'
import {
  createSvaraProgression, getSvaraProgressionParticipants, SVARA_PROGRESSION_SOURCE, type SvaraProgression,
} from '../src/games/svara/svaraProgression.js'
import { getRankTitleForLevel } from '../src/progression/rankProgression.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 1500)}`}`) }
}

type Job = { at: number; order: number; callback: () => void }
class Clock implements SvaraClock {
  time = Date.now()
  private order = 0
  readonly jobs = new Set<Job>()
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const job = { at: this.time + Math.max(0, delay), order: this.order++, callback }
    this.jobs.add(job)
    return () => { this.jobs.delete(job) }
  }
  defer = (callback: () => void) => this.schedule(callback, 0)
  advance(ms: number) {
    const end = this.time + ms
    for (let n = 0; n < 100_000; n++) {
      let next: Job | null = null
      for (const job of this.jobs) if (job.at <= end && (!next || job.at < next.at || (job.at === next.at && job.order < next.order))) next = job
      if (!next) break
      this.jobs.delete(next)
      this.time = next.at
      next.callback()
    }
    this.time = end
  }
}

process.env.SVARA_TEST_ENABLED = '1'
process.env.SVARA_PAID_MATCHES_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'svara-progression-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const store = await createSvaraMatchSnapshotStore(dbPath)
const economy = await createSvaraEconomyStore(dbPath)
const progressStore = await createPlayerProgressStore(dbPath)
const realProgression = createSvaraProgression(progressStore)
for (const fee of SVARA_TEST_ENTRY_FEES) {
  raw.prepare('INSERT OR IGNORE INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled, site_commission_bps) VALUES (?, 1, ?, 1, 2000)').run(fee, fee * 8 / 5)
}
const FEE = 8_000
const RICH = 100_000
const profile = (id: string) => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO NOTHING').run(id, RICH)
}
type Progress = { completed: number; won: number; level: number; rankTitle: string; rankLevel: number; skill: number }
const progressOf = (id: string): Progress => {
  const row = raw.prepare(`SELECT COALESCE(pp.completed_games_count, 0) AS completed, COALESCE(pp.won_games_count, 0) AS won, p.level, p.rank_title AS rankTitle,
    COALESCE(pp.rank_level, 1) AS rankLevel, p.skill_rating AS skill FROM profiles p LEFT JOIN profile_progress pp ON pp.profile_id = p.profile_id WHERE p.profile_id = ?`).get(id) as Progress
  return { ...row }
}
const ledgerRows = (matchId: string) => raw.prepare('SELECT profile_id AS id, source, did_win AS win FROM profile_completed_game_ledger WHERE scope_id = ? ORDER BY profile_id')
  .all(matchId) as Array<{ id: string; source: string; win: number }>
const errors: unknown[] = []

function makeLobby(clock: Clock, progression: SvaraProgression | undefined, paid = true) {
  const lobby = createSvaraLobby({ persistence: store, clock, hasOtherGameCommitment: () => false, onError: (e) => errors.push(e),
    ...(paid ? { paidEconomy: economy } : {}), ...(progression ? { progression } : {}) })
  const recovery = lobby.initializeRecovery()
  const frames = new Map<string, any[]>()
  const attach = (id: string) => {
    profile(id)
    const session = { account: { role: 'admin' }, profile: { profileId: id } } as SvaraAccessSession
    frames.set(id, [])
    lobby.attachConnection(id, { profileId: id, getSession: () => session, send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
  }
  const send = (id: string, message: Record<string, unknown>) => lobby.handle(id, { requestId: randomUUID(), ...message } as never)
  const create = (id: string, capacity: 2 | 3 | 4, startMode: 'auto' | 'manual' = 'auto') => {
    send(id, { type: 'create_svara_table', capacity, entryFee: FEE, entryPercent: 1, startMode })
    return lobby.findCommitment(id)?.matchId ?? null
  }
  const join = (id: string, matchId: string) => send(id, { type: 'join_svara_table', matchId })
  /** Игрова команда; при „картите се раздават“ — изчаква и опитва пак. */
  const command = (id: string, matchId: string, cmd: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const before = frames.get(id)!.length
      send(id, { type: 'submit_svara_command', matchId, commandId: randomUUID(), expectedRevision: store.load(matchId)!.revision, command: cmd })
      const fresh = frames.get(id)!.slice(before)
      if (fresh.some((f) => f.type === 'svara_command_result' && f.status === 'applied')) return true
      if (!fresh.some((f) => f.type === 'svara_command_error' && f.code === 'dealing_in_progress')) return false
      clock.advance(1_000)
    }
    return false
  }
  const runUntilFinished = (matchId: string) => {
    for (let i = 0; i < 200 && store.load(matchId)!.state.phase !== 'finished'; i++) clock.advance(2_000)
    return store.load(matchId)!.state.phase === 'finished'
  }
  return { lobby, recovery, frames, attach, send, create, join, command, runUntilFinished }
}

// Runtime-ниво помощници (мачове „извън“ лобито — стари или за рестарт).
let serial = 0
const sys = (rt: SvaraMatchRuntime, id: string, command: Parameters<SvaraMatchRuntime['executeSystemCommand']>[2]) => rt.executeSystemCommand(id, `sys-${++serial}`, command)
const act = (rt: SvaraMatchRuntime, id: string, player: string, command: unknown) => rt.executeParticipantCommand(id, { playerId: player }, `c-${++serial}`, command)
function startRuntimeMatch(rt: SvaraMatchRuntime, players: string[]): string {
  const id = `rt-${randomUUID()}`
  rt.registerMatch({ matchId: id, creator: { playerId: players[0]! }, capacity: players.length as 2 | 3 | 4, entryFee: 5_000, entryPercent: 1, startMode: 'manual' })
  for (const p of players.slice(1)) act(rt, id, p, { type: 'join-seat' })
  act(rt, id, players[0]!, { type: 'start-match' })
  return id
}
/** Всяко раздаване: всички залагат всичко → някой остава без чипове (отпадане). */
function playAllInToFinish(rt: SvaraMatchRuntime, id: string): void {
  for (let i = 0; i < 3_000; i++) {
    const s = rt.exportInternalStateForServer(id)
    if (s.phase === 'finished') return
    const round = s.round as any
    if (round === null) { sys(rt, id, { type: 'start-next-round' }); continue }
    if ((round.kind === 'ordinary' || round.kind === 'svara') && round.dealing) { sys(rt, id, { type: 'finish-dealing', roundId: round.roundId }); continue }
    if (round.kind === 'ordinary' || round.kind === 'svara') {
      const p = round.betting.toAct
      const tryAct = (action: unknown) => { try { act(rt, id, p, action); return true } catch { return false } }
      if (tryAct({ type: 'act', action: { kind: 'all-in' } }) || tryAct({ type: 'act', action: { kind: 'call' } })) continue
      tryAct({ type: 'look' })
      if (tryAct({ type: 'act', action: { kind: 'all-in' } }) || tryAct({ type: 'act', action: { kind: 'call' } }) || tryAct({ type: 'act', action: { kind: 'fold' } })) continue
      throw new Error(`no action for ${p}`)
    }
    if (round.kind === 'reveal-choice') { sys(rt, id, { type: 'expire-reveal-choice', roundId: round.roundId }); continue }
    if (round.kind === 'reveal-display') { sys(rt, id, { type: 'close-reveal-display', roundId: round.roundId }); continue }
    if (round.kind === 'showdown-display') { sys(rt, id, { type: round.phase === 'showdown' ? 'advance-showdown-display' : 'close-payout-display', roundId: round.roundId }); continue }
    if (round.kind === 'payout-display') { sys(rt, id, { type: 'close-payout-display', roundId: round.roundId }); continue }
    if (round.kind === 'svara-joining') { sys(rt, id, { type: 'close-svara-joining', roundId: round.roundId }); continue }
    throw new Error(`unexpected round ${round.kind}`)
  }
  throw new Error('match did not finish')
}

try {
  console.log('\n[0] Стар мач (преди интеграцията) — не се пипа автоматично')
  const oldPlayers = ['o-win', 'o-exit', 'o-gone']
  for (const id of oldPlayers) profile(id)
  const oldRt = createSvaraMatchRuntime({ persistence: store })
  const oldMatch = startRuntimeMatch(oldRt, oldPlayers)
  act(oldRt, oldMatch, 'o-exit', { type: 'exit' })
  act(oldRt, oldMatch, 'o-gone', { type: 'exit' })
  for (let i = 0; i < 20 && oldRt.exportInternalStateForServer(oldMatch).phase !== 'finished'; i++) {
    const round = oldRt.exportInternalStateForServer(oldMatch).round as any
    if (round?.kind === 'payout-display') sys(oldRt, oldMatch, { type: 'close-payout-display', roundId: round.roundId })
    else if (round?.dealing) sys(oldRt, oldMatch, { type: 'finish-dealing', roundId: round.roundId })
    else if (round?.kind === 'ordinary') act(oldRt, oldMatch, round.betting.toAct, { type: 'act', action: { kind: 'fold' } })
  }
  check('старият мач е приключил с победител o-win', store.load(oldMatch)?.state.phase === 'finished' && store.load(oldMatch)?.state.winnerId === 'o-win', store.load(oldMatch)?.state.phase)
  raw.prepare("UPDATE svara_match_snapshots SET finished_at = datetime('now', '-1 hour') WHERE match_id = ?").run(oldMatch)
  {
    const t = makeLobby(new Clock(), realProgression)
    check('старт без нито един запис за „Свара“ → старите мачове не се пипат', t.recovery === 'ready' && ledgerRows(oldMatch).length === 0 && progressOf('o-win').completed === 0)
    t.lobby.shutdown()
  }

  console.log('\n[1] Живо приключване: победа, напускане, ред, повторения, уреждане')
  {
    profile('p-win'); profile('p-exit1'); profile('p-exit2')
    raw.prepare('INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level) VALUES (?, 14, 3, 4) ON CONFLICT(profile_id) DO UPDATE SET completed_games_count = 14, won_games_count = 3, rank_level = 4').run('p-win')
    const before = { win: progressOf('p-win'), e1: progressOf('p-exit1'), e2: progressOf('p-exit2') }
    const clock = new Clock()
    const t = makeLobby(clock, realProgression)
    for (const id of ['p-win', 'p-exit1', 'p-exit2']) t.attach(id)
    const m = t.create('p-win', 3)!
    t.join('p-exit1', m); t.join('p-exit2', m)
    check('мачът започна', store.load(m)?.state.phase === 'in-progress')
    check('незавършен мач → нищо не е записано', ledgerRows(m).length === 0 && progressOf('p-win').completed === 14)
    // Ред: в момента на финалното svara_table_updated прогресът вече е в базата.
    let ledgerAtFinishedUpdate: number | null = null
    const winFrames = t.frames.get('p-win')!
    const origPush = winFrames.push.bind(winFrames)
    winFrames.push = (...items: any[]) => {
      for (const f of items) if (ledgerAtFinishedUpdate === null && f.type === 'svara_table_updated' && f.table.phase === 'finished') ledgerAtFinishedUpdate = ledgerRows(m).length
      return origPush(...items)
    }
    check('p-exit1 напуска', t.command('p-exit1', m, { type: 'exit' }))
    check('p-exit2 напуска', t.command('p-exit2', m, { type: 'exit' }))
    check('мачът приключи с победител p-win', t.runUntilFinished(m) && store.load(m)?.state.winnerId === 'p-win', store.load(m)?.state.phase)
    const state = store.load(m)!.state
    check('напусналите остават в state.seats със статус exited', state.seats.length === 3 && state.status['p-exit1'] === 'exited' && state.status['p-exit2'] === 'exited')
    const rows = ledgerRows(m)
    check('ledger: 3 реда source=svara_match, победа само за p-win', rows.length === 3 && rows.every((r) => r.source === SVARA_PROGRESSION_SOURCE)
      && rows.filter((r) => r.win === 1).map((r) => r.id).join() === 'p-win', rows)
    const win = progressOf('p-win'), e1 = progressOf('p-exit1'), e2 = progressOf('p-exit2')
    check('победител: +1 игра, +1 победа', win.completed === before.win.completed + 1 && win.won === before.win.won + 1, { before: before.win, win })
    check('напуснали: +1 игра, без победа', e1.completed === before.e1.completed + 1 && e1.won === before.e1.won && e2.completed === before.e2.completed + 1 && e2.won === before.e2.won, { e1, e2 })
    check('ниво/ранг: 15 игри → ниво 5 „Новак“ в profiles и profile_progress', win.level === 5 && win.rankLevel === 5 && win.rankTitle === getRankTitleForLevel(5) && win.rankTitle === 'Новак', win)
    check('ELO (skill_rating) не е пипан', win.skill === before.win.skill && e1.skill === before.e1.skill && e2.skill === before.e2.skill)
    check('прогресът е записан ПРЕДИ финалното svara_table_updated (клиентът тогава презарежда профила)', ledgerAtFinishedUpdate === 3, ledgerAtFinishedUpdate)
    const progressFrames = (id: string) => t.frames.get(id)!.filter((f) => f.type === 'svara_progress_updated' && f.matchId === m).length
    check('напусналите получават svara_progress_updated (по 1), победителят — не (има финалния snapshot)', progressFrames('p-exit1') === 1 && progressFrames('p-exit2') === 1 && progressFrames('p-win') === 0)
    check('финансовото уреждане е минало (paid)', economy.getFinance(m)?.status === 'paid')
    // Повторна обработка: reconnect, заявка за състояние, излизане от резултата.
    t.lobby.disconnect('p-win'); t.attach('p-win'); t.lobby.reconnect('p-win')
    t.send('p-win', { type: 'request_svara_table_state', matchId: m })
    t.send('p-win', { type: 'leave_svara_table', matchId: m })
    t.lobby.reconnect('p-exit1')
    clock.advance(15 * 60_000)
    const after = progressOf('p-win')
    check('reconnect / повторна заявка / излизане → без второ +1', after.completed === win.completed && after.won === win.won && ledgerRows(m).length === 3
      && progressOf('p-exit1').completed === e1.completed)
    check('пряко повторно извикване на записа за същия мач → no-op', realProgression.record(m, 'p-win', true) && progressOf('p-win').completed === win.completed && progressOf('p-win').won === win.won)
    t.lobby.shutdown()
  }

  console.log('\n[2] Временна грешка → уреждането не е засегнато, повторен опит без двойно начисляване')
  {
    for (const id of ['f-a', 'f-b', 'f-c']) profile(id)
    const failures = new Map<string, number>([['f-b', 2], ['f-c', 1]])
    let calls = 0
    const flaky: SvaraProgression = {
      ...realProgression,
      record(matchId, profileId, didWin) {
        calls++
        const left = failures.get(profileId) ?? 0
        if (left > 0) {
          failures.set(profileId, left - 1)
          if (profileId === 'f-c') throw new Error('database is locked (simulated)')
          return false
        }
        return realProgression.record(matchId, profileId, didWin)
      },
    }
    const clock = new Clock()
    const t = makeLobby(clock, flaky)
    for (const id of ['f-a', 'f-b', 'f-c']) t.attach(id)
    const m = t.create('f-a', 3)!
    t.join('f-b', m); t.join('f-c', m)
    t.command('f-b', m, { type: 'exit' }); t.command('f-c', m, { type: 'exit' })
    errors.length = 0
    check('мачът приключи', t.runUntilFinished(m))
    check('уреждането е минало въпреки грешката (paid)', economy.getFinance(m)?.status === 'paid')
    check('записан е само f-a; f-b/f-c чакат повторен опит; грешката е логната',
      ledgerRows(m).map((r) => r.id).join() === 'f-a' && errors.some((e) => String(e).includes('[svara-progression]')), ledgerRows(m))
    const callsBefore = calls
    t.send('f-a', { type: 'request_svara_table_state', matchId: m })
    check('повторен publish докато чака → без нови опити извън графика', calls === callsBefore)
    clock.advance(SVARA_PROGRESSION_RETRY_MS)
    check('1-ви повторен опит: f-c записан, f-b още не (втора грешка), f-a без дубликат',
      ledgerRows(m).map((r) => r.id).join() === 'f-a,f-c' && progressOf('f-a').completed === 1, ledgerRows(m))
    clock.advance(SVARA_PROGRESSION_RETRY_MS)
    check('2-ри повторен опит: всички записани точно веднъж, победа само f-a',
      ledgerRows(m).length === 3 && ['f-a', 'f-b', 'f-c'].every((id) => progressOf(id).completed === 1) && progressOf('f-a').won === 1 && progressOf('f-b').won === 0 && progressOf('f-c').won === 0)
    check('след повторния опит всички получават svara_progress_updated', ['f-a', 'f-b', 'f-c'].every((id) => t.frames.get(id)!.some((f) => f.type === 'svara_progress_updated' && f.matchId === m)))
    const settledCalls = calls
    clock.advance(10 * SVARA_PROGRESSION_RETRY_MS)
    check('без повече опити след успеха', calls === settledCalls && ledgerRows(m).length === 3)
    t.lobby.shutdown()
  }

  console.log('\n[3] Рестарт преди повторния опит → довършване при старта, без дубликат')
  {
    for (const id of ['r-a', 'r-b']) profile(id)
    const down: SvaraProgression = { ...realProgression, record: () => false }
    const clock = new Clock()
    const t1 = makeLobby(clock, down)
    for (const id of ['r-a', 'r-b']) t1.attach(id)
    const m = t1.create('r-a', 2)!
    t1.join('r-b', m)
    t1.command('r-b', m, { type: 'exit' })
    check('мачът приключи, нищо не е записано (базата „недостъпна“)', t1.runUntilFinished(m) && ledgerRows(m).length === 0)
    t1.lobby.shutdown()
    const t2 = makeLobby(new Clock(), realProgression)
    check('рестарт → записът е довършен при старта', t2.recovery === 'ready' && ledgerRows(m).length === 2 && progressOf('r-a').completed === 1 && progressOf('r-a').won === 1 && progressOf('r-b').won === 0)
    check('рестарт след първите записи → старият мач [0] (в 24-часовия прозорец) пак не е начислен', ledgerRows(oldMatch).length === 0 && progressOf('o-win').completed === 0)
    t2.lobby.shutdown()
    const t3 = makeLobby(new Clock(), realProgression)
    check('повторен рестарт → без промяна', ledgerRows(m).length === 2 && progressOf('r-a').completed === 1 && progressOf('r-b').completed === 1)
    t3.lobby.shutdown()
  }

  console.log('\n[4] Отпадане (без чипове) → игра без победа')
  {
    for (const id of ['e-a', 'e-b']) profile(id)
    const rt = createSvaraMatchRuntime({ persistence: store })
    const m = startRuntimeMatch(rt, ['e-a', 'e-b'])
    playAllInToFinish(rt, m)
    const s = store.load(m)!.state
    const winner = s.winnerId!
    const loser = winner === 'e-a' ? 'e-b' : 'e-a'
    check('мачът приключи с отпаднал играч', s.phase === 'finished' && s.status[loser] === 'eliminated' && s.seats.includes(loser), s.status)
    const t = makeLobby(new Clock(), realProgression)
    check('победител +1/+1, отпаднал +1 игра без победа', progressOf(winner).completed === 1 && progressOf(winner).won === 1 && progressOf(loser).completed === 1 && progressOf(loser).won === 0)
    t.lobby.shutdown()
  }

  console.log('\n[5] Мач без победител (всички отсъстват) → само игри')
  {
    for (const id of ['n-a', 'n-b']) profile(id)
    const clock = new Clock()
    const past = clock.time - SVARA_PRESENCE_WAIT_MS - 60_000
    const rt = createSvaraMatchRuntime({ persistence: store, now: () => past })
    const m = `rt-${randomUUID()}`
    rt.registerMatch({ matchId: m, creator: { playerId: 'n-a' }, capacity: 2, entryFee: 5_000, entryPercent: 1, startMode: 'auto' })
    rt.executeParticipantCommand(m, { playerId: 'n-b' }, 'join-n-b', { type: 'join-seat' })
    for (const id of ['n-a', 'n-b']) rt.executeSystemCommand(m, `absent-${id}`, { type: 'set-absent', playerId: id, absent: true })
    const t = makeLobby(clock, realProgression)
    const s = store.load(m)!.state
    check('приключи при възстановяването без победител', s.phase === 'finished' && s.winnerId === null, { phase: s.phase, reason: s.finishReason })
    check('по +1 игра, без победи', ['n-a', 'n-b'].every((id) => progressOf(id).completed === 1 && progressOf(id).won === 0) && ledgerRows(m).every((r) => r.win === 0))
    t.lobby.shutdown()
  }

  console.log('\n[6] Закрита незапочната маса → нищо')
  {
    for (const id of ['c-host', 'c-guest']) profile(id)
    const t = makeLobby(new Clock(), realProgression)
    t.attach('c-host'); t.attach('c-guest')
    const m = t.create('c-host', 3)!
    t.join('c-guest', m)
    t.send('c-host', { type: 'leave_svara_table', matchId: m })
    check('масата е закрита, без записи', store.load(m)?.state.phase === 'closed' && ledgerRows(m).length === 0 && progressOf('c-guest').completed === 0)
    t.lobby.shutdown()
  }

  console.log('\n[7] Извличане на участниците')
  {
    check('live: незавършен мач → null', getSvaraProgressionParticipants({ phase: 'in-progress', seats: ['a', 'b'], winnerId: null }) === null)
    check('live: победител извън масата се игнорира', getSvaraProgressionParticipants({ phase: 'finished', seats: ['a', 'b'], winnerId: 'x' })?.winnerId === null)
  }

  console.log('\n[8] Старият мач остава неначислен до края')
  {
    const t = makeLobby(new Clock(), realProgression)
    t.lobby.shutdown()
    check('нито един запис и нула игри за участниците на стария мач', ledgerRows(oldMatch).length === 0
      && oldPlayers.every((id) => progressOf(id).completed === 0 && progressOf(id).won === 0))
  }

  check('без неочаквани грешки извън симулираните', errors.every((e) => String(e).includes('[svara-progression]') || String(e).includes('(simulated)')), errors.map(String))
} catch (error) {
  failed++
  console.error('UNEXPECTED', error)
} finally {
  progressStore.close(); economy.close(); store.close(); raw.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\nSvara match progression: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
