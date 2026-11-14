/**
 * checkVoiceJoinOffer.ts — Гласов чат: вариантът при включване (VIP прозорец).
 *
 * Бъг (production, режим „Само админ“): VIP създател и VIP поканени виждаха
 * „Само слушай / Вземи VIP / Не сега“, защото UI-ът четеше profile.isVip от
 * сесията (сървърът там винаги праща null). Поправката: сървърното решение
 * (snapshot.speak) има приоритет, иначе /api/vip/status; неизвестното не е
 * „без VIP“. Реалното свързване в main.ts се проверява в браузър от
 * scripts/checkVoiceVipWiringE2E.ts — тук са чистата логика и рендерирането.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceJoinOffer.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceSnapshot } from '../src/app/voice/createVoiceController'
import { createVoiceOwnVipStatusSource, type VoiceOwnVipLoadResult, type VoiceOwnVipStatus } from '../src/app/voice/voiceOwnVipStatus'
import type { VoiceSpeakState } from '../src/app/voice/voiceProtocol'
import { resolveVoiceJoinOffer, type VoiceJoinOffer } from '../src/app/voice/ui/voiceJoinOffer'
import { renderVoiceJoinPrompt, renderVoicePanel } from '../src/app/voice/ui/renderVoicePanel'

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

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const speakOk = (entitled = false): VoiceSpeakState => ({ canSpeak: true, blockedReason: null, hasSpeakingEntitlement: entitled, mutedUntil: null })
const speakVipRequired: VoiceSpeakState = { canSpeak: false, blockedReason: 'vip_required', hasSpeakingEntitlement: false, mutedUntil: null }
const speakMuted = (entitled: boolean): VoiceSpeakState => ({ canSpeak: false, blockedReason: 'muted', hasSpeakingEntitlement: entitled, mutedUntil: null })
const VIP_STATUSES: VoiceOwnVipStatus[] = ['unknown', 'active', 'inactive', 'error']

const has = (html: string, action: string) => html.includes(`data-voice-action="${action}"`)

console.log('\ncheckVoiceJoinOffer\n')

await check('[J1] Без сървърно решение: active -> speak, inactive -> listen_vip, error -> neutral, unknown -> pending (НЕ „без VIP“)', () => {
  const expected: Record<VoiceOwnVipStatus, VoiceJoinOffer> = { active: 'speak', inactive: 'listen_vip', error: 'neutral', unknown: 'pending' }
  for (const vip of VIP_STATUSES) assert(resolveVoiceJoinOffer(null, vip) === expected[vip], `${vip} -> ${resolveVoiceJoinOffer(null, vip)}`)
})

await check('[J2] Сървърното canSpeak има приоритет: придобито право при изтекъл/неизвестен VIP -> speak', () => {
  for (const vip of VIP_STATUSES) {
    assert(resolveVoiceJoinOffer(speakOk(true), vip) === 'speak', `entitled + ${vip}`)
    assert(resolveVoiceJoinOffer(speakOk(false), vip) === 'speak', `canSpeak + ${vip}`)
  }
})

await check('[J3] Административен мют печели над VIP и придобито право -> muted (без микрофон и без „Вземи VIP“)', () => {
  for (const vip of VIP_STATUSES) {
    assert(resolveVoiceJoinOffer(speakMuted(true), vip) === 'muted', `muted+entitled + ${vip}`)
    assert(resolveVoiceJoinOffer(speakMuted(false), vip) === 'muted', `muted + ${vip}`)
  }
})

await check('[J4] Сървърен отказ vip_required -> listen_vip; само по-нов активен VIP го надгражда (сървърното правило VIP -> право)', () => {
  assert(resolveVoiceJoinOffer(speakVipRequired, 'inactive') === 'listen_vip', 'inactive')
  assert(resolveVoiceJoinOffer(speakVipRequired, 'unknown') === 'listen_vip', 'unknown (известното решение не се губи)')
  assert(resolveVoiceJoinOffer(speakVipRequired, 'error') === 'listen_vip', 'error')
  assert(resolveVoiceJoinOffer(speakVipRequired, 'active') === 'speak', 'active')
})

const PROMPT_EXPECT: Record<Exclude<VoiceJoinOffer, 'pending'>, { mic: boolean; listen: boolean; vip: boolean }> = {
  speak: { mic: true, listen: true, vip: false },
  listen_vip: { mic: false, listen: true, vip: true },
  muted: { mic: false, listen: true, vip: false },
  neutral: { mic: true, listen: true, vip: false },
}

await check('[J5] Прозорецът: speak = микрофон+слушай; listen_vip = слушай+„Вземи VIP“; muted = само слушай; neutral = без „Вземи VIP“ (desktop dark + mobile light)', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const [offer, want] of Object.entries(PROMPT_EXPECT) as Array<[Exclude<VoiceJoinOffer, 'pending'>, typeof PROMPT_EXPECT['speak']]>) {
      const html = renderVoiceJoinPrompt({ offer, canOpenShop: true, theme })
      assert(html.includes(`data-voice-prompt-offer="${offer}"`), `${offer}/${theme}: атрибут`)
      assert(has(html, 'join-mic') === want.mic, `${offer}/${theme}: join-mic`)
      assert(has(html, 'join-listen') === want.listen, `${offer}/${theme}: join-listen`)
      assert(has(html, 'get-vip') === want.vip, `${offer}/${theme}: get-vip`)
      assert(has(html, 'not-now'), `${offer}/${theme}: „Не сега“`)
    }
  }
  assert(!has(renderVoiceJoinPrompt({ offer: 'listen_vip', canOpenShop: false }), 'get-vip'), 'без магазин — без „Вземи VIP“')
})

function idleSnapshot(speak: VoiceSpeakState | null): VoiceSnapshot {
  return {
    status: 'idle', voiceTableId: 'vt-1', screen: 'waiting', speak, wantsToSpeak: false, microphone: 'off', playbackBlocked: false,
    uiError: null, canRestore: false, offerDismissed: false, microphoneDevicesChanged: false, generation: null,
    locallyMutedProfileIds: [], participants: [], speakingProfileIds: [],
  } as unknown as VoiceSnapshot
}

await check('[J6] Панелът преди включване следва същия вариант; pending/neutral никога не показват „Вземи VIP“; мютът показва съобщението', () => {
  const panel = (offer: VoiceJoinOffer, speak: VoiceSpeakState | null = null) =>
    renderVoicePanel({ snapshot: idleSnapshot(speak), seats: [], theme: 'light', joinOffer: offer, canOpenShop: true })
  for (const [offer, want] of Object.entries(PROMPT_EXPECT) as Array<[Exclude<VoiceJoinOffer, 'pending'>, typeof PROMPT_EXPECT['speak']]>) {
    const html = panel(offer)
    assert(has(html, 'join-mic') === want.mic && has(html, 'get-vip') === want.vip && has(html, 'join-listen'), `панел ${offer}`)
  }
  const pending = panel('pending')
  assert(!has(pending, 'get-vip') && has(pending, 'join-listen'), 'pending')
  const muted = panel('muted', speakMuted(true))
  assert(muted.includes('Микрофонът е блокиран') && !has(muted, 'join-mic'), 'мют: съобщение, без микрофон')
})

type Deferred = { resolve: (value: VoiceOwnVipLoadResult) => void; reject: (error: unknown) => void }
function makeSource() {
  const calls: Deferred[] = []
  let changes = 0
  const source = createVoiceOwnVipStatusSource({
    load: () => new Promise<VoiceOwnVipLoadResult>((resolve, reject) => { calls.push({ resolve, reject }) }),
    onChange: () => { changes += 1 },
  })
  return { source, calls, changes: () => changes }
}
const target = (screen: 'waiting' | 'game' | 'off_table', voiceTableId = 'vt-1', profileId = 'p-1') => ({ profileId, voiceTableId, screen })

await check('[J7] Източникът: една заявка за посещение на чакалнята — 50 рендерирания = 1 заявка; до отговора статусът е unknown', async () => {
  const { source, calls, changes } = makeSource()
  assert(source.get() === 'unknown', 'начално')
  for (let i = 0; i < 50; i += 1) source.sync(target('waiting'))
  assert(calls.length === 1, `заявки: ${calls.length}`)
  assert(source.get() === 'unknown', 'до отговора — unknown, не inactive')
  calls[0]!.resolve({ ok: true, isActive: true })
  await flush()
  assert(source.get() === 'active' && changes() === 1, `active, onChange ${changes()}`)
  for (let i = 0; i < 20; i += 1) source.sync(target('waiting'))
  source.sync(target('game'))
  source.sync(target('game'))
  assert(calls.length === 1, 'чакалня -> игра: без нова заявка')
  source.sync(target('waiting'))
  assert(calls.length === 2, 'ново влизане в чакалнята -> 1 свежа заявка')
  source.sync(target('waiting', 'vt-2'))
  assert(calls.length === 3 && source.get() === 'unknown', 'нова маса -> свежа заявка и unknown')
})

await check('[J8] Грешка/отхвърляне/изключение -> error (неутрален вариант); без автоматични повторни заявки', async () => {
  for (const mode of ['notOk', 'reject', 'throw'] as const) {
    let loads = 0
    const source = createVoiceOwnVipStatusSource({
      load: () => {
        loads += 1
        if (mode === 'throw') throw new Error('boom')
        return mode === 'reject' ? Promise.reject(new Error('network')) : Promise.resolve({ ok: false })
      },
      onChange: () => {},
    })
    source.sync(target('waiting'))
    await flush()
    assert(source.get() === 'error', `${mode}: ${source.get()}`)
    for (let i = 0; i < 10; i += 1) source.sync(target('waiting'))
    await flush()
    assert(loads === 1, `${mode}: заявки ${loads}`)
  }
})

await check('[J9] Закъснял отговор за стара маса/излизане се пренебрегва; refresh пази последния известен статус', async () => {
  const { source, calls } = makeSource()
  source.sync(target('waiting', 'vt-1'))
  source.sync(target('waiting', 'vt-2'))
  calls[1]!.resolve({ ok: true, isActive: true })
  await flush()
  calls[0]!.resolve({ ok: true, isActive: false })
  await flush()
  assert(source.get() === 'active', `стар отговор: ${source.get()}`)
  source.refresh()
  assert(calls.length === 3 && source.get() === 'active', 'refresh: последният известен до отговора')
  calls[2]!.resolve({ ok: true, isActive: false })
  await flush()
  assert(source.get() === 'inactive', 'refresh: новият статус')
  source.refresh()
  source.sync(null)
  assert(source.get() === 'unknown', 'извън гласова маса -> unknown')
  calls[3]!.resolve({ ok: true, isActive: true })
  await flush()
  assert(source.get() === 'unknown', 'отговор след излизане -> пренебрегнат')
  source.refresh()
  assert(calls.length === 4, 'refresh извън гласова маса -> без заявка')
})

await check('[J10] Без периодични заявки и без profile.isVip: източникът няма таймери; гласовият UI не чете сесията', () => {
  const sourceText = read('src/app/voice/voiceOwnVipStatus.ts')
  assert(!/setTimeout|setInterval|requestAnimationFrame/.test(sourceText.replace(/^\s*\/\/.*$/gm, '')), 'таймери в източника')
  for (const file of ['src/app/voice/ui/createVoiceMobileUi.ts', 'src/app/voice/ui/renderVoicePanel.ts', 'src/app/voice/ui/voiceJoinOffer.ts']) {
    const code = read(file).replace(/^\s*(\/\/|\/?\*).*$/gm, '')
    assert(!/\bisVip\b|isOwnVip/.test(code), `${file}: isVip/isOwnVip`)
  }
})

await check('[J11] Lazy chunk-ът на панела импортира решението само като тип (без статичен импорт извън voice chunk-овете)', () => {
  const panel = read('src/app/voice/ui/renderVoicePanel.ts')
  assert(/^import type \{ VoiceJoinOffer \} from '\.\/voiceJoinOffer'$/m.test(panel), 'import type')
  assert(!/^import \{[^}]*\} from '\.\/voiceJoinOffer'$/m.test(panel), 'без runtime импорт')
})

await check('[J12] main.ts: getOwnVipStatus е вързан към voiceOwnVipStatus (/api/vip/status), а не към currentAuthSession.profile.isVip', () => {
  const main = read('src/main.ts')
  const uiBlock = /voiceMobileUi = createVoiceMobileUi\(\{[\s\S]*?\n\}\)/.exec(main)?.[0] ?? ''
  assert(uiBlock.includes('getOwnVipStatus: () => voiceOwnVipStatus?.get()'), 'getOwnVipStatus')
  assert(!/isVip/.test(uiBlock), 'без isVip в гласовия UI')
  const loader = /async function loadVoiceOwnVipStatus\(\)[\s\S]*?\n\}/.exec(main)?.[0] ?? ''
  assert(loader.includes('/api/vip/status') && loader.includes("typeof data.status?.isActive !== 'boolean'"), 'loader')
  const sync = /function syncVoiceContext\(\): void \{[\s\S]*?\n\}/.exec(main)?.[0] ?? ''
  assert(sync.includes('voiceOwnVipStatus?.sync('), 'syncVoiceContext -> sync')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
