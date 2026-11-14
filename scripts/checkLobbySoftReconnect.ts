/**
 * checkLobbySoftReconnect.ts — тихо възстановяване на игровия WS в лоби
 * контекст (src/app/network/createLobbySoftReconnect.ts + чистите функции в
 * socketReconnectPolicy.ts). Фалшиви таймери и време, без браузър.
 *
 *   [S1]  кратко прекъсване: лента веднага, без цял екран; същият процес +
 *         същата сесия + синхронизация -> възстановено, без reload
 *   [S2]  продължаващо прекъсване: цял екран точно след 15 s; възстановяване
 *         под 120 s пак е тихо (екранът се скрива)
 *   [S3]  прекъсване над 120 s -> reload 'stale' (без синхронизация)
 *   [S4]  друг backend процес / стар сървър без идентификатор -> reload 'restart'
 *   [S5]  сменена или изтекла сесия -> 'session'; грешка при проверката -> 'sync'
 *   [S6]  неуспешна/просрочена синхронизация (10 s) -> reload 'sync'
 *   [S7]  ново прекъсване по време на синхронизацията анулира стария опит
 *         (закъснели резултати се игнорират); 120 s се броят от първото затваряне
 *   [S8]  многократни прекъсвания: всяко се възстановява тихо, без reload цикъл;
 *         reload се вика най-много веднъж
 *   [S9]  без прекъсване 'connected' само обновява отправния процес
 *   [S10] jitter ±25% в граници; health 30 s / 3 s; класификация на екрана;
 *         адрес за reload с причина; сравнение на сесии
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkLobbySoftReconnect.ts
 */

import { createLobbySoftReconnect, type SoftReconnectSessionCheck } from '../src/app/network/createLobbySoftReconnect'
import {
  buildOfflineReloadUrl,
  classifyOfflineScreen,
  getHealthPollDelayMs,
  getReconnectDelayMs,
  isSameAuthSessionIdentity,
  OFFLINE_FULL_SCREEN_DELAY_MS,
  SOFT_RECONNECT_MAX_OUTAGE_MS,
  SOFT_RECONNECT_SYNC_TIMEOUT_MS,
} from '../src/app/network/socketReconnectPolicy'

let passed = 0
let failed = 0
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function createHarness(options: { session?: SoftReconnectSessionCheck | 'never'; lobbySync?: boolean | 'never' } = {}) {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const events: string[] = []
  let sessionResult: SoftReconnectSessionCheck | 'never' = options.session ?? 'same'
  let lobbySyncResult: boolean | 'never' = options.lobbySync ?? true
  const pendingSessionResolvers: Array<(value: SoftReconnectSessionCheck) => void> = []
  const pendingLobbyDone: Array<(ok: boolean) => void> = []

  const soft = createLobbySoftReconnect({
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = nextId++
      timers.set(id, { at: now + delayMs, callback })
      return id
    },
    clearTimeout: (id) => { timers.delete(id as number) },
    verifySession: () => new Promise((resolve) => {
      events.push('verifySession')
      if (sessionResult === 'never') pendingSessionResolvers.push(resolve)
      else resolve(sessionResult)
    }),
    onResumeLobby: () => events.push('resumeLobby'),
    syncLobby: (done) => {
      events.push('syncLobby')
      if (lobbySyncResult === 'never') pendingLobbyDone.push(done)
      else done(lobbySyncResult)
    },
    onShowBanner: () => events.push('banner'),
    onShowFullScreen: () => events.push('fullScreen'),
    onRecovered: () => events.push('recovered'),
    onReload: (via) => events.push(`reload:${via}`),
  })

  return {
    soft,
    events,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = due[1].at
        due[1].callback()
      }
      now = target
    },
    setSession(value: SoftReconnectSessionCheck | 'never') { sessionResult = value },
    setLobbySync(value: boolean | 'never') { lobbySyncResult = value },
    pendingSessionResolvers,
    pendingLobbyDone,
    count(prefix: string) { return events.filter((e) => e.startsWith(prefix)).length },
  }
}

console.log('\ncheckLobbySoftReconnect\n')

await check('[S1] Кратко прекъсване (3 s): лента, без цял екран; същият процес и сесия -> тихо възстановяване', async () => {
  const h = createHarness()
  h.soft.noteConnected('proc-A')
  h.soft.beginOutage()
  h.advance(3_000)
  assert(h.soft.handleOpen() === true, 'handleOpen трябва да поеме отварянето')
  h.soft.noteConnected('proc-A')
  await flush()
  assert(JSON.stringify(h.events) === JSON.stringify(['banner', 'resumeLobby', 'verifySession', 'syncLobby', 'recovered']), JSON.stringify(h.events))
  assert(!h.soft.isOutageActive(), 'прекъсването е приключило')
  h.advance(60_000)
  assert(h.count('fullScreen') === 0 && h.count('reload') === 0, JSON.stringify(h.events))
  assert(h.soft.handleOpen() === false, 'следващо отваряне без прекъсване е обикновено')
})

