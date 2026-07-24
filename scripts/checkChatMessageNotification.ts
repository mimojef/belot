/**
 * checkChatMessageNotification.ts
 *
 * Проверки за "входящ чат" top-popup известието — комбинира:
 *
 *  A) РЕАЛНИ поведенчески тестове върху src/ui/notifications/chatNotificationQueue.ts
 *     (чист state machine, без DOM зависимост — директно import-ваем в Node
 *     чрез tsx). Тук се доказва самата логика "само първото непрочетено
 *     съобщение", опашката с 1 pending слот, дедупликацията по messageId,
 *     и възстановяването на правото чрез markRead — не чрез regex търсене
 *     в source текста.
 *
 *  B) Source-text проверки за частите, които изискват реален DOM рендер
 *     (jsdom не е налична зависимост в клиента) — бутонната структура извън/
 *     по време на игра, wiring-а в main.ts/createLobbyFlowController.ts/
 *     index.ts/chatStore.ts, и че звукът реюзва съществуващия audio helper
 *     pattern (player-seat-fill.mp3), не нов файл.
 *
 *  C) РЕАЛНИ поведенчески тестове върху src/pendingChatRefreshTracker.ts
 *     (чист state machine, без DOM/network зависимост) — regression покритие
 *     за production бъга: чат съобщение по време на игра показва popup
 *     коректно, но conversation/unread state оставаше остарял след напускане
 *     на масата, защото chat GET заявките продължават да връщат 403 известно
 *     време след leave (сървърът брои профила като "в игра" докато bot
 *     takeover довърши мача вместо напусналия играч — виж
 *     server/src/game/abandonHumanControlForRoom.ts, player.mode остава
 *     'human'). Тук се доказва самата логика "маркерът устоява на неуспешни
 *     опити, изчиства се само при потвърден успех, няма дублирани заявки при
 *     няколко съобщения, няма tight retry loop" — не чрез regex.
 *
 *  D) Source-text проверки, че main.ts реално свързва tracker-а на
 *     правилните lifecycle точки (showLobby, startNewGame, visibilitychange,
 *     pageshow, focus) и че popup dismiss/auto-hide не го пипа.
 *
 * MANUAL/RUNTIME-VERIFIED (извън автоматизирания suite — изисква реален
 * spawned HTTP+WS сървър + реален Chromium браузър, виж диагностичната сесия
 * от този fix): с два напълно изолирани browser contexts, реален matchmaking
 * bot-fill до room.status==='playing', и реално доброволно напускане на
 * масата — потвърдено е, че (1) GET /api/chat/conversations връща 403 и
 * директно след left_active_room, и до ~2 минути по-късно (persistent, не
 * race); (2) dispatch на synthetic 'focus' докато все още блокирано коректно
 * задейства нов опит (брой заявки расте), без permanent give-up; (3) build
 * на текущия HEAD е потвърден зареден в browser контекста.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createChatNotificationQueue,
  type ChatNotificationEvent,
} from '../src/ui/notifications/chatNotificationQueue.ts'
import {
  markPendingChatRefresh,
  clearPendingChatRefresh,
  isChatRefreshPending,
  attemptPendingChatRefresh,
  resetPendingChatRefreshTrackerForTests,
} from '../src/pendingChatRefreshTracker.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const NOTIF_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'chatMessageNotification.ts')
const QUEUE_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'chatNotificationQueue.ts')
const MAIN_PATH = join(REPO_ROOT, 'src', 'main.ts')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const CLIENT_PATH = join(REPO_ROOT, 'src', 'app', 'network', 'createGameServerClient.ts')
const SERVER_INDEX_PATH = join(REPO_ROOT, 'server', 'src', 'index.ts')
const CHAT_STORE_PATH = join(REPO_ROOT, 'server', 'src', 'db', 'chatStore.ts')
const TRACKER_PATH = join(REPO_ROOT, 'src', 'pendingChatRefreshTracker.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: получено ${JSON.stringify(actual)}, очаквано ${JSON.stringify(expected)}`)
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function extractFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n}')
  assert(endIdx !== -1, `${label}: край на функция не е намерен след "${signature}"`)
  return afterStart.slice(0, endIdx)
}

function extractBlock(src: string, startMarker: string, label: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker)
  assert(startIdx !== -1, `${label}: маркер "${startMarker}" не е намерен`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf(endMarker)
  assert(endIdx !== -1, `${label}: край на блок не е намерен след "${startMarker}"`)
  return afterStart.slice(0, endIdx)
}

// ─── Load real source files ─────────────────────────────────────────────────

const notifSrc = normalizeLineEndings(await readFile(NOTIF_PATH, 'utf8'))
const queueSrc = normalizeLineEndings(await readFile(QUEUE_PATH, 'utf8'))
const mainSrc = normalizeLineEndings(await readFile(MAIN_PATH, 'utf8'))
const controllerSrc = normalizeLineEndings(await readFile(CONTROLLER_PATH, 'utf8'))
const clientSrc = normalizeLineEndings(await readFile(CLIENT_PATH, 'utf8'))
const serverSrc = normalizeLineEndings(await readFile(SERVER_INDEX_PATH, 'utf8'))
const chatStoreSrc = normalizeLineEndings(await readFile(CHAT_STORE_PATH, 'utf8'))
const trackerSrc = normalizeLineEndings(await readFile(TRACKER_PATH, 'utf8'))

console.log('\n=== Chat Message Notification Checks ===\n')

// ─── A) Поведенчески тестове върху chatNotificationQueue.ts ─────────────────
//
// Симулира popup lifecycle-а: handleIncoming() решава show/queue/skip;
// "show" означава че компонентът реално ще рендира + пусне звук; когато
// текущият popup приключи (ръчно затворен ИЛИ auto-hide), се вика
// handleDismissed(); markRead() е "разговорът е реално отворен и прочетен".

function makeEvent(overrides: Partial<ChatNotificationEvent>): ChatNotificationEvent {
  return {
    friendshipId: 'friend-1',
    messageId: 'msg-1',
    fromDisplayName: 'Петър',
    shouldNotify: true,
    ...overrides,
  }
}

// [1] Първо непрочетено съобщение извън игра → show, точно веднъж
await check('[1] Първо непрочетено (shouldNotify=true) → decision=show', () => {
  const queue = createChatNotificationQueue()
  const decision = queue.handleIncoming(makeEvent({}))
  assertEqual(decision.action, 'show', 'decision.action')
  if (decision.action === 'show') {
    assertEqual(decision.friendshipId, 'friend-1', 'friendshipId')
    assertEqual(decision.fromDisplayName, 'Петър', 'fromDisplayName')
  }
  const state = queue.getState()
  assertEqual(state.activeFriendshipId, 'friend-1', 'activeFriendshipId след show')
})

// [2] Второ и трето съобщение от същия човек → без нов popup, без рестартиране
await check('[2] Второ/трето съобщение от същия подател (shouldNotify=false от сървъра) → skip', () => {
  const queue = createChatNotificationQueue()
  const first = queue.handleIncoming(makeEvent({ messageId: 'm1' }))
  assertEqual(first.action, 'show', 'първо съобщение трябва да покаже popup')

  // Сървърът вече е казал, че следващите не са "първо непрочетено" (получателят
  // все още не е прочел първото) — точно каквото сървърът праща в реалния flow.
  const second = queue.handleIncoming(makeEvent({ messageId: 'm2', shouldNotify: false }))
  assertEqual(second.action, 'skip', 'второ съобщение (shouldNotify=false) → skip')

  const third = queue.handleIncoming(makeEvent({ messageId: 'm3', shouldNotify: false }))
  assertEqual(third.action, 'skip', 'трето съобщение (shouldNotify=false) → skip')
})

await check('[2b] Клиентската защита пази дори ако сървърът погрешно прати shouldNotify=true повторно', () => {
  // Defense-in-depth: notifiedFriendshipIds пази дори ако сървърът поради race
  // condition прати втори shouldNotify=true за същия все още непрочетен разговор.
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ messageId: 'm1', shouldNotify: true }))
  const second = queue.handleIncoming(makeEvent({ messageId: 'm2', shouldNotify: true }))
  assertEqual(second.action, 'skip', 'докато friendshipId е все още "notified", ново show не се допуска')
})

// [3] "Затвори" не маркира като прочетено и не разрешава ново известие
await check('[3] Затваряне (handleDismissed) БЕЗ markRead → следващо съобщение от същия подател остава skip', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ messageId: 'm1' }))
  queue.handleDismissed() // ръчно "Затвори" — не вика markRead

  const next = queue.handleIncoming(makeEvent({ messageId: 'm2', shouldNotify: false }))
  assertEqual(next.action, 'skip', 'без markRead правото не се възстановява')
})

// [4] Автоматичното скриване (истинската функция е идентична с ръчното close
//     в handleDismissed — auto-hide и close бутонът викат едно и също) не
//     разрешава ново известие
await check('[4] Auto-hide (handleDismissed) без markRead → правото остава консумирано', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ messageId: 'm1' }))
  queue.handleDismissed() // симулира auto-hide изтичане на таймера

  const state = queue.getState()
  assert(state.notifiedFriendshipIds.includes('friend-1'), 'friendshipId остава в notified след auto-hide')
})

// [5] След реално отваряне и прочитане (markRead) → следващо БЪДЕЩО
//     съобщение от същия човек отново показва popup
await check('[5] markRead възстановява правото → следващо съобщение отново show', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ messageId: 'm1' }))
  queue.handleDismissed()
  queue.markRead('friend-1')

  const next = queue.handleIncoming(makeEvent({ messageId: 'm2', shouldNotify: true }))
  assertEqual(next.action, 'show', 'след markRead ново съобщение (shouldNotify=true от сървъра) отново показва popup')
})

// [6] Съобщение от текущо отворения разговор → main.ts guard-ва handleIncoming
//     изобщо (alreadyOpen проверка) — тук доказваме самия queue helper НЕ се
//     ползва за отворени разговори (main.ts никога не му подава такова
//     събитие), а вместо това разговорът се маркира прочетен (сървър +
//     локално) чрез markChatConversationRead — виж и тест [16].
await check('[6] main.ts НЕ подава chatMessageNotification.handleIncoming за alreadyOpen случая', () => {
  const block = extractBlock(mainSrc, `if (message.type === 'chat_message_received') {`, 'chat_message_received handler', "\n      return\n    }")
  assert(
    /if \(!isOwnMessage && !alreadyOpen\) \{\s*\n\s*chatMessageNotification\.handleIncoming/.test(block),
    'handleIncoming трябва да се вика само когато !alreadyOpen',
  )
  assert(
    /if \(alreadyOpen\) \{\s*\n[\s\S]*?markChatConversationRead\(message\.friendshipId\)/.test(block),
    'при alreadyOpen трябва да се извика markChatConversationRead (сървър + локален reset), без popup/звук',
  )
})

// [7] Съобщение от друг човек, докато потребителят е в чат с трети → show
await check('[7] Различен friendshipId (не текущо отворения) → show независимо от чат екрана', () => {
  const queue = createChatNotificationQueue()
  // Симулира: разговорът с "friend-ivan" е отворен (main.ts би маркирал
  // alreadyOpen=true и изобщо не би подал събитието на queue-а). "friend-petar"
  // е различен подател — queue-то няма представа за "текущия екран", само
  // за friendshipId-ta, които вече е показало — затова коректно показва.
  const decision = queue.handleIncoming(makeEvent({ friendshipId: 'friend-petar', messageId: 'm1' }))
  assertEqual(decision.action, 'show', 'различен от текущо отворения разговор подател трябва да получи popup')
})

// [8] "Виж" отваря точния разговор — source-text проверка на wiring-а
await check('[8] onView callback подава точния friendshipId на известието към lobby.openChatWithFriend', () => {
  const viewHandlerBlock = extractBlock(
    notifSrc,
    `options.container.querySelector('#chat-notif-view-btn')?.addEventListener('click', () => {`,
    'view click handler',
    '\n    })',
  )
  assert(viewHandlerBlock.includes('const friendshipId = notif.friendshipId'), 'view handler трябва да чете friendshipId от текущото известие')
  assert(viewHandlerBlock.includes('options.onView(friendshipId)'), 'view handler трябва да извика options.onView(friendshipId)')

  const wiring = extractBlock(mainSrc, 'const chatMessageNotification = createChatMessageNotification({', '})')
  assert(
    /onView:\s*\(friendshipId\)\s*=>\s*\{\s*\n\s*lobby\?\.openChatWithFriend\(friendshipId\)/.test(wiring),
    'onView трябва директно да извика lobby?.openChatWithFriend(friendshipId)',
  )

  const openFn = extractBlock(controllerSrc, 'openChatWithFriend: (friendshipId: string) => {', 'openChatWithFriend', '\n    },')
  assert(openFn.includes('openChatConversation(friendshipId)'), 'openChatWithFriend трябва да отвори точно подадения разговор')
  assert(openFn.includes('options.onChatMarkRead?.(friendshipId)'), 'openChatWithFriend трябва да маркира разговора като прочетен чрез съществуващия onChatMarkRead flow')
})

// [9] По време на игра → само "Затвори", но popup и звук работят нормално
await check('[9] По време на игра viewButtonHtml е празен низ (само Затвори), но handleIncoming все още вика show', () => {
  assert(/inGame\s*\n\s*\? ''/.test(notifSrc), 'inGame===true → viewButtonHtml е празен низ')

  const queue = createChatNotificationQueue()
  // Queue логиката е независима от isInGame — isInGame само определя кои
  // бутони се рендират, не дали известието изобщо се показва.
  const decision = queue.handleIncoming(makeEvent({}))
  assertEqual(decision.action, 'show', 'известието продължава да се показва по време на игра')
})

// [10] Много съобщения от един човек по време на игра → само 1 popup, 1 звук
await check('[10] Серия съобщения от един подател (сървърът маркира само първото shouldNotify=true) → 1 show, останалите skip', () => {
  const queue = createChatNotificationQueue()
  const results = [
    queue.handleIncoming(makeEvent({ messageId: 'g1', shouldNotify: true })),
    queue.handleIncoming(makeEvent({ messageId: 'g2', shouldNotify: false })),
    queue.handleIncoming(makeEvent({ messageId: 'g3', shouldNotify: false })),
    queue.handleIncoming(makeEvent({ messageId: 'g4', shouldNotify: false })),
  ]
  const showCount = results.filter((r) => r.action === 'show').length
  assertEqual(showCount, 1, 'точно 1 show от серия съобщения на един подател')
})

// [11] Двама различни изпращачи → по едно независимо известие, без наслагване
await check('[11] Двама различни подателя, докато първият popup е активен → вторият се опашва, после показва', () => {
  const queue = createChatNotificationQueue()
  const first = queue.handleIncoming(makeEvent({ friendshipId: 'friend-a', messageId: 'a1' }))
  assertEqual(first.action, 'show', 'първият подател показва веднага')

  const second = queue.handleIncoming(makeEvent({ friendshipId: 'friend-b', messageId: 'b1' }))
  assertEqual(second.action, 'queue', 'вторият подател (различен) отива в опашката, не се наслагва')

  const stateWhileActive = queue.getState()
  assertEqual(stateWhileActive.activeFriendshipId, 'friend-a', 'активен остава първият')
  assert(stateWhileActive.pendingFriendshipIds.includes('friend-b'), 'чакащ е вторият')

  // Първият popup приключва (ръчно или auto-hide) → опашката поема следващия.
  const afterDismiss = queue.handleDismissed()
  assertEqual(afterDismiss.action, 'show', 'след освобождаване на слота опашката показва чакащия')
  if (afterDismiss.action === 'show') {
    assertEqual(afterDismiss.friendshipId, 'friend-b', 'вторият подател се показва след първия')
  }
})

await check('[11b] Не се допуска един friendshipId едновременно активен и чакащ', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ friendshipId: 'friend-a', messageId: 'a1' }))
  // Второ съобщение от СЪЩИЯ вече-активен подател — не трябва да влезе в опашката паралелно.
  const duplicate = queue.handleIncoming(makeEvent({ friendshipId: 'friend-a', messageId: 'a2', shouldNotify: false }))
  assertEqual(duplicate.action, 'skip', 'активният подател не се появява и като pending')

  const state = queue.getState()
  assert(!state.pendingFriendshipIds.includes('friend-a'), 'friend-a не трябва да е едновременно active и pending')
})

// [11c] КРИТИЧЕН РЕГРЕСИОНЕН ТЕСТ: четирима различни изпращачи A/B/C/D —
// FIFO опашка, никой не се губи, нито един заменя друг.
await check('[11c] A/B/C/D: FIFO опашка от 4 различни изпращачи — никой не се губи', () => {
  const queue = createChatNotificationQueue()

  // 1. A → show
  const decisionA = queue.handleIncoming(makeEvent({ friendshipId: 'A', messageId: 'a1', fromDisplayName: 'Ана' }))
  assertEqual(decisionA.action, 'show', '1. A трябва да покаже popup веднага')

  // 2. B → queue (докато A е активен)
  const decisionB = queue.handleIncoming(makeEvent({ friendshipId: 'B', messageId: 'b1', fromDisplayName: 'Борис' }))
  assertEqual(decisionB.action, 'queue', '2. B трябва да отиде в опашката')

  // 3. C → queue (преди A да е изчезнал — с единичен pending слот C би заменил B; тук не трябва)
  const decisionC = queue.handleIncoming(makeEvent({ friendshipId: 'C', messageId: 'c1', fromDisplayName: 'Цветан' }))
  assertEqual(decisionC.action, 'queue', '3. C трябва да отиде в опашката, БЕЗ да измества B')

  // 4. D → queue
  const decisionD = queue.handleIncoming(makeEvent({ friendshipId: 'D', messageId: 'd1', fromDisplayName: 'Диана' }))
  assertEqual(decisionD.action, 'queue', '4. D трябва да отиде в опашката, БЕЗ да измества B или C')

  const stateAfterAllQueued = queue.getState()
  assertEqual(stateAfterAllQueued.pendingFriendshipIds.length, 3, 'опашката трябва да съдържа точно 3 записа (B, C, D)')
  assertEqual(stateAfterAllQueued.pendingFriendshipIds[0], 'B', 'B трябва да е първи в FIFO реда')
  assertEqual(stateAfterAllQueued.pendingFriendshipIds[1], 'C', 'C трябва да е втори в FIFO реда')
  assertEqual(stateAfterAllQueued.pendingFriendshipIds[2], 'D', 'D трябва да е трети в FIFO реда — не изгубен')

  // 5. след затваряне на A се показва B (точно този — 8. никой не е изгубен)
  const afterA = queue.handleDismissed()
  assertEqual(afterA.action, 'show', '5. след A трябва да покаже следващия')
  assert(afterA.action === 'show' && afterA.friendshipId === 'B', '5. точно B трябва да е следващият показан (FIFO ред), не C или D')

  // 6. после C
  const afterB = queue.handleDismissed()
  assertEqual(afterB.action, 'show', '6. след B трябва да покаже следващия')
  assert(afterB.action === 'show' && afterB.friendshipId === 'C', '6. точно C трябва да е следващият показан')

  // 7. после D
  const afterC = queue.handleDismissed()
  assertEqual(afterC.action, 'show', '7. след C трябва да покаже следващия')
  assert(afterC.action === 'show' && afterC.friendshipId === 'D', '7. точно D трябва да е последният показан — никой не е изгубен')

  // след D опашката е празна
  const afterD = queue.handleDismissed()
  assertEqual(afterD.action, 'skip', 'опашката е изчерпана — няма повече изпращачи за показване')

  const finalState = queue.getState()
  assertEqual(finalState.activeFriendshipId, null, 'няма активен popup накрая')
  assertEqual(finalState.pendingFriendshipIds.length, 0, 'опашката е напълно изпразнена')
})

// [11d] 9. звукът (симулиран чрез 'show' decision) би се стартирал точно
// веднъж за всеки от A/B/C/D — точно при реалното им показване, не при опашването.
await check('[11d] Точно 4 "show" decisions за 4 изпращача — звук веднъж на всеки, не при queue', () => {
  const queue = createChatNotificationQueue()
  const showEvents: string[] = []

  function processAndTrack(friendshipId: string, messageId: string): void {
    const decision = queue.handleIncoming(makeEvent({ friendshipId, messageId, fromDisplayName: friendshipId }))
    if (decision.action === 'show') showEvents.push(decision.friendshipId)
  }

  processAndTrack('A', 'a1')
  processAndTrack('B', 'b1')
  processAndTrack('C', 'c1')
  processAndTrack('D', 'd1')

  assertEqual(showEvents.length, 1, 'само A предизвиква show синхронно при handleIncoming (B/C/D са queue)')
  assertEqual(showEvents[0], 'A', 'единственият синхронен show е за A')

  // Симулира дисмиса на активния popup и проверява, че всеки следващ show
  // идва точно веднъж, в правилния ред — B, после C, после D.
  showEvents.length = 0
  for (let i = 0; i < 3; i++) {
    const decision = queue.handleDismissed()
    if (decision.action === 'show') showEvents.push(decision.friendshipId)
  }
  assertEqual(showEvents.length, 3, 'точно 3 допълнителни show decisions — по едно за B, C, D')
  assertEqual(showEvents.join(','), 'B,C,D', 'редът на показване е точно FIFO: B, после C, после D')
})

// [12] Повторно събитие със същия messageId → без втори popup/звук
await check('[12] Дублирано WS събитие (същия messageId) → втори skip', () => {
  const queue = createChatNotificationQueue()
  const first = queue.handleIncoming(makeEvent({ messageId: 'dup-1' }))
  assertEqual(first.action, 'show', 'първа доставка показва')

  const redelivered = queue.handleIncoming(makeEvent({ messageId: 'dup-1' }))
  assertEqual(redelivered.action, 'skip', 'повторна доставка на СЪЩОТО messageId никога не показва отново')
})

// [13] Refresh с вече непрочетени разговори → без стар popup при зареждане
await check('[13] Зареждане на съществуващи unread разговори (без chat_message_received събитие) не викa show', () => {
  // Самата queue логика реагира само на handleIncoming/handleDismissed/markRead
  // — зареждането на conversations списъка (REST GET) никога не минава през
  // тези методи, значи структурно не може да породи "стар" popup при refresh.
  const src = notifSrc
  assert(
    !src.includes('loadChatConversations') && !src.includes('setChatConversations'),
    'chatMessageNotification.ts не трябва да реагира на списъка разговори — само на WS handleIncoming събития',
  )
})

// [14] Остаряло известие в опашката се пропуска, ако разговорът вече е прочетен
await check('[14] Pending известие, чийто разговор е прочетен междувременно (markRead) → пропуска се при handleDismissed', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ friendshipId: 'friend-a', messageId: 'a1' }))
  queue.handleIncoming(makeEvent({ friendshipId: 'friend-b', messageId: 'b1' })) // отива в опашката

  // Потребителят отваря и прочита friend-b, докато friend-a все още е активен на екрана.
  queue.markRead('friend-b')

  const afterDismiss = queue.handleDismissed()
  assertEqual(afterDismiss.action, 'skip', 'остарялото известие за вече прочетения friend-b се пропуска')

  const state = queue.getState()
  assertEqual(state.activeFriendshipId, null, 'няма нов активен popup')
  assertEqual(state.pendingFriendshipIds.length, 0, 'опашката е изпразнена')
})

await check('[14b] Остарял запис в средата на опашката се премахва, а следващият валиден се показва (не се губи цялата опашка)', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ friendshipId: 'A', messageId: 'a1' })) // активен
  queue.handleIncoming(makeEvent({ friendshipId: 'B', messageId: 'b1' })) // опашка[0]
  queue.handleIncoming(makeEvent({ friendshipId: 'C', messageId: 'c1' })) // опашка[1]

  // B е прочетен междувременно (докато A е още активен) — трябва да отпадне
  // САМО той, C да остане и да бъде показан следващ.
  queue.markRead('B')

  const afterA = queue.handleDismissed()
  assertEqual(afterA.action, 'show', 'след A трябва да покаже следващия валиден запис')
  assert(afterA.action === 'show' && afterA.friendshipId === 'C', 'B е пропуснат (прочетен), но C НЕ е загубен — показва се')
})

// ─── Edge case: markRead() на ТОЧНО активния (в момента показан) popup ──────
//
// Сценарий: Иван изпраща първо непрочетено съобщение → popup активен, 6s
// таймер тече. Потребителят отваря разговора с Иван директно от чат списъка
// (не чрез "Виж" бутона) → сървърно markRead успява → queue.markRead('Иван')
// трябва: (1) да разпознае, че точно АКТИВНИЯТ popup е за Иван, (2) да го
// инвалидира веднага, (3) следващият валиден от опашката (ако има) да поеме.
// Ако после Иван прати НОВО съобщение, то трябва да се третира като нова
// поредица (shouldNotify=true отново) и да покаже нов popup/звук.

await check('[23] markRead на АКТИВНИЯ изпращач връща wasActive:true и премахва активното известие', () => {
  const queue = createChatNotificationQueue()
  const decision = queue.handleIncoming(makeEvent({ friendshipId: 'ivan', messageId: 'i1', fromDisplayName: 'Иван' }))
  assertEqual(decision.action, 'show', 'първото съобщение от Иван показва popup')
  assertEqual(queue.getState().activeFriendshipId, 'ivan', 'Иван е активният преди markRead')

  const result = queue.markRead('ivan')
  assertEqual(result.wasActive, true, 'markRead трябва да разпознае, че Иван е бил точно активният popup')
  if (result.wasActive) {
    assertEqual(result.next, null, 'опашката е празна — няма следващ за показване')
  }
  assertEqual(queue.getState().activeFriendshipId, null, 'активният слот трябва да е освободен веднага след markRead')
})

await check('[24] Стар auto-hide/fade таймер не може да затвори следващ popup (generation guard в UI слоя)', () => {
  // Тук доказваме структурно самия generation token механизъм в
  // chatMessageNotification.ts, който предпазва точно този race: markRead()
  // на активния инкрементира renderGeneration ПРЕДИ да презентира следващия,
  // а fadeOutAndClear() capture-ва поколението в момента на стартиране и
  // проверява дали то все още е текущото, преди да изпълни afterFade.
  assert(/let renderGeneration = 0/.test(notifSrc), 'трябва да съществува renderGeneration брояч')
  assert(/function fadeOutAndClear\(generation: number, afterFade: \(\) => void\)/.test(notifSrc), 'fadeOutAndClear трябва да приема generation параметър')
  assert(/if \(generation !== renderGeneration\) return/.test(notifSrc), 'закъснял fade callback трябва да провери поколението преди да пипа state')
  assert(/function forceClearActive\(\): void \{\s*\n\s*renderGeneration \+= 1/.test(notifSrc), 'forceClearActive трябва да инкрементира renderGeneration, обезсилвайки pending fade callbacks')
  assert(/function presentAndSchedule\(notif: ChatMessageNotif\): void \{\s*\n\s*renderGeneration \+= 1/.test(notifSrc), 'presentAndSchedule (нов show) също трябва да инкрементира renderGeneration')
})

await check('[25] След markRead на активния, ново shouldNotify=true съобщение от същия човек отново дава show', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ friendshipId: 'ivan', messageId: 'i1', fromDisplayName: 'Иван' }))
  queue.markRead('ivan')

  // Иван напуска разговора, после Иван изпраща ново съобщение — сървърът
  // вече би преценил това като първо от НОВА непрочетена поредица.
  const decision = queue.handleIncoming(makeEvent({ friendshipId: 'ivan', messageId: 'i2', fromDisplayName: 'Иван', shouldNotify: true }))
  assertEqual(decision.action, 'show', 'ново първо непрочетено съобщение от Иван след markRead отново трябва да покаже popup')
})

await check('[26] Ако B и C са в опашката, markRead на активния A продължава коректно с B, после C', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ friendshipId: 'A', messageId: 'a1' })) // активен
  queue.handleIncoming(makeEvent({ friendshipId: 'B', messageId: 'b1' })) // опашка[0]
  queue.handleIncoming(makeEvent({ friendshipId: 'C', messageId: 'c1' })) // опашка[1]

  const result = queue.markRead('A')
  assertEqual(result.wasActive, true, 'A е бил активният')
  if (result.wasActive) {
    assert(result.next !== null && result.next.friendshipId === 'B', 'markRead на активния A трябва веднага да предложи B (следващия в FIFO реда)')
  }
  assertEqual(queue.getState().activeFriendshipId, 'B', 'B трябва да стане новият активен')

  const afterB = queue.handleDismissed()
  assertEqual(afterB.action, 'show', 'след B трябва да покаже C')
  assert(afterB.action === 'show' && afterB.friendshipId === 'C', 'C трябва да е следващият показан след B — редът е запазен')
})

await check('[27] markRead на ЧАКАЩ (не активен) изпращач премахва само него, без да наруши реда на останалите', () => {
  const queue = createChatNotificationQueue()
  queue.handleIncoming(makeEvent({ friendshipId: 'A', messageId: 'a1' })) // активен
  queue.handleIncoming(makeEvent({ friendshipId: 'B', messageId: 'b1' })) // опашка[0]
  queue.handleIncoming(makeEvent({ friendshipId: 'C', messageId: 'c1' })) // опашка[1]
  queue.handleIncoming(makeEvent({ friendshipId: 'D', messageId: 'd1' })) // опашка[2]

  const result = queue.markRead('B') // B е само чакащ, НЕ активен
  assertEqual(result.wasActive, false, 'B е бил чакащ, не активен — wasActive трябва да е false')

  const state = queue.getState()
  assertEqual(state.activeFriendshipId, 'A', 'A остава активен непроменен')
  assertEqual(state.pendingFriendshipIds.join(','), 'C,D', 'B е премахнат, C и D запазват точния си FIFO ред')
})

await check('[28] При server mark-read грешка активният popup и notification state НЕ се нулират преждевременно', () => {
  // Доказва структурно, че markChatConversationRead() в main.ts извиква
  // chatMessageNotification.markRead единствено СЛЕД потвърден успешен
  // сървърен отговор — при грешка queue-то (и оттам активния popup) остава
  // напълно непроменено, защото markRead изобщо не се извиква.
  const fn = extractFunctionBody(mainSrc, 'async function markChatConversationRead(friendshipId: string): Promise<boolean> {', 'markChatConversationRead')
  const failBlock = extractBlock(fn, 'if (!response.ok) {', '!response.ok block', '\n    }')
  assert(!failBlock.includes('chatMessageNotification.markRead'), 'при неуспешен сървърен отговор chatMessageNotification.markRead НЕ трябва да се извиква — активният popup/queue остава непроменен')
  assert(fn.includes('} catch {') && !extractBlock(fn, '} catch {', 'catch block', '\n  }').includes('chatMessageNotification.markRead'), 'network грешка (catch) също не трябва да пипа notification state')
})

// ─── Bounded dedup memory (seenMessageIds не расте безкрайно) ───────────────

await check('[dedup-bounded] Стари messageId записи се изчистват след лимита (500), скорошен дубликат продължава да се пропуска', () => {
  const queue = createChatNotificationQueue()

  // Запълва over капацитета от 500 с уникални messageId-та от РАЗЛИЧНИ
  // friendshipId-та (за да не се сблъскаме с notifiedFriendshipIds guard-а —
  // тестваме единствено bounded dedup паметта, не unread state-a).
  for (let i = 0; i < 520; i++) {
    queue.handleIncoming({
      friendshipId: `bulk-${i}`,
      messageId: `bulk-msg-${i}`,
      fromDisplayName: `User ${i}`,
      shouldNotify: false, //ShouldNotify=false → веднага skip, но messageId се маркира seen преди тази проверка
    })
  }

  // Най-старият messageId (bulk-msg-0) трябва да е бил изхвърлен от
  // ограничената памет (лимит 500, добавени 520 → първите 20 изхвърлени).
  // Затова повторна доставка на bulk-msg-0 сега се третира като "невиждана"
  // отново — но shouldNotify пак ще е false тук, значи резултатът пак е skip
  // (коректно, но по РАЗЛИЧНА причина от dedup-а). За да докажем директно
  // "скорошен дубликат продължава да се пропуска", проверяваме скорошен
  // messageId (в рамките на лимита), не най-стария.
  const recentDuplicate = queue.handleIncoming({
    friendshipId: 'bulk-519',
    messageId: 'bulk-msg-519',
    fromDisplayName: 'User 519',
    shouldNotify: true,
  })
  assertEqual(recentDuplicate.action, 'skip', 'скорошен messageId (все още в bounded паметта) продължава да се пропуска при повторна доставка')
})

await check('[dedup-bounded-2] createBoundedIdSet структурата съществува и лимитът е 500', () => {
  assert(/const SEEN_MESSAGE_IDS_LIMIT = 500/.test(queueSrc), 'лимитът на bounded dedup паметта трябва да е 500')
  assert(/function createBoundedIdSet/.test(queueSrc), 'трябва да съществува ограничена по размер структура createBoundedIdSet')
  assert(/while \(order\.length > limit\) \{/.test(queueSrc), 'структурата трябва да изхвърля най-старите записи при препълване')
})

// [15] Собствени съобщения не показват известие
await check('[15] main.ts проверява isOwnMessage преди да подаде на handleIncoming', () => {
  const block = extractBlock(mainSrc, `if (message.type === 'chat_message_received') {`, 'chat_message_received handler', "\n      return\n    }")
  assert(
    /const isOwnMessage = currentAuthSession !== null\s*\n\s*&& message\.senderProfileId === currentAuthSession\.profile\.profileId/.test(block),
    'isOwnMessage сравнение с текущата сесия',
  )
  assert(/if \(!isOwnMessage && !alreadyOpen\) \{/.test(block), 'handleIncoming се вика само когато !isOwnMessage')
})

// ─── Server mark-read при вече отворен разговор (проблем 2) ─────────────────

await check('[16] alreadyOpen случаят вика СЪРВЪРНИЯ markChatConversationRead, не само локален markRead', () => {
  const block = extractBlock(mainSrc, `if (message.type === 'chat_message_received') {`, 'chat_message_received handler', "\n      return\n    }")
  const alreadyOpenBlock = extractBlock(block, 'if (alreadyOpen) {', 'alreadyOpen block', '\n      }')
  assert(
    alreadyOpenBlock.includes('markChatConversationRead(message.friendshipId)'),
    'при alreadyOpen трябва да се извика markChatConversationRead (сървър + локален reset), не само chatMessageNotification.markRead директно',
  )
  assert(
    !alreadyOpenBlock.includes('chatMessageNotification.markRead(message.friendshipId)'),
    'не трябва да вика chatMessageNotification.markRead директно тук — само чрез markChatConversationRead, за да гарантира сървърна консистентност',
  )
})

await check('[17] markChatConversationRead прави POST /api/chat/:id/read (реюз на съществуващия endpoint, без паралелна read система)', () => {
  const fn = extractFunctionBody(mainSrc, 'async function markChatConversationRead(friendshipId: string): Promise<boolean> {', 'markChatConversationRead')
  assert(fn.includes('/api/chat/${encodeURIComponent(friendshipId)}/read'), 'трябва да вика съществуващия /api/chat/:id/read endpoint')
  assert(fn.includes(`method: 'POST'`), 'трябва да е POST заявка, консистентна със съществуващия onChatMarkRead')
})

// ─── Ред на операциите: сървър first, local reset само при успех (проблем 3) ─

await check('[18] markChatConversationRead: локалният queue reset е СЛЕД успешен сървърен отговор, не преди', () => {
  const fn = extractFunctionBody(mainSrc, 'async function markChatConversationRead(friendshipId: string): Promise<boolean> {', 'markChatConversationRead')
  const responseCheckIdx = fn.indexOf('if (!response.ok)')
  const localResetIdx = fn.indexOf('chatMessageNotification.markRead(friendshipId)')
  assert(responseCheckIdx !== -1, 'трябва да провери response.ok')
  assert(localResetIdx !== -1, 'трябва да извика chatMessageNotification.markRead')
  assert(responseCheckIdx < localResetIdx, 'проверката на сървърния отговор трябва да предхожда локалния queue reset')
})

await check('[19] markChatConversationRead връща false при неуспешен сървърен отговор БЕЗ да пипа локалния queue', () => {
  const fn = extractFunctionBody(mainSrc, 'async function markChatConversationRead(friendshipId: string): Promise<boolean> {', 'markChatConversationRead')
  const failBlock = extractBlock(fn, 'if (!response.ok) {', '!response.ok block', '\n    }')
  assert(!failBlock.includes('chatMessageNotification.markRead'), 'при неуспешен отговор НЕ трябва да reset-ва локалния queue — иначе клиент/сървър разминаване')
  assert(failBlock.includes('return false'), 'трябва да върне false при неуспех')
  assert(fn.includes('} catch {') && fn.includes('return false'), 'network грешка (catch) също трябва да върне false без локален reset')
})

await check('[20] onChatMarkRead reuse-ва markChatConversationRead (не дублира fetch логика)', () => {
  const fn = extractBlock(mainSrc, 'onChatMarkRead: async (friendshipId) => {', 'onChatMarkRead', '\n  },')
  assert(fn.includes('markChatConversationRead(friendshipId)'), 'onChatMarkRead трябва да reuse-ва markChatConversationRead')
  assert(!fn.includes('fetch('), 'onChatMarkRead не трябва да дублира собствена fetch заявка')
})

// ─── Chat refresh/unread flow не е прекъснат (проблем 4) ────────────────────

await check('[21] lobby.handleServerMessage(message) продължава да се вика безусловно за chat_message_received (не е заменен от popup логиката)', () => {
  const block = extractBlock(mainSrc, `if (message.type === 'chat_message_received') {`, 'chat_message_received handler', "\n      return\n    }")
  assert(
    /if \(!isInGameNow\) \{\s*\n\s*lobby\.handleServerMessage\(message\)/.test(block),
    'lobby.handleServerMessage(message) трябва да се вика когато !isInGameNow, независимо от popup решението по-горе',
  )
  // Извикването НЕ трябва да е вътре в условие, зависещо от isOwnMessage
  // или alreadyOpen — то е отделен, безусловен (спрямо тях) блок.
  const handleServerMsgIdx = block.indexOf('lobby.handleServerMessage(message)')
  const popupBlockEndIdx = block.indexOf('if (alreadyOpen) {')
  assert(handleServerMsgIdx > popupBlockEndIdx, 'lobby.handleServerMessage трябва да се извиква след/независимо от popup-специфичната логика, не вместо нея')
})

await check('[22] createLobbyFlowController.handleServerMessage реално обработва chat_message_received (unread badge + refresh)', () => {
  assert(
    controllerSrc.includes(`if (message.type === 'chat_message_received') {`),
    'createLobbyFlowController.ts трябва да съдържа собствен handler за chat_message_received (unread badge/refresh flow)',
  )
  const fn = extractBlock(controllerSrc, `if (message.type === 'chat_message_received') {`, 'controller chat_message_received handler', '\n      return true')
  assert(fn.includes('unreadCount'), 'handler-ът трябва да обновява unreadCount (badge за други разговори)')
  assert(fn.includes('refreshChatAfterNotification') || fn.includes('render()'), 'handler-ът трябва да презарежда/рендира актуалното състояние на чата')
})

// ─── B) Source-text проверки: бутони, wiring, звук, сървър ──────────────────

await check('[B1] Извън игра рендира бутон "Виж" (chat-notif-view-btn)', () => {
  assert(notifSrc.includes('id="chat-notif-view-btn"') && notifSrc.includes('>Виж</button>'), '"Виж" бутон трябва да съществува')
  assert(/const viewButtonHtml = inGame\s*\n\s*\? ''\s*\n\s*: `<button id="chat-notif-view-btn"/.test(notifSrc), 'viewButtonHtml е условен на inGame')
})

await check('[B2] Затвори бутонът присъства безусловно (не зависи от inGame)', () => {
  const closeBtnCount = (notifSrc.match(/id="chat-notif-close-btn"/g) ?? []).length
  assertEqual(closeBtnCount, 1, 'точно 1 дефиниция на chat-notif-close-btn')
})

await check('[B3] AUTO_DISMISS_MS === 6_000', () => {
  assert(/const AUTO_DISMISS_MS = 6_000/.test(notifSrc), 'AUTO_DISMISS_MS трябва да е 6000ms')
  assert(/dismissTimer = setTimeout\(dismiss, AUTO_DISMISS_MS\)/.test(notifSrc), 'auto-hide таймер трябва да ползва AUTO_DISMISS_MS')
})

await check('[B4] isInGame идва от activeRoom.hasActiveRoom()', () => {
  const wiring = extractBlock(mainSrc, 'const chatMessageNotification = createChatMessageNotification({', '})')
  assert(wiring.includes('isInGame: () => activeRoom.hasActiveRoom()'), 'isInGame трябва да делегира на activeRoom.hasActiveRoom()')
})

await check('[B5] Звукът реюзва СЪЩИЯ audio helper pattern като profileLike/friendRequest (player-seat-fill.mp3, volume 0.6)', () => {
  assert(notifSrc.includes(`new Audio('/audio/ui/player-seat-fill.mp3')`), 'трябва да ползва same аудио файл /audio/ui/player-seat-fill.mp3')
  assert(/audio\.volume = 0\.6/.test(notifSrc), 'volume трябва да е 0.6, консистентно с останалите известия')
  assert(/void audio\.play\(\)\.catch\(\(\) => \{/.test(notifSrc), 'play() трябва да catch-ва autoplay policy грешки, аналогично на profileLikeNotification/friendRequestNotification')
})

await check('[B6] playSound() се вика само от presentAndSchedule (реален show), не от handleIncoming директно за queue/skip', () => {
  const presentFn = extractFunctionBody(notifSrc, 'function presentAndSchedule(notif: ChatMessageNotif): void {', 'presentAndSchedule')
  assert(presentFn.includes('playSound()'), 'presentAndSchedule трябва да пусне звука')

  const handleIncomingFn = extractFunctionBody(notifSrc, 'function handleIncoming(event: ChatNotificationEvent): void {', 'handleIncoming')
  assert(!handleIncomingFn.includes('playSound()'), 'handleIncoming не трябва пряко да вика playSound — само чрез presentAndSchedule при decision===show')
})

await check('[B7] Известието не се показва два пъти при клик на "Виж"/"Затвори" — dismiss() се вика преди action callback', () => {
  const viewHandlerBlock = extractBlock(
    notifSrc,
    `options.container.querySelector('#chat-notif-view-btn')?.addEventListener('click', () => {`,
    'view click handler',
    '\n    })',
  )
  const dismissIdx = viewHandlerBlock.indexOf('dismiss()')
  const onViewIdx = viewHandlerBlock.indexOf('options.onView(friendshipId)')
  assert(dismissIdx !== -1 && onViewIdx !== -1 && dismissIdx < onViewIdx, 'dismiss() трябва да предхожда onView(), за да няма двойно known известие')
})

await check('[B8] Сървърът изчислява shouldNotify ПРЕДИ insert-а на новото съобщение (snapshot на unread преди sendMessage)', () => {
  const block = extractBlock(serverSrc, `if (messagesMatch !== null && req.method === 'POST') {`, 'chat POST handler', '\n  }')
  assert(block.includes('chatStore.isFirstUnreadMessage(recipientProfileIdBeforeSend, friendshipId)'), 'shouldNotify трябва да идва от isFirstUnreadMessage, изчислена преди sendMessage')
  const shouldNotifyIdx = block.indexOf('const shouldNotify')
  const sendMessageIdx = block.indexOf('chatStore.sendMessage(')
  assert(shouldNotifyIdx !== -1 && sendMessageIdx !== -1 && shouldNotifyIdx < sendMessageIdx, 'shouldNotify трябва да се изчисли ПРЕДИ chatStore.sendMessage (иначе винаги ще намери поне новото съобщение)')
})

await check('[B9] chatStore.isFirstUnreadMessage проверява unread count === 0 (getUnreadCount reuse, без нова заявка)', () => {
  const fn = extractFunctionBody(chatStoreSrc, 'function isFirstUnreadMessage(recipientProfileId: ProfileId, friendshipId: string): boolean {', 'isFirstUnreadMessage')
  assert(fn.includes('getUnreadCount(recipientProfileId, friendshipId) === 0'), 'isFirstUnreadMessage трябва да реюзва getUnreadCount')
})

await check('[B10] messageId се разпространява от sendMessage резултата до WS payload-а (стабилен dedup key)', () => {
  const block = extractBlock(serverSrc, `if (messagesMatch !== null && req.method === 'POST') {`, 'chat POST handler', '\n  }')
  assert(block.includes('result.messages[result.messages.length - 1]?.messageId'), 'newMessageId трябва да идва от последното съобщение в резултата')
  assert(block.includes('messageId: newMessageId'), 'sendChatNotificationToProfile трябва да получи messageId')

  const fn = extractFunctionBody(serverSrc, 'function sendChatNotificationToProfile(input: {', 'sendChatNotificationToProfile')
  assert(fn.includes('messageId: input.messageId') || serverSrc.includes('messageId: input.messageId'), 'WS payload трябва да съдържа messageId')
})

await check('[B11] ChatMessageReceivedMessage типът съдържа messageId и shouldNotify', () => {
  assert(
    /export type ChatMessageReceivedMessage = \{[\s\S]*?messageId: string[\s\S]*?shouldNotify: boolean[\s\S]*?\}/.test(clientSrc),
    'типът трябва да съдържа messageId: string и shouldNotify: boolean',
  )
})

await check('[B12] main.ts подава messageId/shouldNotify от съобщението директно към handleIncoming (не измислени стойности)', () => {
  const block = extractBlock(mainSrc, `if (message.type === 'chat_message_received') {`, 'chat_message_received handler', "\n      return\n    }")
  assert(block.includes('messageId: message.messageId'), 'messageId трябва да идва директно от WS съобщението')
  assert(block.includes('shouldNotify: message.shouldNotify'), 'shouldNotify трябва да идва директно от WS съобщението')
})

await check('[B13] openChatWithFriend и onChatMarkRead в крайна сметка водят до chatMessageNotification.markRead (чрез markChatConversationRead)', () => {
  const markReadWiring = extractBlock(mainSrc, 'onChatMarkRead: async (friendshipId) => {', 'onChatMarkRead', '\n  },')
  assert(markReadWiring.includes('markChatConversationRead(friendshipId)'), 'onChatMarkRead трябва да вика markChatConversationRead')

  const markChatConvFn = extractFunctionBody(mainSrc, 'async function markChatConversationRead(friendshipId: string): Promise<boolean> {', 'markChatConversationRead')
  assert(markChatConvFn.includes('chatMessageNotification.markRead(friendshipId)'), 'markChatConversationRead трябва в крайна сметка да reset-не локалната queue при успех')

  const openFn = extractBlock(controllerSrc, 'openChatWithFriend: (friendshipId: string) => {', 'openChatWithFriend', '\n    },')
  assert(openFn.includes('options.onChatMarkRead?.(friendshipId)'), 'openChatWithFriend трябва да reuse-ва onChatMarkRead (същия сървър+локален flow)')
})

await check('[B14] Popup не блокира игровото управление (компактен банер, не full-screen)', () => {
  assert(notifSrc.includes('pointer-events:auto'), 'банерът трябва изрично pointer-events:auto (малък fixed div)')
  assert(!notifSrc.includes('width:100vw') && !notifSrc.includes('height:100vh'), 'банерът не трябва да заема цял екран')
})

await check('[B15] Позициониране отчита mobile safe-area (notch)', () => {
  assert(notifSrc.includes('env(safe-area-inset-top, 0px)'), 'top позиционирането трябва да добавя safe-area отстъп')
})

// ─── C) РЕАЛНО поведение на pendingChatRefreshTracker (не regex) ────────────
//
// Regression покритие за: чат съобщение по време на игра → popup се показва,
// но unread conversation state остава остарял (chat GET би 403-нал) → трябва
// маркер, който устоява до успешен refresh на следващ сигурен lifecycle
// момент (връщане в лоби / PWA resume), без дублирани заявки и без tight loop.
//
// Реален production сценарий, довел до тази поправка: получателят получава
// popup коректно (сървърна routing логика вече потвърдена в отделни runtime
// тестове), но дори СЛЕД напускане на масата сървърът продължава да брои
// профила като "в активна игра" известно време (bot takeover довършва
// оставащия мач вместо напусналия играч, без да го маркира като бот
// участник — виж server/src/game/abandonHumanControlForRoom.ts), затова
// първите опити за refresh реално получават 403. Тестовете тук доказват, че
// tracker-ът устоява на точно такива неуспехи, вместо да се предаде.

console.log('\n=== C) pendingChatRefreshTracker — реално поведение ===\n')

await check('[C1] Без markPendingChatRefresh() → attempt() е "skipped", performRefresh НЕ се вика', async () => {
  resetPendingChatRefreshTrackerForTests()
  let calls = 0
  const result = await attemptPendingChatRefresh(true, async () => { calls++; return true })
  assert(result === 'skipped', `очаквано 'skipped', получено '${result}'`)
  assert(calls === 0, `performRefresh не трябва да се вика, извикан е ${calls} пъти`)
})

await check('[C2] markPendingChatRefresh() + canAttemptNow=false → "blocked", performRefresh НЕ се вика (все още локално сме в игра)', async () => {
  resetPendingChatRefreshTrackerForTests()
  markPendingChatRefresh()
  let calls = 0
  const result = await attemptPendingChatRefresh(false, async () => { calls++; return true })
  assert(result === 'blocked', `очаквано 'blocked', получено '${result}'`)
  assert(calls === 0, 'performRefresh не трябва да се вика докато canAttemptNow=false')
  assert(isChatRefreshPending(), 'маркерът трябва да остане pending')
})

await check('[C3] markPendingChatRefresh() + canAttemptNow=true, но refresh се проваля (симулира 403) → "failed", маркерът устоява', async () => {
  resetPendingChatRefreshTrackerForTests()
  markPendingChatRefresh()
  const result = await attemptPendingChatRefresh(true, async () => false)
  assert(result === 'failed', `очаквано 'failed', получено '${result}'`)
  assert(isChatRefreshPending(), 'маркерът НЕ трябва да се изчисти при неуспешен refresh — точно това е production бъгът, който поправяме')
})

await check('[C4] След неуспешен опит, следващ опит с успешен refresh → "succeeded", маркерът се изчиства', async () => {
  resetPendingChatRefreshTrackerForTests()
  markPendingChatRefresh()
  const failedResult = await attemptPendingChatRefresh(true, async () => false)
  assert(failedResult === 'failed', 'първият опит трябва да е неуспешен (симулация на все още активен isProfileInActiveGame гейт)')
  assert(isChatRefreshPending(), 'маркерът остава pending след неуспеха')

  const successResult = await attemptPendingChatRefresh(true, async () => {
    clearPendingChatRefresh() // симулира syncLobbyChatConversations() при success
    return true
  })
  assert(successResult === 'succeeded', `очаквано 'succeeded', получено '${successResult}'`)
  assert(!isChatRefreshPending(), 'маркерът трябва да е изчистен след успешния refresh')
})

await check('[C5] Няколко съобщения (няколко markPendingChatRefresh извиквания) → само ЕДИН успешен опит е достатъчен, без дублирани заявки', async () => {
  resetPendingChatRefreshTrackerForTests()
  markPendingChatRefresh() // съобщение 1
  markPendingChatRefresh() // съобщение 2 (все още в същата игра)
  markPendingChatRefresh() // съобщение 3

  let refreshCalls = 0
  const result = await attemptPendingChatRefresh(true, async () => {
    refreshCalls++
    clearPendingChatRefresh()
    return true
  })

  assert(result === 'succeeded', 'опитът трябва да успее')
  assert(refreshCalls === 1, `performRefresh трябва да се извика точно 1 път за целия "burst" от съобщения, извикан е ${refreshCalls} пъти`)
  assert(!isChatRefreshPending(), 'маркерът трябва да е изчистен')
})

await check('[C6] Конкурентен опит докато друг вече тече (in-flight) → "skipped", performRefresh НЕ се извиква повторно (no duplicate GET)', async () => {
  resetPendingChatRefreshTrackerForTests()
  markPendingChatRefresh()

  let refreshCalls = 0
  let resolveFirst: (value: boolean) => void = () => {}
  const firstRefreshPromise = new Promise<boolean>((resolve) => { resolveFirst = resolve })

  const firstAttempt = attemptPendingChatRefresh(true, async () => {
    refreshCalls++
    return firstRefreshPromise // виси, докато не resolve-нем ръчно
  })

  // Втори опит, докато първият все още "тече" (in-flight guard)
  const secondResult = await attemptPendingChatRefresh(true, async () => {
    refreshCalls++
    return true
  })
  assert(secondResult === 'skipped', `конкурентен опит трябва да е 'skipped', получено '${secondResult}'`)
  assert(refreshCalls === 1, `performRefresh трябва да се е извикал само 1 път дотук (от първия опит), извикан е ${refreshCalls} пъти`)

  resolveFirst(true)
  const firstResult = await firstAttempt
  assert(firstResult === 'failed' || firstResult === 'succeeded', 'първият опит трябва в крайна сметка да завърши')
  assert(refreshCalls === 1, `performRefresh трябва да се е извикал общо само 1 път, извикан е ${refreshCalls} пъти`)
})

await check('[C7] Многократни неуспешни опити не хвърлят грешка и не увисват — всеки resolve-ва бързо (без tight retry loop)', async () => {
  resetPendingChatRefreshTrackerForTests()
  markPendingChatRefresh()

  for (let i = 0; i < 5; i++) {
    const start = Date.now()
    const result = await attemptPendingChatRefresh(true, async () => false)
    const elapsedMs = Date.now() - start
    assert(result === 'failed', `опит ${i + 1} трябва да е 'failed'`)
    assert(elapsedMs < 1000, `опит ${i + 1} не трябва да виси — отне ${elapsedMs}ms`)
  }
  assert(isChatRefreshPending(), 'маркерът остава pending след серия неуспешни опити — не се отказва завинаги')
})

resetPendingChatRefreshTrackerForTests()

// ─── D) Wiring source checks — main.ts свързва tracker-а на правилните lifecycle точки ──

console.log('\n=== D) main.ts wiring на pendingChatRefreshTracker ===\n')

await check('[D1] chat_message_received: markPendingChatRefresh() се вика САМО в клона за "все още в игра" (не при !isInGameNow)', () => {
  const block = extractBlock(mainSrc, `if (message.type === 'chat_message_received') {`, 'chat_message_received handler', "\n      return\n    }")
  assert(
    /if \(!isInGameNow\) \{\s*\n\s*lobby\.handleServerMessage\(message\)\s*\n\s*\} else if \(!isOwnMessage\) \{\s*\n[\s\S]*?markPendingChatRefresh\(\)/.test(block),
    'markPendingChatRefresh() трябва да се вика в else-клона (isInGameNow && !isOwnMessage), не безусловно',
  )
})

await check('[D2] showLobby callback вика attemptPendingChatRefresh (връщане в лоби — leave/resume-failed/match-ended пътища)', () => {
  const wiring = extractBlock(mainSrc, 'showLobby: (errorText = null) => {', 'showLobby wiring', '\n  },')
  assert(wiring.includes('void attemptPendingChatRefresh()'), 'showLobby трябва да опита pending chat refresh при всяко връщане в лоби')
})

await check('[D3] startNewGame callback ("Играй пак" от match-ended, байпасва showLobby) също вика attemptPendingChatRefresh', () => {
  const wiring = extractBlock(mainSrc, 'startNewGame: (stake, displayName) => {', 'startNewGame wiring', '\n  },')
  assert(wiring.includes('void attemptPendingChatRefresh()'), 'startNewGame трябва също да опита refresh, иначе "Играй пак" пътят пропуска синхронизацията')
})

await check('[D4] visibilitychange (PWA resume/tab focus) опитва refresh, когато страницата стане видима', () => {
  const block = extractBlock(mainSrc, `document.addEventListener('visibilitychange', () => {`, 'visibilitychange handler', '\n})')
  assert(/if \(document\.visibilityState === 'visible'\) \{[\s\S]*?void attemptPendingChatRefresh\(\)/.test(block), 'visibilitychange трябва да опита refresh при visible')
})

await check('[D5] pageshow (bfcache restore) опитва refresh', () => {
  const block = extractBlock(mainSrc, `window.addEventListener('pageshow', () => {`, 'pageshow handler', '\n})')
  assert(block.includes('void attemptPendingChatRefresh()'), 'pageshow трябва да опита refresh')
})

await check('[D6] window focus listener съществува и опитва refresh', () => {
  const block = extractBlock(mainSrc, `window.addEventListener('focus', () => {`, 'focus handler', '\n})')
  assert(block.includes('void attemptPendingChatRefresh()'), 'focus трябва да опита refresh')
})

await check('[D7] syncLobbyChatConversations() изчиства маркера САМО в success клона (result.ok), не безусловно', () => {
  const fn = extractFunctionBody(mainSrc, 'async function syncLobbyChatConversations(): Promise<boolean> {', 'syncLobbyChatConversations')
  const successBlock = extractBlock(fn, 'if (result.ok) {', 'success block', '\n    return true\n  }')
  assert(successBlock.includes('clearPendingChatRefresh()'), 'clearPendingChatRefresh() трябва да се вика само след потвърден успешен GET')
})

await check('[D8] Popup dismiss/auto-hide/markRead (chatMessageNotification.ts, chatNotificationQueue.ts) НЕ пипат pendingChatRefreshTracker', () => {
  assert(!notifSrc.includes('PendingChatRefresh'), 'chatMessageNotification.ts не трябва да реферира pendingChatRefreshTracker — dismiss не е mark-read, не е и chat-refresh trigger')
  assert(!queueSrc.includes('PendingChatRefresh'), 'chatNotificationQueue.ts не трябва да реферира pendingChatRefreshTracker')
})

await check('[D9] attemptPendingChatRefresh (main.ts) проверява activeRoom.hasActiveRoom() преди опит — не стреля напразно докато локално знаем, че сме в игра', () => {
  const fn = extractFunctionBody(mainSrc, 'async function attemptPendingChatRefresh(): Promise<void> {', 'attemptPendingChatRefresh (main.ts wrapper)')
  assert(fn.includes('!activeRoom.hasActiveRoom()'), 'canAttemptNow трябва да проверява activeRoom.hasActiveRoom()')
})

await check('[D10] Няма нов polling/interval механизъм — синхронизацията е чисто event-driven (lifecycle hooks), не таймер', () => {
  assert(!trackerSrc.includes('setInterval'), 'pendingChatRefreshTracker.ts не трябва да съдържа setInterval')
  assert(!mainSrc.includes('setInterval(') || !extractBlock(mainSrc, 'async function attemptPendingChatRefresh(): Promise<void> {', 'attemptPendingChatRefresh (main.ts wrapper)', '\n}').includes('setInterval'),
    'attemptPendingChatRefresh не трябва да стартира polling interval')
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
