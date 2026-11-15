/**
 * checkVoiceSessionEndDiagnostics.ts
 *
 * Гласов чат, етап А — диагностика на всяко прекратяване на гласовата сесия
 * в браузъра: истинският createVoiceController срещу fake адаптер
 * (scripts/fixtures/voiceControllerFakeHarness.ts).
 *
 * Проверява, че:
 *   * изричното напускане, „Изчакай в лоби“ (извън масата), pagehide,
 *     страница от кеша, смяна на контекста и failConnection изпращат
 *     voice_presence{onTableScreen:false} С ПРИЧИНА и отчитат session_end;
 *   * failConnection посочва етапа (presence / token / възстановяване /
 *     след ротация);
 *   * сървърно прекратяване (lease, 120 s, изгонване от LiveKit) се отчита
 *     без излишен onTableScreen:false;
 *   * повторно спиране не дублира отчета;
 *   * всичко минава строгата сървърна валидация (presence и client-report).
 * Само диагностика — поведението на гласа не се променя.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceSessionEndDiagnostics.ts
 */

import type { VoiceDiagnosticReport } from '../src/app/voice/voiceAdapter'
import type { VoicePresenceClientMessage } from '../src/app/voice/voiceProtocol'
import { parseVoiceClientReport } from '../server/src/voice/voiceClientDiagnostics'
import { parseVoicePresenceMessage } from '../server/src/voice/voiceChatProtocol'
import { TABLE, TABLE_B, SEATS, createHarness, flush, joinWithMic, serverDisconnect, snap, type Harness } from './fixtures/voiceControllerFakeHarness'

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

type SessionEnd = Extract<VoiceDiagnosticReport, { event: 'session_end' }>
const sessionEnds = (h: Harness): SessionEnd[] => h.reports.filter((r): r is SessionEnd => r.event === 'session_end')
const leaves = (h: Harness): VoicePresenceClientMessage[] => h.presence.filter((p) => !p.onTableScreen)

async function connected(h: Harness): Promise<void> {
  await joinWithMic(h)
  assertEqual(snap(h).microphone, 'live', 'подготовка: включен микрофон')
}

/** Едно прекратяване: точно един отчет и (ако се очаква) един onTableScreen:false с причината. */
function assertEnded(h: Harness, reason: SessionEnd['reason'], stage: SessionEnd['stage'], presenceReason: VoicePresenceClientMessage['reason'] | null): void {
  const ends = sessionEnds(h)
  assertEqual(ends.length, 1, `отчети session_end (${JSON.stringify(ends)})`)
  assertEqual(ends[0]!.reason, reason, 'причина')
  assertEqual(ends[0]!.stage, stage, 'етап')
  const sent = leaves(h)
  if (presenceReason === null) {
    assertEqual(sent.length, 0, `без onTableScreen:false (${JSON.stringify(sent)})`)
  } else {
    assertEqual(sent.length, 1, `един onTableScreen:false (${JSON.stringify(sent)})`)
    assertEqual(sent[0]!.reason, presenceReason, 'причина към сървъра')
  }
}

console.log('\ncheckVoiceSessionEndDiagnostics\n')

// ═══ Прекратяване от страницата (сървърът научава причината) ═══════════════

await check('[SE1] „Напусни гласа“ -> onTableScreen:false reason=leave_voice + session_end leave_voice', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.leaveVoice()
  await flush(20)
  assertEnded(h, 'leave_voice', 'none', 'leave_voice')
})

await check('[SE2] „Изчакай в лоби“ (извън екрана на масата) -> reason=off_table', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.setContext(h.ctx('off_table'))
  await flush(20)
  assertEnded(h, 'off_table', 'none', 'off_table')
})

await check('[SE3] pagehide -> page_hide; страница от кеша (pageshow persisted) -> page_restored', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.onPageHide()
  await flush(20)
  assertEnded(h, 'page_hide', 'none', 'page_hide')
  const h2 = createHarness()
  await connected(h2)
  h2.voice.onPageShow(true)
  await flush(20)
  assertEnded(h2, 'page_restored', 'none', 'page_restored')
})

await check('[SE4] Смяна на контекста (маса -> без маса / друга маса) -> context_changed', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.setContext({ kind: 'none' })
  await flush(20)
  assertEnded(h, 'context_changed', 'none', 'context_changed')
  const h2 = createHarness()
  await connected(h2)
  h2.voice.setContext(h2.ctx('waiting', SEATS, TABLE_B))
  await flush(20)
  assertEnded(h2, 'context_changed', 'none', 'context_changed')
  assertEqual(leaves(h2)[0]!.voiceTableId, TABLE, 'причината отива към старата маса')
})

