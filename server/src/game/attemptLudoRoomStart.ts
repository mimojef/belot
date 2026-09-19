import { randomUUID } from 'node:crypto'
import type { LudoRoom, LudoRoomsStore } from './ludoRoomsStore.js'
import type { LudoEconomyStore } from '../db/ludoEconomyStore.js'

// Canonical единствена точка, през която ВСЕКИ реален Ludo start path минава
// (manual "Старт" бутон, auto-full при join) — виж task spec §"AUTO-START
// RACE / MANUAL START RACE": "Не оставяй manual start със собствен economy
// path, auto-full start с друг." И двата call site-а в index.ts (create_ludo_room
// join handler-а при readyToStart, start_ludo_room handler-а) викат точно
// тази функция.
//
// Последователност (§"КРИТИЧЕН RE-CHECK ТОЧНО ПРИ START" + §"ATOMIC DEBIT"):
//   1. Re-fetch стаята по id (НЕ разчита на caller-а подаден room обект —
//      defensive срещу race между validation-а в joinRoom/startRoom и това
//      извикване).
//   2. Ако стаята вече не съществува/не е пълна -> no-op (duplicate-trigger
//      guard — виж по-долу).
//   3. Re-check balance за ВСЕКИ участник (matchEconomyStore.hasEnoughBalance,
//      НЕ разчита на eligibility проверката при create/join).
//   4. Ако някой е insufficient -> eject ВСИЧКИ insufficient (leaveRoom,
//      преизползва host-transfer/empty-room семантиката), уведоми ги,
//      НЕ стартирай match, стаята остава waiting. НИКОЙ не е debit-нат.
//   5. Ако всички са sufficient -> генерирай matchId, atomic debit
//      (collectLudoMatchStakes) за ВСИЧКИ. Ако debit-ът се провали (рядък
//      TOCTOU race след стъпка 3) -> третирай се като insufficient, eject,
//      без match.
//   6. Само СЛЕД успешен atomic debit -> finalizeRoomStart (detach от waiting
//      map-а) -> ludoMatchRuntime.createMatch(room, matchId).
//
// Duplicate-trigger safety: Node.js single-threaded event loop + напълно
// синхронна функция (нито един await вътре) означава, че два "почти
// едновременни" trigger-а (double-click Start, auto-full/manual overlap) се
// сериализират от рънтайма — вторият вика getRoomById() СЛЕД като първият
// вече е приключил (detach-нал ИЛИ eject-нал), и намира стаята или липсваща,
// или вече непълна -> no-op. Виж идентичния argument в cross-game commitment
// guard audit-а (същия проект, същата гаранция).

export type AttemptLudoRoomStartResult =
  | { outcome: 'not_found' }
  | { outcome: 'ejected'; ejectedProfileIds: string[]; room: LudoRoom | null }
  | { outcome: 'started'; matchId: string; room: LudoRoom }

export type AttemptLudoRoomStartDeps = {
  ludoRoomsStore: LudoRoomsStore
  ludoEconomyStore: LudoEconomyStore
  hasEnoughBalance: (profileId: string, amount: number) => boolean
  onPlayerEjectedForInsufficientBalance: (connectionId: string, ludoRoomId: string) => void
  onRoomUpdated: (room: LudoRoom) => void
}

