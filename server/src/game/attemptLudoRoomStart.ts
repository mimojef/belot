import { randomUUID } from 'node:crypto'
import type { LudoRoom, LudoRoomsStore } from './ludoRoomsStore.js'
import type { LudoEconomyStore } from '../db/ludoEconomyStore.js'
import type { LudoInitialMatchData, LudoMatchSnapshot } from './ludoMatchRuntime.js'

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
  // Тясна dependency (само функцията, не целия ludoMatchRuntime обект) — виж
  // task spec §3 "КРИТИЧЕН START TRANSACTION". Чисто изчисление (виж
  // LudoInitialMatchData doc коментара в ludoMatchRuntime.ts), извиквано
  // ТОЧНО ВЕДНЪЖ тук, ПРЕДИ atomic debit транзакцията — резултатът е това,
  // което се persist-ва атомарно с debit-а И се подава обратно на
  // createMatch() (през finalizeRoomStart/onRoomReady), за да не се
  // преизчислява случаен цвят два пъти.
  buildInitialMatch: (room: LudoRoom, matchId: string) => LudoInitialMatchData
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

    // Виж task spec §3 "КРИТИЧЕН START TRANSACTION" — precompute-ваме ЦЕЛИЯ
    // initial match state (color assignment + engine initial state) ТОЧНО
    // ВЕДНЪЖ, ПРЕДИ debit-а, за да можем да го persist-нем АТОМАРНО заедно с
    // него (виж по-долу). Ако debit-ът commit-не без този snapshot да е
    // durable, рестартиран процес би видял "платено, но играта изчезна" —
    // точно прозорецът, който тази задача затваря.
    const initialMatchData = deps.buildInitialMatch(room, matchId)
    const initialSnapshot: LudoMatchSnapshot = {
      matchId,
      ludoRoomId: room.id,
      stake: room.stake,
      revision: 0,
      serverNow: Date.now(),
      deadlineAt: null,
      players: initialMatchData.players,
      state: initialMatchData.state,
      events: [],
      botControlledColors: [],
    }

    const debitResult = deps.ludoEconomyStore.collectLudoMatchStakesWithInitialSnapshot(
      matchId, profileIds, room.stake, initialSnapshot,
    )

    if (!debitResult.ok) {
      // Рядък TOCTOU race — balance-ът е паднал между стъпка 3 (recheck) и
      // атомарния debit опит (напр. паралелен gift spend), ИЛИ snapshot
      // insert-ът е fail-нал (виж инварианта в task spec §3) — в ДВАТА
      // случая ЦЯЛАТА транзакция (debit + snapshot) е rollback-ната от
      // collectLudoMatchStakesWithInitialSnapshot, никой не е debit-нат.
      // Третираме конкретния провалил се profile като insufficient — стаята
      // остава waiting.
      const failedProfileIds = debitResult.insufficientProfileId
        ? [debitResult.insufficientProfileId]
        : profileIds
      return ejectInsufficientPlayers(deps, roomId, failedProfileIds)
    }

    // DB транзакцията е COMMIT-ната тук — debit + persisted initial snapshot
    // вече са durable заедно. Останалото (finalize room detach + in-memory
    // createMatch) е чисто in-memory publication на СЪЩИТЕ вече-commit-нати
    // данни (precomputed-ът се подава по-долу, не се преизчислява). Ако
    // процесът умре точно СЕГА (след DB commit, преди тази стъпка) — boot
    // recovery възстановява match-а от persisted snapshot-а (виж
    // loadPersistedLudoMatches() в index.ts), СЪЩИЯТ matchId, без повторен
    // debit.
    const startedRoom = deps.ludoRoomsStore.finalizeRoomStart(roomId, matchId, initialMatchData)
    if (!startedRoom) {
      // Изключително рядко: стаята изчезна между re-fetch-а по-горе и този
      // финален detach (напр. duplicate trigger вклинил се точно тук).
      // Stake-ът и snapshot-ът вече СА persisted в тази клонка — но
      // createMatch никога не се извиква тук, затова връщаме 'not_found'
      // само за orchestration резултата; реалната защита срещу double-debit
      // е ledger-based идемпотентността в collectLudoMatchStakesWithInitial-
      // Snapshot (виж K/duplicate trigger regression теста), не разчитаме
      // единствено на този guard. Match-ът вече е durable в DB и ще бъде
      // възстановен от boot recovery дори и този edge case да остави
      // in-memory match-а непубликуван в тази конкретна клонка.
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
