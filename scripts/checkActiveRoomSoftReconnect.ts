/**
 * checkActiveRoomSoftReconnect.ts — Етап 2: координаторът за тихо
 * възстановяване (createLobbySoftReconnect) в контекст 'active_room'.
 * Фалшиви таймери и време, без браузър.
 *
 *   [A1] кратко прекъсване: съобщението в стаята, без лоби лента и без цял
 *        екран след 15 s; същият процес + същата сесия + resume -> възстановено
 *   [A2] ПОСЛЕДОВАТЕЛНО: resume_room (syncActiveRoom) не тръгва, преди
 *        проверката на сесията да е завършила успешно
 *   [A3] сменена сесия -> reload 'session', БЕЗ resume_room; грешка -> 'sync'
 *   [A4] друг backend процес -> reload 'restart' (без проверки и resume)
 *   [A5] неуспешен/просрочен resume -> reload 'sync'
 *   [A6] над 120 s -> 'stale'; цял екран (досегашният fallback) едва на 120 s
 *   [A7] ново прекъсване по време на опита: закъснелият отговор на стария
 *        опит се игнорира; новият опит минава отначало
 *   [A8] многократни кратки прекъсвания — всяко тихо; reload най-много веднъж
 *   [A9] лоби контекстът е непроменен (лента + цял екран на 15 s, паралелно)
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkActiveRoomSoftReconnect.ts
 */

import { createLobbySoftReconnect, type SoftReconnectSessionCheck } from '../src/app/network/createLobbySoftReconnect'
import { OFFLINE_FULL_SCREEN_DELAY_MS, SOFT_RECONNECT_MAX_OUTAGE_MS, SOFT_RECONNECT_SYNC_TIMEOUT_MS } from '../src/app/network/socketReconnectPolicy'

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

function createHarness() {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const events: string[] = []
  let resolveSession: ((value: SoftReconnectSessionCheck) => void) | null = null
  let syncDone: ((ok: boolean) => void) | null = null
  let lobbySyncDone: ((ok: boolean) => void) | null = null

  const coordinator = createLobbySoftReconnect({
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = nextId++
      timers.set(id, { at: now + delayMs, callback })
      return id
    },
    clearTimeout: (id) => { timers.delete(id as number) },
    verifySession: () => {
      events.push('verifySession')
      return new Promise<SoftReconnectSessionCheck>((resolve) => { resolveSession = resolve })
    },
    onResumeLobby: () => events.push('onResumeLobby'),
    syncLobby: (done) => { events.push('syncLobby'); lobbySyncDone = done },
    syncActiveRoom: (done) => { events.push('syncActiveRoom'); syncDone = done },
    onShowBanner: () => events.push('banner'),
    onShowActiveRoomOutage: () => events.push('activeRoomOutage'),
    onShowFullScreen: () => events.push('fullScreen'),
    onRecovered: (context) => events.push(`recovered:${context}`),
    onReload: (via) => events.push(`reload:${via}`),
  })

  return {
    coordinator,
    events,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].callback()
      }
      now = target
    },
    async session(value: SoftReconnectSessionCheck) {
      const resolve = resolveSession
      resolveSession = null
      resolve?.(value)
      await flush()
    },
    takeSyncDone() { const done = syncDone; syncDone = null; return done },
    takeLobbySyncDone() { const done = lobbySyncDone; lobbySyncDone = null; return done },
  }
}

const SERVER = 'srv-1'
function connectedOnce(h: ReturnType<typeof createHarness>): void {
  h.coordinator.noteConnected(SERVER)
}

await check('[A1] кратко прекъсване в игра: съобщението в стаята, без лоби лента/цял екран на 15 s; успешно възстановяване', async () => {
  const h = createHarness()
  connectedOnce(h)
  h.coordinator.beginOutage('active_room')
  assert(h.events.includes('activeRoomOutage') && !h.events.includes('banner'), JSON.stringify(h.events))
  h.advance(OFFLINE_FULL_SCREEN_DELAY_MS + 5_000)
  assert(!h.events.includes('fullScreen'), 'цял екран след 15 s')
  assert(h.coordinator.handleOpen() === true, 'handleOpen')
  h.coordinator.noteConnected(SERVER)
  await h.session('same')
  const done = h.takeSyncDone()
  assert(done !== null, 'resume не тръгна')
  done(true)
  assert(h.events.at(-1) === 'recovered:active_room', JSON.stringify(h.events))
  assert(!h.events.some((e) => e.startsWith('reload')), 'reload')
  assert(!h.coordinator.isOutageActive() && h.coordinator.getOutageContext() === null, 'прекъсването не е приключено')
})

await check('[A2] resume_room тръгва едва след успешна проверка на сесията (последователно, не паралелно)', async () => {
  const h = createHarness()
  connectedOnce(h)
  h.coordinator.beginOutage('active_room')
  h.coordinator.handleOpen()
  h.coordinator.noteConnected(SERVER)
  await flush()
  assert(h.events.includes('verifySession') && !h.events.includes('syncActiveRoom'), `преди сесията: ${JSON.stringify(h.events)}`)
  assert(!h.events.includes('onResumeLobby') && !h.events.includes('syncLobby'), 'лоби синхронизация в игра')
  await h.session('same')
  assert(h.events.indexOf('syncActiveRoom') > h.events.indexOf('verifySession'), JSON.stringify(h.events))
})

