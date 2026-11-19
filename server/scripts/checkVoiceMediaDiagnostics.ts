/**
 * checkVoiceMediaDiagnostics.ts — Гласов чат, Етап H: сървърната част на
 * медийната диагностика (voiceClientDiagnostics.ts): затворени изброявания,
 * груба платформа, ring buffer с последните 500 събития (UTC минута), лимит
 * на заявките. Само в паметта — без профил, IP, SQL и логове.
 *
 *   cd server && node node_modules/tsx/dist/cli.mjs scripts/checkVoiceMediaDiagnostics.ts
 */

import {
  VOICE_CLIENT_RECENT_LIMIT,
  createVoiceClientDiagnostics,
  parseVoiceClientPlatform,
  parseVoiceClientReport,
} from '../src/voice/voiceClientDiagnostics.js'

console.log('\ncheckVoiceMediaDiagnostics\n')

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

await check('[MD1] Валидни медийни събития се приемат; непознати стойности / липсващи полета / свободен текст -> 400', () => {
  assert(parseVoiceClientReport({ event: 'media_input', state: 'stall_suspected', evidence: 'capture_active', duration: 'none' }) !== null, 'media_input')
  assert(parseVoiceClientReport({ event: 'media_output', state: 'element_paused' }) !== null, 'media_output')
  assert(parseVoiceClientReport({ event: 'media_recovery', target: 'output', step: 'reattach', result: 'success', trigger: 'pause' }) !== null, 'media_recovery')
  const invalid: unknown[] = [
    { event: 'media_input', state: 'stall_suspected', evidence: 'capture_active' },
    { event: 'media_input', state: 'hacked', evidence: 'none', duration: 'none' },
    { event: 'media_output', state: 'element_paused <script>' },
    { event: 'media_recovery', target: 'input', step: 'play', result: 'success', trigger: 'pause' },
    { event: 'media_recovery', target: 'output', step: 'play', result: 'success', trigger: 'any text' },
  ]
  for (const body of invalid) assert(parseVoiceClientReport(body) === null, `отказано: ${JSON.stringify(body)}`)
})

await check('[MD2] Груба платформа: затворен списък; липсваща/непозната -> unknown (стар клиент не е грешка); пълен UA не се приема', () => {
  assert(parseVoiceClientPlatform({ platform: 'ios_safari' }) === 'ios_safari', 'ios_safari')
  assert(parseVoiceClientPlatform({}) === 'unknown', 'липсва')
  assert(parseVoiceClientPlatform({ platform: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)' }) === 'unknown', 'пълен UA -> unknown')
  const diag = createVoiceClientDiagnostics()
  assert(diag.record('p1', { event: 'connected', platform: 'Mozilla/5.0 (iPhone)' }) === 'ok', 'старият/непознатият формат не отказва отчета')
  assert(diag.snapshot().recent[0]!.platform === 'unknown', 'записано като unknown')
})

await check('[MD3] Ring buffer: последните 500 приети събития, най-новите първи, UTC до минута, без профил/IP; броячи по състояние и платформа', () => {
  let now = Date.parse('2026-11-18T13:38:52.105Z')
  const diag = createVoiceClientDiagnostics({ now: () => now, limitPerMinute: 1_000_000 })
  diag.record('profile-secret-1', { event: 'media_input', state: 'stall_suspected', evidence: 'capture_active', duration: 'none', platform: 'ios_safari' })
  now += 61_000
  for (let i = 0; i < VOICE_CLIENT_RECENT_LIMIT + 20; i += 1) diag.record(`p${i % 7}`, { event: 'media_output', state: 'element_paused', platform: 'android_samsung' })
  diag.record('p1', { event: 'media_recovery', target: 'output', step: 'play', result: 'success', trigger: 'pause', platform: 'android_samsung' })
  const snap = diag.snapshot()
  assert(snap.recent.length === VOICE_CLIENT_RECENT_LIMIT && snap.recentLimit === 500, `таван 500: ${snap.recent.length}`)
  assert(snap.recent[0]!.event === 'media_recovery' && snap.recent[0]!.detail === 'output/play/success/pause', `най-новото първо: ${JSON.stringify(snap.recent[0])}`)
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(snap.recent[0]!.at) && snap.recent[0]!.at === '2026-11-18T13:39Z', `минута: ${snap.recent[0]!.at}`)
  assert(!snap.recent.some((entry) => entry.detail === 'stall_suspected/capture_active/none'), 'най-старото е изместено')
  assert(snap.media.input.stall_suspected === 1 && snap.media.inputEvidence.capture_active === 1, 'броячи вход')
  assert(snap.media.output.element_paused === VOICE_CLIENT_RECENT_LIMIT + 20, 'броячи изход')
  assert(snap.media.recovery['play:success'] === 1, 'броячи възстановяване')
  assert(snap.media.byPlatform.ios_safari === 1 && snap.media.byPlatform.android_samsung === VOICE_CLIENT_RECENT_LIMIT + 21, 'по платформа')
  const text = JSON.stringify(snap)
  assert(!text.includes('profile-secret-1') && !text.includes('"p1"'), 'без профили в snapshot-а')
})

await check('[MD4] Съществуващият лимит важи и за медийните събития (30/мин на профил); отхвърлените не влизат в буфера', () => {
  const diag = createVoiceClientDiagnostics({ now: () => 1_000 })
  const results = Array.from({ length: 35 }, () => diag.record('p1', { event: 'media_output', state: 'element_paused' }))
  assert(results.filter((r) => r === 'ok').length === 30 && results.filter((r) => r === 'limited').length === 5, `лимит: ${results.join(',')}`)
  assert(diag.snapshot().recent.length === 30, 'само приетите')
  assert(diag.record('p2', { event: 'media_output', state: 'nope' }) === 'invalid', 'невалидно')
  assert(diag.snapshot().recent.length === 30, 'невалидните не влизат')
})

await check('[MD5] Старите събития имат кратко описание от затворените стойности (за хронологията в панела)', () => {
  const diag = createVoiceClientDiagnostics()
  diag.record('p1', { event: 'session_end', reason: 'leave_voice', stage: 'none', platform: 'ios_safari' })
  diag.record('p1', { event: 'livekit_disconnect', reason: 'duplicate_identity' })
  const [last, first] = diag.snapshot().recent
  assert(first!.detail === 'leave_voice/none' && last!.detail === 'duplicate_identity', JSON.stringify(diag.snapshot().recent))
})

await check('[MD6] Етап H3: mic_recovery (затворени mode/outcome) — приема се, брои се по mode:outcome и е в хронологията; непознато -> 400', () => {
  const diag = createVoiceClientDiagnostics()
  assert(diag.record('p1', { event: 'mic_recovery', mode: 'auto', outcome: 'recovered', platform: 'ios_safari' }) === 'ok', 'auto:recovered')
  assert(diag.record('p1', { event: 'mic_recovery', mode: 'manual', outcome: 'gum_denied' }) === 'ok', 'manual:gum_denied')
  assert(diag.record('p1', { event: 'mic_recovery', mode: 'auto', outcome: 'anything' }) === 'invalid', 'непознат outcome')
  assert(diag.record('p1', { event: 'mic_recovery', mode: 'robot', outcome: 'recovered' }) === 'invalid', 'непознат mode')
  const snap = diag.snapshot()
  assert(snap.media.micRecovery['auto:recovered'] === 1 && snap.media.micRecovery['manual:gum_denied'] === 1, JSON.stringify(snap.media.micRecovery))
  assert(snap.recent[1]!.detail === 'auto/recovered' && snap.media.byPlatform.ios_safari === 1, JSON.stringify(snap.recent))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