await check('[S2] Продължаващо прекъсване: цял екран точно на 15 s; възстановяване на 40 s -> пак тихо', async () => {
  const h = createHarness()
  h.soft.noteConnected('proc-A')
  h.soft.beginOutage()
  h.advance(OFFLINE_FULL_SCREEN_DELAY_MS - 1)
  assert(h.count('fullScreen') === 0, 'цял екран преди 15 s')
  h.advance(1)
  assert(h.count('fullScreen') === 1, 'цял екран на 15 s')
  h.advance(25_000)
  h.soft.handleOpen()
  h.soft.noteConnected('proc-A')
  await flush()
  assert(h.count('recovered') === 1 && h.count('reload') === 0, JSON.stringify(h.events))
})

await check('[S3] Прекъсване над 120 s -> reload stale при отварянето, без синхронизация', async () => {
  const h = createHarness()
  h.soft.noteConnected('proc-A')
  h.soft.beginOutage()
  h.advance(SOFT_RECONNECT_MAX_OUTAGE_MS + 1)
  assert(h.soft.handleOpen() === true, 'handleOpen')
  h.soft.noteConnected('proc-A')
  await flush()
  assert(h.count('reload:stale') === 1 && h.count('syncLobby') === 0 && h.count('recovered') === 0, JSON.stringify(h.events))
})

await check('[S4] Рестарт на backend (друг процес) и стар сървър без идентификатор -> reload restart', async () => {
  for (const nextInstance of ['proc-B', undefined, '']) {
    const h = createHarness()
    h.soft.noteConnected('proc-A')
    h.soft.beginOutage()
    h.advance(2_000)
    h.soft.handleOpen()
    h.soft.noteConnected(nextInstance)
    await flush()
    assert(h.count('reload:restart') === 1 && h.count('syncLobby') === 0, `${String(nextInstance)}: ${JSON.stringify(h.events)}`)
  }
  // Без нито едно 'connected' преди прекъсването — няма отправна точка -> reload.
  const h = createHarness()
  h.soft.beginOutage()
  h.soft.handleOpen()
  h.soft.noteConnected('proc-A')
  assert(h.count('reload:restart') === 1, JSON.stringify(h.events))
})

await check('[S5] Сменена/изтекла сесия -> reload session; грешка при проверката -> reload sync', async () => {
  for (const [session, via] of [['changed', 'session'], ['error', 'sync']] as const) {
    const h = createHarness({ session })
    h.soft.noteConnected('proc-A')
    h.soft.beginOutage()
    h.soft.handleOpen()
    h.soft.noteConnected('proc-A')
    await flush()
    assert(h.count(`reload:${via}`) === 1 && h.count('recovered') === 0, `${session}: ${JSON.stringify(h.events)}`)
  }
})

await check('[S6] Неуспешна синхронизация -> reload sync; просрочена (без отговор 10 s) -> reload sync', async () => {
  const failedSync = createHarness({ lobbySync: false })
  failedSync.soft.noteConnected('proc-A')
  failedSync.soft.beginOutage()
  failedSync.soft.handleOpen()
  failedSync.soft.noteConnected('proc-A')
  await flush()
  assert(failedSync.count('reload:sync') === 1, JSON.stringify(failedSync.events))

  const hanging = createHarness({ lobbySync: 'never' })
  hanging.soft.noteConnected('proc-A')
  hanging.soft.beginOutage()
  hanging.soft.handleOpen()
  hanging.soft.noteConnected('proc-A')
  await flush()
  hanging.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS - 1)
  assert(hanging.count('reload') === 0, 'преди срока')
  hanging.advance(1)
  assert(hanging.count('reload:sync') === 1, JSON.stringify(hanging.events))
  // Закъснял успешен отговор след reload — игнорира се.
  hanging.pendingLobbyDone.forEach((done) => done(true))
  await flush()
  assert(hanging.count('recovered') === 0 && hanging.count('reload') === 1, JSON.stringify(hanging.events))
})

