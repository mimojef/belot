/**
 * checkActiveRoomWsIdentityResume.ts — Етап 2: тихото възстановяване на
 * активна Белот маса потвърждава сесията от 'connected' (WS handshake), без
 * да чака /api/auth/me. Фалшиви таймери, без браузър.
 *
 *   [W1] същата сесия -> resume_room веднага; /api/auth/me НЕ се вика (блокиран
 *        HTTP няма значение); възстановено с authCheck=ws
 *   [W2] сменена сесия (друг authRef) -> via=session, без resume_room
 *   [W3] изтекла/оттеглена сесия (authRef null) -> via=session, code ws_session_missing
 *   [W4] друг профил (спрямо отпреди прекъсването или спрямо текущия) -> via=session
 *   [W5] стар сървър (без полетата) -> досегашният HTTP път (сесията първо)
 *   [W6] смесено: отправната точка от нов, новата връзка от стар сървър -> HTTP път
 *   [W7] WS път: resume без отговор -> sync/resume_timeout след 10 s (непроменен
 *        срок); отказ other_session_active -> resume_refused; адресът носи authCheck=ws
 *   [W8] свързване извън прекъсване (login/logout) обновява отправната точка
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkActiveRoomWsIdentityResume.ts
 */
import {
  createLobbySoftReconnect,
  type ConnectedAuthIdentity,
  type SoftReconnectAuthCheck,
  type SoftReconnectSessionCheck,
  type SoftReconnectSyncFailure,
} from '../src/app/network/createLobbySoftReconnect'
import { buildOfflineReloadUrl, SOFT_RECONNECT_SYNC_TIMEOUT_MS, type OfflineReloadDetail, type OfflineReloadVia } from '../src/app/network/socketReconnectPolicy'

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

const ME: ConnectedAuthIdentity = { authRef: 'ref-session-A', profileId: 'profile-me' }

function createHarness(expectedProfileId: string | null = 'profile-me') {
  let now = 9_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const reloads: Array<{ via: OfflineReloadVia; detail: OfflineReloadDetail | undefined }> = []
  const recovered: Array<{ context: string; authCheck: SoftReconnectAuthCheck | undefined }> = []
  const syncAttempts: number[] = []
  let verifyCalls = 0
  let sessionResolver: ((value: SoftReconnectSessionCheck) => void) | null = null
  let syncDone: ((ok: boolean, failure?: SoftReconnectSyncFailure) => void) | null = null
  let expected = expectedProfileId
  const coordinator = createLobbySoftReconnect({
    now: () => now,
    setTimeout: (callback, delayMs) => { const id = nextId++; timers.set(id, { at: now + delayMs, callback }); return id },
    clearTimeout: (id) => { timers.delete(id as number) },
    // /api/auth/me „блокиран“: обещанието никога не се изпълнява, освен ако тестът не го реши.
    verifySession: () => { verifyCalls += 1; return new Promise((resolve) => { sessionResolver = resolve }) },
    onResumeLobby: () => {},
    syncLobby: () => {},
    syncActiveRoom: (done, attempt) => { syncAttempts.push(attempt); syncDone = done },
    onShowBanner: () => {},
    onShowActiveRoomOutage: () => {},
    onShowFullScreen: () => {},
    onRecovered: (context, info) => { recovered.push({ context, authCheck: info?.authCheck }) },
    onReload: (via, detail) => { reloads.push({ via, detail }) },
    getExpectedProfileId: () => expected,
  })
  function advance(ms: number): void {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = target
  }
  return {
    coordinator, reloads, recovered, syncAttempts, advance,
    verifyCalls: () => verifyCalls,
    resolveSession: (v: SoftReconnectSessionCheck) => { assert(sessionResolver, 'няма HTTP проверка'); sessionResolver(v) },
    finishSync: (ok: boolean, failure?: SoftReconnectSyncFailure) => { const d = syncDone; syncDone = null; assert(d, 'няма resume'); d(ok, failure) },
    setExpectedProfile: (id: string | null) => { expected = id },
    /** Прекъсване в активна стая -> нова връзка -> connected. */
    drop: (identity: ConnectedAuthIdentity | undefined) => {
      coordinator.beginOutage('active_room')
      advance(1_500)
      assert(coordinator.handleOpen(), 'handleOpen')
      coordinator.noteConnected('server-A', identity)
    },
  }
}

console.log('\ncheckActiveRoomWsIdentityResume\n')

await check('[W1] същата сесия -> resume_room веднага, без /api/auth/me; възстановено с authCheck=ws', async () => {
  const h = createHarness()
  h.coordinator.noteConnected('server-A', ME)
  h.drop({ ...ME })
  assert(h.syncAttempts.join(',') === '1', `resume_room не тръгна веднага: ${h.syncAttempts.join(',')}`)
  assert(h.verifyCalls() === 0, 'чака се /api/auth/me')
  h.advance(50)
  h.finishSync(true)
  assert(h.recovered.length === 1 && h.recovered[0]!.context === 'active_room' && h.recovered[0]!.authCheck === 'ws', JSON.stringify(h.recovered))
  assert(h.reloads.length === 0, 'reload')
})