export function createAttemptLudoRoomStart(
  deps: AttemptLudoRoomStartDeps,
): (roomId: string) => AttemptLudoRoomStartResult {
  return function attemptLudoRoomStart(roomId: string): AttemptLudoRoomStartResult {
    const room = deps.ludoRoomsStore.getRoomById(roomId)
    if (!room) return { outcome: 'not_found' }
    // Defensive — ако вече не е пълна (напр. предходен duplicate trigger вече
    // eject-на някого в СЪЩИЯ tick, или предходно manual leave междувременно),
    // не прави нищо. Родният caller (join/start handler) вече провери
    // fullness преди да ни извика, но re-check-ваме тук за да пази инварианта
    // дори при duplicate/racing извиквания.
    if (room.players.length !== room.playerCount) return { outcome: 'not_found' }

    const insufficientPlayers = room.players.filter(
      (player) => !deps.hasEnoughBalance(player.profileId, room.stake),
    )

    if (insufficientPlayers.length > 0) {
      return ejectInsufficientPlayers(deps, roomId, insufficientPlayers.map((p) => p.profileId))
    }

    const matchId = randomUUID()
    const profileIds = room.players.map((player) => player.profileId)
    const debitResult = deps.ludoEconomyStore.collectLudoMatchStakes(matchId, profileIds, room.stake)

    if (!debitResult.ok) {
      // Рядък TOCTOU race — balance-ът е паднал между стъпка 3 (recheck) и
      // атомарния debit опит (напр. паралелен gift spend). Третираме
      // конкретния провалил се profile като insufficient — никой не е
      // debit-нат (collectLudoMatchStakes е all-or-nothing, виж
      // ludoEconomyStore.ts), стаята остава waiting.
      const failedProfileIds = debitResult.insufficientProfileId
        ? [debitResult.insufficientProfileId]
        : profileIds
      return ejectInsufficientPlayers(deps, roomId, failedProfileIds)
    }

    const startedRoom = deps.ludoRoomsStore.finalizeRoomStart(roomId, matchId)
    if (!startedRoom) {
      // Изключително рядко: стаята изчезна между re-fetch-а по-горе и този
      // финален detach (напр. duplicate trigger вклинил се точно тук).
      // Stake-ът вече Е debit-нат в тази клонка — но createMatch никога не
      // се извиква, затова връщаме 'not_found' само за orchestration
      // резултата; реалната защита срещу double-debit е ledger-based
      // идемпотентността в collectLudoMatchStakes (виж K/duplicate trigger
      // regression теста), не разчитаме единствено на този guard.
      return { outcome: 'not_found' }
    }

    // НЕ викаме deps.createMatch тук отделно — finalizeRoomStart() вече
    // извиква callbacks.onRoomReady(room, matchId) вътрешно (виж
    // ludoRoomsStore.ts), което в index.ts е wire-нато точно към
    // ludoMatchRuntime.createMatch(room, matchId). Двойно извикване тук би
    // debit-нало веднъж коректно, но би създало match/onSnapshot broadcast
    // ДВА пъти за едно и също matchId (хванато от K regression теста).
    return { outcome: 'started', matchId, room: startedRoom }
  }
}

function ejectInsufficientPlayers(
  deps: AttemptLudoRoomStartDeps,
  roomId: string,
  insufficientProfileIds: string[],
): AttemptLudoRoomStartResult {
  const room = deps.ludoRoomsStore.getRoomById(roomId)
  if (!room) return { outcome: 'not_found' }

  const playersToEject = room.players.filter((player) => insufficientProfileIds.includes(player.profileId))

  for (const player of playersToEject) {
    deps.onPlayerEjectedForInsufficientBalance(player.connectionId, room.id)
    // Преизползва СЪЩЕСТВУВАЩАТА waiting-room leave/host-transfer семантика
    // (§"АКО CREATOR-ЪТ Е С НЕДОСТАТЪЧЕН БАЛАНС" — "Не създавай нов
    // lifecycle") — ако ejected играчът е host, ownership автоматично се
    // прехвърля на следващия; ако стаята опразнее, изтрива се.
    deps.ludoRoomsStore.leaveRoom(player.connectionId)
  }

  // НЕ стартирай match в същия call автоматично с намаления брой хора (§11
  // "START FAILURE SEMANTICS") — стаята просто се връща в waiting.
  const remainingRoom = deps.ludoRoomsStore.getRoomById(roomId)
  if (remainingRoom) deps.onRoomUpdated(remainingRoom)

  return {
    outcome: 'ejected',
    ejectedProfileIds: playersToEject.map((p) => p.profileId),
    room: remainingRoom,
  }
}