await check('[S7] Ново прекъсване по време на синхронизацията анулира стария опит; 120 s от първото затваряне', async () => {
  const h = createHarness({ session: 'never', lobbySync: 'never' })
  h.soft.noteConnected('proc-A')
  h.soft.beginOutage()
  h.advance(5_000)
  h.soft.handleOpen()
  h.soft.noteConnected('proc-A')
  h.soft.beginOutage() // пада отново, преди синхронизацията да завърши
  // Закъснелите резултати от стария опит не възстановяват.
  h.pendingSessionResolvers.splice(0).forEach((resolve) => resolve('same'))
  h.pendingLobbyDone.splice(0).forEach((done) => done(true))
  await flush()
  assert(h.count('recovered') === 0 && h.count('reload') === 0 && h.soft.isOutageActive(), JSON.stringify(h.events))
  assert(h.count('banner') === 1, 'лентата не се показва повторно')
  // Старият срок на синхронизацията не стреля.
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS + 1)
  assert(h.count('reload') === 0, JSON.stringify(h.events))
  // 120 s се броят от ПЪРВОТО затваряне (5 s + 10 s + 106 s > 120 s).
  h.advance(106_000)
  h.soft.handleOpen()
  assert(h.count('reload:stale') === 1, JSON.stringify(h.events))
})

await check('[S8] Многократни кратки прекъсвания: всяко тихо, без reload цикъл', async () => {
  const h = createHarness()
  h.soft.noteConnected('proc-A')
  for (let i = 0; i < 6; i += 1) {
    h.soft.beginOutage()
    h.advance(2_000)
    h.soft.handleOpen()
    h.soft.noteConnected('proc-A')
    await flush()
    h.advance(20_000)
  }
  assert(h.count('recovered') === 6 && h.count('banner') === 6 && h.count('reload') === 0 && h.count('fullScreen') === 0, JSON.stringify(h.events))
  // След reload решение повторни сигнали не викат reload втори път.
  const r = createHarness()
  r.soft.noteConnected('proc-A')
  r.soft.beginOutage()
  r.soft.handleOpen()
  r.soft.noteConnected('proc-B')
  r.soft.beginOutage()
  r.soft.handleOpen()
  r.soft.noteConnected('proc-B')
  r.advance(200_000)
  assert(r.count('reload') === 1 && r.count('fullScreen') === 0, JSON.stringify(r.events))
})

await check('[S9] Без прекъсване: connected само обновява отправния процес (напр. след login)', async () => {
  const h = createHarness()
  h.soft.noteConnected('proc-A')
  h.soft.noteConnected('proc-B') // обикновено свързване към нов процес
  h.soft.beginOutage()
  h.soft.handleOpen()
  h.soft.noteConnected('proc-B')
  await flush()
  assert(h.count('recovered') === 1 && h.count('reload') === 0, JSON.stringify(h.events))
})

await check('[S10] Jitter, health интервали, класификация, адрес за reload, сравнение на сесии', () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const linear = Math.min(1_000 + attempt * 1_000, 5_000)
    const low = getReconnectDelayMs(attempt, 1_000, 5_000, () => 0)
    const high = getReconnectDelayMs(attempt, 1_000, 5_000, () => 0.999999)
    assert(low === Math.round(linear * 0.75) && Math.abs(high - linear * 1.25) <= 1, `attempt ${attempt}: ${low}..${high}`)
  }
  const samples = new Set(Array.from({ length: 50 }, () => getReconnectDelayMs(2, 1_000, 5_000)))
  assert(samples.size > 10, 'jitter-ът реално варира')
  assert(getHealthPollDelayMs(true) === 30_000 && getHealthPollDelayMs(false) === 3_000, 'health интервали')
  assert(classifyOfflineScreen(false) === 'internet' && classifyOfflineScreen(true) === 'server', 'класификация')
  assert(buildOfflineReloadUrl(123, 'restart') === '/lobby?offlineReload=123&via=restart', buildOfflineReloadUrl(123, 'restart'))
  assert(isSameAuthSessionIdentity(null, null), 'гост = гост')
  assert(isSameAuthSessionIdentity({ sessionId: 's', profileId: 'p' }, { sessionId: 's', profileId: 'p' }), 'същата')
  assert(!isSameAuthSessionIdentity({ sessionId: 's', profileId: 'p' }, null), 'изтекла')
  assert(!isSameAuthSessionIdentity(null, { sessionId: 's', profileId: 'p' }), 'нов login')
  assert(!isSameAuthSessionIdentity({ sessionId: 's', profileId: 'p' }, { sessionId: 's2', profileId: 'p' }), 'друга сесия')
  assert(!isSameAuthSessionIdentity({ sessionId: 's', profileId: 'p' }, { sessionId: 's', profileId: 'q' }), 'друг профил')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
