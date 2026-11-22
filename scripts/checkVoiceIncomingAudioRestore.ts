/**
 * checkVoiceIncomingAudioRestore.ts — Етап H4: бутон „Възстанови звука“
 * (пресъздаване на входящите audio елементи) — контролер, достъп за всеки
 * участник, интерфейс и сървърната диагностика (без промени по сървъра). Реалният адаптер с LiveKit: scripts/checkVoiceIncomingAudioRestoreE2E.ts.
 *
 *   [A1] без списък по profile_id: модулът с разрешени профили е премахнат
 *   [A2] всеки профил (произволен, бивши разрешени) вижда бутона при свързан глас
 *   [A3] бутонът — само при свързан глас (чакалня и игра); не преди
 *        включване, не при свързване, не след напускане
 *   [A4] натискане: едно извикване на адаптера; микрофонът, getUserMedia,
 *        стаите, токените и присъствието не се пипат; локалното заглушаване остава
 *   [A5] многократно натискане: само едно възстановяване наведнъж
 *   [A6] грешка от адаптера: резултат 'failed', бутонът е отново достъпен
 *   [A7] смяна на стаята по време на възстановяване: старият резултат не се
 *        показва за новата стая; без висящо „в ход“
 *   [A8] напускане по време на възстановяване: без грешка, без нова стая
 *   [A9] интерфейсът: бутон, „Възстановяване…“, текстът на техническия резултат
 *   [A10] сървърът приема отчета на H4 (media_recovery output/reattach/gesture)
 *         без промяна; непознати стойности се отхвърлят както досега
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceIncomingAudioRestore.ts
 */

import type { VoiceSnapshot } from '../src/app/voice/createVoiceController'
import { existsSync } from 'node:fs'
import { renderVoicePanel } from '../src/app/voice/ui/renderVoicePanel'
import { SEATS, createHarness, flush, joinWithMic, rotate, snap, type Harness } from './fixtures/voiceControllerFakeHarness'
import { parseVoiceClientReport } from '../server/src/voice/voiceClientDiagnostics'

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

const DIVAKA = '29925128-167c-408b-9a33-620d2d8f9a95'
const DILEIDI = '90e3e375-1d21-4ce2-9ff5-e341bd91eea4'
const restoreState = (h: Harness) => snap(h).incomingAudioRestore
const counter = (h: Harness, key: string): number => h.voice.debugCounters()[key] ?? 0
function gate(h: Harness): () => Promise<void> {
  let release!: () => void
  h.fake.state.restoreGate = new Promise<void>((resolve) => { release = resolve })
  return async () => {
    h.fake.state.restoreGate = null
    release()
    await flush(20)
  }
}
async function joinListener(h: Harness, screen: 'waiting' | 'game' = 'waiting'): Promise<void> {
  h.voice.setContext(h.ctx(screen))
  await flush()
  h.voice.joinAsListener()
  await flush(30)
}

console.log('\ncheckVoiceIncomingAudioRestore\n')

await check('[A1] без списък по profile_id: модулът с разрешени профили е премахнат', () => {
  assert(!existsSync('src/app/voice/voiceIncomingAudioRestoreConfig.ts'), 'voiceIncomingAudioRestoreConfig.ts не съществува')
})

await check('[A2] всеки профил вижда бутона и може да го ползва (произволен профил с микрофон)', async () => {
  const h = createHarness() // профилът на теста е 'self' — никога не е бил в списък
  await joinWithMic(h, h.ctx('game'))
  assertEqual(snap(h).status, 'connected_speaking', 'свързан')
  assertEqual(restoreState(h).available, true, 'бутон')
  h.voice.restoreIncomingAudio()
  await flush(20)
  assertEqual(h.fake.state.last().restores, 1, 'адаптерът е извикан')
  assertEqual(counter(h, 'audioRestoreStarted'), 1, 'започнало')
})

await check('[A2b] бившите разрешени и произволен UUID — еднакво (слушатели в чакалнята)', async () => {
  for (const id of [DIVAKA, DILEIDI, '0f0e0d0c-0b0a-4908-8706-050403020100']) {
    const h = createHarness({ selfProfileId: id })
    h.voice.setContext(h.ctx('waiting', [{ profileId: id, isBot: false }, ...SEATS.slice(1)]))
    await flush()
    h.voice.joinAsListener()
    await flush(30)
    assertEqual(snap(h).status, 'connected_listening', `свързан ${id}`)
    assertEqual(restoreState(h).available, true, `бутон ${id}`)
  }
})

