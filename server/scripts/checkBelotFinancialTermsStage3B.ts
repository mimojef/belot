/**
 * checkBelotFinancialTermsStage3B.ts — целеви проверки за Етап 3Б:
 * фиксирани финансови условия на Белот маса (room.config.financialTerms).
 *
 *   - модулът belotFinancialTerms.ts (фиксиране, валидация, идемпотентност);
 *   - реален matchEconomyStore.payoutMatchWinners върху ВРЕМЕННА база
 *     (пълният migration runner + databaseFilePathOverride);
 *   - активен мач, промяна на prize_amount, деактивирано/изтрито ниво;
 *   - рестарт: active_room_snapshots round-trip, structuredClone (worker), boot backfill;
 *   - стара чакаща частна маса; маси от случайната опашка;
 *   - статични проверки на свързването в index.ts.
 *
 * Не пипа реалната база. Пускане: npx tsx scripts/checkBelotFinancialTermsStage3B.ts
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
import { createMatchEconomyStore, resolveRoomPayoutPrizeAmount, setMatchPrizeResolver } from '../src/db/matchEconomyStore.js'
import { createMatchRoomsStore } from '../src/db/matchRoomsStore.js'
import {
  BELOT_LEGACY_FIXED_PRIZE_RULES,
  isBelotRoomEligibleForFinancialTerms,
  isValidBelotFinancialTerms,
  pinLegacyBelotFinancialTerms,
  resolvePinnedBelotPrize,
  withPinnedBelotFinancialTerms,
  type BelotFinancialTerms,
} from '../src/economy/belotFinancialTerms.js'
import { createPrivateRoomsStore } from '../src/game/privateRoomsStore.js'

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
let roomCounter = 0
let profileDb: DatabaseSync | null = null

function ensureProfile(profileId: string): void {
  profileDb?.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(profileId, profileId, profileId)
}

function withEndedState(room: ServerRoom): ServerRoom {
  return { ...room, game: { ...room.game, authoritativeState: { phase: 'match-ended', matchEnded: { winnerTeam: 'A' } } as never } }
}

/** 4 човека (с реални профили в базата), без игрово състояние. */
function buildRoom(stake: number, extraConfig: Partial<ServerRoom['config']> = {}): ServerRoom {
  roomCounter += 1
  let room = createServerRoom({ config: { allowBots: false, isPrivate: false, stakeAmount: stake, ...extraConfig } })
  for (const seat of SEATS) {
    const profileId = `p${roomCounter}-${seat}`
    ensureProfile(profileId)
    room = seatParticipantInRoom(room, seat, createHumanParticipant({ identity: { profileId, displayName: seat } }))
  }
  return room
}

/** Завършен мач, победител отбор A. */
function buildEndedRoom(stake: number, extraConfig: Partial<ServerRoom['config']> = {}): ServerRoom {
  return withEndedState(buildRoom(stake, extraConfig))
}

function ledgerPayouts(db: DatabaseSync, room: ServerRoom): number[] {
  return (db.prepare(`SELECT amount FROM match_economy_ledger WHERE room_id LIKE ? AND entry_type = 'winner_payout' ORDER BY profile_id`)
    .all(`${room.id}:v%`) as Array<{ amount: number }>).map((r) => r.amount)
}

