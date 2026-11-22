/**
 * checkVoiceExperimentalAudio.ts — ограничено production изпитване на
 * експерименталния аудио режим (W1 / webAudioMix) само за Divaka655 в Android
 * PWA + централен kill switch (Админ -> Настройки).
 *
 * Проверява само новите промени:
 *   - правилото за режима (voiceExperimentalAudioConfig.ts): kill switch с
 *     абсолютен приоритет, само Android PWA, точен profile_id, локалният
 *     тестов ключ само на localhost;
 *   - контролера: kill switch от отговора на токена, режим за всяка стая,
 *     повторна подготовка при промяна (≤1 стая), настройката и изборът;
 *   - панела („Експериментален аудио режим“);
 *   - H4 остава независим;
 *   - сървъра: admin_settings ключ (липсващ/невалиден -> изключен) и полето
 *     webAudioMix в успешния токен (грешка/липса -> false).
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceExperimentalAudio.ts
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY,
  VOICE_EXPERIMENTAL_AUDIO_PROFILE_IDS,
  VOICE_WEBAUDIO_MIX_STORAGE_KEY,
  isVoiceExperimentalAudioAvailable,
  readVoiceExperimentalAudioPreference,
  resolveVoiceIncomingAudioMode,
  writeVoiceExperimentalAudioPreference,
} from '../src/app/voice/voiceExperimentalAudioConfig'
import { isVoiceIncomingAudioRestoreAllowed } from '../src/app/voice/voiceIncomingAudioRestoreConfig'
import type { VoicePlatform } from '../src/app/voice/voiceMediaHealth'
import { renderVoicePanel } from '../src/app/voice/ui/renderVoicePanel'
import type { VoiceSnapshot } from '../src/app/voice/createVoiceController'
import { SEATS, createHarness, flush, snap, type Harness } from './fixtures/voiceControllerFakeHarness'
import { createAdminSettingsStore } from '../server/src/db/adminSettingsStore'
import { createVoiceChatHttpRequestHandler } from '../server/src/voice/voiceChatHttpApi'

console.log('\ncheckVoiceExperimentalAudio\n')

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
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

const DIVAKA = '29925128-167c-408b-9a33-620d2d8f9a95'
const DILEIDI = '90e3e375-1d21-4ce2-9ff5-e341bd91eea4'
const PROD_HOST = 'pika.bg'

type MemoryStorage = { values: Map<string, string>; getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(initial))
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

/** Зависимостите, както ги подава voiceRuntime (реалната конфигурация). */
function runtimeDeps(platform: VoicePlatform, storage: MemoryStorage, hostname = PROD_HOST) {
  return {
    available: (profileId: string) => isVoiceExperimentalAudioAvailable(platform, profileId),
    enabled: () => readVoiceExperimentalAudioPreference(storage),
    setEnabled: (enabled: boolean) => writeVoiceExperimentalAudioPreference(storage, enabled),
    modeFor: (profileId: string, serverAllowed: boolean) => resolveVoiceIncomingAudioMode({ serverAllowed, platform, profileId, storage, hostname }),
  }
}
const seatsFor = (profileId: string) => [{ profileId, isBot: false }, ...SEATS.slice(1)]
async function join(h: Harness, profileId: string): Promise<void> {
  h.voice.setContext(h.ctx('waiting', seatsFor(profileId)))
  await flush()
  h.voice.joinAsListener()
  await flush(40)
}
async function leave(h: Harness): Promise<void> {
  h.voice.leaveVoice()
  await flush(40)
}
const view = (h: Harness) => snap(h).experimentalAudio