await check('[A3] бутонът само при свързан глас — чакалня и игра; не преди/при свързване, не след напускане', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  assertEqual(restoreState(h).available, false, 'преди включване')
  let release!: () => void
  h.fake.state.connectGate = new Promise<void>((resolve) => { release = resolve })
  h.voice.joinAsListener()
  await flush(10)
  assertEqual(snap(h).status, 'connecting', 'свързва се')
  assertEqual(restoreState(h).available, false, 'при свързване')
  h.fake.state.connectGate = null
  release()
  await flush(30)
  assertEqual(snap(h).status, 'connected_listening', 'чакалня: свързан')
  assertEqual(restoreState(h).available, true, 'чакалня: бутон')
  h.voice.setContext(h.ctx('game'))
  await flush(20)
  assertEqual(snap(h).screen, 'game', 'игра')
  assertEqual(restoreState(h).available, true, 'игра: бутон')
  h.voice.leaveVoice()
  await flush(30)
  assertEqual(restoreState(h).available, false, 'след напускане')
})

await check('[A4] натискане: едно извикване; микрофон, getUserMedia, стаи, токени, присъствие и заглушаване — непокътнати', async () => {
  const h = createHarness()
  await joinWithMic(h, h.ctx('game'))
  h.voice.muteRemoteParticipant('alice')
  await flush()
  const room = h.fake.state.last()
  const before = {
    gum: h.fake.state.getUserMediaCalls, rooms: h.fake.state.rooms.length, publishes: room.publishes,
    capture: room.capture, events: h.events.length, presence: h.presence.length, reports: h.reports.length,
  }
  h.voice.restoreIncomingAudio()
  assertEqual(room.restores, 1, 'адаптерът е извикан синхронно (в жеста)')
  assertEqual(restoreState(h).restoring, true, 'в ход')
  await flush(20)
  const state = restoreState(h)
  assertEqual(state.restoring, false, 'приключило')
  assertEqual(state.last?.outcome, 'played', 'технически резултат')
  assertEqual(state.last?.playing, 2, 'пуснати елементи')
  assertEqual(h.fake.state.getUserMediaCalls, before.gum, 'без нов getUserMedia')
  assertEqual(h.fake.state.rooms.length, before.rooms, 'без нова стая (reconnect/ротация)')
  assertEqual(room.disconnected, false, 'стаята не е затворена')
  assertEqual(room.publishes, before.publishes, 'без ново публикуване')
  assertEqual(room.capture, before.capture, 'същият capture')
  assertEqual(room.micLive, true, 'микрофонът е включен')
  assertEqual(snap(h).microphone, 'live', 'микрофон: live')
  assertEqual(h.events.length, before.events, 'без нов токен/присъствие')
  assertEqual(h.presence.length, before.presence, 'без voice_presence')
  assertEqual(h.reports.length, before.reports, 'контролерът не праща отчет (той е в адаптера)')
  assertEqual(snap(h).locallyMutedProfileIds.join(','), 'alice', 'локалното заглушаване остава')
  assertEqual(counter(h, 'audioRestoreStarted'), 1, 'започнато')
  assertEqual(counter(h, 'audioRestorePlayed'), 1, 'пуснато')
})

await check('[A5] многократно натискане: едно възстановяване наведнъж; след края — отново достъпно', async () => {
  const h = createHarness()
  await joinListener(h)
  const release = gate(h)
  for (let i = 0; i < 4; i += 1) h.voice.restoreIncomingAudio()
  await flush()
  const room = h.fake.state.last()
  assertEqual(room.restores, 1, 'едно извикване')
  assertEqual(counter(h, 'audioRestoreIgnoredBusy'), 3, 'три игнорирани')
  assertEqual(restoreState(h).restoring, true, 'в ход')
  assertEqual(restoreState(h).available, true, 'бутонът остава (показва „Възстановяване…“)')
  await release()
  assertEqual(restoreState(h).restoring, false, 'приключило')
  h.voice.restoreIncomingAudio()
  await flush(20)
  assertEqual(room.restores, 2, 'нов опит след края')
})

