/**
 * checkReconnectDiagnosticsStage0.ts — Етап 0 (диагностика на тихото
 * възстановяване), клиентска страна. Фалшиви таймери и време, без браузър.
 *
 * Проверява, че координаторът (createLobbySoftReconnect) съобщава КОНКРЕТНАТА
 * причина и номера на опита при презареждане, без да променя решенията:
 * via стойностите и моментите на презареждане са същите като преди.
 *
 *   [D1] buildOfflineReloadUrl: без detail — непроменен адрес; с detail —
 *        reason/attempt/outageMs/code; code се почиства
 *   [D2] активна стая: HTTP проверката не отговаря -> via=sync, reason=auth_timeout
 *   [D3] resume_room изпратен, отговор няма -> via=sync, reason=resume_timeout;
 *        syncActiveRoom получава номера на опита
 *   [D4] отказ от сървъра -> via=sync, reason=resume_refused + code
 *   [D5] сменена сесия -> via=session/session_changed; грешка -> sync/auth_error;
 *        отхвърлен promise -> auth_error; done(false) без причина -> resume_failed
 *   [D6] номер на опита: расте при повторно connected в същото прекъсване,
 *        започва от 1 в ново прекъсване
 *   [D7] друг backend процес -> restart; над 120 s -> stale
 *   [D8] лоби контекст: auth_timeout / lobby_sync_timeout / lobby_sync_failed
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkReconnectDiagnosticsStage0.ts
 */

import { createLobbySoftReconnect, type SoftReconnectSessionCheck, type SoftReconnectSyncFailure } from '../src/app/network/createLobbySoftReconnect'
import {
  buildOfflineReloadUrl,
  SOFT_RECONNECT_MAX_OUTAGE_MS,
  SOFT_RECONNECT_SYNC_TIMEOUT_MS,
  type OfflineReloadDetail,
  type OfflineReloadVia,
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

function createHarness() {
  let now = 5_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const reloads: Array<{ via: OfflineReloadVia; detail: OfflineReloadDetail | undefined; at: number }> = []
  const syncAttempts: number[] = []
  let recovered = 0
  let sessionResolvers: Array<{ resolve: (value: SoftReconnectSessionCheck) => void; reject: (error: unknown) => void }> = []
  let syncDone: ((ok: boolean, failure?: SoftReconnectSyncFailure) => void) | null = null
  let lobbyDone: ((ok: boolean) => void) | null = null
  const coordinator = createLobbySoftReconnect({
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = nextId++
      timers.set(id, { at: now + delayMs, callback })
      return id
    },
    clearTimeout: (id) => { timers.delete(id as number) },
    verifySession: () => new Promise((resolve, reject) => { sessionResolvers.push({ resolve, reject }) }),
    onResumeLobby: () => {},
    syncLobby: (done) => { lobbyDone = done },
    syncActiveRoom: (done, attempt) => { syncAttempts.push(attempt); syncDone = done },
    onShowBanner: () => {},
    onShowActiveRoomOutage: () => {},
    onShowFullScreen: () => {},
    onRecovered: () => { recovered += 1 },
    onReload: (via, detail) => { reloads.push({ via, detail, at: now }) },
  })
  function advance(ms: number): void {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = target
  }
  return {
    coordinator,
    reloads,
    syncAttempts,
    advance,
    get now() { return now },
    get recovered() { return recovered },
    resolveSession: (value: SoftReconnectSessionCheck) => { const r = sessionResolvers.shift(); assert(r, 'няма чакаща проверка на сесията'); r.resolve(value) },
    rejectSession: () => { const r = sessionResolvers.shift(); assert(r, 'няма чакаща проверка на сесията'); r.reject(new Error('network')) },
    finishSync: (ok: boolean, failure?: SoftReconnectSyncFailure) => { const d = syncDone; syncDone = null; assert(d, 'няма чакащ resume'); d(ok, failure) },
    finishLobby: (ok: boolean) => { const d = lobbyDone; lobbyDone = null; assert(d, 'няма чакаща лоби синхронизация'); d(ok) },
    hasPendingSync: () => syncDone !== null,
  }
}

/** Прекъсване -> отворен socket -> connected от същия процес. */
function reconnect(h: ReturnType<typeof createHarness>, context: 'lobby' | 'active_room' = 'active_room', downMs = 2_000): void {
  h.coordinator.beginOutage(context)
  h.advance(downMs)
  assert(h.coordinator.handleOpen() === true, 'handleOpen трябва да поеме отварянето')
  h.coordinator.noteConnected('server-A')
}

