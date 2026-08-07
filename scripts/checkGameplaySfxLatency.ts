/**
 * checkGameplaySfxLatency.ts
 *
 * Regression проверки за фикса на card-on-table/card-move audio latency на
 * iOS Safari (production сигнал: ~560-590ms между визуалната card-play
 * анимация и звука).
 *
 * Пази срещу връщане към старата причина за лага:
 *  A) playCardMove()/playCardOnTable() вече не правят `new Audio()` при
 *     всяко извикване — минават през preloaded pool.
 *  B) Pool елементите се create-ват и `.load()`-ват в scope-а на
 *     createGameAudioController() (init), не лениво при play.
 *  C) renderPlayingScreen.ts вече не пуска card-landed звука чрез 250ms
 *     look-ahead setTimeout преди края на 350ms flight анимацията —
 *     onLanded се вика от animation finish, не от произволен offset.
 *  D) speechQueue (bid/декларации) логиката е непокътната — отделна
 *     архитектура, извън обхвата на този fix.
 *  E) Deal packet sound scheduling (constants и извикването на
 *     playCardMove от scheduleDealPacketSounds) е непроменено.
 *  F) Timer countdown warning pool-ът (ReactionCountdownLoop) е непокътнат.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const AUDIO_CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'audio', 'createGameAudioController.ts')
const PLAYING_SCREEN_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'renderPlayingScreen.ts')
const ACTIVE_ROOM_FLOW_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts')

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

// Намира тялото на функция по сигнатура. Скача до КРАЯ на параметър-листа
// (чрез броене на кръгли скоби), преди да търси отварящата `{` на тялото —
// наивно "първата { след сигнатурата" се лъже от default object-literal
// параметри (`= {}`) или inline object type annotations в параметрите
// (`options: { ... }`), защото те са собствена балансирана {}-структура,
// която приключва depth обратно на 0 много преди реалното тяло на функцията.
function extractFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)

  const parenStart = src.indexOf('(', startIdx)
  assert(parenStart !== -1, `${label}: отваряща "(" не е намерена след "${signature}"`)

  let parenDepth = 0
  let parenEnd = -1
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') parenDepth++
    else if (src[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        parenEnd = i
        break
      }
    }
  }
  assert(parenEnd !== -1, `${label}: затваряща ")" на параметър-листа не е намерена след "${signature}"`)

  const braceStart = src.indexOf('{', parenEnd)
  assert(braceStart !== -1, `${label}: отваряща "{" на тялото не е намерена след параметър-листа`)

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

const audioControllerSrc = await readFile(AUDIO_CONTROLLER_PATH, 'utf8')
const playingScreenSrc = await readFile(PLAYING_SCREEN_PATH, 'utf8')
const activeRoomFlowSrc = await readFile(ACTIVE_ROOM_FLOW_PATH, 'utf8')

// ─── A) playCardMove/playCardOnTable не правят `new Audio()` per play ──────

await check('[1] playCardMove() не създава `new Audio()` директно — минава през pool', () => {
  const body = extractFunctionBody(audioControllerSrc, 'function playCardMove(): void', 'playCardMove')
  assert(!/new Audio\(/.test(body), 'playCardMove() не трябва да конструира Audio елемент при всяко извикване')
  assert(/cardMovePool\.play\(\)/.test(body), 'playCardMove() трябва да делегира на cardMovePool.play()')
})

await check('[2] playCardOnTable() не създава `new Audio()` директно — минава през pool', () => {
  const body = extractFunctionBody(audioControllerSrc, 'function playCardOnTable(): void', 'playCardOnTable')
  assert(!/new Audio\(/.test(body), 'playCardOnTable() не трябва да конструира Audio елемент при всяко извикване')
  assert(/cardOnTablePool\.play\(\)/.test(body), 'playCardOnTable() трябва да делегира на cardOnTablePool.play()')
})

// ─── B) Pool-ите се create-ват/load-ват при init, не лениво ────────────────

await check('[3] cardOnTablePool/cardMovePool се създават в scope-а на createGameAudioController (init), не лениво', () => {
  const controllerBody = extractFunctionBody(
    audioControllerSrc,
    'export function createGameAudioController(',
    'createGameAudioController',
  )
  assert(
    /const cardOnTablePool = createPreloadedSfxPool\(/.test(controllerBody),
    'cardOnTablePool трябва да е инстанциран директно в тялото на createGameAudioController',
  )
  assert(
    /const cardMovePool = createPreloadedSfxPool\(/.test(controllerBody),
    'cardMovePool трябва да е инстанциран директно в тялото на createGameAudioController',
  )
})

await check('[4] createPreloadedSfxPool създава елементите с preload="auto" и извиква .load() предварително', () => {
  const poolBody = extractFunctionBody(
    audioControllerSrc,
    'function createPreloadedSfxPool(src: string, size: number): PreloadedSfxPool',
    'createPreloadedSfxPool',
  )
  assert(/audio\.load\(\)/.test(poolBody), 'Всеки pool елемент трябва да извика .load() предварително')
  assert(/createAudio\(src\)/.test(poolBody), 'Pool елементите трябва да минат през createAudio() (preload="auto")')
})

await check('[5] Pool round-robin избира следващ свободен елемент вместо да презаписва един-единствен', () => {
  const poolBody = extractFunctionBody(
    audioControllerSrc,
    'function createPreloadedSfxPool(src: string, size: number): PreloadedSfxPool',
    'createPreloadedSfxPool',
  )
  assert(/nextIndex = \(nextIndex \+ 1\) % elements\.length/.test(poolBody), 'play() трябва да ротира между няколко елемента, за да не реже застъпващи се SFX')
  assert(poolBody.includes('elements: HTMLAudioElement[]'), 'Pool-ът трябва да пази няколко HTMLAudioElement, не един')
})

await check('[6] Pool.play() безопасно нулира currentTime (try/catch) преди .play()', () => {
  const poolBody = extractFunctionBody(
    audioControllerSrc,
    'function createPreloadedSfxPool(src: string, size: number): PreloadedSfxPool',
    'createPreloadedSfxPool',
  )
  assert(/try\s*\{\s*audio\.currentTime = 0/.test(poolBody), 'currentTime = 0 трябва да е в try/catch (Safari може да хвърли, ако readyState е твърде нисък)')
})

await check('[6b] prime() заглушава елементите преди play() и възстановява mute състоянието и при успех, и при неуспех (без audible blip)', () => {
  const primeBody = extractFunctionBody(audioControllerSrc, 'function prime(): void', 'prime')
  assert(/const wasMuted = audio\.muted/.test(primeBody), 'prime() трябва да прочете текущото mute състояние преди да го промени')
  assert(/audio\.muted = true/.test(primeBody), 'prime() трябва да заглуши елемента преди play(), за да няма audible blip')
  assert(/audio\.muted = wasMuted/.test(primeBody), 'prime() трябва да възстанови оригиналното mute състояние (не хардкоднато false)')
  assert(/playResult\.then\(restore\)\.catch\(restore\)/.test(primeBody), 'restore() трябва да тръгва и при успешен play(), и при catch — иначе елементът може да остане заглушен завинаги за реален gameplay')
})

// ─── iOS prewarm/unlock hook (не AudioContext, не нов глобален listener) ───

await check('[7] primeGameplaySfx() съществува, е идемпотентен и НЕ въвежда AudioContext', () => {
  assert(/primeGameplaySfx\(\): void/.test(audioControllerSrc), 'GameAudioController трябва да експортира primeGameplaySfx()')
  const body = extractFunctionBody(audioControllerSrc, 'function primeGameplaySfx(): void', 'primeGameplaySfx')
  assert(/hasPrimedGameplaySfx/.test(body), 'primeGameplaySfx() трябва да е guard-нат с флаг, за да е еднократен')
  assert(!/AudioContext/.test(audioControllerSrc), 'Не трябва да се въвежда AudioContext/Web Audio API за този fix')
})

await check('[8] primeGameplaySfx() се вика от вече съществуващи click handler-и, не от нов document/window listener', () => {
  const occurrences = activeRoomFlowSrc.split('options.gameAudio?.primeGameplaySfx()').length - 1
  assert(occurrences >= 2, 'primeGameplaySfx() трябва да е закачен към поне 2 съществуващи gesture-handler-а (cut + bid)')
  assert(
    !/document\.addEventListener\('click'/.test(activeRoomFlowSrc) &&
      !/document\.addEventListener\('pointerdown'/.test(activeRoomFlowSrc) &&
      !/document\.addEventListener\('touchstart'/.test(activeRoomFlowSrc),
    'Не трябва да е добавен нов глобален document gesture listener само за audio unlock',
  )
})

// ─── C) Card landing sound вече не е 250ms look-ahead преди края ───────────

await check('[9] animatePlayedCardFromHand() вече не съдържа старата landedAudioOffsetMs/250ms look-ahead логика', () => {
  const body = extractFunctionBody(
    playingScreenSrc,
    'async function animatePlayedCardFromHand(options: {',
    'animatePlayedCardFromHand',
  )
  assert(!/landedAudioOffsetMs/.test(body), 'landedAudioOffsetMs константата трябва да е премахната')
  assert(!/durationMs - landedAudioOffsetMs/.test(body), 'Не трябва да остане early-fire smetTimeout спрямо durationMs - offset')
  assert(/durationMs = 350/.test(body), 'Визуалната flight продължителност (350ms) остава непроменена')
})

await check('[10] onLanded се вика от anim.onfinish (didFinish) чрез идемпотентния callOnLandedOnce()', () => {
  const body = extractFunctionBody(
    playingScreenSrc,
    'async function animatePlayedCardFromHand(options: {',
    'animatePlayedCardFromHand',
  )
  assert(/anim\.onfinish = \(\) => resolve\(true\)/.test(body), 'onfinish трябва да остане веригата, която маркира didFinish=true')
  assert(/if \(didFinish\) \{\s*callOnLandedOnce\(\)/.test(body), 'didFinish клонът трябва да вика callOnLandedOnce(), не директно onLanded?.()')
})

await check('[10b] Safety-net timeout за onLanded е >= durationMs (не early-fire) и е идемпотентен спрямо onfinish', () => {
  const body = extractFunctionBody(
    playingScreenSrc,
    'async function animatePlayedCardFromHand(options: {',
    'animatePlayedCardFromHand',
  )
  assert(
    /let didCallOnLanded = false/.test(body) && /if \(didCallOnLanded\) \{\s*return/.test(body),
    'callOnLandedOnce() трябва да е guard-нат с флаг, за да не удвои звука с onfinish',
  )
  const safetyMatch = body.match(/window\.setTimeout\(callOnLandedOnce, durationMs \+ (\d+)\)/)
  assert(safetyMatch !== null, 'Трябва да има safety-net setTimeout(callOnLandedOnce, durationMs + margin) за случая, в който WAAPI никога не извика onfinish/oncancel')
  assert(Number(safetyMatch![1]) > 0, 'Safety-net margin-ът трябва да е положителен (>= durationMs), не по-рано от края на анимацията')
  assert(/window\.clearTimeout\(safetyTimeoutId\)/.test(body), 'Safety-net таймерът трябва да се изчисти веднага щом onfinish/oncancel реши промиса')
})

// ─── D) speechQueue логиката е непокътната ─────────────────────────────────

await check('[11] speechQueue/enqueueSpeech/playNextSpeechFromQueue архитектурата е непроменена', () => {
  assert(audioControllerSrc.includes('let speechQueue: string[] = []'), 'speechQueue декларацията трябва да е същата')
  assert(audioControllerSrc.includes('function playNextSpeechFromQueue(): void'), 'playNextSpeechFromQueue трябва да съществува непроменена')
  assert(audioControllerSrc.includes('function enqueueSpeech(src: string): void'), 'enqueueSpeech трябва да съществува непроменена')
  const enqueueBody = extractFunctionBody(audioControllerSrc, 'function enqueueSpeech(src: string): void', 'enqueueSpeech')
  assert(!/cardOnTablePool|cardMovePool/.test(enqueueBody), 'enqueueSpeech не трябва да реферира новите card SFX pool-ове')
})

// ─── E) Deal packet scheduling е непроменено (само механиката под playCardMove) ─

await check('[12] scheduleDealPacketSounds все още вика playCardMove() със същите timing константи', () => {
  const body = extractFunctionBody(
    audioControllerSrc,
    'function scheduleDealPacketSounds(sequenceKey: string, timing: DealPacketSoundTiming = {}): void',
    'scheduleDealPacketSounds',
  )
  assert(/playCardMove\(\)/.test(body), 'scheduleDealPacketSounds трябва да продължи да вика playCardMove()')
  assert(audioControllerSrc.includes('const DEFAULT_DEAL_PACKET_COUNT = 4'), 'DEFAULT_DEAL_PACKET_COUNT не трябва да е променен от този fix')
  assert(audioControllerSrc.includes('const DEFAULT_DEAL_PACKET_START_DELAY_MS = 220'), 'DEFAULT_DEAL_PACKET_START_DELAY_MS не трябва да е променен от този fix')
  assert(audioControllerSrc.includes('const DEFAULT_DEAL_PACKET_DELAY_STEP_MS = 420'), 'DEFAULT_DEAL_PACKET_DELAY_STEP_MS не трябва да е променен от този fix')
})

// ─── F) Timer countdown warning pool-ът е непокътнат ───────────────────────

await check('[13] syncReactionCountdownWarning/ReactionCountdownLoop не са пипнати от този fix', () => {
  assert(audioControllerSrc.includes('type ReactionCountdownLoop = {'), 'ReactionCountdownLoop типът трябва да остане същия')
  const body = extractFunctionBody(
    audioControllerSrc,
    'function syncReactionCountdownWarning(shouldPlay: boolean): void',
    'syncReactionCountdownWarning',
  )
  assert(!/cardOnTablePool|cardMovePool|createPreloadedSfxPool/.test(body), 'Timer countdown warning не трябва да ползва новите card SFX pool helper-и')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
