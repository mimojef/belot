/**
 * checkHeldPayoutsCrashRecoveryStage3B2.ts — сценарии за срив и
 * възстановяване на задържани изплащания (Етап 3Б.2, финална защита).
 *
 *   [A] heldPayoutRegistrationGuard + реални store-ове: неуспешен запис в
 *       belot_held_payouts → snapshot-ът НЕ се трие → „срив“ → при старт
 *       registerHeldPayoutForRestoredRoom го регистрира.
 *   [B] Диагностика при старт по belot_match_completion_ledger.
 *   [C] Компилиран сървър (`node dist/index.js`) с временна база: старт
 *       регистрира завършен платен мач без изплащане; втори старт — без дубликат.
 *
 * Изисква актуален dist за [C]: `npm run build`.
 * Пускане: npx tsx scripts/checkHeldPayoutsCrashRecoveryStage3B2.ts
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHumanParticipant } from '../src/core/createHumanParticipant.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { seatParticipantInRoom } from '../src/core/seatParticipantInRoom.js'
import type { Seat, ServerRoom } from '../src/core/serverTypes.js'
import { createActiveRoomSnapshotStore } from '../src/db/activeRoomSnapshotStore.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createMatchEconomyStore, getRoomStakeLedgerScope, type HeldPayoutRecord } from '../src/db/matchEconomyStore.js'
import type { BelotFinancialTerms } from '../src/economy/belotFinancialTerms.js'
import { createHeldPayoutRegistrationGuard } from '../src/economy/heldPayoutRegistrationGuard.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const SERVER_ROOT = join(import.meta.dirname, '..')
const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const START = 1_000_000
const quiet = { log: () => {}, error: () => {} }
const silence = <T>(fn: () => T): T => {
  const original = console.error
  console.error = () => {}
  try { return fn() } finally { console.error = original }
}

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => done(port))
    })
  })
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'held-crash-3b2-'))
  try {
    const dbPath = join(root, 'economy.sqlite')
    await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
    const economy = await createMatchEconomyStore(dbPath)
    const raw = new DatabaseSync(dbPath)
    let counter = 0
    const profile = (id: string) => {
      raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
      raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, START)
    }
    const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
    const heldCount = () => (raw.prepare('SELECT COUNT(*) AS n FROM belot_held_payouts').get() as { n: number }).n
    const snapshotExists = (roomId: string) => raw.prepare('SELECT 1 FROM active_room_snapshots WHERE room_id = ?').get(roomId) !== undefined

    /** Приключил мач (A печели) с room-scoped входове; невалидни условия. */
    const buildHeldRoom = (stake: number): ServerRoom => {
      counter += 1
      let room = createServerRoom({ config: { allowBots: false, isPrivate: true, stakeAmount: stake } })
      for (const seat of SEATS) {
        const id = `c${counter}-${seat}`
        profile(id)
        room = seatParticipantInRoom(room, seat, createHumanParticipant({ identity: { profileId: id, displayName: id } }))
      }
      room = { ...room, game: { ...room.game, stateVersion: 2 } }
      if (!economy.collectRoomStakes(room, stake).ok) throw new Error('debit')
      return {
        ...room,
        config: { ...room.config, financialTerms: { broken: true } as unknown as BelotFinancialTerms },
        // `kind` → activeRoomSnapshotStore не нормализира (тестово състояние).
        game: { ...room.game, stateVersion: 30, authoritativeState: { kind: 'test', phase: 'match-ended', matchEnded: { winnerTeam: 'A' } } as never },
      }
    }

    console.log('\n[A] Неуспешен запис → snapshot-ът се пази → срив → регистрация при старт')
    {
      const snapshots = await createActiveRoomSnapshotStore(dbPath)
      const room = buildHeldRoom(20_000)
      const scope = getRoomStakeLedgerScope(room)
      snapshots.upsertRoom(room) // snapshot при match-ended (както applyAcceptedGameWorkerCandidate преди side effects)

      raw.exec(`CREATE TRIGGER fail_held BEFORE INSERT ON belot_held_payouts BEGIN SELECT RAISE(ABORT, 'disk I/O error (simulated)'); END;`)
      const payout = silence(() => economy.payoutMatchWinners(room))
      check('задържано, записът в регистъра не успя', !payout.ok && payout.held?.recorded === false)
      const record = !payout.ok && payout.held?.recorded === false ? payout.held.record : null

      let removed = 0
      let roomActive = true
      const guard = createHeldPayoutRegistrationGuard({
        recordHeldPayout: (r) => economy.recordHeldPayout(r),
        removeRoomSnapshot: (roomId) => { removed += 1; snapshots.markRoomRemoved(roomId) },
        isRoomActive: () => roomActive,
        ...quiet,
      })
      guard.enqueue(record as HeldPayoutRecord, 'disk I/O error')
      // cleanup на масата (markRoomSnapshotRemoved в index.ts): flush → неуспех → retain
      const safe = guard.flushRoom(room.id)
      if (!safe) guard.retainSnapshot(room.id)
      roomActive = false
      check('cleanup: flush неуспешен → snapshot-ът е задържан', !safe && guard.retainedRoomIds().includes(room.id) && removed === 0)
      guard.retryNow()
      check('повторен опит при все още счупена база → snapshot-ът остава', snapshotExists(room.id) && removed === 0 && guard.pendingMatchScopes().includes(scope))
      check('без ред в регистъра и без движение на жълтици', heldCount() === 0 && SEATS.every((s) => balance(`c${counter}-${s}`) === START - 20_000))

      // ── „Срив“: RAM изчезва (guard-ът), базата се оправя, сървърът стартира отново.
      raw.exec('DROP TRIGGER fail_held;')
      const reboot = await createActiveRoomSnapshotStore(dbPath)
      const restored = reboot.loadActiveRooms().find((r) => r.id === room.id)
      check('след срива snapshot-ът се възстановява', restored !== undefined)
      const reg = restored ? economy.registerHeldPayoutForRestoredRoom(restored) : { status: 'failed' as const, message: 'missing' }
      check('при старт: регистриран (invalid), без движение на жълтици', reg.status === 'recorded' && economy.getHeldPayout(scope)?.holdReason === 'invalid'
        && SEATS.every((s) => balance(`c${counter}-${s}`) === START - 20_000))
      const again = restored ? economy.registerHeldPayoutForRestoredRoom(restored) : null
      check('повторен старт: пак един случай (hold_count++)', again?.status === 'recorded' && heldCount() === 1 && economy.getHeldPayout(scope)?.holdCount === 2)

      // Без срив: базата се оправя → retry записва → snapshot-ът се освобождава.
      const room2 = buildHeldRoom(5_000)
      snapshots.upsertRoom(room2)
      raw.exec(`CREATE TRIGGER fail_held2 BEFORE INSERT ON belot_held_payouts BEGIN SELECT RAISE(ABORT, 'busy'); END;`)
      const p2 = silence(() => economy.payoutMatchWinners(room2))
      let active2 = true
      const guard2 = createHeldPayoutRegistrationGuard({
        recordHeldPayout: (r) => economy.recordHeldPayout(r),
        removeRoomSnapshot: (roomId) => snapshots.markRoomRemoved(roomId),
        isRoomActive: () => active2,
        ...quiet,
      })
      if (!p2.ok && p2.held?.recorded === false) guard2.enqueue(p2.held.record, p2.held.error)
      if (!guard2.flushRoom(room2.id)) guard2.retainSnapshot(room2.id)
      raw.exec('DROP TRIGGER fail_held2;')
      guard2.retryNow()
      check('базата се оправи, масата още е активна → записан, snapshot-ът остава', economy.getHeldPayout(getRoomStakeLedgerScope(room2)) !== null && snapshotExists(room2.id) && !guard2.isIdle())
      active2 = false
      guard2.retryNow()
      check('масата вече не е активна → задържаният snapshot се изтрива, guard-ът е празен', !snapshotExists(room2.id) && guard2.isIdle())

      const throwing = createHeldPayoutRegistrationGuard({
        recordHeldPayout: () => { throw new Error('boom') },
        removeRoomSnapshot: () => { throw new Error('should not be called') },
        isRoomActive: () => false,
        ...quiet,
      })
      throwing.enqueue({ ...(record as HeldPayoutRecord), matchScope: 'x:v1', roomId: 'x' }, 'boom')
      throwing.retainSnapshot('x')
      check('хвърлящ запис не чупи guard-а и не трие snapshot-а', !throwing.flushRoom('x') && (() => { throwing.retryNow(); return throwing.retainedRoomIds().includes('x') })())
      snapshots.close()
      reboot.close()
    }

    console.log('\n[B] Диагностика при старт по belot_match_completion_ledger')
    {
      const insertCompletion = raw.prepare(`INSERT INTO belot_match_completion_ledger
        (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at, is_guest_trial) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`)
      const completed = (roomId: string, version: number, stake: number, opts: { guest?: boolean; winners?: string[]; losers?: string[] } = {}) => {
        const scope = `${roomId}:v${version}`
        // Само профил (без да пипа портфейла — входовете може вече да са удържани).
        const ensureProfile = (id: string) => raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
        for (const id of opts.winners ?? [`${roomId}-w1`, `${roomId}-w2`]) { if (!id.startsWith('temp-bot-')) ensureProfile(id); insertCompletion.run(scope, id.startsWith('temp-bot-') ? null : id, roomId, 'A', 1, stake, opts.guest ? 1 : 0) }
        for (const id of opts.losers ?? [`${roomId}-l1`, `${roomId}-l2`]) { ensureProfile(id); insertCompletion.run(scope, id, roomId, 'B', 0, stake, opts.guest ? 1 : 0) }
        return scope
      }

      // Случай: мач от опашката — queue входове + връзки (3Б.1); изплащането липсва.
      const qRoom = 'room-missing-q'
      const ids = [`${qRoom}-w1`, `${qRoom}-w2`, `${qRoom}-l1`, `${qRoom}-l2`]
      ids.forEach(profile)
      for (const id of ids) {
        if (!economy.collectQueueStake(`q-${id}`, id, 5_000).ok) throw new Error('q debit')
      }
      economy.bindQueueStakesToRoom(qRoom, ids.map((id) => ({ queueScope: `queue:q-${id}`, profileId: id })))
      const scopeQ = completed(qRoom, 12, 5_000)
      // Случай: частна маса — room-scoped входове на v3 (и стар v1 от предишен мач).
      const pRoom = 'room-missing-p'
      const pIds = [`${pRoom}-w1`, `${pRoom}-w2`, `${pRoom}-l1`, `${pRoom}-l2`]
      pIds.forEach(profile)
      const fakeP = (v: number) => ({ id: pRoom, game: { stateVersion: v }, seats: Object.fromEntries(SEATS.map((s, i) => [s, { participant: { kind: 'human', identity: { profileId: pIds[i] }, publicProfile: null } }])) }) as unknown as ServerRoom
      economy.collectRoomStakes(fakeP(1), 20_000)
      economy.collectRoomStakes(fakeP(3), 20_000)
      const scopeP = completed(pRoom, 9, 20_000)

      // Изключения.
      const scopeGuest = completed('room-guest', 5, 5_000, { guest: true })
      const scopeTournament = completed('room-tournament', 5, 0)
      const scopeTempBots = completed('room-tempbots', 5, 5_000, { winners: ['temp-bot-1', 'temp-bot-2'] })
      const scopePaid = completed('room-paid', 5, 5_000)
      raw.prepare(`INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after) VALUES ('paid-1', ?, 'room-paid-w1', 'winner_payout', 8000, 0)`).run(scopePaid)

      const balancesBefore = [...ids, ...pIds].map(balance)
      const heldBefore = heldCount()
      raw.exec(`CREATE TRIGGER fail_diag BEFORE INSERT ON belot_held_payouts WHEN NEW.match_scope = '${scopeP}' BEGIN SELECT RAISE(ABORT, 'simulated'); END;`)
      const d1 = economy.registerMissingPayoutsFromCompletionLedger()
      check('намерени точно 2 (опашка + частна); изключени: гост, турнир, временни ботове, платен', d1.found === 2 && d1.registered.includes(scopeQ) && d1.failed.some((f) => f.matchScope === scopeP), d1)
      check('изключенията не са регистрирани', [scopeGuest, scopeTournament, scopeTempBots, scopePaid].every((s) => economy.getHeldPayout(s) === null))
      check('DB грешка за единия → failed, без частичен ред', economy.getHeldPayout(scopeP) === null && heldCount() === heldBefore + 1)
      raw.exec('DROP TRIGGER fail_diag;')

      const rowQ = economy.getHeldPayout(scopeQ)
      check('опашка: payout-missing, pending, 2 победители, 4 queue входа (по връзките)', rowQ?.holdReason === 'payout-missing' && rowQ.status === 'pending_review'
        && rowQ.winners.length === 2 && rowQ.stakeDebits.length === 4 && rowQ.stakeDebits.every((d) => d.scope.startsWith('queue:q-') && d.amount === 5_000), rowQ)
      check('условията не се измислят (financial_terms_json = null, rules_version = null)', rowQ?.financialTermsJson === 'null' && rowQ.rulesVersion === null)

      const d2 = economy.registerMissingPayoutsFromCompletionLedger()
      const rowP = economy.getHeldPayout(scopeP)
      check('следващ старт: регистрира пропуснатия (частна маса)', d2.found === 1 && d2.registered.includes(scopeP))
      check('частна маса: входовете на v3 (не v1)', rowP?.stakeDebits.length === 4 && rowP.stakeDebits.every((d) => d.scope === `${pRoom}:v3`), rowP?.stakeDebits)
      const d3 = economy.registerMissingPayoutsFromCompletionLedger()
      check('трети старт: нищо ново, hold_count непроменен', d3.found === 0 && economy.getHeldPayout(scopeQ)?.holdCount === 1)
      check('диагностиката не движи жълтици', JSON.stringify([...ids, ...pIds].map(balance)) === JSON.stringify(balancesBefore))

      const settled = economy.settleHeldPayout({ matchScope: scopeQ, action: 'refund', resolvedBy: 'admin', note: 'мачът е прекъснат — връщаме входовете' })
      check('уреждане (refund) по диагностичния случай', settled.ok && settled.movements.length === 4 && ids.every((id) => balance(id) === START), { settled, balances: ids.map(balance) })
      const d4 = economy.registerMissingPayoutsFromCompletionLedger()
      check('вече уреден случай не се регистрира отново', d4.found === 0 && economy.getHeldPayout(scopeQ)?.status === 'settled_refund')
      const recon = economy.reconcileOrphanedQueueStakes({ activeRooms: [] })
      check('3Б.1 reconcile не връща същите входове втори път', ids.every((id) => balance(id) === START) && !recon.refunded.some((i) => ids.includes(i.profileId ?? '')))
    }
    raw.close()
    economy.close()

    console.log('\n[C] Компилиран сървър: старт регистрира, втори старт — без дубликат')
    {
      const dist = readFileSync(join(SERVER_ROOT, 'dist', 'index.js'), 'utf8')
      check('dist е актуален (registerMissingPayoutsFromCompletionLedger + guard)', dist.includes('registerMissingPayoutsFromCompletionLedger') && dist.includes('heldPayoutRegistrationGuard.flushRoom'))
      const serverDir = join(root, 'server')
      await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
      await cp(join(SERVER_ROOT, 'dist'), join(serverDir, 'dist'), { recursive: true })
      await cp(join(SERVER_ROOT, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
      await cp(join(SERVER_ROOT, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true })
      await cp(join(SERVER_ROOT, 'package.json'), join(serverDir, 'package.json'))
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      await symlink(join(SERVER_ROOT, 'node_modules'), join(serverDir, 'node_modules'), linkType)
      await symlink(join(SERVER_ROOT, '..', 'node_modules'), join(root, 'node_modules'), linkType)
      const ready = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
      check('временна база в изолирания root', ready.databaseFilePath.startsWith(root))
      const db = new DatabaseSync(ready.databaseFilePath)
      for (const id of ['boot-w1', 'boot-w2', 'boot-l1', 'boot-l2']) {
        db.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
        db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 777)').run(id)
      }
      const ins = db.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at) VALUES ('room-boot:v7', ?, 'room-boot', ?, ?, 5000, datetime('now'))`)
      ins.run('boot-w1', 'A', 1); ins.run('boot-w2', 'A', 1); ins.run('boot-l1', 'B', 0); ins.run('boot-l2', 'B', 0)

      const runOnce = async (): Promise<string> => {
        const port = await freePort()
        const chunks: string[] = []
        const child = spawn(process.execPath, [join('dist', 'index.js')], {
          cwd: serverDir,
          env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1', PASSWORD_RESET_RATE_LIMIT_SECRET: 'stage3b2-crash-check-secret-0123456789' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
        child.stdout.on('data', (c: string) => chunks.push(c)); child.stderr.on('data', (c: string) => chunks.push(c))
        const deadline = Date.now() + 60_000
        let up = false
        while (Date.now() < deadline && child.exitCode === null) {
          try { if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) { up = true; break } } catch { /* not yet */ }
          await sleep(150)
        }
        child.kill('SIGTERM')
        await new Promise<void>((done) => { const t = setTimeout(() => { child.kill('SIGKILL'); done() }, 10_000); child.once('exit', () => { clearTimeout(t); done() }) })
        if (!up) throw new Error(`server did not start\n${chunks.join('')}`)
        return chunks.join('')
      }

      const out1 = await runOnce()
      const row = db.prepare(`SELECT hold_reason, status, hold_count, winners_json FROM belot_held_payouts WHERE match_scope = 'room-boot:v7'`).get() as { hold_reason: string; status: string; hold_count: number; winners_json: string } | undefined
      check('старт 1: регистриран payout-missing / pending_review', row?.hold_reason === 'payout-missing' && row.status === 'pending_review' && (JSON.parse(row.winners_json) as unknown[]).length === 2)
      check('лог: missing-payout diagnostic found=1 registered=1', out1.includes('missing-payout diagnostic found=1 registered=1 failed=0'))
      const diagAt = out1.indexOf('missing-payout diagnostic')
      check('ред: reconcile на опашката → диагностика → HTTP listen', out1.indexOf('[queue-stake-reconcile] epoch=') < diagAt && diagAt < out1.indexOf('[http] Belot V2 server is running'))
      check('без движение на жълтици', (db.prepare(`SELECT SUM(yellow_coins_balance) AS s FROM profile_wallets WHERE profile_id LIKE 'boot-%'`).get() as { s: number }).s === 777 * 4)
      const out2 = await runOnce()
      const row2 = db.prepare(`SELECT COUNT(*) AS n, MAX(hold_count) AS c FROM belot_held_payouts WHERE match_scope = 'room-boot:v7'`).get() as { n: number; c: number }
      check('старт 2: без дубликат, hold_count = 1, диагностиката мълчи', row2.n === 1 && row2.c === 1 && !out2.includes('missing-payout diagnostic found='))
      db.close()
    }
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