function primed(): ReturnType<typeof createHarness> {
  const h = createHarness()
  h.coordinator.noteConnected('server-A') // отправен процес
  return h
}

console.log('\ncheckReconnectDiagnosticsStage0\n')

await check('[D1] buildOfflineReloadUrl: без detail непроменен; с detail — reason/attempt/outageMs/code; code се почиства', () => {
  assert(buildOfflineReloadUrl(123, 'sync') === '/lobby?offlineReload=123&via=sync', buildOfflineReloadUrl(123, 'sync'))
  const full = buildOfflineReloadUrl(123, 'sync', { reason: 'resume_refused', attempt: 2, outageMs: 10_432.6, code: 'other_session_active' })
  assert(full === '/lobby?offlineReload=123&via=sync&reason=resume_refused&attempt=2&outageMs=10433&code=other_session_active', full)
  const bad = buildOfflineReloadUrl(1, 'sync', { reason: 'resume_refused', attempt: 1, outageMs: 5, code: 'Bad Code&x=1' })
  assert(bad.endsWith('&code=other') && !bad.includes('x=1'), bad)
  const bounded = buildOfflineReloadUrl(1, 'stale', { reason: 'stale', attempt: -3, outageMs: Number.NaN })
  assert(bounded === '/lobby?offlineReload=1&via=stale&reason=stale&attempt=0&outageMs=0', bounded)
  assert(full.startsWith('/lobby?offlineReload=123&via=sync&'), 'via трябва да остане преди новите параметри')
})

await check('[D2] активна стая: HTTP проверката на сесията не отговаря -> via=sync, reason=auth_timeout, след точно 10 s', async () => {
  const h = primed()
  reconnect(h)
  const connectedAt = h.now
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS - 1)
  assert(h.reloads.length === 0, 'преждевременен reload')
  h.advance(1)
  assert(h.reloads.length === 1, `reload-и: ${h.reloads.length}`)
  const r = h.reloads[0]!
  assert(r.via === 'sync' && r.detail?.reason === 'auth_timeout', JSON.stringify(r))
  assert(r.detail.attempt === 1, `attempt=${r.detail.attempt}`)
  assert(r.at - connectedAt === SOFT_RECONNECT_SYNC_TIMEOUT_MS, 'моментът на reload е променен')
  assert(r.detail.outageMs === 2_000 + SOFT_RECONNECT_SYNC_TIMEOUT_MS, `outageMs=${r.detail.outageMs}`)
  assert(h.syncAttempts.length === 0, 'resume_room не трябва да тръгва без потвърдена сесия')
})

await check('[D3] resume_room изпратен без отговор -> via=sync, reason=resume_timeout; syncActiveRoom получава attempt=1', async () => {
  const h = primed()
  reconnect(h)
  h.resolveSession('same')
  await flush()
  assert(h.syncAttempts.join(',') === '1', `attempts: ${h.syncAttempts.join(',')}`)
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  assert(h.reloads.length === 1 && h.reloads[0]!.via === 'sync' && h.reloads[0]!.detail?.reason === 'resume_timeout', JSON.stringify(h.reloads))
})

await check('[D4] отказ от сървъра -> via=sync, reason=resume_refused, code=other_session_active; веднага, не след 10 s', async () => {
  const h = primed()
  reconnect(h)
  h.resolveSession('same')
  await flush()
  h.advance(300)
  h.finishSync(false, { reason: 'resume_refused', code: 'other_session_active' })
  assert(h.reloads.length === 1, `reload-и: ${h.reloads.length}`)
  const d = h.reloads[0]!.detail!
  assert(h.reloads[0]!.via === 'sync' && d.reason === 'resume_refused' && d.code === 'other_session_active', JSON.stringify(h.reloads[0]))
  assert(d.outageMs === 2_300, `outageMs=${d.outageMs}`)
})