await check('[SE5] Чакалня -> игра (същата маса): НЯМА прекратяване и няма onTableScreen:false', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.setContext(h.ctx('game'))
  await flush(20)
  assertEqual(sessionEnds(h).length, 0, 'session_end')
  assertEqual(leaves(h).length, 0, 'onTableScreen:false')
  assertEqual(snap(h).microphone, 'live', 'микрофонът остава')
})

// ═══ failConnection — на кой етап ═════════════════════════════════════════

await check('[SE6] Отказано присъствие (not_seat_connection = неясно членство) -> 5 ограничени опита -> fail_connection / presence; сървърът получава причината', async () => {
  const h = createHarness()
  h.backend.presenceFailure = 'not_seat_connection'
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  h.voice.joinAsListener()
  await flush(30)
  assertEqual(sessionEnds(h).length, 0, 'първият отказ не спира веднага')
  await h.clock.advance(1_000 + 2_000 + 4_000 + 8_000)
  await flush(30)
  assertEqual(h.presence.filter((p) => p.onTableScreen).length, 5, 'точно 5 опита')
  assertEqual(snap(h).status, 'unavailable', '„недостъпен“')
  assertEnded(h, 'fail_connection', 'presence', 'fail_connection')
  await h.clock.advance(300_000)
  assertEqual(h.presence.filter((p) => p.onTableScreen).length, 5, 'без нови опити след спирането')
})

await check('[SE7] Без отговор на присъствието (5 s) -> fail_connection / presence', async () => {
  const h = createHarness()
  h.backend.presenceFailure = 'silent'
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  h.voice.joinAsListener()
  await flush(10)
  // 5 опита × (5 s без отговор) + паузи 1/2/4/8 s.
  for (let index = 0; index < 12; index += 1) {
    await h.clock.advance(5_100)
    await flush(20)
  }
  const ends = sessionEnds(h)
  assert(ends.length === 1 && ends[0]!.reason === 'fail_connection' && ends[0]!.stage === 'presence', JSON.stringify(ends))
  assertEqual(h.presence.filter((p) => p.onTableScreen).length, 5, 'точно 5 опита')
})

await check('[SE8] Етап В: временно недостъпен токен (503) 6 пъти при валидно членство -> без прекратяване, нарастващи паузи, после свързан', async () => {
  const h = createHarness()
  h.backend.tokenFailures = Array.from({ length: 6 }, () => ({ status: 503, code: 'voice_unavailable' }))
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  h.voice.joinAsListener()
  await flush(20)
  await h.clock.advance(1_000 + 2_000 + 4_000 + 8_000 + 15_000 + 30_000)
  await flush(20)
  assertEqual(sessionEnds(h).length, 0, 'без session_end')
  assertEqual(leaves(h).length, 0, 'без onTableScreen:false')
  assertEqual(snap(h).status, 'connected_listening', 'свързан след временните откази')
  const connectFailed = h.reports.filter((r) => r.event === 'connect_failed')
  assertEqual(connectFailed.length, 1, 'един диагностичен отчет за серията')
})

await check('[SE9] Етап В: загубена връзка + продължително недостъпен LiveKit -> опитите продължават (≤30 s пауза), без прекратяване; възстановяване щом услугата се върне', async () => {
  const h = createHarness()
  await connected(h)
  h.backend.tokenFailures = Array.from({ length: 10 }, () => ({ status: 503, code: 'voice_unavailable' }))
  serverDisconnect(h.fake.state.last(), 'connection_lost')
  await flush(20)
  await h.clock.advance(120_000)
  await flush(20)
  assertEqual(sessionEnds(h).length, 0, 'без session_end')
  assertEqual(snap(h).status, 'reconnecting', 'продължава да опитва')
  const tokensAt2min = h.events.filter((e) => e.startsWith('token@')).length
  assert(tokensAt2min <= 10, `ограничена честота (${tokensAt2min} заявки за 2 min)`)
  await h.clock.advance(300_000)
  await flush(20)
  // Fixture-ът не предава capture-а; без разрешение „без прозорец“ -> слушане + молба за изрично включване.
  assertEqual(snap(h).status, 'connected_listening', 'възстановен')
  assertEqual(snap(h).uiError?.code, 'mic_not_enabled', '„Микрофонът не беше включен“')
})

await check('[SE10] Етап В: ротация + 6 последователни 503 voice_rotation_pending -> без прекратяване, новата генерация с микрофона', async () => {
  const h = createHarness()
  await connected(h)
  h.backend.tokenFailures = Array.from({ length: 6 }, () => ({ status: 503, code: 'voice_rotation_pending' }))
  h.backend.generation = 2
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: false } as never)
  await flush(20)
  await h.clock.advance(60_000)
  await flush(20)
  assertEqual(sessionEnds(h).length, 0, 'без session_end')
  assertEqual(snap(h).generation, 2, 'нова генерация')
  assertEqual(snap(h).status, 'connected_listening', 'свързан (fixture-ът не предава capture-а, а разрешението не е налично)')
})

