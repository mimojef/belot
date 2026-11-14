/**
 * checkVoiceSpeakPreview.ts — Гласов чат: сървърното решение за говорене
 * ПРЕДИ включване (voiceSpeak в WS snapshot-ите) — клиентската страна.
 * Реалният път сървър -> WS -> main.ts -> прозорец е в
 * scripts/checkVoiceSpeakPreviewE2E.ts.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceSpeakPreview.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceSnapshot } from '../src/app/voice/createVoiceController'
import { createVoiceSpeakPreviewTracker, parseVoiceSpeakPreview } from '../src/app/voice/voiceSpeakPreview'
import { resolveVoiceJoinOffer } from '../src/app/voice/ui/voiceJoinOffer'
import { renderVoiceJoinPrompt, renderVoicePanel } from '../src/app/voice/ui/renderVoicePanel'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
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
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')

console.log('\ncheckVoiceSpeakPreview\n')

check('[S1] Парсване: само canSpeak/blockedReason/mutedUntil; mutedUntil само при мют; противоречиви/непознати стойности -> null', () => {
  const full = parseVoiceSpeakPreview({ canSpeak: true, blockedReason: null, mutedUntil: '2026-11-14T12:00:00.000Z', hasSpeakingEntitlement: true, profileId: 'x' })
  assert(full !== null && JSON.stringify(Object.keys(full).sort()) === '["blockedReason","canSpeak","mutedUntil"]', `ключове: ${JSON.stringify(full)}`)
  assert(full.mutedUntil === null, 'mutedUntil без мют се изхвърля')
  const muted = parseVoiceSpeakPreview({ canSpeak: false, blockedReason: 'muted', mutedUntil: '2026-11-14T12:00:00.000Z' })
  assert(muted?.blockedReason === 'muted' && muted.mutedUntil === '2026-11-14T12:00:00.000Z', 'мют')
  for (const bad of [null, undefined, 'x', {}, { canSpeak: 'yes' }, { canSpeak: true, blockedReason: 'muted' }, { canSpeak: false, blockedReason: null }, { canSpeak: false, blockedReason: 'banned' }]) {
    assert(parseVoiceSpeakPreview(bad) === null, `невалидно: ${JSON.stringify(bad)}`)
  }
})

check('[S2] Tracker: private_room_updated / room_snapshot / voice_speak_access_updated / voice_presence_result; стар сървър без полето не променя нищо; null изчиства', () => {
  const t = createVoiceSpeakPreviewTracker()
  const can = { canSpeak: true, blockedReason: null, mutedUntil: null }
  const muted = { canSpeak: false, blockedReason: 'muted', mutedUntil: null, hasSpeakingEntitlement: true }
  assert(t.applyServerMessage({ type: 'private_room_updated', room: { voiceTableId: 'vt-1' }, voiceSpeak: can } as never), 'waiting')
  assert(t.get('vt-1')?.canSpeak === true && t.get('vt-2') === null, 'по маса')
  assert(!t.applyServerMessage({ type: 'private_room_updated', room: { voiceTableId: 'vt-1' }, voiceSpeak: can } as never), 'същото решение -> без промяна (без излишно прерисуване)')
  assert(!t.applyServerMessage({ type: 'private_room_updated', room: { voiceTableId: 'vt-1' } } as never) && t.get('vt-1') !== null, 'стар сървър')
  assert(t.applyServerMessage({ type: 'voice_speak_access_updated', voiceTableId: 'vt-1', speak: muted } as never) && t.get('vt-1')?.blockedReason === 'muted', 'мют известие')
  assert(!('hasSpeakingEntitlement' in t.get('vt-1')!), 'без допълнителни полета')
  assert(t.applyServerMessage({ type: 'room_snapshot', voiceTableId: 'vt-1', voiceSpeak: can } as never) && t.get('vt-1')?.canSpeak === true, 'игра')
  assert(!t.applyServerMessage({ type: 'voice_presence_result', voiceTableId: 'vt-1', ok: false, code: 'banned' } as never), 'неуспешен presence')
  assert(t.applyServerMessage({ type: 'voice_presence_result', voiceTableId: 'vt-1', ok: true, speak: muted } as never) && t.get('vt-1')?.blockedReason === 'muted', 'presence')
  assert(t.applyServerMessage({ type: 'private_room_updated', room: { voiceTableId: 'vt-1' }, voiceSpeak: null } as never) && t.get('vt-1') === null, 'null изчиства')
  assert(!t.applyServerMessage({ type: 'private_room_updated', room: { voiceTableId: null }, voiceSpeak: can } as never), 'без гласова маса')
  assert(!t.applyServerMessage({ type: 'lobby_chat_history' } as never), 'чуждо съобщение')
})

check('[S3] Приоритет: сървърното решение преди включване печели над VIP статуса (придобито право след изтичане на VIP; мют)', () => {
  assert(resolveVoiceJoinOffer({ canSpeak: true, blockedReason: null }, 'inactive') === 'speak', 'изтекъл VIP + придобито право')
  assert(resolveVoiceJoinOffer({ canSpeak: true, blockedReason: null }, 'error') === 'speak', 'статусът не се е заредил')
  assert(resolveVoiceJoinOffer({ canSpeak: false, blockedReason: 'muted' }, 'active') === 'muted', 'мют над VIP')
  assert(resolveVoiceJoinOffer({ canSpeak: false, blockedReason: 'vip_required' }, 'unknown') === 'listen_vip', 'отказ без изчакване на статуса')
})

check('[S4] Панелът преди включване показва мюта от решението (със срока) и без бутон за микрофона', () => {
  const snapshot = {
    status: 'idle', voiceTableId: 'vt-1', screen: 'waiting', speak: null, wantsToSpeak: false, microphone: 'off', playbackBlocked: false,
    uiError: null, canRestore: false, offerDismissed: false, microphoneDevicesChanged: false, generation: null,
    locallyMutedProfileIds: [], participants: [], speakingProfileIds: [],
  } as unknown as VoiceSnapshot
  const html = renderVoicePanel({
    snapshot, seats: [], theme: 'light', joinOffer: 'muted', canOpenShop: true,
    preJoinSpeak: { canSpeak: false, blockedReason: 'muted', mutedUntil: new Date(Date.now() + 3_600_000).toISOString() },
  })
  assert(html.includes('Микрофонът е блокиран') && html.includes('Наказанието е до'), 'съобщение и срок')
  assert(!html.includes('data-voice-action="join-mic"') && !html.includes('data-voice-action="get-vip"'), 'без микрофон/VIP')
})

check('[S5] Неутралният прозорец е с одобрения текст', () => {
  const html = renderVoiceJoinPrompt({ offer: 'neutral', canOpenShop: true })
  assert(html.includes('Можеш да се включиш в гласовия разговор с останалите играчи на масата.'), 'текст')
})

check('[S6] Без заявки и таймери: решението идва само от вече пристигналите WS съобщения; main.ts го прилага преди гласовия контролер', () => {
  const tracker = read('src/app/voice/voiceSpeakPreview.ts').replace(/^\s*(\/\/|\/?\*).*$/gm, '')
  assert(!/fetch\(|XMLHttpRequest|setTimeout|setInterval|WebSocket/.test(tracker), 'мрежа/таймери')
  const main = read('src/main.ts')
  const apply = main.indexOf('voiceSpeakPreview.applyServerMessage(message)')
  const handled = main.indexOf('voiceController.handleServerMessage(message)) return')
  assert(apply > 0 && handled > apply, 'прилага се преди контролера (той поглъща гласовите съобщения)')
  assert(main.includes('getSpeakPreview: (voiceTableId) => voiceSpeakPreview.get(voiceTableId)'), 'UI свързване')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
