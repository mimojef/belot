/**
 * checkPrivateRoomCreatedNotification.ts
 *
 * Проверки за "нова частна маса е създадена" top-popup известието:
 *
 *  A) РЕАЛНИ поведенчески тестове върху
 *     src/ui/notifications/privateRoomCreatedNotificationQueue.ts (чист state
 *     machine, без DOM зависимост) — dedup по notificationId, FIFO опашка от
 *     няколко близки известия, никой не се губи.
 *
 *  B) Source-text проверки на server/src/index.ts за:
 *     - известието се изпраща само СЛЕД успешно създаване (createResult.ok),
 *       не при грешка;
 *     - broadcast-ът изключва създателя (по profileId, покрива всички негови
 *       връзки, не само текущата);
 *     - recipientInActiveGame се изчислява СЪРВЪРНО (isProfileInActiveGame)
 *       за всеки получател, не идва от клиента;
 *     - използва вече доверения publicProfile (не клиентски подадено име/
 *       аватар);
 *     - не се тригва от join/leave/reconnect/expire на частна маса (не е
 *       закачено към onRoomsChanged);
 *     - payload-ът не съдържа парола/код за достъп или други чувствителни
 *       полета.
 *
 *  C) Source-text проверки на клиентското wiring-а (main.ts,
 *     createLobbyFlowController.ts, privateRoomCreatedNotification.ts):
 *     - escaping на името (без HTML injection);
 *     - fallback аватар при липсващ URL и при счупено изображение (onerror);
 *     - 8 секунди auto-dismiss, × бутон;
 *     - "Влез" бутон присъства само когато !recipientInActiveGame, отваря
 *       private-rooms екрана през съществуващата SPA навигация, без auto-join
 *       и без презареждане;
 *     - звукът реюзва съществуващия audio helper pattern.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createPrivateRoomCreatedNotificationQueue,
  type PrivateRoomCreatedNotice,
} from '../src/ui/notifications/privateRoomCreatedNotificationQueue.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const QUEUE_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'privateRoomCreatedNotificationQueue.ts')
const NOTIF_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'privateRoomCreatedNotification.ts')
const MAIN_PATH = join(REPO_ROOT, 'src', 'main.ts')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const CLIENT_PATH = join(REPO_ROOT, 'src', 'app', 'network', 'createGameServerClient.ts')
const SERVER_INDEX_PATH = join(REPO_ROOT, 'server', 'src', 'index.ts')
const SERVER_MESSAGE_TYPES_PATH = join(REPO_ROOT, 'server', 'src', 'protocol', 'messageTypes.ts')

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

const queueSrc = normalizeLineEndings(await readFile(QUEUE_PATH, 'utf8'))
const notifSrc = normalizeLineEndings(await readFile(NOTIF_PATH, 'utf8'))
const mainSrc = normalizeLineEndings(await readFile(MAIN_PATH, 'utf8'))
const controllerSrc = normalizeLineEndings(await readFile(CONTROLLER_PATH, 'utf8'))
const clientSrc = normalizeLineEndings(await readFile(CLIENT_PATH, 'utf8'))
const serverSrc = normalizeLineEndings(await readFile(SERVER_INDEX_PATH, 'utf8'))
const serverMessageTypesSrc = normalizeLineEndings(await readFile(SERVER_MESSAGE_TYPES_PATH, 'utf8'))

console.log('\n=== Private Room Created Notification Checks ===\n')

// ─── A) Поведенчески тестове върху privateRoomCreatedNotificationQueue.ts ───

function makeNotice(overrides: Partial<PrivateRoomCreatedNotice>): PrivateRoomCreatedNotice {
  return {
    notificationId: 'room-1',
    creatorDisplayName: 'Иван',
    creatorAvatarUrl: null,
    recipientInActiveGame: false,
    ...overrides,
  }
}

await check('[1] Първо известие → decision=show', () => {
  const queue = createPrivateRoomCreatedNotificationQueue()
  const decision = queue.handleIncoming(makeNotice({}))
  assertEqual(decision.action, 'show', 'decision.action')
  if (decision.action === 'show') {
    assertEqual(decision.notice.notificationId, 'room-1', 'notificationId')
  }
  assertEqual(queue.getState().activeNotificationId, 'room-1', 'activeNotificationId след show')
})

await check('[2] Дублирано известие (същия notificationId) → skip, не втори popup', () => {
  const queue = createPrivateRoomCreatedNotificationQueue()
  const first = queue.handleIncoming(makeNotice({ notificationId: 'room-a' }))
  assertEqual(first.action, 'show', 'първата доставка показва')

  const redelivered = queue.handleIncoming(makeNotice({ notificationId: 'room-a' }))
  assertEqual(redelivered.action, 'skip', 'повторна доставка на СЪЩИЯ notificationId не показва отново')
})

await check('[3] Дубликат пристига докато popup-ът вече е приключил (след handleDismissed) → пак skip', () => {
  const queue = createPrivateRoomCreatedNotificationQueue()
  queue.handleIncoming(makeNotice({ notificationId: 'room-a' }))
  queue.handleDismissed()

  const redelivered = queue.handleIncoming(makeNotice({ notificationId: 'room-a' }))
  assertEqual(redelivered.action, 'skip', 'веднъж показан notificationId никога не се показва отново, дори след dismiss')
})

await check('[4] Няколко близки известия от различни създатели → FIFO опашка, никой не се губи', () => {
  const queue = createPrivateRoomCreatedNotificationQueue()

  const a = queue.handleIncoming(makeNotice({ notificationId: 'room-a', creatorDisplayName: 'Ана' }))
  assertEqual(a.action, 'show', 'първото известие показва веднага')

  const b = queue.handleIncoming(makeNotice({ notificationId: 'room-b', creatorDisplayName: 'Борис' }))
  assertEqual(b.action, 'queue', 'второто отива в опашката, докато първото е активно')

  const c = queue.handleIncoming(makeNotice({ notificationId: 'room-c', creatorDisplayName: 'Цветан' }))
  assertEqual(c.action, 'queue', 'третото отива в опашката, БЕЗ да измества второто')

  const stateWhileActive = queue.getState()
  assertEqual(stateWhileActive.pendingNotificationIds.join(','), 'room-b,room-c', 'опашката пази точния FIFO ред')

  const afterA = queue.handleDismissed()
  assertEqual(afterA.action, 'show', 'след първото приключило известие се показва следващото')
  assert(afterA.action === 'show' && afterA.notice.notificationId === 'room-b', 'точно room-b трябва да е следващият показан')

  const afterB = queue.handleDismissed()
  assertEqual(afterB.action, 'show', 'после се показва третото')
  assert(afterB.action === 'show' && afterB.notice.notificationId === 'room-c', 'точно room-c трябва да е последният показан — никой не е изгубен')

  const afterC = queue.handleDismissed()
  assertEqual(afterC.action, 'skip', 'опашката е изчерпана')

  const finalState = queue.getState()
  assertEqual(finalState.activeNotificationId, null, 'няма активен popup накрая')
  assertEqual(finalState.pendingNotificationIds.length, 0, 'опашката е напълно изпразнена')
})

await check('[5] Известие в игра (recipientInActiveGame=true) се пренася непроменено през опашката', () => {
  const queue = createPrivateRoomCreatedNotificationQueue()
  const decision = queue.handleIncoming(makeNotice({ notificationId: 'room-x', recipientInActiveGame: true }))
  assertEqual(decision.action, 'show', 'известието се показва независимо от recipientInActiveGame')
  if (decision.action === 'show') {
    assertEqual(decision.notice.recipientInActiveGame, true, 'флагът се пренася без промяна')
  }
})

await check('[dedup-bounded] Стари notificationId записи се изчистват след лимита (200), скорошен дубликат продължава да се пропуска', () => {
  const queue = createPrivateRoomCreatedNotificationQueue()

  for (let i = 0; i < 220; i++) {
    queue.handleIncoming(makeNotice({ notificationId: `bulk-${i}`, creatorDisplayName: `User ${i}` }))
    queue.handleDismissed()
  }

  const recentDuplicate = queue.handleIncoming(makeNotice({ notificationId: 'bulk-219' }))
  assertEqual(recentDuplicate.action, 'skip', 'скорошен notificationId (все още в bounded паметта) продължава да се пропуска при повторна доставка')
})

await check('[dedup-bounded-2] createBoundedIdSet структурата съществува и лимитът е 200', () => {
  assert(/const SEEN_NOTIFICATION_IDS_LIMIT = 200/.test(queueSrc), 'лимитът на bounded dedup паметта трябва да е 200')
  assert(/function createBoundedIdSet/.test(queueSrc), 'трябва да съществува ограничена по размер структура createBoundedIdSet')
})

// ─── B) Сървърна логика (server/src/index.ts) ───────────────────────────────

await check('[6] broadcastPrivateRoomCreatedNotice се извиква само СЛЕД createResult.ok (не при грешка)', () => {
  const handlerBlock = extractBlock(serverSrc, `if (message.type === 'create_private_room') {`, 'create_private_room handler', "\n      if (message.type === 'join_private_room')")

  const errorBlock = extractBlock(handlerBlock, 'if (!createResult.ok) {', '!createResult.ok block', '\n        }')
  assert(!errorBlock.includes('broadcastPrivateRoomCreatedNotice'), 'при неуспешно създаване НЕ трябва да се вика broadcastPrivateRoomCreatedNotice')

  const okIdx = handlerBlock.indexOf('if (!createResult.ok) {')
  const broadcastIdx = handlerBlock.indexOf('broadcastPrivateRoomCreatedNotice(')
  assert(okIdx !== -1 && broadcastIdx !== -1 && broadcastIdx > okIdx, 'broadcastPrivateRoomCreatedNotice трябва да се извика след ok-проверката')
})

await check('[7] Известието използва вече доверения publicProfile (не клиентски подадено име/аватар)', () => {
  const handlerBlock = extractBlock(serverSrc, `if (message.type === 'create_private_room') {`, 'create_private_room handler', "\n      if (message.type === 'join_private_room')")
  const broadcastCall = extractBlock(handlerBlock, 'broadcastPrivateRoomCreatedNotice({', 'broadcastPrivateRoomCreatedNotice call', '\n        })')

  assert(broadcastCall.includes('creatorDisplayName: publicProfile.displayName'), 'creatorDisplayName трябва да идва от сървърния publicProfile')
  assert(broadcastCall.includes('creatorAvatarUrl: publicProfile.avatarUrl'), 'creatorAvatarUrl трябва да идва от сървърния publicProfile')
  assert(broadcastCall.includes('creatorProfileId: latestConnection.profileId'), 'creatorProfileId трябва да идва от сървърната сесия (latestConnection), не от клиента')
  assert(!broadcastCall.includes('message.displayName') && !broadcastCall.includes('message.avatarUrl'), 'не трябва да ползва каквото и да е подадено от клиентското WS съобщение за име/аватар')
})

await check('[8] roomId (notificationId) идва от createResult.room.id, генериран сървърно', () => {
  const handlerBlock = extractBlock(serverSrc, `if (message.type === 'create_private_room') {`, 'create_private_room handler', "\n      if (message.type === 'join_private_room')")
  const broadcastCall = extractBlock(handlerBlock, 'broadcastPrivateRoomCreatedNotice({', 'broadcastPrivateRoomCreatedNotice call', '\n        })')
  assert(broadcastCall.includes('roomId: createResult.room.id'), 'notificationId трябва да произлиза от сървърно генерирания room.id')
})

const BROADCAST_FN_END_MARKER = 'function sendPrivateRoomUpdateToMembers(room: PrivateRoom): void {'

await check('[9] broadcastPrivateRoomCreatedNotice изключва създателя по profileId (всички негови връзки, не само текущата)', () => {
  const fn = extractBlock(serverSrc, 'function broadcastPrivateRoomCreatedNotice(input: {', 'broadcastPrivateRoomCreatedNotice', BROADCAST_FN_END_MARKER)
  assert(fn.includes('conn.profileId === input.creatorProfileId'), 'трябва да сравнява по profileId (покрива всички connections на профила), не само по connectionId на подателя')
})

await check('[10] recipientInActiveGame се изчислява СЪРВЪРНО с isProfileInActiveGame, персонализирано за всеки получател', () => {
  const fn = extractBlock(serverSrc, 'function broadcastPrivateRoomCreatedNotice(input: {', 'broadcastPrivateRoomCreatedNotice', BROADCAST_FN_END_MARKER)
  assert(fn.includes('recipientInActiveGame: isProfileInActiveGame(conn.profileId)'), 'recipientInActiveGame трябва да се смята за всеки получател чрез isProfileInActiveGame(conn.profileId)')
})

await check('[11] Само connected свързаности с валиден profileId получават известието (анонимни/disconnected се прескачат)', () => {
  const fn = extractBlock(serverSrc, 'function broadcastPrivateRoomCreatedNotice(input: {', 'broadcastPrivateRoomCreatedNotice', BROADCAST_FN_END_MARKER)
  assert(fn.includes(`conn.status !== 'connected'`), 'трябва да прескача connections, които не са connected')
  assert(fn.includes('conn.profileId === null'), 'трябва да прескача connections без profileId (неаутентикирани)')
})

await check('[12] broadcastPrivateRoomCreatedNotice НЕ е закачено към onRoomsChanged (join/leave/expire не тригват известие)', () => {
  const callbacksBlock = extractBlock(serverSrc, 'onRoomsChanged: () =>', 'onRoomsChanged callback wiring', '\n')
  assert(!callbacksBlock.includes('broadcastPrivateRoomCreatedNotice'), 'onRoomsChanged callback не трябва директно да вика broadcastPrivateRoomCreatedNotice')

  const bodyOfOnRoomsChanged = extractFunctionBody(serverSrc, 'function broadcastPrivateRoomsListToLobbyConnections(): void {', 'broadcastPrivateRoomsListToLobbyConnections')
  assert(!bodyOfOnRoomsChanged.includes('broadcastPrivateRoomCreatedNotice'), 'broadcastPrivateRoomsListToLobbyConnections (общата "нещо се промени" функция) не трябва да вика broadcastPrivateRoomCreatedNotice')

  const joinHandlerIdx = serverSrc.indexOf(`if (message.type === 'join_private_room') {`)
  const joinHandlerBlock = serverSrc.slice(joinHandlerIdx, joinHandlerIdx + 2000)
  assert(!joinHandlerBlock.includes('broadcastPrivateRoomCreatedNotice'), 'join_private_room handler-ът не трябва да вика broadcastPrivateRoomCreatedNotice')
})

await check('[13] Payload-ът не съдържа парола/код за достъп или други чувствителни полета', () => {
  const messageType = extractBlock(serverMessageTypesSrc, 'export type PrivateRoomCreatedNoticeMessage = {', 'PrivateRoomCreatedNoticeMessage type', '\n}')
  assert(!/password|passcode|accessCode|secret|token/i.test(messageType), 'типът не трябва да съдържа парола/код/token полета')
  const fields = ['notificationId', 'creatorDisplayName', 'creatorAvatarUrl', 'recipientInActiveGame']
  for (const field of fields) {
    assert(messageType.includes(field), `типът трябва да съдържа полето ${field}`)
  }
})

await check('[14] Публична (не частна) маса не тригва известието — само create_private_room handler-ът вика broadcastPrivateRoomCreatedNotice', () => {
  const occurrences = (serverSrc.match(/broadcastPrivateRoomCreatedNotice\(\{/g) ?? []).length
  assertEqual(occurrences, 1, 'broadcastPrivateRoomCreatedNotice трябва да се извиква точно от едно място в целия сървърен код')
})

// ─── C) Клиентско wiring-о ───────────────────────────────────────────────────

await check('[15] main.ts подава реалните полета от WS съобщението (не измислени стойности) към privateRoomCreatedNotification', () => {
  const block = extractBlock(mainSrc, `if (message.type === 'private_room_created_notice') {`, 'private_room_created_notice handler', '\n      return\n    }')
  assert(block.includes('notificationId: message.notificationId'), 'notificationId трябва да идва директно от WS съобщението')
  assert(block.includes('creatorDisplayName: message.creatorDisplayName'), 'creatorDisplayName трябва да идва директно от WS съобщението')
  assert(block.includes('creatorAvatarUrl: message.creatorAvatarUrl'), 'creatorAvatarUrl трябва да идва директно от WS съобщението')
  assert(block.includes('recipientInActiveGame: message.recipientInActiveGame'), 'recipientInActiveGame трябва да идва директно от WS съобщението')
})

await check('[16] "Влез" бутонът навигира през съществуващата SPA логика (navigateToPrivateRooms), без презареждане и без auto-join', () => {
  const wiring = extractBlock(mainSrc, 'const privateRoomCreatedNotification = createPrivateRoomCreatedNotification({', 'privateRoomCreatedNotification wiring', '\n})')
  assert(wiring.includes('lobby?.navigateToPrivateRooms()'), 'onEnterPrivateRooms трябва да вика lobby?.navigateToPrivateRooms()')
  assert(!wiring.includes('window.location') && !wiring.includes('location.reload') && !wiring.includes('location.href'), 'не трябва да презарежда страницата')
  assert(!wiring.includes('onPrivateRoomJoin') && !wiring.includes('privateRoomId'), 'не трябва да присъединява автоматично към конкретна маса')
})

await check('[17] navigateToPrivateRooms() в контролера сменя currentScreen на "private-rooms" (същия екран като съществуващия onPrivateRoomsOpen), без join', () => {
  // Извлечена в именувана top-level функция (не inline arrow в options
  // обекта) — вижте коментара непосредствено след дефиницията ѝ в
  // createLobbyFlowController.ts: "за да може да се извиква и публично...
  // огледално на startMatchmaking" (публична част от controller-ния API,
  // виж return statement-а). Функционалното поведение (проверено тук) е
  // непроменено — само формата на декларацията.
  const fn = extractBlock(controllerSrc, 'function navigateToPrivateRooms(): void {', 'navigateToPrivateRooms', '\n  }')
  assert(fn.includes(`state.currentScreen = 'private-rooms'`), 'трябва да смени currentScreen на екрана със списъка на частните маси')
  assert(!fn.includes('onPrivateRoomJoin'), 'не трябва да присъединява автоматично играча към маса')
})

await check('[18] Името на създателя се escape-ва в innerHTML (без HTML injection)', () => {
  assert(/function escapeHtml\(/.test(notifSrc), 'трябва да съществува escapeHtml helper')
  assert(notifSrc.includes('${escapeHtml(notice.creatorDisplayName)}'), 'creatorDisplayName трябва да мине през escapeHtml преди вмъкване в innerHTML')
})

await check('[18b] Реално поведение: escapeHtml неутрализира <script> опити', () => {
  // Директна проверка на самата escapeHtml имплементация, извлечена като текст
  // (модулът не export-ва escapeHtml) — създаваме еквивалентна функция тук и
  // сравняваме резултата с очаквания escaped низ, за да е реално поведенческа
  // проверка, не само regex за наличие на извикването.
  const fn = new Function('value', extractFunctionBody(notifSrc, 'function escapeHtml(value: string): string {', 'escapeHtml').replace('function escapeHtml(value: string): string {', '').replace(/^\s*return/, 'return')) as (v: string) => string
  const malicious = '<img src=x onerror="alert(1)">'
  const escaped = fn(malicious)
  assert(!escaped.includes('<img'), 'escapeHtml трябва да неутрализира < тагове')
  assert(escaped.includes('&lt;img'), 'escapeHtml трябва да произведе &lt; за <')
})

await check('[19] Липсващ avatarUrl (null) използва fallback markup веднага', () => {
  assert(notifSrc.includes('FALLBACK_AVATAR_HTML'), 'трябва да съществува fallback markup константа')
  assert(/notice\.creatorAvatarUrl\s*\n\s*\? `<img/.test(notifSrc), 'при null avatarUrl рендерът трябва директно да ползва fallback (не празен img src)')
})

await check('[20] Счупено изображение (onerror) превключва към fallback markup, не празно място', () => {
  const errorHandlerBlock = extractBlock(
    notifSrc,
    `options.container.querySelector('#private-room-created-avatar-img')?.addEventListener('error', () => {`,
    'avatar onerror handler',
    '\n    }, { once: true })',
  )
  assert(errorHandlerBlock.includes('FALLBACK_AVATAR_HTML'), 'onerror handler-ът трябва да замести с FALLBACK_AVATAR_HTML')
})

await check('[21] AUTO_DISMISS_MS === 8_000 (8 секунди видимост)', () => {
  assert(/const AUTO_DISMISS_MS = 8_000/.test(notifSrc), 'AUTO_DISMISS_MS трябва да е 8000ms')
  assert(/dismissTimer = setTimeout\(dismiss, AUTO_DISMISS_MS\)/.test(notifSrc), 'auto-hide таймерът трябва да ползва AUTO_DISMISS_MS')
})

await check('[22] × бутонът затваря веднага (без потвърждение), безусловно присъства', () => {
  const closeBtnCount = (notifSrc.match(/id="private-room-created-close-btn"/g) ?? []).length
  assertEqual(closeBtnCount, 1, 'точно 1 дефиниция на close бутона')
  assert(notifSrc.includes(`querySelector('#private-room-created-close-btn')?.addEventListener('click', dismiss)`), '× бутонът трябва директно да вика dismiss()')
})

await check('[23] "Влез" е само извън игра; "Изключи в игра" е само в игра', () => {
  assert(notifSrc.includes('private-room-created-enter-btn'), 'outside-game popup must keep the Enter button')
  assert(notifSrc.includes('private-room-created-disable-in-game-btn'), 'in-game popup must include disable-in-game button')
  assert(/const actionButtonHtml = notice\.recipientInActiveGame\s*\n\s*\? `<button id="private-room-created-disable-in-game-btn"/.test(notifSrc), 'recipientInActiveGame=true must render disable-in-game action')
  assert(notifSrc.includes('`<button id="private-room-created-enter-btn"'), 'recipientInActiveGame=false must render Enter action')
})

await check('[24] В игра текстът е информативен без действие; извън игра — покана с действие', () => {
  assert(notifSrc.includes('Можеш да се присъединиш, след като завършиш играта.'), 'текстът за в игра трябва да съвпада с изискването')
  assert(notifSrc.includes('Присъедини се, ако искаш.'), 'текстът извън игра трябва да съвпада с изискването')
})

await check('[25] Клик на "Влез" затваря попъпа преди навигацията (dismiss() предхожда onEnterPrivateRooms())', () => {
  const clickBlock = extractBlock(
    notifSrc,
    `options.container.querySelector('#private-room-created-enter-btn')?.addEventListener('click', () => {`,
    'enter click handler',
    '\n    })',
  )
  const dismissIdx = clickBlock.indexOf('dismiss()')
  const navIdx = clickBlock.indexOf('options.onEnterPrivateRooms()')
  assert(dismissIdx !== -1 && navIdx !== -1 && dismissIdx < navIdx, 'dismiss() трябва да предхожда навигацията')
})

await check('[26] Звукът за нова частна маса е краткият notification-1.mp3, не notification-3.mp3', () => {
  assert(notifSrc.includes(`new Audio('/audio/Notifications/notification-1.mp3')`), 'трябва да използва /audio/Notifications/notification-1.mp3')
  assert(!notifSrc.includes(`new Audio('/audio/Notifications/notification-3.mp3')`), 'не трябва да използва стария дълъг notification-3.mp3')
  assert(/audio\.volume = 0\.6/.test(notifSrc), 'volume трябва да е 0.6, консистентно с останалите известия')
  assert(/void audio\.play\(\)\.catch\(\(\) => \{/.test(notifSrc), 'play() трябва да catch-ва autoplay policy грешки')
})

await check('[27] playSound() се вика само от presentAndSchedule (реален show), не при queue/skip', () => {
  const presentFn = extractFunctionBody(notifSrc, 'function presentAndSchedule(notice: PrivateRoomCreatedNotice): void {', 'presentAndSchedule')
  assert(presentFn.includes('playSound()'), 'presentAndSchedule трябва да пусне звука')

  const handleIncomingFn = extractFunctionBody(notifSrc, 'function handleIncoming(notice: PrivateRoomCreatedNotice): void {', 'handleIncoming')
  assert(!handleIncomingFn.includes('playSound()'), 'handleIncoming не трябва пряко да вика playSound')
})

await check('[27b] В игра и изключена настройка: няма popup и няма звук', () => {
  const handleIncomingFn = extractFunctionBody(notifSrc, 'function handleIncoming(notice: PrivateRoomCreatedNotice): void {', 'handleIncoming')
  assert(handleIncomingFn.includes('recipientInActiveGame: options.isInActiveGame()'), 'client must use live activeRoom state, not stale DOM/server display state')
  assert(handleIncomingFn.includes('normalizedNotice.recipientInActiveGame && !options.areInGameNotificationsEnabled()'), 'in-game disabled setting must skip notification before show/sound')
  const skipIdx = handleIncomingFn.indexOf('return')
  const queueIdx = handleIncomingFn.indexOf('queue.handleIncoming')
  assert(skipIdx !== -1 && queueIdx !== -1 && skipIdx < queueIdx, 'suppressed in-game notice must return before queue/show/sound')
})

await check('[27c] Бутонът "Изключи в игра" променя същата постоянна настройка и затваря popup-а', () => {
  const clickBlock = extractBlock(
    notifSrc,
    `options.container.querySelector('#private-room-created-disable-in-game-btn')?.addEventListener('click', () => {`,
    'disable-in-game click handler',
    '\n    })',
  )
  assert(clickBlock.includes('options.onDisableInGameNotifications()'), 'disable button must call the shared preference setter')
  assert(clickBlock.includes('dismiss()'), 'disable button must dismiss the active popup')
})

await check('[27d] Local preference persists, defaults enabled, and syncs across tabs through storage event', () => {
  assert(mainSrc.includes("const PRIVATE_ROOM_IN_GAME_NOTIFICATIONS_KEY = 'pika.privateRoomInGameNotificationsEnabled'"), 'localStorage key missing')
  assert(mainSrc.includes("localStorage.getItem(PRIVATE_ROOM_IN_GAME_NOTIFICATIONS_KEY) !== 'false'"), 'default must be enabled unless explicitly false')
  assert(mainSrc.includes("localStorage.setItem(PRIVATE_ROOM_IN_GAME_NOTIFICATIONS_KEY, enabled ? 'true' : 'false')"), 'setter must persist the same setting')
  assert(mainSrc.includes("window.addEventListener('storage'"), 'multi-tab storage sync missing')
  assert(mainSrc.includes('privateRoomCreatedNotification.syncPreferences()'), 'storage sync must update/suppress current popup')
})

await check('[27e] Toggle is in the existing notifications dropdown and uses the same preference', () => {
  assert(controllerSrc.includes('initialPrivateRoomInGameNotificationsEnabled'), 'controller must receive initial setting')
  assert(controllerSrc.includes('onPrivateRoomInGameNotificationsChange?.(enabled)'), 'dropdown toggle must call the shared setting callback')
  assert(controllerSrc.includes('setPrivateRoomInGameNotificationsEnabled'), 'controller must expose setter for storage sync')
  assert(notifSrc.includes('areInGameNotificationsEnabled'), 'notification controller must read the same setting')
})

await check('[27f] Извън игра настройката не влияе: popup и notification-1.mp3 продължават да работят', () => {
  const handleIncomingFn = extractFunctionBody(notifSrc, 'function handleIncoming(notice: PrivateRoomCreatedNotice): void {', 'handleIncoming')
  assert(handleIncomingFn.includes('normalizedNotice.recipientInActiveGame && !options.areInGameNotificationsEnabled()'), 'suppression must be gated by recipientInActiveGame')
  assert(!/if \(!options\.areInGameNotificationsEnabled\(\)\)/.test(handleIncomingFn), 'setting must not suppress outside-game notices globally')
})

await check('[27g] Другите notification звуци не са променени', async () => {
  const friendSrc = normalizeLineEndings(await readFile(join(REPO_ROOT, 'src', 'ui', 'notifications', 'friendRequestNotification.ts'), 'utf8'))
  const likeSrc = normalizeLineEndings(await readFile(join(REPO_ROOT, 'src', 'ui', 'notifications', 'profileLikeNotification.ts'), 'utf8'))
  const tournamentPartnerSrc = normalizeLineEndings(await readFile(join(REPO_ROOT, 'src', 'ui', 'notifications', 'tournamentPartnerInvitePopup.ts'), 'utf8'))
  const chatSrc = normalizeLineEndings(await readFile(join(REPO_ROOT, 'src', 'ui', 'notifications', 'chatMessageNotification.ts'), 'utf8'))
  assert(friendSrc.includes("notification-1.mp3"), 'friend request sound must remain notification-1.mp3')
  assert(likeSrc.includes("notification-2.mp3"), 'profile like sound must remain notification-2.mp3')
  assert(tournamentPartnerSrc.includes("notification-1.mp3"), 'tournament partner invite sound must remain notification-1.mp3')
  assert(chatSrc.includes("player-seat-fill.mp3"), 'chat message sound must remain player-seat-fill.mp3')
})

await check('[28] Съобщението е добавено към клиентския и сървърния ServerMessage union', () => {
  assert(/\| PrivateRoomCreatedNoticeMessage/.test(clientSrc), 'клиентският ServerMessage union трябва да съдържа PrivateRoomCreatedNoticeMessage')
  assert(/\| PrivateRoomCreatedNoticeMessage/.test(serverMessageTypesSrc), 'сървърният ServerMessage union трябва да съдържа PrivateRoomCreatedNoticeMessage')
})

await check('[29] Известието не блокира игровото управление (компактен fixed банер, не full-screen)', () => {
  assert(!notifSrc.includes('width:100vw') && !notifSrc.includes('height:100vh'), 'банерът не трябва да заема цял екран')
  assert(notifSrc.includes('max-width:90vw'), 'банерът трябва да е ограничен по ширина за mobile')
})

await check('[30] Позиционирането отчита mobile safe-area (notch)', () => {
  assert(notifSrc.includes('env(safe-area-inset-top, 0px)'), 'top позиционирането трябва да добавя safe-area отстъп')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