await check('[W2] сменена удостоверителна сесия (друг authRef) -> via=session, без resume_room', () => {
  const h = createHarness()
  h.coordinator.noteConnected('server-A', ME)
  h.drop({ authRef: 'ref-session-B', profileId: 'profile-me' })
  assert(h.syncAttempts.length === 0 && h.verifyCalls() === 0, 'resume_room/HTTP при сменена сесия')
  const r = h.reloads[0]
  assert(r?.via === 'session' && r.detail?.reason === 'session_changed' && r.detail.code === 'ws_identity_changed' && r.detail.authCheck === 'ws', JSON.stringify(h.reloads))
})

await check('[W3] изтекла или оттеглена сесия (authRef null) -> via=session, code ws_session_missing', () => {
  const h = createHarness()
  h.coordinator.noteConnected('server-A', ME)
  h.drop({ authRef: null, profileId: null })
  assert(h.syncAttempts.length === 0, 'resume_room без сесия')
  const r = h.reloads[0]
  assert(r?.via === 'session' && r.detail?.code === 'ws_session_missing', JSON.stringify(h.reloads))
})

await check('[W4] друг профил (спрямо отпреди прекъсването или спрямо текущия профил) -> via=session', () => {
  const a = createHarness()
  a.coordinator.noteConnected('server-A', ME)
  a.drop({ authRef: ME.authRef, profileId: 'profile-other' })
  assert(a.syncAttempts.length === 0 && a.reloads[0]?.via === 'session', JSON.stringify(a.reloads))
  const b = createHarness()
  b.coordinator.noteConnected('server-A', ME)
  b.setExpectedProfile('profile-switched-in-client')
  b.drop({ ...ME })
  assert(b.syncAttempts.length === 0 && b.reloads[0]?.via === 'session', JSON.stringify(b.reloads))
})

await check('[W5] стар сървър (без полетата) -> досегашният HTTP път: първо сесията, после resume; authCheck=http', async () => {
  const h = createHarness()
  h.coordinator.noteConnected('server-A')
  h.drop(undefined)
  assert(h.verifyCalls() === 1 && h.syncAttempts.length === 0, 'HTTP пътят не е спазен')
  h.resolveSession('same')
  await flush()
  assert(h.syncAttempts.length === 1, 'resume_room след HTTP проверката')
  h.finishSync(true)
  assert(h.recovered[0]?.authCheck === 'http', JSON.stringify(h.recovered))
})

await check('[W6] смесено: отправна точка от нов сървър, нова връзка от стар -> HTTP път', () => {
  const h = createHarness()
  h.coordinator.noteConnected('server-A', ME)
  h.drop(undefined)
  assert(h.verifyCalls() === 1 && h.syncAttempts.length === 0, 'трябва HTTP път')
})

await check('[W7] WS път: resume без отговор -> sync/resume_timeout след 10 s; отказ -> resume_refused; адресът носи authCheck=ws', () => {
  const h = createHarness()
  h.coordinator.noteConnected('server-A', ME)
  h.drop({ ...ME })
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS - 1)
  assert(h.reloads.length === 0, 'преждевременен reload')
  h.advance(1)
  const d = h.reloads[0]?.detail
  assert(h.reloads[0]?.via === 'sync' && d?.reason === 'resume_timeout' && d.authCheck === 'ws', JSON.stringify(h.reloads))
  const url = buildOfflineReloadUrl(1, 'sync', d!)
  assert(url.endsWith('&authCheck=ws') && url.includes('reason=resume_timeout'), url)
  const r = createHarness()
  r.coordinator.noteConnected('server-A', ME)
  r.drop({ ...ME })
  r.finishSync(false, { reason: 'resume_refused', code: 'other_session_active' })
  const rd = r.reloads[0]?.detail
  assert(r.reloads[0]?.via === 'sync' && rd?.reason === 'resume_refused' && rd.code === 'other_session_active' && rd.authCheck === 'ws', JSON.stringify(r.reloads))
})

await check('[W8] свързване извън прекъсване (login/logout) обновява отправната точка', () => {
  const h = createHarness('profile-new')
  h.coordinator.noteConnected('server-A', ME)
  h.coordinator.noteConnected('server-A', { authRef: 'ref-after-login', profileId: 'profile-new' })
  h.drop({ authRef: 'ref-after-login', profileId: 'profile-new' })
  assert(h.syncAttempts.length === 1 && h.reloads.length === 0, JSON.stringify({ attempts: h.syncAttempts, reloads: h.reloads }))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
