/**
 * checkHeldPayoutReplayBlockStage3B2.ts — Етап 3Б.2, последна защита:
 * „Преиграй“ се отказва САМО ако задържаното изплащане на масата още не е
 * записано в belot_held_payouts.
 *
 *   [1] Решението (heldPayoutRegistrationGuard.flushRoom) върху реален
 *       matchEconomyStore + временна база: неуспешен запис → блок; успешен
 *       синхронен опит → разрешено; вече регистрирано → разрешено; друга маса
 *       → не се засяга.
 *   [2] Свързването в index.ts / клиента (статично).
 *   [3] Установен ред: в края на мача стаята става `finished` и snapshot-ът
 *       ѝ се изтрива ОЩЕ при записа на края — преди изплащането (документира
 *       защо устойчивият източник е belot_match_completion_ledger).
 *
 * Пускане: npx tsx scripts/checkHeldPayoutReplayBlockStage3B2.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHumanParticipant } from '../src/core/createHumanParticipant.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { seatParticipantInRoom } from '../src/core/seatParticipantInRoom.js'
import type { Seat, ServerRoom } from '../src/core/serverTypes.js'
import { createActiveRoomSnapshotStore } from '../src/db/activeRoomSnapshotStore.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createMatchEconomyStore, getRoomStakeLedgerScope } from '../src/db/matchEconomyStore.js'
import type { BelotFinancialTerms } from '../src/economy/belotFinancialTerms.js'
import { createHeldPayoutRegistrationGuard } from '../src/economy/heldPayoutRegistrationGuard.js'
import { syncRoomWithAuthoritativeState } from '../src/game/syncRoomWithAuthoritativeState.js'

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

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const quiet = { log: () => {}, error: () => {} }
const silence = <T>(fn: () => T): T => {
  const original = console.error
  console.error = () => {}
  try { return fn() } finally { console.error = original }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'replay-block-3b2-'))
  const dbPath = join(dir, 'economy.sqlite')
  try {
    await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
    const economy = await createMatchEconomyStore(dbPath)
    const raw = new DatabaseSync(dbPath)
    let counter = 0
    const heldRoom = (): ServerRoom => {
      counter += 1
      let room = createServerRoom({ config: { allowBots: false, isPrivate: true, stakeAmount: 5_000 } })
      for (const seat of SEATS) {
        const id = `r${counter}-${seat}`
        raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
        raw.prepare('INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000)').run(id)
        room = seatParticipantInRoom(room, seat, createHumanParticipant({ identity: { profileId: id, displayName: id } }))
      }
      if (!economy.collectRoomStakes(room, 5_000).ok) throw new Error('debit')
      return {
        ...room,
        config: { ...room.config, financialTerms: { broken: true } as unknown as BelotFinancialTerms },
        game: { ...room.game, stateVersion: 20, authoritativeState: { phase: 'match-ended', matchEnded: { winnerTeam: 'A' } } as never },
      }
    }
    const guard = createHeldPayoutRegistrationGuard({
      recordHeldPayout: (record) => economy.recordHeldPayout(record),
      removeRoomSnapshot: () => {},
      isRoomActive: () => true,
      ...quiet,
    })
    // Същата логика като blockReplayIfHeldPayoutUnrecorded в index.ts.
    const replayBlocked = (room: ServerRoom) => !guard.flushRoom(room.id)

    console.log('\n[1] Решение за „Преиграй“')
    {
      const room = heldRoom()
      raw.exec(`CREATE TRIGGER fail_held BEFORE INSERT ON belot_held_payouts BEGIN SELECT RAISE(ABORT, 'simulated'); END;`)
      const payout = silence(() => economy.payoutMatchWinners(room))
      if (!payout.ok && payout.held?.recorded === false) guard.enqueue(payout.held.record, payout.held.error)
      check('незаписано задържане → „Преиграй“ е блокиран', replayBlocked(room))
      check('опитът е синхронен, но базата още отказва → случаят остава в RAM', guard.pendingMatchScopes().includes(getRoomStakeLedgerScope(room)))
      const other = heldRoom()
      check('друга маса без незаписан случай → не е блокирана', !replayBlocked(other))
      raw.exec('DROP TRIGGER fail_held;')
      check('базата се оправя → синхронният опит записва → „Преиграй“ е разрешен', !replayBlocked(room) && economy.getHeldPayout(getRoomStakeLedgerScope(room))?.status === 'pending_review')
      check('след записа няма какво да блокира', !replayBlocked(room) && guard.pendingMatchScopes().length === 0)

      const registered = heldRoom()
      const p = silence(() => economy.payoutMatchWinners(registered))
      check('задържане, записано веднага → не блокира „Преиграй“', !p.ok && p.held?.recorded === true && !replayBlocked(registered))
    }

    console.log('\n[2] Свързване (статично)')
    {
      const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
      const tryAt = src.indexOf('function tryApplyReplayRestart(room: ServerRoom, votes: Seat[]): void {')
      const guardAt = src.indexOf('if (blockReplayIfHeldPayoutUnrecorded(room)) return', tryAt)
      const coPlayAt = src.indexOf('findReplayCoPlayConflictSeats(room, votes)', tryAt)
      check('проверката е първа в tryApplyReplayRestart (общ път за глас на играч и на бот)', tryAt > 0 && guardAt > tryAt && guardAt < coPlayAt)
      check('единственият път към applyReplayRestart е през tryApplyReplayRestart', (src.match(/applyReplayRestart\(room\)/g) ?? []).length === 1 && (src.match(/tryApplyReplayRestart\(/g) ?? []).length === 3)
      const fn = /function blockReplayIfHeldPayoutUnrecorded[\s\S]*?\n}\r?\n/.exec(src)?.[0] ?? ''
      check('синхронен опит: heldPayoutRegistrationGuard.flushRoom(room.id)', fn.includes('if (heldPayoutRegistrationGuard.flushRoom(room.id)) return false'))
      check('отказ: само гласовете се нулират (стаята остава match-ended), съобщение с код', fn.includes('{ ...room, replayVotes: [] }') && fn.includes("code: 'replay_blocked_held_payout'") && !fn.includes('authoritativeState'))
      const client = readFileSync(join(import.meta.dirname, '../../src/app/activeRoom/createActiveRoomFlowController.ts'), 'utf8')
      check('клиент: показва прозорец с неутрално заглавие', client.includes("message.code === 'replay_blocked_held_payout'") && client.includes("showCoPlayRestrictedNotice(message.message, 'replay', 'Преиграването е временно спряно')"))
      const notice = readFileSync(join(import.meta.dirname, '../../src/app/coPlay/showCoPlayRestrictedNotice.ts'), 'utf8')
      check('досегашните извиквания на прозореца пазят заглавието по подразбиране', notice.includes('title: string = CO_PLAY_RESTRICTED_TITLE'))
    }

    console.log('\n[3] Установен ред: snapshot-ът се изтрива още в края на мача')
    {
      const snapshots = await createActiveRoomSnapshotStore(dbPath)
      const room = heldRoom()
      const playing = { ...room, status: 'playing' as const, game: { ...room.game, authoritativeState: null } }
      snapshots.upsertRoom(playing)
      check('по време на игра snapshot-ът съществува', raw.prepare('SELECT 1 FROM active_room_snapshots WHERE room_id = ?').get(room.id) !== undefined)
      const ended = syncRoomWithAuthoritativeState(playing, { phase: 'match-ended', timer: { expiresAt: null } } as never)
      check('match-ended → room.status = finished', ended.status === 'finished')
      snapshots.upsertRoom(ended) // persist на кандидата — ПРЕДИ onApplied (completion ledger + payout)
      check('записът на края на мача изтрива snapshot-а (преди изплащането)', raw.prepare('SELECT 1 FROM active_room_snapshots WHERE room_id = ?').get(room.id) === undefined)
      snapshots.close()
    }
    raw.close()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows */ }
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
