/**
 * checkOrphanedQueueStakesBootStage3B1.ts — проверка на startup пътя от
 * Етап 3Б.1 с КОМПИЛИРАНИЯ сървър (`node dist/index.js`) и временна база.
 *
 * Изолиран server root (копие на dist + migrations, junction към
 * node_modules) → временна SQLite база → seed: осиротял вход, вход в активна
 * маса (истински active_room_snapshots ред), вход от завършен мач,
 * исторически вход → два последователни старта на сървъра.
 *
 * Изисква актуален dist: `npm run build` преди пускане.
 * Пускане: npx tsx scripts/checkOrphanedQueueStakesBootStage3B1.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
import type { Seat } from '../src/core/serverTypes.js'
import { createActiveRoomSnapshotStore } from '../src/db/activeRoomSnapshotStore.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createMatchEconomyStore, MATCHMAKING_STAKE_BINDINGS_MIGRATION } from '../src/db/matchEconomyStore.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'

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
const STAKE = 5_000
const START = 100_000
const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => done(addr.port))
    })
  })
}

async function startCompiledServer(serverDir: string, port: number): Promise<{ child: ChildProcessWithoutNullStreams; output: () => string }> {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('dist', 'index.js')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
      PASSWORD_RESET_RATE_LIMIT_SECRET: 'stage3b1-boot-check-secret-0123456789',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early code=${child.exitCode}\n${chunks.join('')}`)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return { child, output: () => chunks.join('') }
    } catch { /* not yet */ }
    await sleep(150)
  }
  child.kill()
  throw new Error(`server did not start\n${chunks.join('')}`)
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); done() }, 10_000)
    child.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function main(): Promise<void> {
  const distSource = readFileSync(join(SERVER_ROOT, 'dist', 'index.js'), 'utf8')
  check('dist е актуален (съдържа reconcileOrphanedQueueStakesOnBoot)', distSource.includes('reconcileOrphanedQueueStakesOnBoot(serverState)'))

  const root = await mkdtemp(join(tmpdir(), 'belot-3b1-boot-'))
  const serverDir = join(root, 'server')
  try {
    await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
    await cp(join(SERVER_ROOT, 'dist'), join(serverDir, 'dist'), { recursive: true })
    // resolveGameWorkerEntryUrl stat-ва и src/…/gameWorkerThread.ts (избира по
    // mtime) — копираме src със запазени timestamps, както съществуващия harness.
    await cp(join(SERVER_ROOT, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
    await cp(join(SERVER_ROOT, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true })
    await cp(join(SERVER_ROOT, 'package.json'), join(serverDir, 'package.json'))
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(SERVER_ROOT, 'node_modules'), join(serverDir, 'node_modules'), linkType)
    await symlink(join(SERVER_ROOT, '..', 'node_modules'), join(root, 'node_modules'), linkType)

    // ── Seed на временната база (същите миграции като сървъра) ─────────────
    const ready = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
    const dbPath = ready.databaseFilePath
    check('базата е във временния root (не локалната/production)', dbPath.startsWith(root), dbPath)

    const raw = new DatabaseSync(dbPath)
    raw.prepare(`UPDATE server_migrations SET applied_at = datetime('now', '-1 hour') WHERE filename = ?`).run(MATCHMAKING_STAKE_BINDINGS_MIGRATION)
    const profile = (id: string) => {
      raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
      raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, START)
    }
    const economy = await createMatchEconomyStore(dbPath)
    const debit = (entryId: string, profileId: string) => {
      profile(profileId)
      const r = economy.collectQueueStake(entryId, profileId, STAKE)
      if (!r.ok) throw new Error(r.message)
    }

    debit('boot-orphan', 'boot-p-orphan')
    debit('boot-historic', 'boot-p-historic')
    raw.prepare(`UPDATE match_economy_ledger SET created_at = datetime('now', '-3 hours') WHERE room_id = 'queue:boot-historic'`).run()
    debit('boot-done', 'boot-p-done')
    economy.bindQueueStakesToRoom('room-boot-done', [{ queueScope: 'queue:boot-done', profileId: 'boot-p-done' }])
    raw.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at)
      VALUES ('room-boot-done:v2', 'boot-p-done', 'room-boot-done', 'B', 0, ?, datetime('now'))`).run(STAKE)

    // Истинска активна маса от опашката (без връзка — създадена „преди 3Б.1“).
    let room = createServerRoom({ config: { allowBots: false, isPrivate: false, stakeAmount: STAKE } })
    for (const seat of SEATS) {
      const profileId = `boot-p-active-${seat}`
      debit(`boot-active-${seat}`, profileId)
      room = seatParticipantInRoom(room, seat, createHumanParticipant({ identity: { profileId, displayName: profileId }, stakeLedgerScope: `queue:boot-active-${seat}` }))
    }
    room = initializeRoomAuthoritativeGameState(room)
    const snapshots = await createActiveRoomSnapshotStore(dbPath)
    snapshots.upsertRoom(room)
    snapshots.close()
    economy.close()

    const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
    const refunds = (scope: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE room_id = ? AND entry_type = 'stake_refund'`).get(scope) as { n: number }).n
    check('seed: всички входове удържани', ['boot-p-orphan', 'boot-p-historic', 'boot-p-done', 'boot-p-active-bottom'].every((p) => balance(p) === START - STAKE))

    // ── Старт 1 ─────────────────────────────────────────────────────────────
    console.log('\n[1] Първи старт на компилирания сървър')
    const port1 = await freePort()
    const s1 = await startCompiledServer(serverDir, port1)
    await sleep(500)
    const out1 = s1.output()
    await stop(s1.child)

    const restoredAt = out1.indexOf('[room-snapshot] restored active rooms=1')
    const reconcileAt = out1.indexOf('[queue-stake-reconcile] epoch=')
    const listenAt = out1.indexOf('[http] Belot V2 server is running')
    check('лог: масата е възстановена', restoredAt >= 0, out1.slice(0, 2000))
    check('лог: reconcile се изпълнява', reconcileAt >= 0)
    check('ред: възстановяване → reconcile → HTTP listen', restoredAt >= 0 && restoredAt < reconcileAt && reconcileAt < listenAt, { restoredAt, reconcileAt, listenAt })
    const summary = /\[queue-stake-reconcile\] epoch=.+? refunded=(\d+) inActiveRoom=(\d+) consumed=(\d+) refundFailed=(\d+) ambiguous=(\d+) \(preTracking=(\d+)/.exec(out1)
    check('доклад: refunded=1 inActiveRoom=4 consumed=1 refundFailed=0 preTracking=1',
      summary !== null && summary[1] === '1' && summary[2] === '4' && summary[3] === '1' && summary[4] === '0' && summary[6] === '1', summary?.[0])

    check('осиротелият вход е върнат (100 000, 1 refund ред)', balance('boot-p-orphan') === START && refunds('queue:boot-orphan') === 1)
    check('активната маса: нито един refund', SEATS.every((s) => balance(`boot-p-active-${s}`) === START - STAKE && refunds(`queue:boot-active-${s}`) === 0))
    const backfilled = (raw.prepare(`SELECT COUNT(*) AS n FROM matchmaking_stake_bindings WHERE room_id = ?`).get(room.id) as { n: number }).n
    check('връзките за възстановената маса са допълнени (4)', backfilled === 4)
    check('завършен мач: без refund', balance('boot-p-done') === START - STAKE && refunds('queue:boot-done') === 0)
    check('исторически вход: без refund', balance('boot-p-historic') === START - STAKE && refunds('queue:boot-historic') === 0)

    // ── Старт 2 ─────────────────────────────────────────────────────────────
    console.log('\n[2] Втори старт — без повторно връщане')
    const port2 = await freePort()
    const s2 = await startCompiledServer(serverDir, port2)
    await sleep(500)
    const out2 = s2.output()
    await stop(s2.child)
    const summary2 = /\[queue-stake-reconcile\] epoch=.+? refunded=(\d+) inActiveRoom=(\d+)/.exec(out2)
    check('втори старт: refunded=0', summary2 !== null && summary2[1] === '0', summary2?.[0])
    check('осиротелият: пак точно 1 refund, баланс 100 000', balance('boot-p-orphan') === START && refunds('queue:boot-orphan') === 1)
    check('без „refund FAILED“ в двата лога', !out1.includes('refund FAILED') && !out2.includes('refund FAILED'))
    raw.close()
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