// ═══ Прекратяване от сървъра — без излишен onTableScreen:false ════════════

await check('[SE11] voice_access_ended (изтекъл lease) -> session_end access_ended, без onTableScreen:false', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.handleServerMessage({ type: 'voice_access_ended', voiceTableId: TABLE, reason: 'lease_expired' } as never)
  await flush(20)
  assertEnded(h, 'access_ended', 'none', null)
})

await check('[SE12] Етап В: отстранен в LiveKit (RemoveParticipant) -> диагностика participant_removed, ново присъствие + токен, без onTableScreen:false', async () => {
  const h = createHarness()
  await connected(h)
  const presenceBefore = h.presence.filter((p) => p.onTableScreen).length
  serverDisconnect(h.fake.state.last(), 'removed')
  await flush(30)
  assert(h.reports.some((r) => r.event === 'livekit_disconnect'), 'livekit_disconnect')
  assertEqual(leaves(h).length, 0, 'без onTableScreen:false')
  assertEqual(sessionEnds(h).length, 0, 'не е край на сесията')
  assert(h.presence.filter((p) => p.onTableScreen).length > presenceBefore, 'присъствие преди новия токен')
  assertEqual(snap(h).status, 'connected_listening', 'свързан отново')
})

await check('[SE13] Етап В: 120 s без игрова връзка -> клиентът не прекратява (сървърът решава), без onTableScreen:false', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.setGameConnection(false)
  await h.clock.advance(120_100)
  await flush(20)
  assertEqual(sessionEnds(h).length, 0, 'без session_end')
  assertEqual(leaves(h).length, 0, 'без onTableScreen:false')
  assertEqual(snap(h).status, 'connected_speaking', 'LiveKit връзката остава')
})

await check('[SE14] Повторно спиране на вече спряна сесия не дублира отчета', async () => {
  const h = createHarness()
  await connected(h)
  h.voice.leaveVoice()
  await flush(20)
  h.voice.leaveVoice()
  h.voice.onPageHide()
  h.voice.setContext({ kind: 'none' })
  await flush(20)
  assertEqual(sessionEnds(h).length, 1, 'един отчет')
})

// ═══ Сървърна валидация ═══════════════════════════════════════════════════

await check('[SE15] Всички отчети и всички voice_presence минават строгата сървърна валидация; причината се запазва само при onTableScreen:false', async () => {
  const reports: VoiceDiagnosticReport[] = []
  const presence: VoicePresenceClientMessage[] = []
  for (const run of [
    async (h: Harness) => { await connected(h); h.voice.leaveVoice() },
    async (h: Harness) => { await connected(h); h.voice.setContext(h.ctx('off_table')) },
    async (h: Harness) => { await connected(h); h.voice.onPageHide() },
    async (h: Harness) => { await connected(h); h.voice.setContext({ kind: 'none' }) },
    async (h: Harness) => { h.backend.presenceFailure = 'not_seat_connection'; h.voice.setContext(h.ctx('waiting')); await flush(); h.voice.joinAsListener() },
  ]) {
    const h = createHarness()
    await run(h)
    await flush(30)
    reports.push(...h.reports)
    presence.push(...h.presence)
  }
  for (const report of reports) assert(parseVoiceClientReport(report) !== null, `отхвърлен отчет: ${JSON.stringify(report)}`)
  for (const message of presence) {
    const parsed = parseVoicePresenceMessage(message as unknown as Record<string, unknown>)
    assert(parsed !== null, `отхвърлен presence: ${JSON.stringify(message)}`)
    assertEqual(parsed!.reason, message.onTableScreen ? undefined : message.reason, 'причината')
  }
  assert(presence.some((p) => p.onTableScreen) && presence.some((p) => !p.onTableScreen), 'и двата вида presence')
  // Невалидна причина -> съобщението остава валидно, причината се игнорира (стари/чужди клиенти).
  const odd = parseVoicePresenceMessage({ type: 'voice_presence', voiceTableId: TABLE, clientInstanceId: 'inst_test_0000000000000001', onTableScreen: false, reason: '<script>' })
  assert(odd !== null && odd.reason === undefined, 'непозната причина')
  const onScreen = parseVoicePresenceMessage({ type: 'voice_presence', voiceTableId: TABLE, clientInstanceId: 'inst_test_0000000000000001', onTableScreen: true, reason: 'page_hide' })
  assert(onScreen !== null && onScreen.reason === undefined, 'причина при onTableScreen:true се игнорира')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