await check('[A6] грешка от адаптера: резултат „failed“, без висящо „в ход“', async () => {
  const h = createHarness()
  await joinListener(h)
  h.fake.state.restoreThrows = true
  h.voice.restoreIncomingAudio()
  await flush(20)
  assertEqual(restoreState(h).restoring, false, 'приключило')
  assertEqual(restoreState(h).last?.outcome, 'failed', 'failed')
  assertEqual(counter(h, 'audioRestoreFailed'), 1, 'брояч')
  assertEqual(snap(h).status, 'connected_listening', 'връзката остава')
})

await check('[A7] ротация по време на възстановяване: резултатът не се пренася в новата стая; без висящо „в ход“', async () => {
  const h = createHarness()
  await joinListener(h)
  const release = gate(h)
  h.voice.restoreIncomingAudio()
  await flush()
  await rotate(h)
  assertEqual(h.fake.state.rooms.length, 2, 'нова стая (ротацията е от сървъра, не от H4)')
  await release()
  assertEqual(restoreState(h).restoring, false, 'приключило')
  assertEqual(restoreState(h).last, null, 'без резултат от старата стая')
  assertEqual(restoreState(h).available, true, 'бутонът е достъпен в новата стая')
  h.voice.restoreIncomingAudio()
  await flush(20)
  assertEqual(h.fake.state.last().restores, 1, 'нов опит в новата стая')
})

await check('[A8] напускане по време на възстановяване: без грешка и без нова стая', async () => {
  const h = createHarness()
  await joinListener(h)
  const release = gate(h)
  h.voice.restoreIncomingAudio()
  await flush()
  h.voice.leaveVoice()
  await flush(30)
  await release()
  assertEqual(snap(h).status, 'idle', 'напуснал')
  assertEqual(snap(h).uiError, null, 'без грешка')
  assertEqual(h.fake.state.rooms.length, 1, 'без нова стая')
  assertEqual(restoreState(h).available, false, 'без бутон')
  assertEqual(restoreState(h).restoring, false, 'без висящо „в ход“')
})

await check('[A9] интерфейс: бутон само при available; „Възстановяване…“ (заключен); технически резултат без твърдение за чуване', async () => {
  const h = createHarness()
  await joinListener(h)
  const render = (snapshot: VoiceSnapshot) => renderVoicePanel({ snapshot, seats: [], theme: 'dark', joinOffer: 'speak', canOpenShop: false })
  const base = snap(h)
  const shown = render(base)
  assert(shown.includes('data-voice-action="restore-audio"') && shown.includes('Възстанови звука'), 'бутон')
  const hidden = render({ ...base, incomingAudioRestore: { available: false, restoring: false, last: null } })
  assert(!hidden.includes('restore-audio'), 'без бутон за неразрешен')
  const busy = render({ ...base, incomingAudioRestore: { available: true, restoring: true, last: null } })
  assert(/data-voice-action="restore-audio"[^>]*disabled/.test(busy) && busy.includes('Възстановяване…'), 'заключен по време на възстановяване')
  for (const [outcome, text] of [['played', 'Ако още не чувате'], ['partial', 'частично'], ['failed', 'не можа'], ['no_tracks', 'няма какво'], ['gesture_required', 'Включи звука']] as const) {
    const html = render({ ...base, incomingAudioRestore: { available: true, restoring: false, last: { outcome, tracks: 1, detached: 1, attached: 1, playing: outcome === 'played' ? 1 : 0, errors: [] } } })
    assert(html.includes(`data-voice-audio-restore-result="${outcome}"`) && html.includes(text), `текст за ${outcome}`)
  }
  assert(!render({ ...base, incomingAudioRestore: { available: true, restoring: false, last: { outcome: 'played', tracks: 1, detached: 1, attached: 1, playing: 1, errors: [] } } }).includes('възстановен'), 'без „възстановен“ (успешен play() не е доказателство)')
  const idle = render({ ...base, status: 'idle' })
  assert(!idle.includes('restore-audio'), 'не и извън гласа')
})

await check('[A10] сървърът приема отчета на H4 без промяна; непознатите стойности се отхвърлят както досега', () => {
  for (const result of ['success', 'failed', 'gesture_required'] as const) {
    const parsed = parseVoiceClientReport({ event: 'media_recovery', target: 'output', step: 'reattach', result, trigger: 'gesture' })
    assert(parsed !== null && parsed.event === 'media_recovery', `приет: reattach/${result}/gesture`)
  }
  assertEqual(parseVoiceClientReport({ event: 'media_recovery', target: 'output', step: 'restore_incoming', result: 'success', trigger: 'gesture' }), null, 'нова стъпка би била отхвърлена (затова не се ползва)')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
