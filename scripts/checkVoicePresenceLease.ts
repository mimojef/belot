/**
 * checkVoicePresenceLease.ts
 *
 * Гласов чат, етап Б — присъствие (lease) в браузъра: истинският
 * createVoiceController срещу fake адаптер (scripts/fixtures/voiceControllerFakeHarness.ts).
 *
 *   * преди ВСЕКИ токен има потвърдено присъствие: първо включване,
 *     възстановяване след загубена връзка, ротация, изтрита стая и нов
 *     токен за говорене;
 *   * подновяването се отброява от последното изпратено присъствие —
 *     свързване/ротация не го отлагат; паузата между две присъствия никога
 *     не надхвърля периода (20 s);
 *   * без игрова връзка няма опити; при връщането ѝ присъствието се изпраща
 *     веднага.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoicePresenceLease.ts
 */

import { TABLE, createHarness, flush, joinWithMic, serverDisconnect, snap, type Harness } from './fixtures/voiceControllerFakeHarness'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

const at = (event: string): number => Number(event.split('@')[1])
const presenceTimes = (h: Harness): number[] => h.events.filter((e) => e.startsWith('presence:on')).map(at)
const tokenTimes = (h: Harness): number[] => h.events.filter((e) => e.startsWith('token')).map(at)

/** Всеки токен е предшестван от присъствие в рамките на същия опит (≤ 1 s по-рано, без друг токен между тях). */
function assertPresenceBeforeEveryToken(h: Harness, label: string): void {
  let lastPresence: number | null = null
  for (const event of h.events) {
    if (event.startsWith('presence:on')) lastPresence = at(event)
    if (event.startsWith('token')) {
      assert(lastPresence !== null && at(event) - lastPresence <= 1_000, `${label}: токен без скорошно присъствие (${h.events.join(', ')})`)
      lastPresence = null
    }
  }
}

/** Максимална пауза между последователни присъствия в интервала. */
function maxGap(h: Harness, until: number): number {
  const times = presenceTimes(h)
  let gap = 0
  for (let index = 1; index < times.length; index += 1) gap = Math.max(gap, times[index]! - times[index - 1]!)
  if (times.length > 0) gap = Math.max(gap, until - times[times.length - 1]!)
  return gap
}

async function rotate(h: Harness): Promise<void> {
  h.backend.generation += 1
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: false } as never)
  await flush(30)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: true } as never)
  await flush(30)
}

console.log('\ncheckVoicePresenceLease\n')

await check('[PL1] Първо включване: присъствие -> токен', async () => {
  const h = createHarness()
  await joinWithMic(h)
  assertEqual(snap(h).microphone, 'live', 'включен')
  assertPresenceBeforeEveryToken(h, 'включване')
})

await check('[PL2] Ротация на 19-ата секунда: присъствие ПРЕДИ новия токен; следващото подновяване е 20 s след него (не се отлага)', async () => {
  const h = createHarness()
  await joinWithMic(h)
  const start = h.clock.now()
  await h.clock.advance(19_000)
  await rotate(h)
  assertPresenceBeforeEveryToken(h, 'ротация')
  const lastPresence = presenceTimes(h).at(-1)!
  assertEqual(lastPresence, start + 19_000, 'присъствие при ротацията')
  await h.clock.advance(19_900)
  assertEqual(presenceTimes(h).at(-1), lastPresence, 'без ранно подновяване')
  await h.clock.advance(200)
  assertEqual(presenceTimes(h).at(-1), lastPresence + 20_000, 'подновяване точно 20 s след последното присъствие')
})

await check('[PL3] Загубена връзка -> възстановяване: присъствие преди токена (микрофонът — по сегашното правило слушане; авто-възстановяването е етап В)', async () => {
  const h = createHarness()
  await joinWithMic(h)
  await h.clock.advance(15_000)
  serverDisconnect(h.fake.state.last(), 'connection_lost')
  await flush(20)
  await h.clock.advance(2_500)
  await flush(30)
  assertEqual(snap(h).status, 'connected_listening', 'възстановен (слушане)')
  assertPresenceBeforeEveryToken(h, 'възстановяване')
})

await check('[PL4] Изтрита стая (ROOM_DELETED) и нов токен за говорене: присъствие преди всеки токен', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  h.voice.joinAsListener()
  await flush(30)
  h.backend.generation = 2
  serverDisconnect(h.fake.state.last(), 'room_deleted')
  await flush(20)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: true } as never)
  await flush(30)
  assertEqual(snap(h).status, 'connected_listening', 'в новата стая')
  assertPresenceBeforeEveryToken(h, 'изтрита стая')
})

await check('[PL5] Много прекъсвания (ротация, загуба, ротация) за 60 s: паузата между две присъствия никога не надхвърля 20 s; lease (60 s) не може да изтече', async () => {
  const h = createHarness()
  await joinWithMic(h)
  const start = h.clock.now()
  await h.clock.advance(12_000)
  await rotate(h)
  await h.clock.advance(14_000)
  serverDisconnect(h.fake.state.last(), 'connection_lost')
  await flush(20)
  await h.clock.advance(2_500)
  await flush(30)
  await h.clock.advance(17_000)
  await rotate(h)
  await h.clock.advance(30_000)
  const gap = maxGap(h, h.clock.now())
  assert(gap <= 20_000, `максимална пауза ${gap} ms (${presenceTimes(h).map((t) => t - start).join(', ')})`)
  assertPresenceBeforeEveryToken(h, 'серия')
})

await check('[PL6] Без игрова връзка: няма подновявания; при връщането — присъствие веднага и нов 20 s цикъл', async () => {
  const h = createHarness()
  await joinWithMic(h)
  const before = presenceTimes(h).length
  h.voice.setGameConnection(false)
  await h.clock.advance(45_000)
  assertEqual(presenceTimes(h).length, before, 'без опити без игрова връзка')
  h.voice.setGameConnection(true)
  await flush()
  const back = presenceTimes(h).at(-1)!
  assertEqual(back, h.clock.now(), 'присъствие веднага')
  await h.clock.advance(20_100)
  assertEqual(presenceTimes(h).at(-1), back + 20_000, 'следващото след 20 s')
})

await check('[PL7] Отказано присъствие при ротация -> без токен (няма заявка с изтичащ lease)', async () => {
  const h = createHarness()
  await joinWithMic(h)
  const tokensBefore = tokenTimes(h).length
  h.backend.presenceFailure = 'not_seat_connection'
  await rotate(h)
  assertEqual(tokenTimes(h).length, tokensBefore, 'без нов токен при отказано присъствие')
})

await check('[PL8] ROOM_DELETED и веднага ready:true (production последователността): ЕДИН опит за възстановяване — едно присъствие, един токен, без „недостъпен“', async () => {
  const h = createHarness()
  await joinWithMic(h)
  const presenceBefore = presenceTimes(h).length
  const tokensBefore = tokenTimes(h).length
  h.backend.generation = 2
  serverDisconnect(h.fake.state.last(), 'room_deleted')
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: true } as never)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: true } as never)
  await flush(40)
  await h.clock.advance(6_000)
  assertEqual(presenceTimes(h).length - presenceBefore, 1, 'едно присъствие за възстановяването')
  assertEqual(tokenTimes(h).length - tokensBefore, 1, 'един токен')
  // (Запазването на живия микрофон при ROOM_DELETED се проверява в checkVoiceController RD1 — този fake не предава capture-а.)
  assertEqual(snap(h).status, 'connected_listening', 'свързан, без „недостъпен“')
  assert(!h.reports.some((r) => r.event === 'session_end'), 'без прекратяване')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