try {
  // ─── Правилото ───────────────────────────────────────────────────────
  await check('[R1] списъкът: точно Divaka655, по profile_id (не nickname); H4 списъкът е непроменен', () => {
    assert(VOICE_EXPERIMENTAL_AUDIO_PROFILE_IDS.length === 1 && VOICE_EXPERIMENTAL_AUDIO_PROFILE_IDS[0] === DIVAKA, 'само Divaka655')
    assert(isVoiceExperimentalAudioAvailable('android_pwa', DIVAKA) && isVoiceExperimentalAudioAvailable('android_pwa', DIVAKA.toUpperCase()), 'Divaka655 (без значение за регистъра)')
    for (const value of ['Divaka655', DILEIDI, '', null, undefined, `${DIVAKA} `, DIVAKA.slice(0, -1)]) {
      assert(!isVoiceExperimentalAudioAvailable('android_pwa', value as string | null | undefined), `не: ${String(value)}`)
    }
    for (const platform of ['android_chrome', 'android_samsung', 'android_other', 'ios_pwa', 'desktop_chrome', 'unknown'] as const) {
      assert(!isVoiceExperimentalAudioAvailable(platform, DIVAKA), `само Android PWA (${platform})`)
    }
    assert(isVoiceIncomingAudioRestoreAllowed(DIVAKA) && isVoiceIncomingAudioRestoreAllowed(DILEIDI), 'H4: Divaka655 и DILEIDI')
  })

  await check('[R2] kill switch: изключен/липсващ/невалиден -> стария механизъм за ВСИЧКИ (абсолютен приоритет)', () => {
    const local = memoryStorage({ [VOICE_WEBAUDIO_MIX_STORAGE_KEY]: '1', [VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY]: '1' })
    for (const serverAllowed of [false, undefined, null, 'true', 1] as unknown[]) {
      assertEqual(resolveVoiceIncomingAudioMode({ serverAllowed: serverAllowed as boolean, platform: 'android_pwa', profileId: DIVAKA, storage: local, hostname: PROD_HOST }), 'element', `Divaka655 при ${String(serverAllowed)}`)
      assertEqual(resolveVoiceIncomingAudioMode({ serverAllowed: serverAllowed as boolean, platform: 'android_pwa', profileId: 'other', storage: local, hostname: 'localhost' }), 'element', `локален ключ при ${String(serverAllowed)}`)
    }
  })

  await check('[R3] разрешен: Divaka655 в Android PWA — включен по подразбиране; изборът "0" го изключва; другите платформи — не', () => {
    const base = { serverAllowed: true, profileId: DIVAKA, hostname: PROD_HOST }
    assertEqual(resolveVoiceIncomingAudioMode({ ...base, platform: 'android_pwa', storage: memoryStorage() }), 'webaudio', 'по подразбиране')
    assertEqual(resolveVoiceIncomingAudioMode({ ...base, platform: 'android_pwa', storage: null }), 'webaudio', 'без storage')
    assertEqual(resolveVoiceIncomingAudioMode({ ...base, platform: 'android_pwa', storage: memoryStorage({ [VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY]: '0' }) }), 'element', 'изключен от панела')
    assertEqual(resolveVoiceIncomingAudioMode({ ...base, platform: 'android_pwa', storage: { getItem: () => { throw new Error('blocked') } } }), 'webaudio', 'хвърлящ storage -> по подразбиране')
    for (const platform of ['android_chrome', 'android_samsung', 'ios_pwa', 'desktop_chrome', 'unknown'] as const) {
      assertEqual(resolveVoiceIncomingAudioMode({ ...base, platform, storage: memoryStorage() }), 'element', platform)
    }
  })

  await check('[R4] локалният тестов ключ: само на localhost/127.0.0.1 (и при разрешен kill switch); в production — игнориран', () => {
    const key = memoryStorage({ [VOICE_WEBAUDIO_MIX_STORAGE_KEY]: '1' })
    for (const hostname of ['localhost', '127.0.0.1']) {
      assertEqual(resolveVoiceIncomingAudioMode({ serverAllowed: true, platform: 'android_pwa', profileId: 'other', storage: key, hostname }), 'webaudio', hostname)
    }
    for (const hostname of [PROD_HOST, 'www.pika.bg', 'localhost.pika.bg', '192.168.1.5', '', null]) {
      assertEqual(resolveVoiceIncomingAudioMode({ serverAllowed: true, platform: 'android_pwa', profileId: 'other', storage: key, hostname }), 'element', `production/друг адрес: ${String(hostname)}`)
    }
    assertEqual(resolveVoiceIncomingAudioMode({ serverAllowed: true, platform: 'android_chrome', profileId: 'other', storage: key, hostname: 'localhost' }), 'element', 'само Android PWA и локално')
    // Изборът на Divaka655 печели над локалния ключ.
    assertEqual(resolveVoiceIncomingAudioMode({ serverAllowed: true, platform: 'android_pwa', profileId: DIVAKA, storage: memoryStorage({ [VOICE_WEBAUDIO_MIX_STORAGE_KEY]: '1', [VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY]: '0' }), hostname: 'localhost' }), 'element', 'изборът "0" печели')
  })

  await check('[R5] изборът: по подразбиране включен; записва се "1"/"0"; грешка при запис не хвърля', () => {
    const storage = memoryStorage()
    assertEqual(readVoiceExperimentalAudioPreference(storage), true, 'по подразбиране')
    writeVoiceExperimentalAudioPreference(storage, false)
    assertEqual(storage.values.get(VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY), '0', 'изключен')
    assertEqual(readVoiceExperimentalAudioPreference(storage), false, 'чете изключен')
    writeVoiceExperimentalAudioPreference(storage, true)
    assertEqual(readVoiceExperimentalAudioPreference(storage), true, 'отново включен')
    writeVoiceExperimentalAudioPreference({ setItem: () => { throw new Error('quota') } }, false)
    writeVoiceExperimentalAudioPreference(null, false)
  })

  // ─── Контролерът ─────────────────────────────────────────────────────
  await check('[C1] без зависимостта (тестове/други среди): винаги element, без настройка', async () => {
    const h = createHarness({ selfProfileId: DIVAKA })
    h.backend.webAudioMix = true
    await join(h, DIVAKA)
    assertEqual(snap(h).status, 'connected_listening', 'свързан')
    assertEqual(h.fake.state.prepareModes.join(','), 'element', 'режим')
    assertEqual(view(h).available, false, 'без настройка')
  })

  await check('[C2] Divaka655 в Android PWA: стар сървър (без поле) / kill switch изключен -> element; разрешен -> webaudio', async () => {
    for (const [flag, expected] of [[undefined, 'element'], [false, 'element'], ['true', 'element'], [1, 'element'], [true, 'webaudio']] as const) {
      const storage = memoryStorage()
      const h = createHarness({ selfProfileId: DIVAKA, experimentalAudio: runtimeDeps('android_pwa', storage) })
      h.backend.webAudioMix = flag
      await join(h, DIVAKA)
      assertEqual(snap(h).status, 'connected_listening', `свързан (${String(flag)})`)
      assertEqual(h.fake.state.prepareModes.at(-1), expected, `режим при webAudioMix=${String(flag)}`)
      assertEqual(view(h).available, true, 'настройката е видима')
      assertEqual(view(h).enabled, true, 'включена по подразбиране')
      assertEqual(view(h).active, expected, 'текущата стая')
      assertEqual(h.fake.state.prepareRejected, 0, '≤1 стая')
    }
  })

  await check('[C3] kill switch изключен ПРЕДИ следващото включване: стаята от жеста (стар режим) се затваря, нова — element; ≤1 стая', async () => {
    const storage = memoryStorage()
    const h = createHarness({ selfProfileId: DIVAKA, experimentalAudio: runtimeDeps('android_pwa', storage) })
    h.backend.webAudioMix = true
    await join(h, DIVAKA)
    assertEqual(view(h).active, 'webaudio', 'първо webaudio')
    await leave(h)
    h.backend.webAudioMix = false
    await join(h, DIVAKA)
    assertEqual(snap(h).status, 'connected_listening', 'свързан')
    const modes = h.fake.state.prepareModes
    assertEqual(modes.at(-1), 'element', `последната стая (${modes.join(',')})`)
    assert((h.voice.debugCounters().audioModeReprepared ?? 0) >= 1 && modes.at(-2) === 'webaudio', `подготвената в жеста стая (webaudio от предишния токен) е затворена (${modes.join(',')})`)
    assertEqual(view(h).active, 'element', 'текущата стая — стария механизъм')
    assertEqual(h.fake.state.prepareRejected, 0, '≤1 стая (подготвената е затворена преди новата)')
    assertEqual(h.fake.state.activeRooms(), 1, 'една активна стая')
    // Включен отново -> следващото включване отново webaudio.
    await leave(h)
    h.backend.webAudioMix = true
    await join(h, DIVAKA)
    assertEqual(view(h).active, 'webaudio', 'отново webaudio')
    assertEqual(h.fake.state.prepareRejected, 0, '≤1 стая')
  })

  await check('[C4] настройката: изключване по време на разговор не пипа текущата стая; важи при следващото включване; пази се локално', async () => {
    const storage = memoryStorage()
    const h = createHarness({ selfProfileId: DIVAKA, experimentalAudio: runtimeDeps('android_pwa', storage) })
    h.backend.webAudioMix = true
    await join(h, DIVAKA)
    const roomsBefore = h.fake.state.prepareModes.length
    h.voice.setExperimentalAudioEnabled(false)
    await flush(10)
    assertEqual(storage.values.get(VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY), '0', 'записан локално')
    assertEqual(view(h).enabled, false, 'панелът — изключен')
    assertEqual(view(h).active, 'webaudio', 'текущата стая е непроменена')
    assertEqual(h.fake.state.prepareModes.length, roomsBefore, 'без нова стая')
    assertEqual(snap(h).status, 'connected_listening', 'разговорът продължава')
    await leave(h)
    await join(h, DIVAKA)
    assertEqual(view(h).active, 'element', 'следващото включване — стария механизъм')
    h.voice.setExperimentalAudioEnabled(true)
    await flush(10)
    await leave(h)
    await join(h, DIVAKA)
    assertEqual(view(h).active, 'webaudio', 'отново включен')
    assertEqual(h.fake.state.prepareRejected, 0, '≤1 стая')
  })

  await check('[C5] друг профил / друга платформа: без настройка, element, изборът не се пипа', async () => {
    for (const [platform, profileId] of [['android_pwa', DILEIDI], ['android_pwa', 'self'], ['android_chrome', DIVAKA], ['desktop_chrome', DIVAKA]] as const) {
      const storage = memoryStorage()
      const h = createHarness({ selfProfileId: profileId, experimentalAudio: runtimeDeps(platform, storage) })
      h.backend.webAudioMix = true
      await join(h, profileId)
      assertEqual(h.fake.state.prepareModes.at(-1), 'element', `${platform}/${profileId}`)
      assertEqual(view(h).available, false, 'без настройка')
      h.voice.setExperimentalAudioEnabled(false)
      assertEqual(storage.values.size, 0, 'изборът не е записан')
    }
  })

  await check('[C6] H4 е независим: Divaka655 вижда „Възстанови звука“ и при двата режима', async () => {
    for (const flag of [false, true]) {
      const h = createHarness({ selfProfileId: DIVAKA, experimentalAudio: runtimeDeps('android_pwa', memoryStorage()) })
      h.backend.webAudioMix = flag
      await join(h, DIVAKA)
      assertEqual(snap(h).incomingAudioRestore.available, true, `H4 при webAudioMix=${flag}`)
    }
  })

  // ─── Панелът ─────────────────────────────────────────────────────────
  await check('[P1] панелът: настройката само когато е налична; включен/изключен; бележка за следващото включване и текущия режим', async () => {
    const h = createHarness({ selfProfileId: DIVAKA, experimentalAudio: runtimeDeps('android_pwa', memoryStorage()) })
    h.backend.webAudioMix = true
    await join(h, DIVAKA)
    const render = (snapshot: VoiceSnapshot) => renderVoicePanel({ snapshot, seats: [], theme: 'dark', joinOffer: 'speak', canOpenShop: false } as unknown as Parameters<typeof renderVoicePanel>[0])
    const on = render(snap(h))
    assert(on.includes('data-voice-action="experimental-audio-off"') && on.includes('aria-checked="true"') && on.includes('Експериментален аудио режим: включен'), 'включен')
    assert(on.includes('Промяната важи при следващото включване в гласовия чат.') && on.includes('Сега: експерименталният механизъм.'), 'бележка')
    h.voice.setExperimentalAudioEnabled(false)
    await flush(10)
    const off = render(snap(h))
    assert(off.includes('data-voice-action="experimental-audio-on"') && off.includes('aria-checked="false"') && off.includes('Експериментален аудио режим: изключен'), 'изключен')
    assert(off.includes('Сега: експерименталният механизъм.'), 'текущата стая е непроменена')
    const other = createHarness({ selfProfileId: 'self', experimentalAudio: runtimeDeps('android_pwa', memoryStorage()) })
    await join(other, 'self')
    assert(!render(snap(other)).includes('experimental-audio'), 'друг профил — без настройка')
  })

  // ─── Сървърът ────────────────────────────────────────────────────────
  await check('[S1] admin_settings: липсващ / невалиден -> изключен; true/false; не-boolean се отказва', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'pika-webaudio-killswitch-'))
    try {
      const dbFile = pathJoin(dir, 'settings.sqlite')
      const db = new DatabaseSync(dbFile)
      db.exec(await readFile('server/database/migrations/20260510_010_create_admin_settings.sql', 'utf8'))
      db.close()
      const store = await createAdminSettingsStore(dbFile)
      assertEqual(store.getSettings().voiceWebAudioMixEnabled, false, 'липсващ ред')
      const enabled = store.updateSettings({ voiceWebAudioMixEnabled: true })
      assert(enabled.ok && enabled.settings.voiceWebAudioMixEnabled === true, 'включен')
      const rejected = store.updateSettings({ voiceWebAudioMixEnabled: 'true' as unknown as boolean })
      assert(!rejected.ok, 'низ — отказ')
      assertEqual(store.getSettings().voiceWebAudioMixEnabled, true, 'отказът не променя')
      assert(store.updateSettings({ signupBonusYellowCoins: 100_000 }).ok && store.getSettings().voiceWebAudioMixEnabled === true, 'друга настройка не пипа ключа')
      const disabled = store.updateSettings({ voiceWebAudioMixEnabled: false })
      assert(disabled.ok && disabled.settings.voiceWebAudioMixEnabled === false, 'изключен')
      store.close()
      const raw = new DatabaseSync(dbFile)
      assertEqual((raw.prepare("SELECT setting_value AS v FROM admin_settings WHERE setting_key = 'voice_webaudio_mix_enabled'").get() as { v: string }).v, '0', 'записан "0"')
      raw.prepare("UPDATE admin_settings SET setting_value = 'yes' WHERE setting_key = 'voice_webaudio_mix_enabled'").run()
      raw.close()
      const reopened = await createAdminSettingsStore(dbFile)
      assertEqual(reopened.getSettings().voiceWebAudioMixEnabled, false, 'невалидна стойност -> изключен')
      reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  await check('[S2] токенът: webAudioMix само в успешния отговор; live стойност; грешка/липса -> false; неуспехът е непроменен', async () => {
    const call = async (options: { flag?: () => boolean; status?: number }): Promise<{ status: number; body: Record<string, unknown> }> => {
      let captured: { status: number; body: string } | null = null
      const handler = createVoiceChatHttpRequestHandler({
        service: {
          handleTokenRequest: async (_input: unknown, respond: (result: { status: number; body: Record<string, unknown> }) => void) => {
            respond(options.status === undefined || options.status === 200
              ? { status: 200, body: { ok: true, token: 'secret', url: 'wss://voice' } }
              : { status: options.status, body: { ok: false, code: 'voice_off' } })
          },
          handleSpeakAccessRequest: async () => {},
          describeCreationOption: () => ({}),
        } as never,
        getSessionProfileId: () => 'profile-1',
        isFullAdminProfile: () => false,
        isAllowedOrigin: () => true,
        readJsonBody: async () => ({ voiceTableId: '11111111-2222-4333-8444-555555555555', clientInstanceId: 'inst_test_0000000000000001' }),
        ...(options.flag === undefined ? {} : { isWebAudioMixEnabled: options.flag }),
      })
      const res = {
        headersSent: false,
        writableEnded: false,
        status: 0,
        writeHead(status: number) { this.status = status; this.headersSent = true },
        end(body: string) { captured = { status: this.status, body }; this.writableEnded = true },
      }
      const handled = await handler({ method: 'POST', headers: {} } as IncomingMessage, res as unknown as ServerResponse, new URL('http://x/api/voice/token'))
      assert(handled && captured !== null, 'обработено')
      const result = captured as { status: number; body: string }
      return { status: result.status, body: JSON.parse(result.body) as Record<string, unknown> }
    }
    let live = false
    assertEqual((await call({ flag: () => live })).body.webAudioMix, false, 'изключен')
    live = true
    assertEqual((await call({ flag: () => live })).body.webAudioMix, true, 'включен live (без рестарт)')
    assertEqual((await call({})).body.webAudioMix, false, 'без зависимост -> false')
    assertEqual((await call({ flag: () => { throw new Error('db') } })).body.webAudioMix, false, 'грешка -> false')
    assertEqual((await call({ flag: () => 'yes' as unknown as boolean })).body.webAudioMix, false, 'не-boolean -> false')
    const failure = await call({ flag: () => true, status: 503 })
    assert(failure.status === 503 && !('webAudioMix' in failure.body), 'неуспешният отговор е непроменен')
  })
} finally {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
