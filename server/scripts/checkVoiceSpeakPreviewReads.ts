/**
 * checkVoiceSpeakPreviewReads.ts — Гласов чат: решението за говорене преди
 * включване (voiceSpeak в room_snapshot/private_room_updated) без излишни SQL
 * четения.
 *
 *   * активната маса се проверява в паметта (участието), не в voice_tables;
 *   * VIP се чете само без придобито право (същата семантика);
 *   * мютът остава директно от източника при всяко решение;
 *   * авторитетните проверки за токен и speak-access са непроменени.
 *
 * Реална гласова услуга + реален store във временна SQLite база (никога
 * реалната). LiveKit не се вика (reconciler-ът не тиктака).
 *
 *   cd server && node node_modules/tsx/dist/cli.mjs scripts/checkVoiceSpeakPreviewReads.ts
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createVoiceChatService, type VoiceSeatLookup } from '../src/voice/voiceChatService.js'
import { createVoiceChatStore, type VoiceChatStore } from '../src/voice/voiceChatStore.js'
import type { VoiceTableRecord } from '../src/voice/voiceChatTypes.js'
import { createVoiceLiveKitApi } from '../src/voice/voiceLiveKitApi.js'
import { createVoiceLiveKitDispatcher } from '../src/voice/voiceLiveKitDispatcher.js'
import { createVoiceTokenSigner } from '../src/voice/voiceTokenIssuer.js'

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

const serverRoot = resolve(process.cwd())
const root = await mkdtemp(join(tmpdir(), 'belot-voice-preview-'))
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(serverRoot, 'database', 'migrations'), { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') await cp(join(serverRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
const realStore = await createVoiceChatStore(databaseFilePath)
const sqlite = await import('node:sqlite')
function seedProfile(name: string): string {
  const raw = new sqlite.DatabaseSync(databaseFilePath)
  try {
    const profileId = randomUUID()
    const accountId = randomUUID()
    raw.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
    raw.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, 'human');`)
      .run(profileId, accountId, name, `${name.toLowerCase()}-${profileId.slice(0, 8)}`)
    return profileId
  } finally {
    raw.close()
  }
}

// Броячи: voice_tables четене (store.getVoiceTable), VIP и мют.
const reads = { table: 0, vip: 0, mute: 0 }
const store = new Proxy(realStore, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver)
    if (prop === 'getVoiceTable' && typeof value === 'function') {
      return (...args: unknown[]) => { reads.table += 1; return (value as (...a: unknown[]) => unknown).apply(target, args) }
    }
    return value
  },
}) as VoiceChatStore

const seats = new Map<string, VoiceSeatLookup>()
const vip = new Set<string>()
const muted = new Map<string, string>()
const service = createVoiceChatService({
  store,
  liveKit: {
    api: createVoiceLiveKitApi({ apiUrl: 'http://127.0.0.1:9', apiKey: 'test-only', apiSecret: 'test-only-not-a-real-secret-000000000000' }, { requestTimeoutSeconds: 0.2 }),
    wsUrl: 'ws://127.0.0.1:9',
    signToken: createVoiceTokenSigner({ apiKey: 'test-only', apiSecret: 'test-only-not-a-real-secret-000000000000' }),
  },
  dispatcher: createVoiceLiveKitDispatcher({ retryBaseDelayMs: 5, retryMaxDelayMs: 10, maxAttempts: 1, hardTimeoutMs: 500, breakerFailureThreshold: 50 }),
  resolveSeat: (profileId: string, table: VoiceTableRecord) => seats.get(`${table.voiceTableId}|${profileId}`) ?? { relation: 'none' },
  isConnectionOpen: () => true,
  sendToConnection: () => {},
  isVipActive: (profileId) => { reads.vip += 1; return vip.has(profileId) },
  isBanned: () => false,
  getChatMuteStatus: (profileId) => { reads.mute += 1; return muted.has(profileId) ? { isMuted: true, mutedUntil: muted.get(profileId)! } : { isMuted: false, mutedUntil: null } },
  env: {},
  log: () => {},
  reconcilerOptions: { scheduler: { setTimeout: () => 0, clearTimeout: () => {} }, now: () => Date.now(), retryBaseDelayMs: 1_000 },
})
assert(realStore.setMode('public', { profileId: null }).ok, 'setMode')
service.boot([])

const creator = seedProfile('Creator')
vip.add(creator)
const reserved = service.reserveVoiceTableForPrivateRoom({ profileId: creator, isFullAdmin: false })
assert(reserved.ok, 'reserve')
const table = reserved.voiceTableId
service.attachPrivateRoom(table, `private-${randomUUID()}`, creator)
function seat(profileId: string, connectionId: string): void {
  seats.set(`${table}|${profileId}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: connectionId })
  service.onMemberSeated(table, profileId)
}
const entitledP = seedProfile('Entitled')
const plainP = seedProfile('Plain')
vip.add(entitledP)
seat(entitledP, 'c-ent')
seat(plainP, 'c-plain')

function measure<T>(fn: () => T): { value: T; table: number; vip: number; mute: number } {
  const before = { ...reads }
  const value = fn()
  return { value, table: reads.table - before.table, vip: reads.vip - before.vip, mute: reads.mute - before.mute }
}

console.log('\ncheckVoiceSpeakPreviewReads\n')

await check('[R1] Активната маса се проверява в паметта: 0 четения на voice_tables за решение', () => {
  for (const profileId of [creator, entitledP, plainP]) {
    const m = measure(() => service.describeSpeakPreview(table, profileId))
    assert(m.value !== null, 'решение')
    assert(m.table === 0, `voice_tables четения: ${m.table}`)
  }
})

await check('[R2] Придобито право (VIP при сядането), VIP вече изтекъл: може да говори, без VIP четене (1 четене — мютът)', () => {
  vip.delete(entitledP)
  const m = measure(() => service.describeSpeakPreview(table, entitledP))
  assert(m.value?.canSpeak === true && m.value.blockedReason === null, JSON.stringify(m.value))
  assert(m.vip === 0 && m.mute === 1, `vip=${m.vip} mute=${m.mute}`)
})

await check('[R3] Без придобито право: VIP се чете при всяко решение (без кеш) — изтичане/придобиване се вижда веднага', () => {
  let m = measure(() => service.describeSpeakPreview(table, plainP))
  assert(m.value?.canSpeak === false && m.value.blockedReason === 'vip_required' && m.vip === 1 && m.mute === 1, JSON.stringify(m))
  vip.add(plainP)
  m = measure(() => service.describeSpeakPreview(table, plainP))
  assert(m.value?.canSpeak === true && m.vip === 1, 'придобит VIP -> веднага')
  vip.delete(plainP)
  m = measure(() => service.describeSpeakPreview(table, plainP))
  assert(m.value?.blockedReason === 'vip_required' && m.vip === 1, 'изтекъл VIP (без право) -> веднага')
})

await check('[R4] Семантиката е същата: canSpeak = !мют && (VIP || придобито право) за всички комбинации; мютът печели и носи срока', () => {
  const until = new Date(Date.now() + 3_600_000).toISOString()
  for (const [profileId, entitled] of [[entitledP, true], [plainP, false]] as const) {
    for (const isVip of [false, true]) {
      for (const isMuted of [false, true]) {
        if (isVip) vip.add(profileId); else vip.delete(profileId)
        if (isMuted) muted.set(profileId, until); else muted.delete(profileId)
        const preview = service.describeSpeakPreview(table, profileId)
        const expected = !isMuted && (isVip || entitled)
        assert(preview?.canSpeak === expected, `entitled=${entitled} vip=${isVip} muted=${isMuted}: ${JSON.stringify(preview)}`)
        assert(preview.blockedReason === (isMuted ? 'muted' : expected ? null : 'vip_required'), 'причина')
        assert(preview.mutedUntil === (isMuted ? until : null), 'срок')
      }
    }
  }
  vip.delete(plainP)
  muted.clear()
})

await check('[R5] Без участие -> няма решение (стар/непознат играч, напуснал), без SQL', () => {
  const stranger = seedProfile('Stranger')
  let m = measure(() => service.describeSpeakPreview(table, stranger))
  assert(m.value === null && m.table === 0 && m.vip === 0 && m.mute === 0, JSON.stringify(m))
  service.onMemberRemoved(table, plainP, 'left_waiting_room')
  m = measure(() => service.describeSpeakPreview(table, plainP))
  assert(m.value === null && m.table === 0, 'напуснал')
})

await check('[R6] Освободена маса -> няма решение (участията се махат от паметта при освобождаването)', async () => {
  service.onWaitingRoomEnded(table, 'waiting_room_closed')
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && service.describeSpeakPreview(table, creator) !== null) await new Promise((r) => setTimeout(r, 20))
  assert(service.describeSpeakPreview(table, creator) === null && service.describeSpeakPreview(table, entitledP) === null, 'след освобождаване')
  assert(realStore.getVoiceTable(table)?.status === 'released', 'в базата също е освободена')
})

await check('[R7] Авторитетните проверки за токен и speak-access са непроменени спрямо HEAD (evaluateClaim, handleTokenRequest, handleSpeakAccessRequest)', () => {
  const current = readFileSync(join(serverRoot, 'src', 'voice', 'voiceChatService.ts'), 'utf8').replace(/\r\n/g, '\n')
  const head = execFileSync('git', ['show', 'HEAD:server/src/voice/voiceChatService.ts'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).replace(/\r\n/g, '\n')
  const body = (text: string, start: string, end: string) => {
    const from = text.indexOf(start)
    const to = text.indexOf(end, from + start.length)
    assert(from >= 0 && to > from, `липсва ${start}`)
    return text.slice(from, to)
  }
  assert(body(current, '  function evaluateClaim(', '\n  function ') === body(head, '  function evaluateClaim(', '\n  function '), 'evaluateClaim')
  assert(body(current, '    async handleTokenRequest(', '\n    async handleSpeakAccessRequest(') === body(head, '    async handleTokenRequest(', '\n    async handleSpeakAccessRequest('), 'handleTokenRequest')
  assert(body(current, '    async handleSpeakAccessRequest(', '\n    onModeChanged(') === body(head, '    async handleSpeakAccessRequest(', '\n    onModeChanged('), 'handleSpeakAccessRequest')
})

service.dispose()
realStore.close?.()
await rm(root, { recursive: true, force: true }).catch(() => undefined)
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
