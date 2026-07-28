/**
 * checkNotificationSoundAssignments.ts
 *
 * Проверки за разпределението на звуковите файлове между top-popup
 * известията, след като всяко от тях получи собствен, различим звук вместо
 * споделения /audio/ui/player-seat-fill.mp3:
 *
 *   - Създадена частна маса         → /audio/Notifications/notification-3.mp3
 *   - Покана за приятелство         → /audio/Notifications/notification-1.mp3
 *   - Приета покана за приятелство  → /audio/Notifications/notification-1.mp3
 *   - Харесване на профил           → /audio/Notifications/notification-2.mp3
 *
 * Чат известието (chatMessageNotification.ts) и partner rating известието
 * (partnerRatingNotification.ts) НЕ са част от това преразпределение и трябва
 * да продължат да ползват /audio/ui/player-seat-fill.mp3 непроменено — този
 * скрипт пази и срещу регресия там.
 *
 * Комбинира:
 *  A) Реална fs проверка, че трите mp3 файла съществуват на диск (не regex/
 *     текстово предположение) — липсващ файл би означавало 404 в реалния
 *     браузър дори source кодът да сочи към правилния път.
 *  B) Source-text проверки, точно scoped към функциите, в които звукът се
 *     пуска — доказва, че всяко известие ползва точния файл, ЧЕ playSound()
 *     се извиква единствено при реално показване (show/showRequest/
 *     showAccepted/presentAndSchedule и успешните confirmation клонове), и
 *     НЕ се извиква при dismiss/render/queue/skip/error пътищата.
 *  C) Регресионна проверка, че chatMessageNotification.ts и
 *     partnerRatingNotification.ts не са били неволно променени.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const PRIVATE_ROOM_CREATED_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'privateRoomCreatedNotification.ts')
const FRIEND_REQUEST_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'friendRequestNotification.ts')
const PROFILE_LIKE_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'profileLikeNotification.ts')
const CHAT_MESSAGE_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'chatMessageNotification.ts')
const PARTNER_RATING_PATH = join(REPO_ROOT, 'src', 'ui', 'notifications', 'partnerRatingNotification.ts')

const NOTIFICATIONS_AUDIO_DIR = join(REPO_ROOT, 'public', 'audio', 'Notifications')

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

// Брой-скоби извличане на функционално тяло — за разлика от наивно търсене
// на "\n}" (което не работи за функции, вложени в closure, тъй като тяхната
// собствена затваряща скоба е с отстъп, не на колона 0, и наивното търсене
// би "прескочило" чак до края на файла), тук се брои реалната дълбочина на
// скобите от първата "{" след сигнатурата до нейното точно затваряне.
// Безопасно е за функциите, проверявани тук (dismiss/show/presentAndSchedule
// и др.) — те не съдържат CSS/template-literal блокове с "{"/"}" вътре.
function extractFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)
  const braceStart = src.indexOf('{', startIdx)
  assert(braceStart !== -1, `${label}: отваряща скоба не е намерена след "${signature}"`)

  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        return src.slice(startIdx, i + 1)
      }
    }
  }
  throw new Error(`${label}: затваряща скоба не е намерена след "${signature}"`)
}

function extractBlock(src: string, startMarker: string, label: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker)
  assert(startIdx !== -1, `${label}: маркер "${startMarker}" не е намерен`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf(endMarker)
  assert(endIdx !== -1, `${label}: край на блок не е намерен след "${startMarker}"`)
  return afterStart.slice(0, endIdx)
}

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1
}

// ─── Load real source files ─────────────────────────────────────────────────

const privateRoomCreatedSrc = normalizeLineEndings(await readFile(PRIVATE_ROOM_CREATED_PATH, 'utf8'))
const friendRequestSrc = normalizeLineEndings(await readFile(FRIEND_REQUEST_PATH, 'utf8'))
const profileLikeSrc = normalizeLineEndings(await readFile(PROFILE_LIKE_PATH, 'utf8'))
const chatMessageSrc = normalizeLineEndings(await readFile(CHAT_MESSAGE_PATH, 'utf8'))
const partnerRatingSrc = normalizeLineEndings(await readFile(PARTNER_RATING_PATH, 'utf8'))

console.log('\n=== Notification Sound Assignment Checks ===\n')

// ─── A) Реалните mp3 файлове съществуват на диск ────────────────────────────

await check('[1] /public/audio/Notifications/notification-1.mp3 съществува на диск', () => {
  assert(existsSync(join(NOTIFICATIONS_AUDIO_DIR, 'notification-1.mp3')), 'файлът липсва — известието би заредило 404 в реалния браузър')
})

await check('[2] /public/audio/Notifications/notification-2.mp3 съществува на диск', () => {
  assert(existsSync(join(NOTIFICATIONS_AUDIO_DIR, 'notification-2.mp3')), 'файлът липсва — известието би заредило 404 в реалния браузър')
})

await check('[3] /public/audio/Notifications/notification-3.mp3 съществува на диск', () => {
  assert(existsSync(join(NOTIFICATIONS_AUDIO_DIR, 'notification-3.mp3')), 'файлът липсва — известието би заредило 404 в реалния браузър')
})

// ─── B1) Създадена частна маса → notification-3.mp3 ─────────────────────────

await check('[4] privateRoomCreatedNotification.ts ползва точно notification-3.mp3', () => {
  assert(privateRoomCreatedSrc.includes(`new Audio('/audio/Notifications/notification-3.mp3')`), 'трябва да инстанцира точно /audio/Notifications/notification-3.mp3')
  assertEqual(countOccurrences(privateRoomCreatedSrc, 'new Audio('), 1, 'трябва да съществува точно едно Audio инстанциране в модула')
})

await check('[5] privateRoomCreatedNotification.ts: playSound() се вика единствено от presentAndSchedule (реален show)', () => {
  const presentFn = extractFunctionBody(privateRoomCreatedSrc, 'function presentAndSchedule(notice: PrivateRoomCreatedNotice): void {', 'presentAndSchedule')
  assert(presentFn.includes('playSound()'), 'presentAndSchedule трябва да пусне звука')

  // 2 съвпадения на буквалния низ "playSound()": самата дефиниция
  // "function playSound(): void {" (функцията е без параметри) + 1 реално
  // извикване — от presentAndSchedule.
  assertEqual(countOccurrences(privateRoomCreatedSrc, 'playSound()'), 2, 'playSound() трябва да се извиква точно от едно място (плюс собствената си дефиниция) — само presentAndSchedule')

  const handleIncomingFn = extractFunctionBody(privateRoomCreatedSrc, 'function handleIncoming(notice: PrivateRoomCreatedNotice): void {', 'handleIncoming')
  assert(!handleIncomingFn.includes('playSound()'), 'handleIncoming (queue/skip решения) не трябва пряко да вика playSound')

  const dismissFn = extractFunctionBody(privateRoomCreatedSrc, 'function dismiss(): void {', 'dismiss')
  assert(!dismissFn.includes('playSound()'), 'dismiss() не трябва да пуска звук')
})

// ─── B2) Покана за приятелство + приета покана → notification-1.mp3 ─────────

await check('[6] friendRequestNotification.ts ползва точно notification-1.mp3 за ВСИЧКИ свои сценарии (един споделен playSound)', () => {
  assert(friendRequestSrc.includes(`new Audio('/audio/Notifications/notification-1.mp3')`), 'трябва да инстанцира точно /audio/Notifications/notification-1.mp3')
  assertEqual(countOccurrences(friendRequestSrc, 'new Audio('), 1, 'трябва да съществува точно едно Audio инстанциране (споделено между покана и приемане)')
})

await check('[7] showRequest() (нова входяща покана) реално вика playSound()', () => {
  const fn = extractFunctionBody(friendRequestSrc, 'function showRequest(notification: FriendRequestNotif): void {', 'showRequest')
  assert(fn.includes('playSound()'), 'showRequest трябва да пусне звука при показване на нова покана')
})

await check('[8] showAccepted() (приета покана, известена от сървъра) реално вика playSound()', () => {
  const fn = extractFunctionBody(friendRequestSrc, 'function showAccepted(notification: AcceptedNotif): void {', 'showAccepted')
  assert(fn.includes('playSound()'), 'showAccepted трябва да пусне звука при показване на потвърждението')
})

await check('[9] Директно приемане от самия popup (freq-accept-btn success клон) също вика playSound() — трети легитимен show момент', () => {
  const acceptHandlerBlock = extractBlock(
    friendRequestSrc,
    `options.container.querySelector('#freq-accept-btn')?.addEventListener('click', () => {`,
    'accept click handler',
    '\n    })',
  )
  const successBlock = extractBlock(acceptHandlerBlock, 'isProcessing = false\n        clearDismissTimer()', 'accept success branch', '\n      }).catch(')
  assert(successBlock.includes('playSound()'), 'успешното локално приемане трябва да пусне звука на потвърждението, идентично с showAccepted')
})

await check('[10] Точно 3 реални извиквания на playSound() в целия файл — showRequest, showAccepted, accept-success клон', () => {
  // 4 съвпадения на буквалния низ "playSound()": дефиницията (без параметри)
  // + 3 реални извиквания.
  assertEqual(countOccurrences(friendRequestSrc, 'playSound()'), 4, 'очакват се точно 3 извиквания playSound() (плюс собствената дефиниция на функцията)')
})

await check('[11] playSound() НЕ се вика при dismissByTimer/dismissConfirmation/reject клон (не е "show" момент)', () => {
  const dismissByTimerFn = extractFunctionBody(friendRequestSrc, 'function dismissByTimer(): void {', 'dismissByTimer')
  assert(!dismissByTimerFn.includes('playSound()'), 'auto-hide на поканата не трябва да пуска звук')

  const dismissConfirmationFn = extractFunctionBody(friendRequestSrc, 'function dismissConfirmation(): void {', 'dismissConfirmation')
  assert(!dismissConfirmationFn.includes('playSound()'), 'auto-hide на потвърждението не трябва да пуска звук')

  const rejectHandlerBlock = extractBlock(
    friendRequestSrc,
    `options.container.querySelector('#freq-reject-btn')?.addEventListener('click', () => {`,
    'reject click handler',
    '\n    })',
  )
  assert(!rejectHandlerBlock.includes('playSound()'), 'отказ на покана не трябва да пуска звук')
})

// ─── B3) Харесване на профил → notification-2.mp3 ───────────────────────────

await check('[12] profileLikeNotification.ts ползва точно notification-2.mp3', () => {
  assert(profileLikeSrc.includes(`new Audio('/audio/Notifications/notification-2.mp3')`), 'трябва да инстанцира точно /audio/Notifications/notification-2.mp3')
  assertEqual(countOccurrences(profileLikeSrc, 'new Audio('), 1, 'трябва да съществува точно едно Audio инстанциране в модула')
})

await check('[13] show() (получено харесване) реално вика playSound()', () => {
  const fn = extractFunctionBody(profileLikeSrc, 'function show(notification: LikeNotification): void {', 'show')
  assert(fn.includes('playSound()'), 'show трябва да пусне звука при показване на новото харесване')
})

await check('[14] Успешен клик на "Харесай" (like-notif-like-btn success клон) също вика playSound() — потвърждението', () => {
  const likeHandlerBlock = extractBlock(
    profileLikeSrc,
    `options.container.querySelector('#like-notif-like-btn')?.addEventListener('click', () => {`,
    'like click handler',
    '\n    })',
  )
  const successBlock = extractBlock(likeHandlerBlock, 'void options.onLike(profileId).then(() => {', 'like success branch', '\n      }).catch(')
  assert(successBlock.includes('playSound()'), 'успешното "Харесай" действие трябва да пусне звука на потвърждението')
})

await check('[15] Точно 2 реални извиквания на playSound() в целия файл — show и like-success клон', () => {
  // 3 съвпадения на буквалния низ "playSound()": дефиницията (без параметри)
  // + 2 реални извиквания.
  assertEqual(countOccurrences(profileLikeSrc, 'playSound()'), 3, 'очакват се точно 2 извиквания playSound() (плюс собствената дефиниция на функцията)')
})

await check('[16] playSound() НЕ се вика при dismiss()/dismissConfirmation() (auto-hide не е "show" момент)', () => {
  const dismissFn = extractFunctionBody(profileLikeSrc, 'function dismiss(): void {', 'dismiss')
  assert(!dismissFn.includes('playSound()'), 'auto-hide на известието не трябва да пуска звук')

  const dismissConfirmationFn = extractFunctionBody(profileLikeSrc, 'function dismissConfirmation(): void {', 'dismissConfirmation')
  assert(!dismissConfirmationFn.includes('playSound()'), 'auto-hide на потвърждението не трябва да пуска звук')
})

// ─── C) Безопасен audio pattern запазен (volume + catch за autoplay policy) ─

for (const [label, src] of [
  ['privateRoomCreatedNotification.ts', privateRoomCreatedSrc],
  ['friendRequestNotification.ts', friendRequestSrc],
  ['profileLikeNotification.ts', profileLikeSrc],
] as const) {
  await check(`[17] ${label}: audio.volume = 0.6 и play().catch() за autoplay policy запазени`, () => {
    assert(/audio\.volume = 0\.6/.test(src), `${label} трябва да зададе volume 0.6`)
    assert(/void audio\.play\(\)\.catch\(\(\) => \{/.test(src), `${label} трябва да catch-ва autoplay policy грешки от play()`)
  })
}

// ─── D) Регресионна защита — чат и partner rating НЕ са пипнати ────────────

await check('[18] chatMessageNotification.ts продължава да ползва /audio/ui/player-seat-fill.mp3 (непроменено)', () => {
  assert(chatMessageSrc.includes(`new Audio('/audio/ui/player-seat-fill.mp3')`), 'chatMessageNotification.ts не трябва да е засегнат от преразпределението на звуците')
  assert(!chatMessageSrc.includes('/audio/Notifications/'), 'chatMessageNotification.ts не трябва да реферира новата Notifications папка')
})

await check('[19] partnerRatingNotification.ts продължава да ползва /audio/ui/player-seat-fill.mp3 (непроменено)', () => {
  assert(partnerRatingSrc.includes(`new Audio('/audio/ui/player-seat-fill.mp3')`), 'partnerRatingNotification.ts не трябва да е засегнат от преразпределението на звуците')
  assert(!partnerRatingSrc.includes('/audio/Notifications/'), 'partnerRatingNotification.ts не трябва да реферира новата Notifications папка')
})

await check('[20] Никой от трите преназначени файла не сочи вече към стария споделен /audio/ui/player-seat-fill.mp3', () => {
  assert(!privateRoomCreatedSrc.includes('player-seat-fill'), 'privateRoomCreatedNotification.ts не трябва повече да реферира player-seat-fill.mp3')
  assert(!friendRequestSrc.includes('player-seat-fill'), 'friendRequestNotification.ts не трябва повече да реферира player-seat-fill.mp3')
  assert(!profileLikeSrc.includes('player-seat-fill'), 'profileLikeNotification.ts не трябва повече да реферира player-seat-fill.mp3')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