await check('[A3] сменена сесия -> reload session без resume_room; грешка -> reload sync без resume_room', async () => {
  for (const [session, via] of [['changed', 'session'], ['error', 'sync']] as const) {
    const h = createHarness()
    connectedOnce(h)
    h.coordinator.beginOutage('active_room')
    h.coordinator.handleOpen()
    h.coordinator.noteConnected(SERVER)
    await h.session(session)
    assert(!h.events.includes('syncActiveRoom'), `${session}: resume_room тръгна`)
    assert(h.events.at(-1) === `reload:${via}`, `${session}: ${JSON.stringify(h.events)}`)
  }
})

await check('[A4] друг backend процес -> reload restart (без проверка на сесията и resume)', async () => {
  const h = createHarness()
  connectedOnce(h)
  h.coordinator.beginOutage('active_room')
  h.coordinator.handleOpen()
  h.coordinator.noteConnected('srv-2')
  await flush()
  assert(h.events.at(-1) === 'reload:restart', JSON.stringify(h.events))
  assert(!h.events.includes('verifySession') && !h.events.includes('syncActiveRoom'), JSON.stringify(h.events))
})

await check('[A5] отказан resume -> reload sync; липсващ отговор (10 s) -> reload sync', async () => {
  const h = createHarness()
  connectedOnce(h)
  h.coordinator.beginOutage('active_room')
  h.coordinator.handleOpen()
  h.coordinator.noteConnected(SERVER)
  await h.session('same')
  h.takeSyncDone()!(false)
  assert(h.events.at(-1) === 'reload:sync', JSON.stringify(h.events))

  const h2 = createHarness()
  connectedOnce(h2)
  h2.coordinator.beginOutage('active_room')
  h2.coordinator.handleOpen()
  h2.coordinator.noteConnected(SERVER)
  await h2.session('same')
  h2.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS + 1)
  assert(h2.events.at(-1) === 'reload:sync', JSON.stringify(h2.events))
  // Закъснял успех след просрочване не възстановява.
  h2.takeSyncDone()?.(true)
  assert(!h2.events.includes('recovered:active_room'), 'закъснял успех беше приет')
})

await check('[A6] над 120 s -> stale; цял екран (досегашният fallback) едва на 120 s', async () => {
  const h = createHarness()
  connectedOnce(h)
  h.coordinator.beginOutage('active_room')
  h.advance(SOFT_RECONNECT_MAX_OUTAGE_MS - 1_000)
  assert(!h.events.includes('fullScreen'), 'цял екран преди 120 s')
  h.advance(2_000)
  assert(h.events.includes('fullScreen'), 'няма цял екран след 120 s')
  h.coordinator.handleOpen()
  assert(h.events.at(-1) === 'reload:stale', JSON.stringify(h.events))
})

await check('[A7] ново прекъсване по време на опита: закъснелият отговор на стария опит се игнорира', async () => {
  const h = createHarness()
  connectedOnce(h)
  h.coordinator.beginOutage('active_room')
  h.coordinator.handleOpen()
  h.coordinator.noteConnected(SERVER)
  await h.session('same')
  const staleDone = h.takeSyncDone()!
  h.coordinator.beginOutage('active_room') // нов срив по време на resume
  staleDone(true)
  assert(!h.events.includes('recovered:active_room') && h.coordinator.isOutageActive(), 'старият отговор възстанови')
  assert(h.coordinator.getOutageContext() === 'active_room', 'контекстът се загуби')
  h.coordinator.handleOpen()
  h.coordinator.noteConnected(SERVER)
  await h.session('same')
  h.takeSyncDone()!(true)
  assert(h.events.at(-1) === 'recovered:active_room', JSON.stringify(h.events))
  assert(h.events.filter((e) => e === 'activeRoomOutage').length === 1, 'съобщението се показа повторно като ново прекъсване')
})

await check('[A8] 4 поредни кратки прекъсвания — всяко тихо, без reload', async () => {
  const h = createHarness()
  connectedOnce(h)
  for (let i = 0; i < 4; i += 1) {
    h.coordinator.beginOutage('active_room')
    h.advance(1_500)
    h.coordinator.handleOpen()
    h.coordinator.noteConnected(SERVER)
    await h.session('same')
    h.takeSyncDone()!(true)
    h.advance(1_500)
  }
  assert(h.events.filter((e) => e === 'recovered:active_room').length === 4, JSON.stringify(h.events))
  assert(!h.events.some((e) => e.startsWith('reload')), 'reload')
})

await check('[A9] лоби контекст — непроменен: лента, цял екран на 15 s, паралелна синхронизация', async () => {
  const h = createHarness()
  connectedOnce(h)
  h.coordinator.beginOutage()
  assert(h.events.includes('banner') && !h.events.includes('activeRoomOutage'), JSON.stringify(h.events))
  h.advance(OFFLINE_FULL_SCREEN_DELAY_MS + 1)
  assert(h.events.includes('fullScreen'), 'няма цял екран на 15 s')
  h.coordinator.handleOpen()
  h.coordinator.noteConnected(SERVER)
  await flush()
  assert(h.events.includes('verifySession') && h.events.includes('syncLobby') && h.events.includes('onResumeLobby'), `паралелно: ${JSON.stringify(h.events)}`)
  assert(!h.events.includes('syncActiveRoom'), 'resume_room в лоби контекст')
  h.takeLobbySyncDone()!(true)
  await h.session('same')
  assert(h.events.at(-1) === 'recovered:lobby', JSON.stringify(h.events))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
