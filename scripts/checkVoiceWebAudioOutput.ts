/**
 * checkVoiceWebAudioOutput.ts — W1 (ЕКСПЕРИМЕНТАЛНО): логиката на
 * src/app/voice/voiceWebAudioOutput.ts с фалшив AudioContext (без браузър):
 * createGain() от 0, resume по събития (едно на епизод, без
 * watchdog), „Включи звука“, изолирана смяна на затворен контекст (лимит,
 * reconnect, напускане), изчакване на H4, една операция наведнъж, диагностика.
 * Плюс сървърното приемане на media_context.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceWebAudioOutput.ts
 */

import {
  VOICE_CONTEXT_REPLACE_LIMIT,
  VOICE_CONTEXT_RESUME_TIMEOUT_MS,
  createVoiceWebAudioOutput,
  zeroGainAudioContextClass,
  type VoiceMediaContextReport,
  type VoiceWebAudioOutput,
} from '../src/app/voice/voiceWebAudioOutput'
import { parseVoiceClientReport } from '../server/src/voice/voiceClientDiagnostics'

console.log('\ncheckVoiceWebAudioOutput\n')

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
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const flush = async (rounds = 6): Promise<void> => { for (let i = 0; i < rounds; i += 1) await Promise.resolve() }

// ─── Фалшив AudioContext ───────────────────────────────────────────────
type ResumeBehavior = 'run' | 'hang' | 'stay'
const allContexts: FakeContext[] = []
class FakeContext {
  state: string = 'running'
  resumeBehavior: ResumeBehavior = 'run'
  resumeCalls = 0
  private listeners: Array<() => void> = []
  constructor(_options?: AudioContextOptions) { allContexts.push(this) }
  addEventListener(type: string, listener: () => void): void { if (type === 'statechange') this.listeners.push(listener) }
  createGain(): { gain: { value: number } } { return { gain: { value: 1 } } }
  setState(state: string): void { if (this.state === state) return; this.state = state; for (const l of [...this.listeners]) l() }
  resume(): Promise<void> {
    this.resumeCalls += 1
    if (this.state === 'closed') return Promise.reject(new Error('closed'))
    if (this.resumeBehavior === 'hang') return new Promise(() => {})
    if (this.resumeBehavior === 'stay') return Promise.resolve()
    this.setState('running')
    return Promise.resolve()
  }
  close(): Promise<void> { this.setState('closed'); return Promise.resolve() }
}

// ─── Детерминирани таймери и документ ─────────────────────────────────
type Timer = { at: number; fn: () => void; id: number }
let now = 0
let timers: Timer[] = []
let nextId = 1
const fakeSetTimeout = (fn: () => void, ms: number): unknown => { const t = { at: now + ms, fn, id: nextId++ }; timers.push(t); return t.id }
const fakeClearTimeout = (id: unknown): void => { timers = timers.filter((t) => t.id !== id) }
async function advance(ms: number): Promise<void> {
  const end = now + ms
  for (;;) {
    timers.sort((a, b) => a.at - b.at)
    const next = timers[0]
    if (next === undefined || next.at > end) break
    timers.shift()
    now = next.at
    next.fn()
    await flush()
  }
  now = end
  await flush()
}

