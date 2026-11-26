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
  BELOT_FORMULA_RULES,
  BELOT_LEGACY_FIXED_PRIZE_RULES,
  computeBelotPrizePerWinner,
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
    // Етап 4В: нова маса → формула + обща комисиона; маси без условия /
    // boot-backfill → непроменената ръчна prize_amount (както в index.ts).
    const currentPrize = (stake: number) => matchRooms.getBelotPrizeTerms(stake)
    const legacyPrize = (stake: number) => matchRooms.getLegacyPrizeAmount(stake)
    setMatchPrizeResolver(legacyPrize)
    const setCommission = (stake: number, siteCommissionBps: number, isEnabled = true) => {
      const r = matchRooms.upsertRoom({ stakeAmount: stake, minLevel: 1, isEnabled, siteCommissionBps })
      if (!r.ok) throw new Error(r.message)
    }

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
      // Етап 4В: версия по формула.
      const f = pinLegacyBelotFinancialTerms(5_000, () => ({ prizePerWinner: 8_000, siteCommissionBps: 2_000 }), 'matchmaking-room-created', 7)
      check('формула: belot-formula-v1 + комисиона 20%', f !== null && f.rulesVersion === BELOT_FORMULA_RULES && f.prizePerWinner === 8_000 && f.siteCommissionBps === 2_000 && isValidBelotFinancialTerms(f))
      check('формула: награда, различна от формулата → не се фиксира', pinLegacyBelotFinancialTerms(5_000, () => ({ prizePerWinner: 8_100, siteCommissionBps: 2_000 }), 'boot-backfill') === null)
      check('формула: подправена награда / комисиона → невалидни', !isValidBelotFinancialTerms({ ...f, prizePerWinner: 9_000 }) && !isValidBelotFinancialTerms({ ...f, siteCommissionBps: 900 }) && !isValidBelotFinancialTerms({ ...f, siteCommissionBps: undefined }))
      check('формула: BigInt закръгляне до 100 (5 100 × 4 × 80% / 2 = 8 160 → 8 200)', computeBelotPrizePerWinner(5_100, 2_000) === 8_200 && computeBelotPrizePerWinner(5_000, 2_000) === 8_000)
    }

    console.log('\n[2] Активен мач + промяна на общата комисиона')
    {
      check('seed по формулата: 5 000 → 8 000 (20%); 8 000 → 12 800 (ръчната 12 000 не важи)', matchRooms.getPrizeAmount(5_000) === 8_000 && matchRooms.getPrizeAmount(8_000) === 12_800 && matchRooms.getLegacyPrizeAmount(8_000) === 12_000)
      const room = withPinnedBelotFinancialTerms(buildEndedRoom(5_000), currentPrize, 'matchmaking-room-created')
      check('условията са фиксирани с 8 000 (формула, 20%)', room.config.financialTerms?.prizePerWinner === 8_000 && room.config.financialTerms.rulesVersion === BELOT_FORMULA_RULES)
      setCommission(5_000, 2_500)
      check('комисиона 25% → нова награда 7 500', matchRooms.getPrizeAmount(5_000) === 7_500)
      const payout = economy.payoutMatchWinners(room)
      check('изплащане по фиксираните 8 000 (не 7 500)', payout.ok && Object.values(payout.awardedPerSeat).every((a) => a === 8_000) && Object.keys(payout.awardedPerSeat).length === 2, payout)
      check('ledger: 2 × 8 000', JSON.stringify(ledgerPayouts(raw, room)) === '[8000,8000]', ledgerPayouts(raw, room))
      const again = economy.payoutMatchWinners(room)
      check('повторно извикване не плаща двойно (идемпотентно)', again.ok && ledgerPayouts(raw, room).length === 2 && Object.values(again.awardedPerSeat).every((a) => a === 8_000))

      const legacyRoom = buildEndedRoom(8_000)
      const legacyPayout = economy.payoutMatchWinners(legacyRoom)
      check('стара маса без условия → ръчната prize_amount, с която е започнала (12 000)', legacyPayout.ok && Object.values(legacyPayout.awardedPerSeat).every((a) => a === 12_000))
      setCommission(5_000, 2_000)
    }

    console.log('\n[3] Деактивирано и изтрито ниво')
    {
      const room = withPinnedBelotFinancialTerms(buildEndedRoom(10_000), currentPrize, 'private-room-created')
      check('фиксирано 10 000 → 16 000', room.config.financialTerms?.prizePerWinner === 16_000)
      setCommission(10_000, 3_000, false)
      const p1 = economy.payoutMatchWinners(room)
      check('деактивирано + нова комисиона → пак 16 000', p1.ok && Object.values(p1.awardedPerSeat).every((a) => a === 16_000))

      const roomB = withPinnedBelotFinancialTerms(buildEndedRoom(15_000), currentPrize, 'matchmaking-room-created')
      matchRooms.deleteRoom(15_000)
      check('нивото 15 000 е изтрито (resolver → null)', matchRooms.getPrizeAmount(15_000) === null)
      const p2 = economy.payoutMatchWinners(roomB)
      check('изтрито ниво → фиксираните 24 000 (а не fallback = входа)', p2.ok && Object.values(p2.awardedPerSeat).every((a) => a === 24_000), p2)
      const legacyDeleted = buildEndedRoom(15_000)
      const legacyResolution = resolveRoomPayoutPrizeAmount(legacyDeleted, 15_000)
      check('стара маса при изтрито ниво → досегашният fallback (входът)', legacyResolution.ok && legacyResolution.prize === 15_000 && legacyResolution.source === 'legacy-current-prize')
      setCommission(15_000, 2_000)
      setCommission(10_000, 2_000)
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
      check('историческа маса (без поле) → ръчната (legacy) награда 30 000', h.ok && h.prize === 30_000 && h.source === 'legacy-current-prize')
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

      check('boot backfill не „поправя“ повредени условия', withPinnedBelotFinancialTerms(withTerms({ prizePerWinner: 'x' }), legacyPrize, 'boot-backfill').config.financialTerms !== undefined
        && (withPinnedBelotFinancialTerms(withTerms({ prizePerWinner: 'x' }), legacyPrize, 'boot-backfill').config.financialTerms as unknown as { prizePerWinner: unknown }).prizePerWinner === 'x')
      const nullRoom = withTerms(null)
      check('boot backfill не презаписва null', withPinnedBelotFinancialTerms(nullRoom, legacyPrize, 'boot-backfill') === nullRoom)
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
      check('нова маса 8 000 → по формулата 12 800', pinned.config.financialTerms?.prizePerWinner === 12_800)
      const backfilled = withPinnedBelotFinancialTerms(rUnpinned, legacyPrize, 'boot-backfill')
      check('boot backfill фиксира ръчните 12 000, с които масата е започнала', backfilled.config.financialTerms?.prizePerWinner === 12_000 && backfilled.config.financialTerms.pinSource === 'boot-backfill')
      snapshots.upsertRoom(backfilled)
      // Устойчивост: записът е видим от НОВА връзка към базата веднага (autocommit),
      // т.е. преди какъвто и да е payout в същия процес.
      const freshConnection = await createActiveRoomSnapshotStore(dbPath)
      const durable = freshConnection.loadActiveRooms().find((r) => r.id === unpinned.id)
      check('backfill-ът е записан устойчиво (нова връзка вижда 12 000)', durable?.config.financialTerms?.prizePerWinner === 12_000 && durable.config.financialTerms.pinSource === 'boot-backfill')
      freshConnection.close()

      setCommission(8_000, 3_000)
      const secondBoot = snapshots.loadActiveRooms()
      const afterPinned = secondBoot.find((r) => r.id === pinned.id)!
      const afterBackfilled = secondBoot.find((r) => r.id === unpinned.id)!
      check('втори рестарт: backfill-ът не преизчислява (идемпотентно)', withPinnedBelotFinancialTerms(afterBackfilled, legacyPrize, 'boot-backfill') === afterBackfilled)
      const p1 = economy.payoutMatchWinners(withEndedState(afterPinned))
      const p2 = economy.payoutMatchWinners(withEndedState(afterBackfilled))
      check('след рестарт + комисиона 30%: фиксирана маса → 12 800', p1.ok && Object.values(p1.awardedPerSeat).every((a) => a === 12_800))
      check('след рестарт + комисиона 30%: backfill маса → 12 000', p2.ok && Object.values(p2.awardedPerSeat).every((a) => a === 12_000))
      setCommission(8_000, 2_000)
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
      check('чакащата маса пази условията (32 000 по формулата)', created.ok && created.room.financialTerms?.prizePerWinner === 32_000)
      const legacyCreated = store.createRoom({
        connectionId: 'c-host2', profileId: 'host2', displayName: 'Host2', avatarUrl: null, level: 1, rankTitle: null,
        stake: 20_000, isLocked: false, waitMinutes: 5, manualStart: false,
      })
      check('без подадени условия → null (обратна съвместимост)', legacyCreated.ok && legacyCreated.room.financialTerms === null)
      setCommission(20_000, 2_500)
      if (created.ok) {
        // Същата композиция като handlePrivateRoomReady в index.ts.
        const started = withPinnedBelotFinancialTerms(
          { ...buildEndedRoom(20_000, { isPrivate: true, isPrivateTableOrigin: true }) },
          currentPrize, 'private-room-created', Date.now(), created.room.financialTerms,
        )
        check('старт след смяна на комисионата (25% → 30 000) → старите 32 000', started.config.financialTerms?.prizePerWinner === 32_000)
        const payout = economy.payoutMatchWinners(started)
        check('изплащане 32 000 (не 30 000)', payout.ok && Object.values(payout.awardedPerSeat).every((a) => a === 32_000))
      }
      setCommission(20_000, 2_000)
    }

    console.log('\n[7] Случайна опашка: условията се фиксират еднократно при създаване на масата')
    {
      const before = withPinnedBelotFinancialTerms(buildEndedRoom(5_000), currentPrize, 'matchmaking-room-created')
      setCommission(5_000, 1_200)
      const after = withPinnedBelotFinancialTerms(buildEndedRoom(5_000), currentPrize, 'matchmaking-room-created')
      check('маса преди промяната → 8 000; след (12%) → 8 800 (без смесване в една маса)',
        before.config.financialTerms?.prizePerWinner === 8_000 && after.config.financialTerms?.prizePerWinner === 8_800)
      check('всичките 4 места делят един config (едни условия за масата)', SEATS.every((s) => before.seats[s].participant !== null))
      const replay = { ...before, game: { ...before.game, stateVersion: before.game.stateVersion + 1 } }
      check('„Преиграй“ (spread на стаята) запазва условията', replay.config.financialTerms === before.config.financialTerms)
      setCommission(5_000, 2_000)
    }

    console.log('\n[8] Свързване в index.ts (статично)')
    {
      const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
      check('опашка: фиксиране преди initializeRoomAuthoritativeGameState',
        /initializeRoomAuthoritativeGameState\(\s*withPinnedBelotFinancialTerms\(result\.room, resolveCurrentBelotPrizeForPinning, 'matchmaking-room-created'\)/.test(src))
      check('частна маса: фиксиране при създаване', /financialTerms: pinLegacyBelotFinancialTerms\(message\.stake, resolveCurrentBelotPrizeForPinning, 'private-room-created'\)/.test(src))
      check('частна маса: старт с preset privateRoom.financialTerms', /'private-room-created',\s*Date\.now\(\),\s*privateRoom\.financialTerms,/.test(src))
      const boot = /function loadPersistedServerState[\s\S]*?\n}\r?\n/.exec(src)?.[0] ?? ''
      check('boot backfill + незабавен запис', boot.includes("withPinnedBelotFinancialTerms(preparedRoom, resolveLegacyBelotPrizeForBackfill, 'boot-backfill', now)") && boot.includes('persistRoomSnapshot(pinnedRoom)'))
      check('boot: записът е ПРЕДИ стаята да влезе в server state',
        boot.indexOf('persistRoomSnapshot(pinnedRoom)') > 0 && boot.indexOf('persistRoomSnapshot(pinnedRoom)') < boot.indexOf('upsertServerRoom(nextServerState, pinnedRoom)'))
      const bootCall = src.indexOf('let serverState: ServerState = loadPersistedServerState()')
      check('boot: възстановяването е при инициализация, преди runtime-а да тръгне',
        bootCall > 0 && bootCall < src.indexOf('const activeRoomRuntime ='))
      check('исторически маси без условия → legacy prize_amount (resolver)', (src.match(/setMatchPrizeResolver\(\(stake\) => matchRoomsStore\.getLegacyPrizeAmount\(stake\)\)/g) ?? []).length === 3)
      check('нови маси → формула (getBelotPrizeTerms)', src.includes('const resolveCurrentBelotPrizeForPinning = (stake: number) => matchRoomsStore.getBelotPrizeTerms(stake)'))
      check('турнир/гост не се изплащат през payoutMatchWinners (непроменено)', src.includes('if (!room.config.isGuestTrial && !isTournamentMatchRoom(room)) {'))
      check('изплащането чете само фиксираните условия (формулата е само при фиксирането)', !/computePrizeBreakdown|requirePrizeBreakdown/.test(src) && !/computePrizeBreakdown/.test(readFileSync(join(import.meta.dirname, '../src/db/matchEconomyStore.ts'), 'utf8')))
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