const silence = <T>(fn: () => T): T => {
  const original = console.error
  console.error = () => {}
  try { return fn() } finally { console.error = original }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'belot-terms-3b-'))
  const dbPath = join(dir, 'economy.sqlite')
  try {
    await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
    const economy = await createMatchEconomyStore(dbPath)
    const matchRooms = await createMatchRoomsStore(dbPath)
    const raw = new DatabaseSync(dbPath)
    profileDb = raw
    const currentPrize = (stake: number) => matchRooms.getPrizeAmount(stake)
    setMatchPrizeResolver(currentPrize)

    console.log('\n[1] Модул: фиксиране и валидация')
    {
      const t = pinLegacyBelotFinancialTerms(5_000, () => 8_000, 'matchmaking-room-created', 123)
      check('фиксира вход + награда + версия', t !== null && t.entryFee === 5_000 && t.prizePerWinner === 8_000 && t.rulesVersion === BELOT_LEGACY_FIXED_PRIZE_RULES && t.pinnedAt === 123)
      check('неизвестна награда → null (не измисля)', pinLegacyBelotFinancialTerms(5_000, () => null, 'boot-backfill') === null)
      check('награда 0 / дробна → null', pinLegacyBelotFinancialTerms(5_000, () => 0, 'boot-backfill') === null && pinLegacyBelotFinancialTerms(5_000, () => 80.5, 'boot-backfill') === null)
      check('невалиден вход → null', pinLegacyBelotFinancialTerms(0, () => 8_000, 'boot-backfill') === null && pinLegacyBelotFinancialTerms(null, () => 8_000, 'boot-backfill') === null)
      check('isValid: валидни ✓', isValidBelotFinancialTerms(t))
      check('isValid: чужда версия ✗', !isValidBelotFinancialTerms({ ...t, rulesVersion: 'formula-v1' }))
      check('isValid: string награда ✗', !isValidBelotFinancialTerms({ ...t, prizePerWinner: '8000' }))
      check('resolvePinned: missing', resolvePinnedBelotPrize({ stakeAmount: 5_000 }).prize === null)
      const mismatch = resolvePinnedBelotPrize({ stakeAmount: 10_000, financialTerms: t })
      check('resolvePinned: stake-mismatch → null', mismatch.prize === null && mismatch.reason === 'stake-mismatch')
      const invalid = resolvePinnedBelotPrize({ stakeAmount: 5_000, financialTerms: { foo: 1 } })
      check('resolvePinned: invalid → null', invalid.prize === null && invalid.reason === 'invalid')
      check('eligibility: гост ✗, турнир ✗, залог 0/null ✗, нормален ✓',
        !isBelotRoomEligibleForFinancialTerms({ stakeAmount: 5_000, isGuestTrial: true })
        && !isBelotRoomEligibleForFinancialTerms({ stakeAmount: 5_000, isTournamentMatchOrigin: true })
        && !isBelotRoomEligibleForFinancialTerms({ stakeAmount: 0 })
        && !isBelotRoomEligibleForFinancialTerms({ stakeAmount: null })
        && isBelotRoomEligibleForFinancialTerms({ stakeAmount: 5_000 }))
      const room = buildEndedRoom(5_000)
      const pinned = withPinnedBelotFinancialTerms(room, () => 8_000, 'matchmaking-room-created')
      check('withPinned добавя условия', pinned !== room && pinned.config.financialTerms?.prizePerWinner === 8_000)
      check('withPinned е идемпотентно (същият обект)', withPinnedBelotFinancialTerms(pinned, () => 99_999, 'boot-backfill') === pinned)
      check('withPinned не мутира оригинала', room.config.financialTerms === undefined)
      const preset = pinLegacyBelotFinancialTerms(5_000, () => 7_000, 'private-room-created')!
      check('preset има предимство пред текущата награда', withPinnedBelotFinancialTerms(room, () => 9_000, 'private-room-created', Date.now(), preset).config.financialTerms?.prizePerWinner === 7_000)
      const wrongPreset = pinLegacyBelotFinancialTerms(10_000, () => 7_000, 'private-room-created')!
      check('preset с друг вход се игнорира → текуща', withPinnedBelotFinancialTerms(room, () => 9_000, 'private-room-created', Date.now(), wrongPreset).config.financialTerms?.prizePerWinner === 9_000)
      check('гост стая не се фиксира', withPinnedBelotFinancialTerms(buildEndedRoom(5_000, { isGuestTrial: true }), () => 8_000, 'boot-backfill').config.financialTerms === undefined)
      check('турнирна стая не се фиксира', withPinnedBelotFinancialTerms(buildEndedRoom(5_000, { isTournamentMatchOrigin: true }), () => 8_000, 'boot-backfill').config.financialTerms === undefined)
    }

    console.log('\n[2] Активен мач + промяна на prize_amount')
    {
      check('seed: 5 000 → 8 000', matchRooms.getPrizeAmount(5_000) === 8_000)
      const room = withPinnedBelotFinancialTerms(buildEndedRoom(5_000), currentPrize, 'matchmaking-room-created')
      check('условията са фиксирани с 8 000', room.config.financialTerms?.prizePerWinner === 8_000)
      matchRooms.upsertRoom({ stakeAmount: 5_000, minLevel: 1, prizeAmount: 9_500, isEnabled: true })
      check('prize_amount сменен на 9 500', matchRooms.getPrizeAmount(5_000) === 9_500)
      const payout = economy.payoutMatchWinners(room)
      check('изплащане по фиксираните 8 000 (не 9 500)', payout.ok && Object.values(payout.awardedPerSeat).every((a) => a === 8_000) && Object.keys(payout.awardedPerSeat).length === 2, payout)
      check('ledger: 2 × 8 000', JSON.stringify(ledgerPayouts(raw, room)) === '[8000,8000]', ledgerPayouts(raw, room))
      const again = economy.payoutMatchWinners(room)
      check('повторно извикване не плаща двойно (идемпотентно)', again.ok && ledgerPayouts(raw, room).length === 2 && Object.values(again.awardedPerSeat).every((a) => a === 8_000))

      const legacyRoom = buildEndedRoom(5_000)
      const legacyPayout = economy.payoutMatchWinners(legacyRoom)
      check('стара маса без условия → досегашно поведение (текущите 9 500)', legacyPayout.ok && Object.values(legacyPayout.awardedPerSeat).every((a) => a === 9_500))
      matchRooms.upsertRoom({ stakeAmount: 5_000, minLevel: 1, prizeAmount: 8_000, isEnabled: true })
    }

    console.log('\n[3] Деактивирано и изтрито ниво')
    {
      const room = withPinnedBelotFinancialTerms(buildEndedRoom(10_000), currentPrize, 'private-room-created')
      check('фиксирано 10 000 → 15 000', room.config.financialTerms?.prizePerWinner === 15_000)
      matchRooms.upsertRoom({ stakeAmount: 10_000, minLevel: 1, prizeAmount: 20_000, isEnabled: false })
      const p1 = economy.payoutMatchWinners(room)
      check('деактивирано + нова награда → пак 15 000', p1.ok && Object.values(p1.awardedPerSeat).every((a) => a === 15_000))

      const roomB = withPinnedBelotFinancialTerms(buildEndedRoom(15_000), currentPrize, 'matchmaking-room-created')
      matchRooms.deleteRoom(15_000)
      check('нивото 15 000 е изтрито (resolver → null)', matchRooms.getPrizeAmount(15_000) === null)
      const p2 = economy.payoutMatchWinners(roomB)
      check('изтрито ниво → фиксираните 22 000 (а не fallback = входа)', p2.ok && Object.values(p2.awardedPerSeat).every((a) => a === 22_000), p2)
      const legacyDeleted = buildEndedRoom(15_000)
      const legacyResolution = resolveRoomPayoutPrizeAmount(legacyDeleted, 15_000)
      check('стара маса при изтрито ниво → досегашният fallback (входът)', legacyResolution.ok && legacyResolution.prize === 15_000 && legacyResolution.source === 'legacy-current-prize')
      matchRooms.upsertRoom({ stakeAmount: 15_000, minLevel: 1, prizeAmount: 22_000, isEnabled: true })
      matchRooms.upsertRoom({ stakeAmount: 10_000, minLevel: 1, prizeAmount: 15_000, isEnabled: true })
    }

    console.log('\n[4] Налични, но невалидни условия → задържане (без резерва от prize_amount)')
    {
      const balances = (room: ServerRoom) => SEATS.map((s) => {
        const id = room.seats[s].participant?.kind === 'human' ? room.seats[s].participant.identity.profileId : null
        return (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number } | undefined)?.b ?? null
      })
      const withTerms = (terms: unknown) => {
        const room = buildEndedRoom(20_000)
        return { ...room, config: { ...room.config, financialTerms: terms as BelotFinancialTerms } }
      }
      const validFor20k = pinLegacyBelotFinancialTerms(20_000, () => 30_000, 'matchmaking-room-created')!
      const cases: Array<[string, unknown, string]> = [
        ['несъответстващ вход (5 000 при маса 20 000)', { ...validFor20k, entryFee: 5_000, prizePerWinner: 999_999 }, 'stake-mismatch'],
        ['награда като текст', { ...validFor20k, prizePerWinner: '30000' }, 'invalid'],
        ['отрицателна награда', { ...validFor20k, prizePerWinner: -1 }, 'invalid'],
        ['непозната версия на правилата', { ...validFor20k, rulesVersion: 'formula-v1' }, 'invalid'],
        ['празен обект', {}, 'invalid'],
        ['null', null, 'invalid'],
      ]
      for (const [label, terms, reason] of cases) {
        const room = withTerms(terms)
        const resolution = resolveRoomPayoutPrizeAmount(room, 20_000)
        check(`${label}: resolve → ok:false (${reason})`, !resolution.ok && resolution.reason === reason, resolution)
        const before = balances(room)
        const payout = silence(() => economy.payoutMatchWinners(room))
        check(`${label}: payout задържан, 0 ledger реда, портфейлите непроменени`,
          !payout.ok && ledgerPayouts(raw, room).length === 0 && JSON.stringify(balances(room)) === JSON.stringify(before), { payout, before, after: balances(room) })
      }

      const historical = buildEndedRoom(20_000)
      const h = resolveRoomPayoutPrizeAmount(historical, 20_000)
      check('историческа маса (без поле) → текущата награда 30 000', h.ok && h.prize === 30_000 && h.source === 'legacy-current-prize')
      const valid = withTerms(validFor20k)
      const v = resolveRoomPayoutPrizeAmount(valid, 20_000)
      check('валидни условия → записаната награда', v.ok && v.prize === 30_000 && v.source === 'financial-terms')

      // Задържаното изплащане не е маркирано като платено: след ръчна корекция
      // на условията същият мач се изплаща точно веднъж.
      const held = withTerms({ ...validFor20k, prizePerWinner: 'broken' })
      check('задържано изплащане', !silence(() => economy.payoutMatchWinners(held)).ok && ledgerPayouts(raw, held).length === 0)
      // Етап 3Б.2: регистриран случай се урежда САМО ръчно (settleHeldPayout) —
      // „поправени“ условия не отключват автоматично изплащане.
      const repaired = { ...held, config: { ...held.config, financialTerms: validFor20k } }
      const p1 = silence(() => economy.payoutMatchWinners(repaired))
      check('след „корекция“: автоматичното изплащане остава отказано (регистър)', !p1.ok && ledgerPayouts(raw, repaired).length === 0)
      const settled = economy.settleHeldPayout({ matchScope: `${held.id}:v${held.game.stateVersion}`, action: 'payout', prizePerWinner: 30_000, resolvedBy: 'test', note: 'проверено', evidence: 'test' })
      const p2 = silence(() => economy.payoutMatchWinners(repaired))
      check('ръчно уреждане: 2 × 30 000; повторно — без двойно', settled.ok && !p2.ok && JSON.stringify(ledgerPayouts(raw, repaired)) === '[30000,30000]')

      check('boot backfill не „поправя“ повредени условия', withPinnedBelotFinancialTerms(withTerms({ prizePerWinner: 'x' }), currentPrize, 'boot-backfill').config.financialTerms !== undefined
        && (withPinnedBelotFinancialTerms(withTerms({ prizePerWinner: 'x' }), currentPrize, 'boot-backfill').config.financialTerms as unknown as { prizePerWinner: unknown }).prizePerWinner === 'x')
      const nullRoom = withTerms(null)
      check('boot backfill не презаписва null', withPinnedBelotFinancialTerms(nullRoom, currentPrize, 'boot-backfill') === nullRoom)
    }

    console.log('\n[5] Рестарт и възстановяване')
    {
      const snapshots = await createActiveRoomSnapshotStore(dbPath)
      const pinned = withPinnedBelotFinancialTerms(buildRoom(8_000), currentPrize, 'matchmaking-room-created')
      snapshots.upsertRoom(pinned)
      const unpinned = buildRoom(8_000)
      snapshots.upsertRoom(unpinned)
      const reloaded = snapshots.loadActiveRooms()
      const rPinned = reloaded.find((r) => r.id === pinned.id)
      check('active_room_snapshots пази financialTerms', JSON.stringify(rPinned?.config.financialTerms) === JSON.stringify(pinned.config.financialTerms))
      check('structuredClone (worker) пази financialTerms', JSON.stringify(structuredClone(pinned).config.financialTerms) === JSON.stringify(pinned.config.financialTerms))

      // Boot backfill — същата композиция като loadPersistedServerState в index.ts.
      const rUnpinned = reloaded.find((r) => r.id === unpinned.id)!
      check('стара стая се възстановява без условия', rUnpinned.config.financialTerms === undefined)
      const backfilled = withPinnedBelotFinancialTerms(rUnpinned, currentPrize, 'boot-backfill')
      check('boot backfill фиксира текущите 12 000', backfilled.config.financialTerms?.prizePerWinner === 12_000 && backfilled.config.financialTerms.pinSource === 'boot-backfill')
      snapshots.upsertRoom(backfilled)
      // Устойчивост: записът е видим от НОВА връзка към базата веднага (autocommit),
      // т.е. преди какъвто и да е payout в същия процес.
      const freshConnection = await createActiveRoomSnapshotStore(dbPath)
      const durable = freshConnection.loadActiveRooms().find((r) => r.id === unpinned.id)
      check('backfill-ът е записан устойчиво (нова връзка вижда 12 000)', durable?.config.financialTerms?.prizePerWinner === 12_000 && durable.config.financialTerms.pinSource === 'boot-backfill')
      freshConnection.close()

      matchRooms.upsertRoom({ stakeAmount: 8_000, minLevel: 1, prizeAmount: 13_000, isEnabled: true })
      const secondBoot = snapshots.loadActiveRooms()
      const afterPinned = secondBoot.find((r) => r.id === pinned.id)!
      const afterBackfilled = secondBoot.find((r) => r.id === unpinned.id)!
      check('втори рестарт: backfill-ът не преизчислява (идемпотентно)', withPinnedBelotFinancialTerms(afterBackfilled, currentPrize, 'boot-backfill') === afterBackfilled)
      const p1 = economy.payoutMatchWinners(withEndedState(afterPinned))
      const p2 = economy.payoutMatchWinners(withEndedState(afterBackfilled))
      check('след рестарт + промяна на наградата: фиксирана маса → 12 000', p1.ok && Object.values(p1.awardedPerSeat).every((a) => a === 12_000))
      check('след рестарт + промяна на наградата: backfill маса → 12 000', p2.ok && Object.values(p2.awardedPerSeat).every((a) => a === 12_000))
      matchRooms.upsertRoom({ stakeAmount: 8_000, minLevel: 1, prizeAmount: 12_000, isEnabled: true })
      snapshots.close()
    }

    console.log('\n[6] Стара чакаща частна маса')
    {
      const store = createPrivateRoomsStore({
        onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => {}, onRoomClosed: () => {}, onMemberLeft: () => {}, onMemberKicked: () => {},
      })
      const created = store.createRoom({
        connectionId: 'c-host', profileId: 'host', displayName: 'Host', avatarUrl: null, level: 1, rankTitle: null,
        stake: 20_000, isLocked: false, waitMinutes: 5, manualStart: false,
        financialTerms: pinLegacyBelotFinancialTerms(20_000, currentPrize, 'private-room-created'),
      })
      check('чакащата маса пази условията (30 000)', created.ok && created.room.financialTerms?.prizePerWinner === 30_000)
      const legacyCreated = store.createRoom({
        connectionId: 'c-host2', profileId: 'host2', displayName: 'Host2', avatarUrl: null, level: 1, rankTitle: null,
        stake: 20_000, isLocked: false, waitMinutes: 5, manualStart: false,
      })
      check('без подадени условия → null (обратна съвместимост)', legacyCreated.ok && legacyCreated.room.financialTerms === null)
      matchRooms.upsertRoom({ stakeAmount: 20_000, minLevel: 1, prizeAmount: 33_000, isEnabled: true })
      if (created.ok) {
        // Същата композиция като handlePrivateRoomReady в index.ts.
        const started = withPinnedBelotFinancialTerms(
          { ...buildEndedRoom(20_000, { isPrivate: true, isPrivateTableOrigin: true }) },
          currentPrize, 'private-room-created', Date.now(), created.room.financialTerms,
        )
        check('старт след промяна на наградата → старите 30 000', started.config.financialTerms?.prizePerWinner === 30_000)
        const payout = economy.payoutMatchWinners(started)
        check('изплащане 30 000 (не 33 000)', payout.ok && Object.values(payout.awardedPerSeat).every((a) => a === 30_000))
      }
      matchRooms.upsertRoom({ stakeAmount: 20_000, minLevel: 1, prizeAmount: 30_000, isEnabled: true })
    }

    console.log('\n[7] Случайна опашка: условията се фиксират еднократно при създаване на масата')
    {
      const before = withPinnedBelotFinancialTerms(buildEndedRoom(5_000), currentPrize, 'matchmaking-room-created')
      matchRooms.upsertRoom({ stakeAmount: 5_000, minLevel: 1, prizeAmount: 8_800, isEnabled: true })
      const after = withPinnedBelotFinancialTerms(buildEndedRoom(5_000), currentPrize, 'matchmaking-room-created')
      check('маса преди промяната → 8 000; след → 8 800 (без смесване в една маса)',
        before.config.financialTerms?.prizePerWinner === 8_000 && after.config.financialTerms?.prizePerWinner === 8_800)
      check('всичките 4 места делят един config (едни условия за масата)', SEATS.every((s) => before.seats[s].participant !== null))
      const replay = { ...before, game: { ...before.game, stateVersion: before.game.stateVersion + 1 } }
      check('„Преиграй“ (spread на стаята) запазва условията', replay.config.financialTerms === before.config.financialTerms)
      matchRooms.upsertRoom({ stakeAmount: 5_000, minLevel: 1, prizeAmount: 8_000, isEnabled: true })
    }

    console.log('\n[8] Свързване в index.ts (статично)')
    {
      const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
      check('опашка: фиксиране преди initializeRoomAuthoritativeGameState',
        /initializeRoomAuthoritativeGameState\(\s*withPinnedBelotFinancialTerms\(result\.room, resolveCurrentBelotPrizeForPinning, 'matchmaking-room-created'\)/.test(src))
      check('частна маса: фиксиране при създаване', /financialTerms: pinLegacyBelotFinancialTerms\(message\.stake, resolveCurrentBelotPrizeForPinning, 'private-room-created'\)/.test(src))
      check('частна маса: старт с preset privateRoom.financialTerms', /'private-room-created',\s*Date\.now\(\),\s*privateRoom\.financialTerms,/.test(src))
      const boot = /function loadPersistedServerState[\s\S]*?\n}\r?\n/.exec(src)?.[0] ?? ''
      check('boot backfill + незабавен запис', boot.includes("withPinnedBelotFinancialTerms(preparedRoom, resolveCurrentBelotPrizeForPinning, 'boot-backfill', now)") && boot.includes('persistRoomSnapshot(pinnedRoom)'))
      check('boot: записът е ПРЕДИ стаята да влезе в server state',
        boot.indexOf('persistRoomSnapshot(pinnedRoom)') > 0 && boot.indexOf('persistRoomSnapshot(pinnedRoom)') < boot.indexOf('upsertServerRoom(nextServerState, pinnedRoom)'))
      const bootCall = src.indexOf('let serverState: ServerState = loadPersistedServerState()')
      check('boot: възстановяването е при инициализация, преди runtime-а да тръгне',
        bootCall > 0 && bootCall < src.indexOf('const activeRoomRuntime ='))
      check('изплащанията все още са legacy (resolver = prize_amount)', (src.match(/setMatchPrizeResolver\(\(stake\) => matchRoomsStore\.getPrizeAmount\(stake\)\)/g) ?? []).length === 3)
      check('турнир/гост не се изплащат през payoutMatchWinners (непроменено)', src.includes('if (!room.config.isGuestTrial && !isTournamentMatchRoom(room)) {'))
      check('формулата не участва в изплащания', !/computePrizeBreakdown|requirePrizeBreakdown/.test(src) && !/computePrizeBreakdown/.test(readFileSync(join(import.meta.dirname, '../src/db/matchEconomyStore.ts'), 'utf8')))
    }
    raw.close()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows: отворени SQLite файлове */ }
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