type Env = {
  output: VoiceWebAudioOutput
  reports: VoiceMediaContextReport[]
  blockedChanges: number
  state: { connected: boolean; visible: boolean; restore: Promise<unknown> | null; startAudioCalls: number; startAudioFails: boolean }
  ctx: () => FakeContext
  visibility: () => void
}
function setup(): Env {
  now = 0
  timers = []
  allContexts.length = 0
  const state = { connected: true, visible: true, restore: null as Promise<unknown> | null, startAudioCalls: 0, startAudioFails: false }
  const reports: VoiceMediaContextReport[] = []
  let visibilityListener: (() => void) | null = null
  const env = { reports, blockedChanges: 0, state } as Env
  const output = createVoiceWebAudioOutput({
    AudioContextClass: FakeContext as unknown as new () => AudioContext,
    report: (r) => reports.push(r),
    onBlockedChange: () => { env.blockedChanges += 1 },
    isRoomConnected: () => state.connected,
    incomingRestore: () => state.restore,
    startAudio: async () => {
      state.startAudioCalls += 1
      if (state.startAudioFails) throw new Error('start failed')
      // Както SDK-то: acquireAudioContext прави resume на подадения контекст.
      await (env.output.settings.audioContext as unknown as FakeContext).resume()
    },
    isPageVisible: () => state.visible,
    doc: {
      addEventListener: ((type: string, l: () => void) => { if (type === 'visibilitychange') visibilityListener = l }) as Document['addEventListener'],
      removeEventListener: ((type: string) => { if (type === 'visibilitychange') visibilityListener = null }) as Document['removeEventListener'],
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  })
  assert(output !== null, 'output')
  env.output = output
  env.ctx = () => output.settings.audioContext as unknown as FakeContext
  env.visibility = () => visibilityListener?.()
  return env
}
const summary = (reports: VoiceMediaContextReport[]) => reports.map((r) => `${r.state}/${r.action}/${r.result}`)

try {
  // Правилото за режима (kill switch, профил, локален ключ) — scripts/checkVoiceExperimentalAudio.ts.
  await check('createGain() от 0 (подклас, без промяна на базовия клас); без AudioContext -> null', () => {
    const Zero = zeroGainAudioContextClass(FakeContext as unknown as new () => AudioContext)
    assert(zeroGainAudioContextClass(FakeContext as unknown as new () => AudioContext) === Zero, 'кеширан клас')
    const zero = new Zero()
    for (let i = 0; i < 3; i += 1) assert(zero.createGain().gain.value === 0, 'всеки GainNode от 0')
    assert(new FakeContext().createGain().gain.value === 1, 'базовият клас е непроменен')
    const env = setup()
    assert(env.output.settings.audioContext.createGain().gain.value === 0, 'контекстът на стаята -> от 0')
    assert(createVoiceWebAudioOutput({ AudioContextClass: undefined, report: () => {}, onBlockedChange: () => {}, isRoomConnected: () => true, incomingRestore: () => null, startAudio: async () => {}, isPageVisible: () => true }) === null, 'неподдържано -> null')
    const Throwing = class { constructor() { throw new Error('no audio') } }
    assert(createVoiceWebAudioOutput({ AudioContextClass: Throwing as unknown as new () => AudioContext, report: () => {}, onBlockedChange: () => {}, isRoomConnected: () => true, incomingRestore: () => null, startAudio: async () => {}, isPageVisible: () => true }) === null, 'хвърлящ конструктор -> null')
  })

  await check('начален отчет само веднъж (start/success); Reconnected не го повтаря', () => {
    const env = setup()
    env.output.onConnected(true)
    env.output.onConnected(false)
    env.output.onConnected(true)
    assert(summary(env.reports).join(',') === 'running/start/success', summary(env.reports).join(','))
  })

  await check('suspended -> ЕДНО resume -> running; без повторение по таймер', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.ctx().setState('suspended')
    await flush()
    assert(env.ctx().resumeCalls === 1 && env.ctx().state === 'running', `resume ${env.ctx().resumeCalls}, ${env.ctx().state}`)
    await advance(60_000)
    assert(env.ctx().resumeCalls === 1, 'без последващи опити')
    assert(summary(env.reports).slice(1).join(',') === 'suspended/resume/success', summary(env.reports).join(','))
    assert(!env.output.blocked(), 'не е блокиран')
    // Нов епизод -> отново едно resume.
    env.ctx().setState('suspended')
    await flush()
    assert(env.ctx().resumeCalls === 2, 'новият епизод има свой опит')
  })

  await check('неуспешно resume (виси) -> след срока blocked („Включи звука“), без нови опити; running го чисти', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.ctx().resumeBehavior = 'hang'
    env.ctx().setState('suspended')
    await flush()
    assert(!env.output.blocked() && env.output.debug().ctxBusy === 1, 'чака срока')
    await advance(VOICE_CONTEXT_RESUME_TIMEOUT_MS)
    assert(env.output.blocked() && env.blockedChanges === 1, 'blocked след срока')
    assert(summary(env.reports).at(-1) === 'suspended/resume/blocked', summary(env.reports).join(','))
    env.visibility()
    await advance(60_000)
    assert(env.ctx().resumeCalls === 1, `без нови автоматични опити (${env.ctx().resumeCalls})`)
    env.ctx().setState('running') // напр. системата го пусна сама
    assert(!env.output.blocked() && env.blockedChanges === 2, 'running чисти blocked')
  })

  await check('„Включи звука“ (жест): resume при спрян; неуспех -> остава blocked', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.ctx().resumeBehavior = 'stay'
    env.ctx().setState('suspended')
    await flush()
    assert(env.output.blocked(), 'blocked (resume не пусна контекста)')
    await env.output.gesture()
    assert(env.output.blocked() && summary(env.reports).at(-1) === 'suspended/gesture/failed', summary(env.reports).join(','))
    env.ctx().resumeBehavior = 'run'
    await env.output.gesture()
    assert(!env.output.blocked() && env.ctx().state === 'running', 'жестът успя')
    assert(summary(env.reports).at(-1) === 'suspended/gesture/success', summary(env.reports).join(','))
  })

  await check('скрита страница: без resume; при видимост — едно', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.state.visible = false
    env.ctx().setState('suspended')
    await flush()
    assert(env.ctx().resumeCalls === 0, 'скрита -> нищо')
    env.state.visible = true
    env.visibility()
    await flush()
    assert(env.ctx().resumeCalls === 1 && env.ctx().state === 'running', 'видима -> едно resume')
  })

  await check('interrupted се третира като suspended (едно resume)', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.ctx().setState('interrupted')
    await flush()
    assert(env.ctx().resumeCalls === 1 && summary(env.reports).at(-1) === 'interrupted/resume/success', summary(env.reports).join(','))
  })

  await check('затворен контекст -> смяна (нов контекст в СЪЩИЯ settings обект, startAudio, нулев gain)', async () => {
    const env = setup()
    env.output.onConnected(true)
    const settings = env.output.settings
    const old = env.ctx()
    old.setState('closed')
    await flush()
    assert(env.output.settings === settings, 'същият обект (SDK пази референцията)')
    assert(env.ctx() !== old && env.ctx().state === 'running', 'нов работещ контекст')
    assert(env.state.startAudioCalls === 1, 'startAudio веднъж')
    assert(env.output.settings.audioContext.createGain().gain.value === 0, 'новият също е с нулев gain')
    assert(summary(env.reports).at(-1) === 'closed/replace/success', summary(env.reports).join(','))
  })

  await check(`лимит: ${VOICE_CONTEXT_REPLACE_LIMIT} автоматични смени, после limited -> blocked; жестът сменя въпреки лимита`, async () => {
    const env = setup()
    env.output.onConnected(true)
    for (let i = 0; i < VOICE_CONTEXT_REPLACE_LIMIT; i += 1) { env.ctx().setState('closed'); await flush() }
    assert(allContexts.length === 1 + VOICE_CONTEXT_REPLACE_LIMIT, `контексти ${allContexts.length}`)
    env.ctx().setState('closed')
    await flush()
    assert(allContexts.length === 1 + VOICE_CONTEXT_REPLACE_LIMIT, 'без нова смяна над лимита')
    assert(env.output.blocked() && summary(env.reports).at(-1) === 'closed/replace/limited', summary(env.reports).join(','))
    env.visibility()
    await flush()
    assert(summary(env.reports).filter((r) => r.endsWith('/limited')).length === 1, 'limited — един отчет')
    await env.output.gesture()
    assert(!env.output.blocked() && env.ctx().state === 'running' && summary(env.reports).at(-1) === 'closed/gesture/success', summary(env.reports).join(','))
  })

  await check('неуспешна смяна (startAudio хвърля) -> blocked; без автоматично повторение', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.state.startAudioFails = true
    env.ctx().setState('closed')
    await flush()
    assert(env.output.blocked() && summary(env.reports).at(-1) === 'closed/replace/blocked', summary(env.reports).join(','))
    const contexts = allContexts.length
    env.visibility()
    env.output.onConnected(false)
    await flush()
    assert(allContexts.length === contexts, 'без нови контексти, докато чака жест')
  })

  await check('затворен по време на reconnect -> смяната чака Reconnected', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.state.connected = false
    env.ctx().setState('closed')
    await flush()
    assert(allContexts.length === 1 && env.state.startAudioCalls === 0, 'без смяна при reconnect')
    env.state.connected = true
    env.output.onConnected(false)
    await flush()
    assert(allContexts.length === 2 && env.ctx().state === 'running', 'смяна след Reconnected')
  })

  await check('dispose (напускане/ротация/disconnect): затваря, НИКОГА нов контекст; statechange closed се игнорира', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.output.dispose()
    await flush()
    assert(env.ctx().state === 'closed' && allContexts.length === 1, 'затворен, без нов')
    env.output.onConnected(false)
    env.visibility()
    await env.output.gesture()
    assert(allContexts.length === 1 && env.reports.length === 1, 'след dispose — нищо')
    assert(env.output.debug().ctxClosedByUs === 1, 'затворен от нас')
    env.output.dispose()
    assert(env.output.debug().ctxClosedByUs === 1, 'идемпотентно')
  })

  await check('dispose ПО ВРЕМЕ на смяна -> новият контекст се затваря (без изтичане)', async () => {
    setup()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    // startAudio виси до release (смяната е в ход).
    const outputWithHang = createVoiceWebAudioOutput({
      AudioContextClass: FakeContext as unknown as new () => AudioContext,
      report: () => {},
      onBlockedChange: () => {},
      isRoomConnected: () => true,
      incomingRestore: () => null,
      startAudio: () => pending,
      isPageVisible: () => true,
      doc: { addEventListener: (() => {}) as Document['addEventListener'], removeEventListener: (() => {}) as Document['removeEventListener'] },
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    })!
    const before = allContexts.length
    ;(outputWithHang.settings.audioContext as unknown as FakeContext).setState('closed')
    await flush()
    assert(allContexts.length === before + 1, 'смяната е започнала (нов контекст)')
    const fresh = outputWithHang.settings.audioContext as unknown as FakeContext
    outputWithHang.dispose()
    release()
    await flush()
    assert(fresh.state === 'closed', 'новият контекст е затворен след dispose')
    assert(allContexts.length === before + 1, 'без още контексти')
  })

  await check('една операция наведнъж: събития по време на resume не стартират втора', async () => {
    const env = setup()
    env.output.onConnected(true)
    env.ctx().resumeBehavior = 'hang'
    env.ctx().setState('suspended')
    await flush()
    env.ctx().setState('interrupted')
    env.visibility()
    env.output.onConnected(false)
    await flush()
    assert(env.ctx().resumeCalls === 1, `един resume (${env.ctx().resumeCalls})`)
    // Затваряне по време на висящото resume -> смяната е СЛЕД него (оценка в края).
    env.ctx().setState('closed')
    await flush()
    assert(allContexts.length === 1, 'без паралелна смяна')
    await advance(VOICE_CONTEXT_RESUME_TIMEOUT_MS)
    assert(allContexts.length === 2 && env.ctx().state === 'running', 'смяната след края на resume')
  })

  await check('H4 в ход: възстановяването го изчаква; idle() се изпълнява след операцията', async () => {
    const env = setup()
    env.output.onConnected(true)
    let finishRestore!: () => void
    env.state.restore = new Promise<void>((resolve) => { finishRestore = resolve })
    env.ctx().setState('suspended')
    await flush()
    assert(env.ctx().resumeCalls === 0 && env.output.debug().ctxDeferredForRestore === 1, 'чака H4')
    let idleDone = false
    void env.output.idle().then(() => { idleDone = true })
    await flush()
    assert(!idleDone, 'idle() чака операцията')
    env.state.restore = null
    finishRestore()
    await flush(12)
    assert(env.ctx().resumeCalls === 1 && env.ctx().state === 'running', 'resume след H4')
    assert(idleDone, 'idle() след операцията')
  })

  await check('H4 вече пусна контекста (connectWebAudio -> resume): възстановяването не прави излишно resume', async () => {
    const env = setup()
    env.output.onConnected(true)
    let finishRestore!: () => void
    env.state.restore = new Promise<void>((resolve) => { finishRestore = resolve })
    env.ctx().setState('suspended')
    await flush()
    env.ctx().setState('running') // H4 -> attach -> connectWebAudio -> resume
    env.state.restore = null
    finishRestore()
    await flush(12)
    // Задачата вижда running след изчакването — resume е безвредно (вече running) и е отчетено като успех.
    assert(env.ctx().state === 'running' && !env.output.blocked(), 'работи, не е блокиран')
  })

  await check('сървър: media_context се приема само със затворени стойности', () => {
    const ok = parseVoiceClientReport({ event: 'media_context', state: 'closed', action: 'replace', result: 'success' })
    assert(ok !== null && ok.event === 'media_context', 'валидно')
    for (const bad of [
      { event: 'media_context', state: 'weird', action: 'replace', result: 'success' },
      { event: 'media_context', state: 'running', action: 'reload', result: 'success' },
      { event: 'media_context', state: 'running', action: 'start', result: 'ok' },
      { event: 'media_context', state: 'running', action: 'start' },
    ]) assert(parseVoiceClientReport(bad) === null, `невалидно: ${JSON.stringify(bad)}`)
  })
} finally {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
