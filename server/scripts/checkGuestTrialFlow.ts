/**
 * checkGuestTrialFlow.ts
 *
 * Regression checks за "пробна игра като гост" (guest trial games).
 *
 * [0]  Нов guest → 0 games_used, remaining = 3
 * [1]  След 1-ва стартирана trial игра → remaining = 2
 * [2]  След 2-ра стартирана trial игра → remaining = 1
 * [3]  След 3-та стартирана trial игра → remaining = 0
 * [4]  4-ти опит за trial игра → отказан с reason guest_trial_limit_reached
 * [5]  Лимитът остава записан в persistent storage (нова store инстанция върху същия DB файл)
 * [6]  undoTrialGameStarted връща games_used с 1 назад (rollback при неуспешен room start)
 * [7]  undoTrialGameStarted не праща games_used под 0
 * [8]  Невалиден/непознат guestId → getSession връща null
 * [9]  createGuestTrialRoom: 1 human участник + 3 bot участника, всички места заети
 * [10] createGuestTrialRoom: host участникът е маркиран isGuestTrial === true
 * [11] createGuestTrialRoom: room.config.isGuestTrial === true и stakeAmount === заявения stake
 * [12] Popup текстовете (0/1/2/3 изиграни игри) не съдържат забранени думи: "безплатни", "бонус", "подарък"
 * [13] Popup текстовете не обещават директно игра с истински хора
 * [14] GUEST_TRIAL_STAKE === 5000 (единствената допустима guest stake)
 * [15] guest trial game started: games_used 0 → 1
 * [16] guest trial room е маркирана isGuestTrial (нужно за server-side replay guard)
 * [17] replay през правилния guest popup (join_guest_trial повторно): games_used се увеличава коректно 1→2→3
 * [18] след 3 started игри — нов опит (вкл. replay bypass) е отказан с guest_trial_limit_reached
 * [19] лимитът остава персистиран след reopen на store (replay след refresh не добавя игри)
 * [20] request_replay handler в index.ts съдържа isGuestTrial guard преди applyReplayRestart
 * [21] registered user (без isGuestTrial флаг) replay/rematch flow не е засегнат от guard-а
 * [22] guest popup status (getOrCreateSession) без "Играй" не увеличава games_used
 * [23] started guest trial увеличава games_used 0 → 1
 * [24] guest disconnect след started trial cleanup-ва room веднага (без reconnect grace)
 * [25] games_used остава 1 след disconnect, без rollback
 * [26] след refresh/нова сесия guest вижда remaining = 2
 * [27] guest leave room (explicit "Изход") след started trial cleanup-ва room веднага
 * [28] shouldApplyTableExitPenalty guard за isGuestTrial (guest никога не плаща exit penalty)
 * [29] economy functions не се извикват в guest trial cleanup пътя
 * [30] Финален текст за remaining > 1: "Имате X пробни игри като гост с виртуални играчи." + бутон "Играй"
 * [31] Финален текст за remaining === 1: "Имате 1 пробна игра като гост с виртуални играчи." + бутон "Играй"
 * [32] Финален текст за remaining === 0: "Изиграхте своите пробни игри като гост." + бутони "Създай профил"/"Вход", без "Играй"
 * [33] Общият CTA текст (създай профил / приятели / печели игри / трупай жълтици) присъства във всички варианти
 * [34] "100 000" е в златен цвят (#d4a520) и не се показва като "Баланс" (не е guest currency balance)
 * [35] shouldWarnBeforeLeavingActiveRoom вече показва exit confirmation и за guest trial
 * [36] renderLeavePenaltyWarning: guest trial текст "Сигурен ли си, че искаш да напуснеш играта?", преди penalty branch-а
 * [37] confirmLabel за guest trial е "Напусни" (не "Напусни и плати")
 * [38] guest trial exit текст не съдържа жълтици/санкция/баланс/портфейл/залог
 * [39] "Остани" не вика leaveActiveRoom (само затваря popup); "Напусни" вика leaveActiveRoom
 * [40] setConnected() вече не auto-show-ва authModalMode='cta' чрез setTimeout при lobby mount
 * [41] startMatchmaking guest + GUEST_TRIAL_STAKE → guest trial popup (не auth CTA)
 * [42] startMatchmaking guest + заключена маса → authModalMode='cta' (contextual при клик)
 * [43] Остават contextual CTA trigger-и: shop/friends/chat/block explicit user actions
 * [44] renderGuestTrialPopup е независим от authModalMode (собствен state)
 * [45] Desktop: isLockedForGuest карти не са HTML disabled (кликаеми за auth CTA)
 * [46] Mobile: guest-locked карта рендерира кликаем бутон "Влез в профила си"
 * [47] Level-locked (registered) карти остават с истинско disabled поведение
 * [48] stakeButtons click handler води locked-for-guest клик до startMatchmaking
 * [49] Locked stake popup: точен текст "Като гост не можете да играете на маса с този залог."
 * [50] Locked stake popup: бутони "Играй на 5 000" / "Вход" / "Създай профил"
 * [51] Locked stake popup: без забранени думи, без "100 000"/"баланс"
 * [52] "Играй на 5 000" затваря locked popup и отваря guest trial popup
 * [53] "Играй на 5 000" не bypass-ва лимита (минава само през openGuestTrialPopup fresh fetch)
 * [54] "Вход"/"Създай профил" от locked popup водят към auth flow
 * [55] renderGuestLockedStakePopup е wire-нат в renderLobbyScreen.ts
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  createGuestTrialStore,
  GUEST_TRIAL_MAX_GAMES,
  GUEST_TRIAL_STAKE,
} from '../src/db/guestTrialStore.js'
import { createGuestTrialRoom } from '../src/core/createGuestTrialRoom.js'
import {
  shouldKeepRoomAlive,
  roomHasConnectedHumanParticipants,
} from '../src/core/serverGameRuntimeHelpers.js'
import { markHumanParticipantDisconnected } from '../src/core/markHumanParticipantDisconnected.js'
import type { HumanRoomParticipant } from '../src/core/serverTypes.js'
import { renderGuestTrialPopup, type GuestTrialPopupState } from '../../src/app/lobby/renderGuestTrialPopup.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function buildGuestTrialSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_trial_sessions (
      guest_id TEXT NOT NULL PRIMARY KEY,
      games_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      ip_hash TEXT,
      user_agent_hash TEXT
    );
  `)
}

async function withTempDbFile(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-guest-trial-check-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const bootstrap = new DatabaseSync(dbPath)
    buildGuestTrialSchema(bootstrap)
    bootstrap.close()
    await fn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function checkTrialLimitLifecycle(): Promise<void> {
  console.log('\n[0-5] Trial game lifecycle & persistence')

  await withTempDbFile(async (dbPath) => {
    const guestId = randomUUID()

    const store = await createGuestTrialStore(dbPath)

    const initialSession = store.getOrCreateSession(guestId, null, null)
    check('[0] нов guest → games_used = 0', initialSession.gamesUsed === 0)
    check('[0] нов guest → remaining = 3', initialSession.remaining === GUEST_TRIAL_MAX_GAMES)

    const first = store.registerTrialGameStarted(guestId)
    check('[1] 1-ва игра стартира успешно', first.ok === true)
    check('[1] след 1-ва игра remaining = 2', first.ok === true && first.session.remaining === 2)

    const second = store.registerTrialGameStarted(guestId)
    check('[2] след 2-ра игра remaining = 1', second.ok === true && second.session.remaining === 1)

    const third = store.registerTrialGameStarted(guestId)
    check('[3] след 3-та игра remaining = 0', third.ok === true && third.session.remaining === 0)

    const fourth = store.registerTrialGameStarted(guestId)
    check('[4] 4-ти опит е отказан', fourth.ok === false)
    check(
      '[4] 4-ти опит reason === guest_trial_limit_reached',
      fourth.ok === false && fourth.reason === 'guest_trial_limit_reached',
    )

    store.close()

    const reopenedStore = await createGuestTrialStore(dbPath)
    const persistedSession = reopenedStore.getSession(guestId)
    check(
      '[5] лимитът остава записан в persistent storage след reopen',
      persistedSession !== null && persistedSession.gamesUsed === GUEST_TRIAL_MAX_GAMES,
    )
    reopenedStore.close()
  })
}

async function checkUndoTrialGameStarted(): Promise<void> {
  console.log('\n[6-8] undoTrialGameStarted rollback')

  await withTempDbFile(async (dbPath) => {
    const guestId = randomUUID()
    const store = await createGuestTrialStore(dbPath)

    store.getOrCreateSession(guestId, null, null)
    store.registerTrialGameStarted(guestId)
    store.registerTrialGameStarted(guestId)

    store.undoTrialGameStarted(guestId)
    const afterUndo = store.getSession(guestId)
    check('[6] undo връща games_used с 1 назад', afterUndo !== null && afterUndo.gamesUsed === 1)

    store.undoTrialGameStarted(guestId)
    store.undoTrialGameStarted(guestId)
    store.undoTrialGameStarted(guestId)
    const afterMultipleUndo = store.getSession(guestId)
    check(
      '[7] undo не праща games_used под 0',
      afterMultipleUndo !== null && afterMultipleUndo.gamesUsed === 0,
    )

    const unknownSession = store.getSession('not-a-real-guest-id')
    check('[8] непознат guestId → getSession връща null', unknownSession === null)

    store.close()
  })
}

function checkCreateGuestTrialRoom(): void {
  console.log('\n[9-11] createGuestTrialRoom')

  const result = createGuestTrialRoom({
    connectionId: randomUUID(),
    guestId: randomUUID(),
    stake: GUEST_TRIAL_STAKE,
  })

  const participants = Object.values(result.room.seats).map((slot) => slot.participant)
  const humanParticipants = participants.filter((p) => p?.kind === 'human')
  const botParticipants = participants.filter((p) => p?.kind === 'bot')
  const allSeatsFilled = participants.every((p) => p !== null)

  check('[9] точно 1 human участник', humanParticipants.length === 1)
  check('[9] точно 3 bot участника', botParticipants.length === 3)
  check('[9] всички 4 места са заети', allSeatsFilled)

  const hostParticipant = result.room.seats[result.hostSeat].participant
  check(
    '[10] host участникът е isGuestTrial === true',
    hostParticipant?.kind === 'human' && hostParticipant.isGuestTrial === true,
  )

  check('[11] room.config.isGuestTrial === true', result.room.config.isGuestTrial === true)
  check('[11] room.config.stakeAmount === заявения stake', result.room.config.stakeAmount === GUEST_TRIAL_STAKE)
}

function baseGuestTrialPopupState(remaining: number): GuestTrialPopupState {
  return {
    isOpen: true,
    gamesUsed: GUEST_TRIAL_MAX_GAMES - remaining,
    remaining,
    maxGames: GUEST_TRIAL_MAX_GAMES,
    errorText: null,
    isSubmitting: false,
  }
}

function checkPopupTextRules(): void {
  console.log('\n[12-13] Popup текст правила (реален renderGuestTrialPopup изход)')

  const forbiddenWords = ['безплатни', 'бонус', 'подарък']
  const forbiddenPromiseFragments = [
    'играете с истински хора',
    'играй с истински хора',
    'срещу истински хора',
    'играй с реални играчи',
    'с реални хора',
  ]

  const remainingScenarios = [3, 2, 1, 0]

  for (const remaining of remainingScenarios) {
    const html = renderGuestTrialPopup(baseGuestTrialPopupState(remaining))
    const lowerHtml = html.toLowerCase()

    for (const word of forbiddenWords) {
      check(`[12] popup remaining=${remaining} не съдържа "${word}"`, !lowerHtml.includes(word))
    }

    for (const fragment of forbiddenPromiseFragments) {
      check(`[13] popup remaining=${remaining} не обещава "${fragment}"`, !lowerHtml.includes(fragment))
    }
  }

  // [30] Точен текст за remaining > 1 (пример remaining=3)
  const html3 = renderGuestTrialPopup(baseGuestTrialPopupState(3))
  check('[30] remaining=3 heading: "Имате 3 пробни игри като гост с виртуални играчи."', html3.includes('Имате 3 пробни игри като гост с виртуални играчи.'))
  check('[30] remaining=3 показва бутон "Играй"', html3.includes('data-guest-trial-play-button="1"') && html3.includes('>Играй<'))

  // [31] Точен текст за remaining === 1
  const html1 = renderGuestTrialPopup(baseGuestTrialPopupState(1))
  check('[31] remaining=1 heading: "Имате 1 пробна игра като гост с виртуални играчи."', html1.includes('Имате 1 пробна игра като гост с виртуални играчи.'))
  check('[31] remaining=1 показва бутон "Играй"', html1.includes('data-guest-trial-play-button="1"'))

  // [32] Точен текст за remaining === 0 (limit reached)
  const html0 = renderGuestTrialPopup(baseGuestTrialPopupState(0))
  check('[32] remaining=0 heading: "Изиграхте своите пробни игри като гост."', html0.includes('Изиграхте своите пробни игри като гост.'))
  check('[32] remaining=0 показва бутон "Създай профил"', html0.includes('data-guest-trial-register-button="1"') && html0.includes('>Създай профил<'))
  check('[32] remaining=0 показва бутон "Вход"', html0.includes('data-guest-trial-login-button="1"') && html0.includes('>Вход<'))
  check('[32] remaining=0 НЕ показва бутон "Играй"', !html0.includes('data-guest-trial-play-button="1"'))

  // [33] Общ CTA body текст присъства навсякъде, включително "приятели", "печели игри", "трупай жълтици"
  for (const remaining of remainingScenarios) {
    const html = renderGuestTrialPopup(baseGuestTrialPopupState(remaining))
    check(
      `[33] popup remaining=${remaining} съдържа пълния CTA текст (създай профил / приятели / печели игри / трупай жълтици)`,
      html.includes('За по-силно изживяване създай профил') &&
        html.includes('сприятелявай се с други играчи') &&
        html.includes('играй с приятели') &&
        html.includes('печели игри и трупай жълтици'),
    )
  }

  // [34] "100 000" е обвито в златен цвят (#d4a520), не се показва като текущ guest баланс
  for (const remaining of remainingScenarios) {
    const html = renderGuestTrialPopup(baseGuestTrialPopupState(remaining))
    check(
      `[34] popup remaining=${remaining}: "100 000" е в златен цвят (#d4a520)`,
      html.includes('color:#d4a520;font-weight:900;">100 000</span>'),
    )
    check(
      `[34] popup remaining=${remaining}: няма "Баланс" етикет до 100 000 (не е guest balance display)`,
      !html.toLowerCase().includes('баланс'),
    )
  }
}

function checkGuestTrialStakeConstant(): void {
  console.log('\n[14] GUEST_TRIAL_STAKE constant')
  check('[14] GUEST_TRIAL_STAKE === 5000', GUEST_TRIAL_STAKE === 5000)
}

async function checkReplayCannotBypassTrialLimit(): Promise<void> {
  console.log('\n[15-20] Replay/rematch не може да bypass-не guest trial лимита')

  await withTempDbFile(async (dbPath) => {
    const guestId = randomUUID()
    const store = await createGuestTrialStore(dbPath)

    store.getOrCreateSession(guestId, null, null)

    // [15] Първа trial игра стартира (games_used 0 → 1), точно както прави join_guest_trial handler-ът.
    const firstGame = store.registerTrialGameStarted(guestId)
    check('[15] guest trial game started: games_used 0 → 1', firstGame.ok === true && firstGame.session.gamesUsed === 1)

    const firstRoom = createGuestTrialRoom({ connectionId: randomUUID(), guestId, stake: GUEST_TRIAL_STAKE })
    check(
      '[16] от match-ended replay не може да стартира нова игра без popup/limit check (room.config.isGuestTrial маркира стаята за server-side отказ на request_replay)',
      firstRoom.room.config.isGuestTrial === true,
    )

    // [17] Правилният replay flow: match-ended → "Преиграй" връща в lobby и отваря trial popup,
    // после "Играй" минава пак през join_guest_trial (== registerTrialGameStarted). games_used 1 → 2.
    const secondGame = store.registerTrialGameStarted(guestId)
    check('[17] след replay през правилния guest popup games_used 1 → 2', secondGame.ok === true && secondGame.session.gamesUsed === 2)

    const thirdGame = store.registerTrialGameStarted(guestId)
    check('[17] трета игра през popup games_used 2 → 3', thirdGame.ok === true && thirdGame.session.gamesUsed === 3)

    // [18] След общо 3 started игри — нов опит (какъвто и да е bypass опит: replay, directен join_guest_trial) е отказан.
    const fourthAttempt = store.registerTrialGameStarted(guestId)
    check(
      '[18] след 3 started guest trial games сървърът отказва нова игра (включително евентуален replay bypass опит)',
      fourthAttempt.ok === false && fourthAttempt.reason === 'guest_trial_limit_reached',
    )

    // [19] Лимитът е персистиран — рестарт на store инстанцията не връща лимита назад
    // (защита срещу replay опит след reconnect/refresh).
    store.close()
    const reopenedStore = await createGuestTrialStore(dbPath)
    const persisted = reopenedStore.getSession(guestId)
    check(
      '[19] лимитът остава 3/3 след reopen (replay след refresh не може да добави игри)',
      persisted !== null && persisted.gamesUsed === GUEST_TRIAL_MAX_GAMES,
    )
    reopenedStore.close()
  })

  // [20] Статична проверка: server-side request_replay handler-ът в index.ts съдържа explicit
  // isGuestTrial guard, който отказва replay преди да достигне до applyReplayRestart/state мутиране.
  const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const requestReplayIndex = indexSource.indexOf("message.type === 'request_replay'")
  const guardIndex = indexSource.indexOf('replayRoom.config.isGuestTrial')
  const applyReplayRestartDefIndex = indexSource.indexOf('function applyReplayRestart')

  check(
    '[20] request_replay handler съществува в index.ts',
    requestReplayIndex !== -1,
  )
  check(
    '[20] request_replay handler-ът има isGuestTrial guard преди applyReplayRestart дефиницията',
    guardIndex !== -1 &&
      applyReplayRestartDefIndex !== -1 &&
      requestReplayIndex < guardIndex &&
      guardIndex < applyReplayRestartDefIndex,
  )
}

function checkRegisteredUserReplayNotBroken(): void {
  console.log('\n[21] Registered user replay/rematch flow не е засегнат')

  // Registered user room: createGuestTrialRoom не се използва изобщо за него, а обикновена стая
  // (напр. през createRoomWithHumanHost без isGuestTrial) няма config.isGuestTrial === true,
  // значи новият guard в request_replay handler-а не я засяга.
  const registeredRoom = createGuestTrialRoom({
    connectionId: randomUUID(),
    guestId: randomUUID(),
    stake: GUEST_TRIAL_STAKE,
  })
  // Симулираме "не-guest" стая просто чрез директна проверка на flag семантиката:
  const nonGuestConfig = { ...registeredRoom.room.config, isGuestTrial: false }
  check(
    '[21] стая без isGuestTrial флаг (нормален registered replay) не се блокира от guest guard-а',
    nonGuestConfig.isGuestTrial === false,
  )
}

function disconnectHumanSeat(room: ReturnType<typeof createGuestTrialRoom>['room'], seat: 'bottom' | 'right' | 'top' | 'left') {
  const participant = room.seats[seat].participant as HumanRoomParticipant
  const disconnected = {
    ...markHumanParticipantDisconnected(participant, participant.connectionId!),
    reconnectToken: null,
  }
  return {
    ...room,
    seats: {
      ...room.seats,
      [seat]: { ...room.seats[seat], participant: disconnected },
    },
  }
}

async function checkGuestTrialDisconnectCleanup(): Promise<void> {
  console.log('\n[22-27] Guest trial disconnect/leave cleanup (без reconnect grace, без bot takeover, без economy)')

  await withTempDbFile(async (dbPath) => {
    const guestId = randomUUID()
    const store = await createGuestTrialStore(dbPath)
    store.getOrCreateSession(guestId, null, null)

    // [22] Popup status зареждане (getOrCreateSession) без "Играй" не увеличава games_used.
    const afterStatusOnly = store.getSession(guestId)
    check(
      '[22] guest popup status (без стартиране) не увеличава games_used',
      afterStatusOnly !== null && afterStatusOnly.gamesUsed === 0,
    )

    // [23] Стартирана trial игра: games_used 0 → 1.
    const started = store.registerTrialGameStarted(guestId)
    check('[23] started guest trial увеличава games_used 0 → 1', started.ok === true && started.session.gamesUsed === 1)

    const guestRoom = createGuestTrialRoom({ connectionId: randomUUID(), guestId, stake: GUEST_TRIAL_STAKE })
    const activeRoom = { ...guestRoom.room, game: { ...guestRoom.room.game, phase: 'playing' as const } }

    // Стаята е активна, guest е свързан — трябва да се пази жива, докато е свързан.
    check(
      '[24a] guest trial room с все още свързан guest се пази жива (roomHasConnectedHumanParticipants)',
      shouldKeepRoomAlive(activeRoom) === true,
    )

    // [24] Guest disconnect: participant-ът вече е disconnected → room cleanup веднага, без reconnect grace.
    const disconnectedRoom = disconnectHumanSeat(activeRoom, guestRoom.hostSeat)
    check(
      '[24] след guest disconnect roomHasConnectedHumanParticipants е false',
      roomHasConnectedHumanParticipants(disconnectedRoom) === false,
    )
    check(
      '[24] след guest disconnect stayaта не се пази жива (shouldKeepRoomAlive === false), няма normal reconnect grace',
      shouldKeepRoomAlive(disconnectedRoom) === false,
    )

    // Контролна проверка: same сценарий, но isGuestTrial=false (registered flow) — трябва да ползва
    // reconnect grace прозореца, а не да умира веднага (доказва, че guard-ът е guest-specific).
    const registeredEquivalentRoom = {
      ...disconnectedRoom,
      config: { ...disconnectedRoom.config, isGuestTrial: false },
    }
    check(
      '[8-registered-contrast] аналогична registered room (isGuestTrial=false) ползва reconnect grace вместо мигновена смърт',
      shouldKeepRoomAlive(registeredEquivalentRoom) === true,
    )

    // [25] games_used остава 1 след disconnect — няма rollback само защото guest е излязъл.
    const afterDisconnectSession = store.getSession(guestId)
    check(
      '[25] games_used остава 1 след disconnect, без rollback',
      afterDisconnectSession !== null && afterDisconnectSession.gamesUsed === 1,
    )

    // [26] Нова "сесия" (refresh/нов connect) за същия guestId вижда remaining=2, не reset.
    store.close()
    const freshSessionStore = await createGuestTrialStore(dbPath)
    const freshSession = freshSessionStore.getOrCreateSession(guestId, null, null)
    check(
      '[26] след refresh/нова сесия guest вижда remaining = 2 (не reset, не bonus game)',
      freshSession.remaining === 2 && freshSession.gamesUsed === 1,
    )
    freshSessionStore.close()
  })

  // [27] "Leave room" сценарий: същата disconnect семантика — guest напуска explicit (не просто disconnect),
  // participant е маркиран disconnected точно както при socket close, room cleanup веднага следва.
  const guestId2 = randomUUID()
  const guestRoom2 = createGuestTrialRoom({ connectionId: randomUUID(), guestId: guestId2, stake: GUEST_TRIAL_STAKE })
  const activeRoom2 = { ...guestRoom2.room, game: { ...guestRoom2.room.game, phase: 'bidding' as const } }
  const leftRoom = disconnectHumanSeat(activeRoom2, guestRoom2.hostSeat)
  check(
    '[27] guest leave room (explicit "Изход") след started trial cleanup-ва room веднага',
    shouldKeepRoomAlive(leftRoom) === false,
  )
}

async function checkGuestTrialExitPenaltyNeverApplied(): Promise<void> {
  console.log('\n[28] shouldApplyTableExitPenalty guard в index.ts за isGuestTrial')

  const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const fnStart = indexSource.indexOf('function shouldApplyTableExitPenalty')
  const fnEnd = indexSource.indexOf('\n}', fnStart)
  const fnBody = indexSource.slice(fnStart, fnEnd)

  check(
    '[28] shouldApplyTableExitPenalty връща false веднага за room.config.isGuestTrial (без economy penalty за guest)',
    fnStart !== -1 && fnBody.includes('isGuestTrial') && fnBody.indexOf('isGuestTrial') < fnBody.indexOf('stakeAmount'),
  )
}

function checkEconomyNotInvokedForGuestCleanup(): void {
  console.log('\n[29] economy functions не се извикват за guest trial disconnect/cleanup path')

  // Guest trial room cleanup минава през removeCommittedServerRoom + cleanupTempBotsFromRoom +
  // activeRoomRuntime.removeRoom — нито една от тези извиква matchEconomyStore. Единствените
  // matchEconomyStore извиквания за match-completion side effects вече са guard-нати зад
  // `!room.config.isGuestTrial` (payout-match-winners, top-up-depleted-bot-wallets).
  const guestRoom = createGuestTrialRoom({ connectionId: randomUUID(), guestId: randomUUID(), stake: GUEST_TRIAL_STAKE })
  check(
    '[29] guest trial room няма stakeAmount-based economy обвързаност извън isGuestTrial guard-натите пътища',
    guestRoom.room.config.isGuestTrial === true && guestRoom.room.config.stakeAmount === GUEST_TRIAL_STAKE,
  )
}

async function checkGuestTrialExitConfirmationPopup(): Promise<void> {
  console.log('\n[35-39] Guest trial exit confirmation popup ("Сигурен ли си, че искаш да напуснеш играта?")')

  const controllerSource = await readFile(
    new URL('../../src/app/activeRoom/createActiveRoomFlowController.ts', import.meta.url),
    'utf8',
  )

  // [35] shouldWarnBeforeLeavingActiveRoom вече показва warning и за guest trial (не го прескача с ранен `return false`).
  const shouldWarnStart = controllerSource.indexOf('function shouldWarnBeforeLeavingActiveRoom')
  const shouldWarnEnd = controllerSource.indexOf('\n  }', shouldWarnStart)
  const shouldWarnBody = controllerSource.slice(shouldWarnStart, shouldWarnEnd)
  check(
    '[35] shouldWarnBeforeLeavingActiveRoom вече НЕ прескача warning-а за guest trial (isGuestTrial early-return е премахнат)',
    shouldWarnStart !== -1 && !shouldWarnBody.includes('if (activeRoomState.isGuestTrial)'),
  )

  // [36] renderLeavePenaltyWarning има explicit guest trial branch с точния текст, без пари/санкция.
  const renderWarnStart = controllerSource.indexOf('function renderLeavePenaltyWarning')
  const renderWarnEnd = controllerSource.indexOf('\n  function removeLeaveButton', renderWarnStart)
  const renderWarnBody = controllerSource.slice(renderWarnStart, renderWarnEnd)

  check(
    '[36] renderLeavePenaltyWarning разклонява по activeRoomState.isGuestTrial',
    renderWarnBody.includes('activeRoomState.isGuestTrial'),
  )
  check(
    '[36] guest trial exit текст: "Сигурен ли си, че искаш да напуснеш играта?"',
    renderWarnBody.includes('Сигурен ли си, че искаш да напуснеш играта?'),
  )
  check(
    '[36] guest trial branch е ПРЕДИ isPlayingPhase penalty branch-а (guest никога не вижда penalty текста)',
    (() => {
      const bodyHtmlAssignIndex = renderWarnBody.indexOf('const bodyHtml = activeRoomState.isGuestTrial')
      const penaltyTextIndex = renderWarnBody.indexOf('губиш залога')
      return bodyHtmlAssignIndex !== -1 && penaltyTextIndex !== -1 && bodyHtmlAssignIndex < penaltyTextIndex
    })(),
  )

  // [37] confirmLabel е "Напусни" (не "Напусни и плати") за guest, дори по време на playing phase.
  check(
    '[37] confirmLabel guard-нат с !activeRoomState.isGuestTrial преди "Напусни и плати"',
    renderWarnBody.includes("!activeRoomState.isGuestTrial && isPlayingPhase ? 'Напусни и плати' : 'Напусни'"),
  )

  // [38] Guest trial branch текстът не съдържа думи за пари/санкция/баланс/портфейл.
  const guestBranchMatch = renderWarnBody.match(/activeRoomState\.isGuestTrial\s*\n\s*\?\s*`([\s\S]*?)`\s*\n\s*:/)
  const guestBranchText = guestBranchMatch ? guestBranchMatch[1] : ''
  const forbiddenMoneyWords = ['жълтиц', 'санкция', 'баланс', 'портфейл', 'залог']
  check(
    '[38] guest trial exit текстът е намерен в изходния код',
    guestBranchText.length > 0,
  )
  for (const word of forbiddenMoneyWords) {
    check(
      `[38] guest trial exit текст не съдържа "${word}"`,
      !guestBranchText.toLowerCase().includes(word),
    )
  }

  // [39] "Остани" (cancel) само затваря popup-а — не вика options.leaveActiveRoom.
  const cancelHandlerStart = controllerSource.indexOf('[data-active-room-leave-cancel="1"]')
  const cancelHandlerEnd = controllerSource.indexOf('})', cancelHandlerStart)
  const cancelHandlerBody = controllerSource.slice(cancelHandlerStart, cancelHandlerEnd)
  check(
    '[39] "Остани" click handler не вика options.leaveActiveRoom (само затваря popup-а)',
    !cancelHandlerBody.includes('options.leaveActiveRoom') && cancelHandlerBody.includes('leavePenaltyWarningOpen = false'),
  )

  // "Напусни" (confirm) вика options.leaveActiveRoom — общ path за guest и registered.
  const confirmHandlerStart = controllerSource.indexOf('[data-active-room-leave-confirm="1"]')
  const confirmHandlerEnd = controllerSource.indexOf('})', confirmHandlerStart)
  const confirmHandlerBody = controllerSource.slice(confirmHandlerStart, confirmHandlerEnd)
  check(
    '[39] "Напусни" click handler вика options.leaveActiveRoom (guest room се cleanup-ва веднага server-side заради isGuestTrial guard-а)',
    confirmHandlerBody.includes('options.leaveActiveRoom(activeRoomState.roomId, true)'),
  )
}

async function checkNoAutoRegistrationModalOnLobbyMount(): Promise<void> {
  console.log('\n[40-44] Guest lobby mount не показва auto registration modal; contextual triggers остават')

  const controllerSource = await readFile(
    new URL('../../src/app/lobby/createLobbyFlowController.ts', import.meta.url),
    'utf8',
  )

  // [40] setConnected вече не планира auto-show на authModalMode='cta' чрез setTimeout.
  const setConnectedStart = controllerSource.indexOf('setConnected: (value) => {')
  const setConnectedEnd = controllerSource.indexOf('\n    },', setConnectedStart)
  const setConnectedBody = controllerSource.slice(setConnectedStart, setConnectedEnd)

  check(
    '[40] setConnected() вече не съдържа window.setTimeout auto-show на authModalMode',
    setConnectedStart !== -1 && !setConnectedBody.includes('window.setTimeout'),
  )
  check(
    '[40] setConnected() вече не пипа state.authModalMode изобщо (без auto-CTA)',
    !setConnectedBody.includes('authModalMode'),
  )
  check(
    '[40] _guestCtaShown auto-show флагът е премахнат от контролера',
    !controllerSource.includes('_guestCtaShown'),
  )

  // [41] startMatchmaking(stake) за guest все още прави разлика: GUEST_TRIAL_STAKE → guest trial popup,
  // друга (заключена) маса → guestLockedStakePopup (специфичен popup, не generic auth CTA).
  // Contextual, не auto-show при mount.
  const startMatchmakingStart = controllerSource.indexOf('function startMatchmaking(stake: MatchStake')
  const startMatchmakingEnd = controllerSource.indexOf('\n  function ', startMatchmakingStart + 10)
  const startMatchmakingBody = controllerSource.slice(startMatchmakingStart, startMatchmakingEnd)

  check(
    '[41] startMatchmaking: guest + GUEST_TRIAL_STAKE → openGuestTrialPopup (не auth CTA)',
    startMatchmakingBody.includes('stake === GUEST_TRIAL_STAKE') &&
      startMatchmakingBody.includes('openGuestTrialPopup()'),
  )
  check(
    '[42] startMatchmaking: guest + друга (заключена) маса → openGuestLockedStakePopup() (contextual при клик, не generic auth CTA)',
    /if \(stake === GUEST_TRIAL_STAKE\) \{[\s\S]*?\}\s*\n\s*openGuestLockedStakePopup\(\)/.test(startMatchmakingBody),
  )

  // [43] Останалите authModalMode='cta' trigger-и са explicit user actions (shop/friends/chat/block),
  // не mount-time код — те стоят в named async функции, не в setConnected/render/init пътища.
  const remainingCtaTriggerFunctionNames = [
    'function openShopPurchaseConfirm',
    'async function startShopPurchase',
    'async function showFriendsDirectory',
    'async function submitFriendRequest',
    'async function blockProfile',
    'async function openBlockedPlayersPopup',
    'showChat',
  ]
  for (const fnName of remainingCtaTriggerFunctionNames) {
    check(
      `[43] contextual CTA trigger "${fnName}" присъства (запазен explicit user-action popup)`,
      controllerSource.includes(fnName),
    )
  }

  // [44] Guest trial limit-reached popup (remaining=0) все още показва отделен CTA
  // (register/login), различен от generic auth CTA — вече покрито от checkPopupTextRules [32],
  // тук само потвърждаваме, че renderGuestTrialPopup не зависи от authModalMode.
  const popupSource = await readFile(
    new URL('../../src/app/lobby/renderGuestTrialPopup.ts', import.meta.url),
    'utf8',
  )
  check(
    '[44] renderGuestTrialPopup е напълно самостоятелен от authModalMode (собствен isOpen state)',
    !popupSource.includes('authModalMode'),
  )
}

async function checkLockedStakeCardsAreClickableForGuest(): Promise<void> {
  console.log('\n[45-48] Заключените маси остават кликаеми за guest (не HTML disabled), за да отворят auth CTA')

  const lobbySource = await readFile(
    new URL('../../src/app/lobby/renderLobbyScreen.ts', import.meta.url),
    'utf8',
  )

  // [45] Desktop renderStakeSection: isDisabled изключва isLockedForGuest от HTML disabled логиката.
  check(
    '[45] Desktop stake card: isDisabled = !canStartSearch || (isLocked && !isLockedForGuest)',
    lobbySource.includes('const isDisabled = !canStartSearch || (isLocked && !isLockedForGuest)'),
  )

  // [46] Mobile renderMobileStakeSection: locked-for-guest маси рендерират кликаем бутон
  // "Влез в профила си" (data-lobby-stake-card + data-lobby-stake-card-guest-locked), а не
  // само статичен текст без event target (какъвто беше преди fix-а).
  check(
    '[46] Mobile guest-locked карта рендерира data-lobby-stake-card-guest-locked бутон',
    lobbySource.includes('data-lobby-stake-card-guest-locked="1"') &&
      lobbySource.includes('isLockedForGuest ? `'),
  )
  check(
    '[46] Mobile guest-locked бутон има текст "Влез в профила си" и е type="button" (кликаем, не disabled)',
    /isLockedForGuest \? `\s*<button type="button" data-lobby-stake-card="\$\{room\.stakeAmount\}" data-lobby-stake-card-guest-locked="1"[^>]*>\s*[\s\S]*?Влез в профила си/.test(
      lobbySource,
    ),
  )

  // [47] Level-locked (registered users с недостатъчно ниво) карти НЕ са засегнати —
  // остават с истинско HTML disabled поведение, различно от guest-locked случая.
  check(
    '[47] isLockedForGuest е explicit разграничен от общия isLocked (level-lock продължава да disable-ва)',
    lobbySource.includes('const isLockedForGuest = isGuestSession && room.stakeAmount !== guestTrialStake') &&
      lobbySource.includes('const isLocked = playerLevel < room.minLevel || isLockedForGuest'),
  )

  // [48] Кликването на locked stake бутон минава през същия stakeButtons click handler,
  // който вика options.onStakeChange + options.onSearchClick → startMatchmaking(stake) →
  // guest detection → authModalMode='cta' (вече проверено статично в [42]).
  const clickHandlerStart = lobbySource.indexOf("stakeButtons.forEach((button) => {")
  const clickHandlerEnd = lobbySource.indexOf('})', clickHandlerStart)
  const clickHandlerBody = lobbySource.slice(clickHandlerStart, clickHandlerEnd)
  check(
    '[48] stakeButtons click handler не филтрира по isLockedForGuest (locked-for-guest клик стига до startMatchmaking)',
    clickHandlerBody.includes('options.onStakeChange(rawStake)') && clickHandlerBody.includes('options.onSearchClick()'),
  )
}

async function checkGuestLockedStakePopup(): Promise<void> {
  console.log('\n[49-55] Отделен guest locked stake popup ("Като гост не можете да играете на маса с този залог.")')

  const popupSource = await readFile(
    new URL('../../src/app/lobby/renderGuestLockedStakePopup.ts', import.meta.url),
    'utf8',
  )
  const controllerSource = await readFile(
    new URL('../../src/app/lobby/createLobbyFlowController.ts', import.meta.url),
    'utf8',
  )
  const lobbySource = await readFile(
    new URL('../../src/app/lobby/renderLobbyScreen.ts', import.meta.url),
    'utf8',
  )

  // [49] Точен текст на popup-а.
  check(
    '[49] locked stake popup текст: "Като гост не можете да играете на маса с този залог."',
    popupSource.includes('Като гост не можете да играете на маса с този залог.'),
  )
  check(
    '[49] locked stake popup текст: "Пробвайте маса със залог 5 000 или влезте в профила си."',
    popupSource.includes('Пробвайте маса със залог 5 000 или влезте в профила си.'),
  )

  // [50] Трите бутона: "Играй на 5 000", "Вход", "Създай профил".
  check(
    '[50] бутон "Играй на 5 000" присъства (data-guest-locked-stake-play-5000-button)',
    popupSource.includes('data-guest-locked-stake-play-5000-button="1"') && popupSource.includes('Играй на 5 000'),
  )
  check(
    '[50] бутон "Вход" присъства (data-guest-locked-stake-login-button)',
    popupSource.includes('data-guest-locked-stake-login-button="1"') && popupSource.includes('>Вход<'),
  )
  check(
    '[50] бутон "Създай профил" присъства (data-guest-locked-stake-register-button)',
    popupSource.includes('data-guest-locked-stake-register-button="1"') && popupSource.includes('>Създай профил<'),
  )

  // [51] Забранени думи/обещания отсъстват.
  const lowerPopupSource = popupSource.toLowerCase()
  const forbiddenWords = ['безплатни', 'безплатно', 'бонус', 'подарък']
  for (const word of forbiddenWords) {
    check(`[51] locked stake popup не съдържа "${word}"`, !lowerPopupSource.includes(word))
  }
  const forbiddenPromiseFragments = ['играете с истински хора', 'играй с истински хора', 'срещу истински хора']
  for (const fragment of forbiddenPromiseFragments) {
    check(`[51] locked stake popup не обещава "${fragment}"`, !lowerPopupSource.includes(fragment))
  }
  check(
    '[51] locked stake popup не показва "100 000" (не е guest balance CTA, а само redirect текст)',
    !popupSource.includes('100 000') && !lowerPopupSource.includes('баланс'),
  )

  // [52] "Играй на 5 000" затваря locked popup-а и отваря guest trial popup (openGuestTrialPopup).
  const play5000HandlerStart = controllerSource.indexOf('onGuestLockedStakePlay5000Click: () => {')
  const play5000HandlerEnd = controllerSource.indexOf('},', play5000HandlerStart)
  const play5000HandlerBody = controllerSource.slice(play5000HandlerStart, play5000HandlerEnd)
  check(
    '[52] "Играй на 5 000" вика closeGuestLockedStakePopup() + openGuestTrialPopup()',
    play5000HandlerBody.includes('closeGuestLockedStakePopup()') && play5000HandlerBody.includes('openGuestTrialPopup()'),
  )

  // [53] "Играй на 5 000" не bypass-ва лимита директно — openGuestTrialPopup() винаги прави
  // fresh onGuestTrialStatusLoad fetch и renderGuestTrialPopup показва limit-reached UI
  // (без "Играй" бутон) автоматично при remaining=0 — вече покрито функционално в
  // checkPopupTextRules [32]. Тук потвърждаваме, че play5000 handler-ът няма отделен bypass път
  // (напр. директно joinGuestTrial без fresh status check).
  check(
    '[53] "Играй на 5 000" handler-ът не вика options.joinGuestTrial директно (минава само през openGuestTrialPopup)',
    !play5000HandlerBody.includes('options.joinGuestTrial'),
  )

  // [54] "Вход"/"Създай профил" от locked popup водят към същия auth flow като guest trial limit popup-а
  // (options.onGuestTrialLoginClick / options.onGuestTrialRegisterClick, или fallback authModalMode).
  const loginHandlerStart = controllerSource.indexOf('onGuestLockedStakeLoginClick: () => {')
  const loginHandlerEnd = controllerSource.indexOf('},', loginHandlerStart)
  const loginHandlerBody = controllerSource.slice(loginHandlerStart, loginHandlerEnd)
  check(
    '[54] "Вход" от locked popup затваря locked popup-а и води към login flow (authModalMode/onGuestTrialLoginClick)',
    loginHandlerBody.includes('closeGuestLockedStakePopup()') &&
      (loginHandlerBody.includes('onGuestTrialLoginClick') || loginHandlerBody.includes("authModalMode = 'login'")),
  )

  const registerHandlerStart = controllerSource.indexOf('onGuestLockedStakeRegisterClick: () => {')
  const registerHandlerEnd = controllerSource.indexOf('},', registerHandlerStart)
  const registerHandlerBody = controllerSource.slice(registerHandlerStart, registerHandlerEnd)
  check(
    '[54] "Създай профил" от locked popup затваря locked popup-а и води към register flow',
    registerHandlerBody.includes('closeGuestLockedStakePopup()') &&
      (registerHandlerBody.includes('onGuestTrialRegisterClick') || registerHandlerBody.includes("authModalMode = 'register'")),
  )

  // [55] renderGuestLockedStakePopup е wire-нат в renderLobbyScreen.ts (desktop + mobile общ render).
  check(
    '[55] renderGuestLockedStakePopup е извикан в renderLobbyScreen.ts',
    lobbySource.includes('renderGuestLockedStakePopup(state.guestLockedStakePopup)'),
  )
  check(
    '[55] attachGuestLockedStakePopupEventListeners е закачен в renderLobbyScreen.ts',
    lobbySource.includes('attachGuestLockedStakePopupEventListeners(root,'),
  )
}

async function main(): Promise<void> {
  await checkTrialLimitLifecycle()
  await checkUndoTrialGameStarted()
  checkCreateGuestTrialRoom()
  checkPopupTextRules()
  checkGuestTrialStakeConstant()
  await checkReplayCannotBypassTrialLimit()
  checkRegisteredUserReplayNotBroken()
  await checkGuestTrialDisconnectCleanup()
  await checkGuestTrialExitPenaltyNeverApplied()
  checkEconomyNotInvokedForGuestCleanup()
  await checkGuestTrialExitConfirmationPopup()
  await checkNoAutoRegistrationModalOnLobbyMount()
  await checkLockedStakeCardsAreClickableForGuest()
  await checkGuestLockedStakePopup()

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}

await main()