await check('[D5] сменена сесия -> session/session_changed; грешка -> sync/auth_error; отхвърлен promise -> auth_error; done(false) без причина -> resume_failed', async () => {
  const cases: Array<{ run: (h: ReturnType<typeof createHarness>) => Promise<void>; via: OfflineReloadVia; reason: string }> = [
    { run: async (h) => { h.resolveSession('changed'); await flush() }, via: 'session', reason: 'session_changed' },
    { run: async (h) => { h.resolveSession('error'); await flush() }, via: 'sync', reason: 'auth_error' },
    { run: async (h) => { h.rejectSession(); await flush(); await flush() }, via: 'sync', reason: 'auth_error' },
    { run: async (h) => { h.resolveSession('same'); await flush(); h.finishSync(false) }, via: 'sync', reason: 'resume_failed' },
  ]
  for (const c of cases) {
    const h = primed()
    reconnect(h)
    await c.run(h)
    assert(h.reloads.length === 1, `${c.reason}: reload-и ${h.reloads.length}`)
    assert(h.reloads[0]!.via === c.via && h.reloads[0]!.detail?.reason === c.reason, `${c.reason}: ${JSON.stringify(h.reloads[0])}`)
  }
})

await check('[D6] номер на опита: 2 при второ connected в същото прекъсване; ново прекъсване след успех започва от 1', async () => {
  const h = primed()
  reconnect(h)
  h.resolveSession('same')
  await flush()
  assert(h.syncAttempts.join(',') === '1', h.syncAttempts.join(','))
  // Връзката пада отново по време на опита — същото прекъсване.
  h.coordinator.beginOutage('active_room')
  h.advance(1_000)
  assert(h.coordinator.handleOpen() === true, 'handleOpen')
  h.coordinator.noteConnected('server-A')
  h.resolveSession('same')
  await flush()
  assert(h.syncAttempts.join(',') === '1,2', h.syncAttempts.join(','))
  h.finishSync(true)
  assert(h.recovered === 1 && h.reloads.length === 0, 'трябва да е възстановено без reload')
  // Ново прекъсване: броячът започва отначало.
  reconnect(h)
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  assert(h.reloads.length === 1 && h.reloads[0]!.detail?.attempt === 1 && h.reloads[0]!.detail.reason === 'auth_timeout', JSON.stringify(h.reloads))
})

await check('[D7] друг backend процес -> via=restart/reason=restart; отворен socket след 120 s -> stale/stale', () => {
  const h = primed()
  h.coordinator.beginOutage('active_room')
  h.advance(1_000)
  h.coordinator.handleOpen()
  h.coordinator.noteConnected('server-B')
  assert(h.reloads.length === 1 && h.reloads[0]!.via === 'restart' && h.reloads[0]!.detail?.reason === 'restart' && h.reloads[0]!.detail.attempt === 0, JSON.stringify(h.reloads))
  const s = primed()
  s.coordinator.beginOutage('active_room')
  s.advance(SOFT_RECONNECT_MAX_OUTAGE_MS - 1)
  // Цял екран на 120 s е досегашният fallback — тук само отваряне след лимита.
  s.advance(2)
  s.coordinator.handleOpen()
  assert(s.reloads.length === 1 && s.reloads[0]!.via === 'stale' && s.reloads[0]!.detail?.reason === 'stale', JSON.stringify(s.reloads))
})

await check('[D8] лоби контекст: auth_timeout / lobby_sync_timeout / lobby_sync_failed (via непроменено = sync)', async () => {
  const a = primed()
  reconnect(a, 'lobby')
  a.finishLobby(true)
  a.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  assert(a.reloads.length === 1 && a.reloads[0]!.via === 'sync' && a.reloads[0]!.detail?.reason === 'auth_timeout', JSON.stringify(a.reloads))
  const b = primed()
  reconnect(b, 'lobby')
  b.resolveSession('same')
  await flush()
  b.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  assert(b.reloads.length === 1 && b.reloads[0]!.via === 'sync' && b.reloads[0]!.detail?.reason === 'lobby_sync_timeout', JSON.stringify(b.reloads))
  const c = primed()
  reconnect(c, 'lobby')
  c.finishLobby(false)
  assert(c.reloads.length === 1 && c.reloads[0]!.via === 'sync' && c.reloads[0]!.detail?.reason === 'lobby_sync_failed', JSON.stringify(c.reloads))
  const ok = primed()
  reconnect(ok, 'lobby')
  ok.resolveSession('same')
  await flush()
  ok.finishLobby(true)
  assert(ok.recovered === 1 && ok.reloads.length === 0, 'успешното възстановяване не трябва да презарежда')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
