/**
 * checkSoftReconnectRetryStage3.ts — Етап 3: временен неуспех на тихото
 * възстановяване на активна стая -> нов тих опит (нова връзка, пауза),
 * вместо презареждане. Фалшиви таймери, без браузър.
 *
 *   [T1] класификация временен/окончателен
 *   [T2] паузи 1, 2, 4, 8, 8 s (±25% jitter, таван 8 s)
 *   [T3] resume без отговор -> БЕЗ reload; onTransientFailure (опит 1, 1 s);
 *        паузата се взима еднократно; следващият опит възстановява
 *   [T4] постоянни временни неуспехи -> едва след 120 s reload stale (с retries)
 *   [T5] окончателни (отказ other_session_active, сменена сесия) -> веднага reload
 *   [T6] закъснял отговор на изоставен опит се игнорира (без двойно възстановяване)
 *   [T7] стар сървър (HTTP път): timeout/грешка на /api/auth/me -> нов опит
 *   [T8] предусловие: socket_not_open -> нов опит; no_target -> reload
 *   [T9] без onTransientFailure -> досегашното поведение (reload)
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkSoftReconnectRetryStage3.ts
 */
import { createLobbySoftReconnect, type ConnectedAuthIdentity, type SoftReconnectSessionCheck, type SoftReconnectSyncFailure } from '../src/app/network/createLobbySoftReconnect'
import {
  appendSilentReconnectAttemptProof,
  buildOfflineReloadUrl,
  MAX_SILENT_RECONNECT_ATTEMPTS_PER_OUTAGE,
  MAX_SILENT_RECONNECT_PRIOR_ATTEMPTS,
  getSoftReconnectRetryDelayMs,
  isTransientActiveRoomSyncFailure,
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
const ME: ConnectedAuthIdentity = { authRef: 'ref-A', profileId: 'p-me' }

function createHarness(options: { withRetry?: boolean } = {}) {
  let now = 20_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const reloads: Array<{ via: OfflineReloadVia; detail: OfflineReloadDetail | undefined }> = []
  const transients: Array<{ reason: string; code?: string; retry: number; delayMs: number }> = []
  const syncDones: Array<(ok: boolean, failure?: SoftReconnectSyncFailure) => void> = []
  let recovered = 0
  let sessionResolvers: Array<(v: SoftReconnectSessionCheck) => void> = []
  const coordinator = createLobbySoftReconnect({
    now: () => now,
    setTimeout: (callback, delayMs) => { const id = nextId++; timers.set(id, { at: now + delayMs, callback }); return id },
    clearTimeout: (id) => { timers.delete(id as number) },
    verifySession: () => new Promise((resolve) => { sessionResolvers.push(resolve) }),
    onResumeLobby: () => {},
    syncLobby: () => {},
    syncActiveRoom: (done) => { syncDones.push(done) },
    onShowBanner: () => {},
    onShowActiveRoomOutage: () => {},
    onShowFullScreen: () => {},
    onRecovered: () => { recovered += 1 },
    onReload: (via, detail) => { reloads.push({ via, detail }) },
    getExpectedProfileId: () => 'p-me',
    random: () => 0.5, // jitter фактор 1.0 — детерминистични паузи
    ...(options.withRetry === false ? {} : { onTransientFailure: (info) => { transients.push(info) } }),
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
  /** Нова връзка + connected в текущото прекъсване (както main.ts след паузата). */
  const reconnectNow = (identity: ConnectedAuthIdentity | 'legacy' = ME) => {
    assert(coordinator.handleOpen(), 'handleOpen')
    coordinator.noteConnected('srv', identity === 'legacy' ? undefined : identity)
  }
  return {
    coordinator, reloads, transients, syncDones, advance, reconnectNow,
    recovered: () => recovered,
    get now() { return now },
    resolveSession: (v: SoftReconnectSessionCheck) => { const r = sessionResolvers.shift(); assert(r, 'няма HTTP проверка'); r(v) },
    /** main.ts при onTransientFailure: изоставя socket-а -> onClose -> beginOutage (прекъсването продължава). */
    abandonAndCloseLikeMain: () => coordinator.beginOutage('active_room'),
  }
}

function startOutage(h: ReturnType<typeof createHarness>, identity: ConnectedAuthIdentity | 'legacy' = ME): void {
  h.coordinator.noteConnected('srv', identity === 'legacy' ? undefined : identity)
  h.coordinator.beginOutage('active_room')
  h.advance(1_000)
  h.reconnectNow(identity)
}

console.log('\ncheckSoftReconnectRetryStage3\n')

await check('[T1] временни: resume/auth timeout, auth/resume грешка, socket_not_open; окончателни: отказ, сесия, стая, рестарт, stale', () => {
  for (const r of ['resume_timeout', 'auth_timeout', 'auth_error', 'resume_failed'] as const) assert(isTransientActiveRoomSyncFailure(r), r)
  assert(isTransientActiveRoomSyncFailure('resume_precondition', 'socket_not_open'), 'socket_not_open')
  for (const [r, c] of [['resume_refused', 'other_session_active'], ['resume_refused', 'reconnect_unavailable'], ['session_changed', 'ws_identity_changed'], ['resume_precondition', 'no_target'], ['resume_precondition', 'session_in_game_other_room'], ['resume_precondition', 'room_changed'], ['restart', undefined], ['stale', undefined]] as const) {
    assert(!isTransientActiveRoomSyncFailure(r, c), `${r}/${c}`)
  }
})

await check('[T2] паузи 1, 2, 4, 8, 8 s; jitter ±25%', () => {
  const seq = [1, 2, 3, 4, 5].map((i) => getSoftReconnectRetryDelayMs(i, () => 0.5))
  assert(seq.join(',') === '1000,2000,4000,8000,8000', seq.join(','))
  assert(getSoftReconnectRetryDelayMs(1, () => 0) === 750 && getSoftReconnectRetryDelayMs(1, () => 1) === 1250, 'jitter')
})

await check('[T3] resume без отговор -> без reload; нов опит след 1 s; паузата се взима веднъж; вторият опит възстановява', () => {
  const h = createHarness()
  startOutage(h)
  assert(h.syncDones.length === 1, 'първи resume')
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  assert(h.reloads.length === 0, `reload при първи временен неуспех: ${JSON.stringify(h.reloads)}`)
  assert(h.transients.length === 1 && h.transients[0]!.reason === 'resume_timeout' && h.transients[0]!.retry === 1 && h.transients[0]!.delayMs === 1000, JSON.stringify(h.transients))
  h.abandonAndCloseLikeMain()
  assert(h.coordinator.consumeRetryDelayMs() === 1000 && h.coordinator.consumeRetryDelayMs() === null, 'паузата трябва да е еднократна')
  h.advance(1000)
  h.reconnectNow()
  assert(h.syncDones.length === 2, 'втори resume')
  h.syncDones[1]!(true)
  assert(h.recovered() === 1 && h.reloads.length === 0, 'не е възстановено')
})

await check('[T4] постоянни временни неуспехи -> reload stale едва след 120 s, с брой повторни опити', () => {
  const h = createHarness()
  startOutage(h)
  let guard = 0
  while (h.reloads.length === 0 && guard++ < 50) {
    h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
    if (h.reloads.length > 0) break
    h.abandonAndCloseLikeMain()
    h.advance(h.coordinator.consumeRetryDelayMs() ?? 1000)
    if (h.coordinator.handleOpen()) h.coordinator.noteConnected('srv', ME)
  }
  const r = h.reloads[0]
  assert(r !== undefined && r.via === 'stale', JSON.stringify(h.reloads))
  assert(h.transients.length >= 5, `повторни опити: ${h.transients.length}`)
  assert((r.detail?.retries ?? 0) === h.transients.length, JSON.stringify(r.detail))
  assert(buildOfflineReloadUrl(1, r.via, r.detail!).includes(`&retries=${h.transients.length}`), 'retries в адреса')
})

await check('[T5] окончателни: other_session_active / сменена сесия -> веднага reload, без нов опит', () => {
  const a = createHarness()
  startOutage(a)
  a.syncDones[0]!(false, { reason: 'resume_refused', code: 'other_session_active' })
  assert(a.reloads.length === 1 && a.reloads[0]!.via === 'sync' && a.transients.length === 0, JSON.stringify({ r: a.reloads, t: a.transients }))
  const b = createHarness()
  b.coordinator.noteConnected('srv', ME)
  b.coordinator.beginOutage('active_room')
  b.advance(500)
  b.reconnectNow({ authRef: 'ref-OTHER', profileId: 'p-me' })
  assert(b.reloads.length === 1 && b.reloads[0]!.via === 'session' && b.transients.length === 0, JSON.stringify(b.reloads))
})

await check('[T6] закъснял отговор на изоставения опит се игнорира', () => {
  const h = createHarness()
  startOutage(h)
  const firstDone = h.syncDones[0]!
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  h.abandonAndCloseLikeMain()
  firstDone(true) // закъснял успех от изоставената връзка
  assert(h.recovered() === 0, 'закъснелият отговор възстанови')
  h.advance(h.coordinator.consumeRetryDelayMs() ?? 0)
  h.reconnectNow()
  h.syncDones[1]!(true)
  assert(h.recovered() === 1, 'новият опит не възстанови')
})

await check('[T7] стар сървър (HTTP път): timeout на /api/auth/me -> нов опит, не reload', async () => {
  const h = createHarness()
  startOutage(h, 'legacy')
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  assert(h.reloads.length === 0 && h.transients[0]?.reason === 'auth_timeout', JSON.stringify({ r: h.reloads, t: h.transients }))
  h.abandonAndCloseLikeMain()
  h.advance(h.coordinator.consumeRetryDelayMs() ?? 0)
  h.reconnectNow('legacy')
  h.resolveSession('same') // първата HTTP проверка (изоставена) — пропуска се
  h.resolveSession('same')
  await flush()
  assert(h.syncDones.length === 1, `resume след HTTP: ${h.syncDones.length}`)
  h.syncDones[0]!(true)
  assert(h.recovered() === 1, 'не е възстановено')
})

await check('[T8] socket_not_open -> нов опит; no_target -> reload', () => {
  const a = createHarness()
  startOutage(a)
  a.syncDones[0]!(false, { reason: 'resume_precondition', code: 'socket_not_open' })
  assert(a.reloads.length === 0 && a.transients[0]?.code === 'socket_not_open', JSON.stringify(a.transients))
  const b = createHarness()
  startOutage(b)
  b.syncDones[0]!(false, { reason: 'resume_precondition', code: 'no_target' })
  assert(b.reloads.length === 1 && b.transients.length === 0, JSON.stringify(b.reloads))
})

await check('[T9] без onTransientFailure -> досегашното презареждане (обратна съвместимост)', () => {
  const h = createHarness({ withRetry: false })
  startOutage(h)
  h.advance(SOFT_RECONNECT_SYNC_TIMEOUT_MS)
  assert(h.reloads.length === 1 && h.reloads[0]!.detail?.reason === 'resume_timeout', JSON.stringify(h.reloads))
})

await check('[T10] Етап 4: клиентът пази proof за всеки опит до тавана (32), без дубликати', () => {
  let list: Array<{ connectionId: string; proof: string }> = []
  for (let i = 0; i < 40; i++) list = appendSilentReconnectAttemptProof(list, { connectionId: `c${i}`, proof: `p${i}` })
  assert(MAX_SILENT_RECONNECT_PRIOR_ATTEMPTS === MAX_SILENT_RECONNECT_ATTEMPTS_PER_OUTAGE && list.length === 32 && list[0]!.connectionId === 'c8' && list[31]!.connectionId === 'c39', JSON.stringify(list.map((x) => x.connectionId)))
  list = appendSilentReconnectAttemptProof(list, { connectionId: 'c20', proof: 'new' })
  assert(list.length === 32 && list.filter((x) => x.connectionId === 'c20').length === 1 && list[31]!.proof === 'new', 'дубликат')
})

await check('[T11] таван 32 опита в прекъсване: при всеки опит клиентът има proof за ВСИЧКИ предишни; 33-ият -> reload attempts_exhausted без resume', () => {
  const h = createHarness()
  h.coordinator.noteConnected('srv', ME)
  h.coordinator.beginOutage('active_room')
  let proofs: Array<{ connectionId: string; proof: string }> = []
  for (let attempt = 1; attempt <= MAX_SILENT_RECONNECT_ATTEMPTS_PER_OUTAGE; attempt++) {
    h.advance(800) // бързи цикли: пауза ~750 ms
    assert(h.coordinator.handleOpen(), `handleOpen ${attempt}`)
    // main.ts: proof-ът се записва при 'connected'; priorAttempts = всички без текущия
    proofs = appendSilentReconnectAttemptProof(proofs, { connectionId: `a${attempt}`, proof: `p${attempt}` })
    const prior = proofs.filter((p) => p.connectionId !== `a${attempt}`)
    assert(prior.length === attempt - 1, `опит ${attempt}: подадени ${prior.length} от ${attempt - 1} предишни`)
    h.coordinator.noteConnected('srv', ME)
    assert(h.syncDones.length === attempt && h.reloads.length === 0, `опит ${attempt}: sync=${h.syncDones.length} reload=${h.reloads.length}`)
    h.abandonAndCloseLikeMain() // връзката пада веднага (бърз временен неуспех)
  }
  h.advance(800)
  assert(h.coordinator.handleOpen(), 'handleOpen 33')
  h.coordinator.noteConnected('srv', ME)
  assert(h.syncDones.length === MAX_SILENT_RECONNECT_ATTEMPTS_PER_OUTAGE, 'resume при 33-ия опит')
  assert(h.reloads.length === 1 && h.reloads[0]!.via === 'sync' && h.reloads[0]!.detail?.reason === 'attempts_exhausted', JSON.stringify(h.reloads))
})

void SOFT_RECONNECT_MAX_OUTAGE_MS
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
