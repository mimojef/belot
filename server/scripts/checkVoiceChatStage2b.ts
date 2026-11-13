/**
 * checkVoiceChatStage2b.ts
 *
 * Гласов чат, Етап 2б — LiveKit API клиент (официален livekit-server-sdk
 * срещу FAKE Twirp сървър), dispatcher (timeouts, ограничени опашки, circuit
 * breaker, retry само за идемпотентни), издаване на токени (точни grants,
 * race проверки), участие с право за говорене (VIP правила), session
 * binding, ротация, durable DeleteRoom + reconciliation (вкл. забавен
 * CreateRoom), 120 s таймер, lease, напускане на екрана, режими, рестарт,
 * единният mute (забранява говоренето), изолация по namespace и
 * свързването в index.ts (статично).
 *
 * Само изолирани temp SQLite бази и локален fake сървър на 127.0.0.1 —
 * никога production, реален LiveKit или реални потребители. Токени и тайни
 * не се печатат.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkVoiceChatStage2b.ts --server-root=.
 */

import { createHmac, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { TokenVerifier } from 'livekit-server-sdk'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPrivateRoomsStore, type PrivateRoom } from '../src/game/privateRoomsStore.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import { createVoiceChatHttpRequestHandler } from '../src/voice/voiceChatHttpApi.js'
import type { VoiceServerMessage } from '../src/voice/voiceChatProtocol.js'
import {
  createVoiceChatService,
  type VoiceChatService,
  type VoiceHttpResult,
  type VoiceSeatLookup,
} from '../src/voice/voiceChatService.js'
import { createVoiceChatStore, type VoiceChatStore } from '../src/voice/voiceChatStore.js'
import type { VoiceTableRecord } from '../src/voice/voiceChatTypes.js'
import { classifyLiveKitError, createVoiceLiveKitApi, readVoiceLiveKitConfig, type VoiceLiveKitApi } from '../src/voice/voiceLiveKitApi.js'
import { createVoiceLiveKitDispatcher, type VoiceLiveKitDispatcher } from '../src/voice/voiceLiveKitDispatcher.js'
import { buildVoiceIdentity, buildVoiceVideoGrant, createVoiceTokenSigner, type VoiceTokenSigner } from '../src/voice/voiceTokenIssuer.js'

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

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckVoiceChatStage2b')
console.log(`Server root: ${sourceServerRoot}`)

// Тестови креденшъли — генерирани за процеса, никога не се печатат.
const API_KEY = `APItest${randomUUID().slice(0, 8)}`
const API_SECRET = randomUUID() + randomUUID()

// ─── Temp бази ────────────────────────────────────────────────────────────
const tempRoots: string[] = []
const sqliteModule = await import('node:sqlite')
const storesToClose: VoiceChatStore[] = []

async function freshDatabase(): Promise<{ path: string; store: VoiceChatStore; seedProfile: (name: string) => string }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-voice-2b-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.sql') continue
    await cp(join(sourceMigrationsDirectoryPath, entry.name), join(root, 'database', 'migrations', entry.name))
  }
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const store = await createVoiceChatStore(path)
  storesToClose.push(store)
  const seedProfile = (name: string): string => {
    const raw = new sqliteModule.DatabaseSync(path, { open: true, enableForeignKeyConstraints: true })
    try {
      const profileId = randomUUID()
      const accountId = randomUUID()
      raw.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
      raw.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, 'human');`).run(
        profileId, accountId, name, `${name.toLowerCase()}-${profileId.slice(0, 8)}`,
      )
      return profileId
    } finally {
      raw.close()
    }
  }
  return { path, store, seedProfile }
}

// ─── Fake LiveKit Twirp сървър ───────────────────────────────────────────

type FakeBehavior =
  | { kind: 'ok' }
  | { kind: 'status'; status: number; code?: string }
  | { kind: 'hang' }
  /** Отговаря след delayMs; операцията СЕ ИЗПЪЛНЯВА тогава (дори клиентът да е прекъснал). */
  | { kind: 'delay_apply'; delayMs: number }

type FakeCall = { method: string; body: Record<string, unknown>; grants: Record<string, unknown> }

type FakeLiveKit = {
  url: string
  rooms: Map<string, { maxParticipants: number; participants: Map<string, Record<string, unknown>> }>
  calls: FakeCall[]
  /** Еднократни поведения по метод (FIFO), след тях — default. */
  next: Map<string, FakeBehavior[]>
  defaults: Map<string, FakeBehavior>
  addParticipant: (room: string, identity: string) => void
  reset: () => void
  close: () => Promise<void>
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function verifyAdminJwt(header: string | undefined): Record<string, unknown> | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null
  const [h, p, sig] = header.slice(7).split('.')
  if (h === undefined || p === undefined || sig === undefined) return null
  const expected = createHmac('sha256', API_SECRET).update(`${h}.${p}`).digest('base64url')
  if (expected !== sig) return null
  const payload = JSON.parse(base64UrlDecode(p)) as Record<string, unknown>
  if (payload.iss !== API_KEY) return null
  return (payload.video as Record<string, unknown> | undefined) ?? {}
}

async function startFakeLiveKit(): Promise<FakeLiveKit> {
  const rooms: FakeLiveKit['rooms'] = new Map()
  const calls: FakeCall[] = []
  const next = new Map<string, FakeBehavior[]>()
  const defaults = new Map<string, FakeBehavior>()
  const pendingSockets = new Set<ServerResponse>()

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  function notFound(res: ServerResponse): void {
    sendJson(res, 404, { code: 'not_found', msg: 'not found' })
  }

  function apply(method: string, body: Record<string, unknown>): { status: number; payload: unknown } {
    const roomName = String(body.room ?? body.name ?? '')
    switch (method) {
      case 'CreateRoom': {
        if (!rooms.has(roomName)) rooms.set(roomName, { maxParticipants: Number(body.maxParticipants ?? 0), participants: new Map() })
        return { status: 200, payload: { sid: `RM_${roomName.slice(-6)}`, name: roomName, maxParticipants: Number(body.maxParticipants ?? 0) } }
      }
      case 'DeleteRoom': {
        if (!rooms.delete(roomName)) return { status: 404, payload: { code: 'not_found', msg: 'room not found' } }
        return { status: 200, payload: {} }
      }
      case 'ListRooms': {
        const names = Array.isArray(body.names) ? (body.names as string[]) : []
        const list = [...rooms.entries()]
          .filter(([name]) => names.length === 0 || names.includes(name))
          .map(([name, room]) => ({ sid: `RM_${name.slice(-6)}`, name, numParticipants: room.participants.size }))
        return { status: 200, payload: { rooms: list } }
      }
      case 'RemoveParticipant': {
        const room = rooms.get(roomName)
        if (room === undefined || !room.participants.delete(String(body.identity))) return { status: 404, payload: { code: 'not_found', msg: 'participant not found' } }
        return { status: 200, payload: {} }
      }
      case 'UpdateParticipant': {
        const room = rooms.get(roomName)
        const identity = String(body.identity)
        if (room === undefined || !room.participants.has(identity)) return { status: 404, payload: { code: 'not_found', msg: 'participant not found' } }
        room.participants.set(identity, (body.permission as Record<string, unknown>) ?? {})
        return { status: 200, payload: { identity, permission: body.permission ?? {} } }
      }
      default:
        return { status: 404, payload: { code: 'bad_route', msg: 'unknown' } }
    }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      const match = /^\/twirp\/livekit\.RoomService\/([A-Za-z]+)$/.exec(req.url ?? '')
      if (req.method !== 'POST' || match === null) return notFound(res)
      const method = match[1]!
      const grants = verifyAdminJwt(req.headers.authorization)
      if (grants === null) return sendJson(res, 401, { code: 'unauthenticated', msg: 'bad token' })
      const body = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>
      calls.push({ method, body, grants })
      const behavior = next.get(method)?.shift() ?? defaults.get(method) ?? { kind: 'ok' }
      if (behavior.kind === 'hang') {
        pendingSockets.add(res)
        return
      }
      if (behavior.kind === 'status') return sendJson(res, behavior.status, { code: behavior.code ?? 'internal', msg: 'fake failure' })
      if (behavior.kind === 'delay_apply') {
        setTimeout(() => {
          const result = apply(method, body)
          sendJson(res, result.status, result.payload)
        }, behavior.delayMs)
        return
      }
      const result = apply(method, body)
      sendJson(res, result.status, result.payload)
    })
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    rooms,
    calls,
    next,
    defaults,
    addParticipant: (room, identity) => rooms.get(room)?.participants.set(identity, {}),
    reset: () => {
      rooms.clear()
      calls.length = 0
      next.clear()
      defaults.clear()
    },
    close: async () => {
      for (const res of pendingSockets) res.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    },
  }
}

// ─── Ръчен часовник / scheduler ───────────────────────────────────────────

type ManualClock = {
  now: () => number
  scheduler: { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }
  advance: (ms: number) => void
  pending: () => number
}

function createManualClock(start = Date.parse('2027-05-01T10:00:00.000Z')): ManualClock {
  let current = start
  let seq = 0
  const timers = new Map<number, { due: number; cb: () => void }>()
  return {
    now: () => current,
    scheduler: {
      setTimeout: (cb, ms) => {
        seq += 1
        timers.set(seq, { due: current + Math.max(0, ms), cb })
        return seq
      },
      clearTimeout: (handle) => { timers.delete(handle as number) },
    },
    advance: (ms) => {
      const target = current + ms
      for (;;) {
        let nextId: number | null = null
        let nextDue = Number.POSITIVE_INFINITY
        for (const [id, timer] of timers) if (timer.due <= target && timer.due < nextDue) { nextDue = timer.due; nextId = id }
        if (nextId === null) break
        const timer = timers.get(nextId)!
        timers.delete(nextId)
        current = Math.max(current, timer.due)
        timer.cb()
      }
      current = target
    },
    pending: () => timers.size,
  }
}

// ─── Харнес на услугата ───────────────────────────────────────────────────

type Harness = {
  store: VoiceChatStore
  path: string
  seedProfile: (name: string) => string
  service: VoiceChatService
  clock: ManualClock
  dispatcher: VoiceLiveKitDispatcher
  seats: Map<string, VoiceSeatLookup>
  open: Set<string>
  vip: Set<string>
  banned: Set<string>
  /** profileId -> mutedUntil (ISO) за активно mute наказание. */
  muted: Map<string, string | null>
  failMuteLookup: { value: boolean }
  sent: Array<{ connectionId: string; message: VoiceServerMessage }>
  logs: string[]
  token: (profileId: string, voiceTableId: string, clientInstanceId: string) => Promise<VoiceHttpResult>
  speak: (profileId: string, voiceTableId: string, clientInstanceId: string) => Promise<VoiceHttpResult>
  presence: (connectionId: string, profileId: string, voiceTableId: string, clientInstanceId: string, onTableScreen?: boolean) => VoiceServerMessage | undefined
  seat: (voiceTableId: string, profileId: string, connectionId: string) => void
  createTable: (creator: string, connectionId: string) => string
  reconcile: () => Promise<void>
  dispose: () => void
}

const instanceId = (label: string): string => `inst_${label}_${randomUUID().replace(/-/g, '')}`.slice(0, 48)

async function createHarness(options: {
  fake: FakeLiveKit | null
  signToken?: VoiceTokenSigner
  dispatcher?: VoiceLiveKitDispatcher
  existing?: { path: string; store: VoiceChatStore; seedProfile: (name: string) => string }
  env?: Record<string, string>
  clock?: ManualClock
  boot?: Parameters<VoiceChatService['boot']>[0]
  mode?: 'public' | 'admin_only' | 'off'
} = { fake: null }): Promise<Harness> {
  const db = options.existing ?? (await freshDatabase())
  if (options.existing === undefined) {
    const set = db.store.setMode(options.mode ?? 'public', { profileId: null })
    assert(set.ok, 'setMode')
  }
  const clock = options.clock ?? createManualClock()
  const reconcilerClock = { setTimeout: () => 0, clearTimeout: () => {} }
  const seats = new Map<string, VoiceSeatLookup>()
  const open = new Set<string>()
  const vip = new Set<string>()
  const banned = new Set<string>()
  const muted = new Map<string, string | null>()
  const failMuteLookup = { value: false }
  const sent: Harness['sent'] = []
  const logs: string[] = []
  const dispatcher = options.dispatcher ?? createVoiceLiveKitDispatcher({
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 10,
    maxAttempts: 2,
    hardTimeoutMs: 1_500,
    breakerFailureThreshold: 50,
  })
  const api: VoiceLiveKitApi | null = options.fake === null
    ? null
    : createVoiceLiveKitApi({ apiUrl: options.fake.url, apiKey: API_KEY, apiSecret: API_SECRET }, { requestTimeoutSeconds: 0.4 })
  const service = createVoiceChatService({
    store: db.store,
    liveKit: api === null ? null : { api, wsUrl: 'ws://127.0.0.1:7880', signToken: options.signToken ?? createVoiceTokenSigner({ apiKey: API_KEY, apiSecret: API_SECRET }) },
    dispatcher,
    resolveSeat: (profileId: string, table: VoiceTableRecord) => seats.get(`${table.voiceTableId}|${profileId}`) ?? { relation: 'none' },
    isConnectionOpen: (connectionId) => open.has(connectionId),
    sendToConnection: (connectionId, message) => { sent.push({ connectionId, message }) },
    isVipActive: (profileId) => vip.has(profileId),
    isBanned: (profileId) => banned.has(profileId),
    getChatMuteStatus: (profileId) => {
      if (failMuteLookup.value) throw new Error('mute lookup unavailable')
      return muted.has(profileId) ? { isMuted: true, mutedUntil: muted.get(profileId) ?? null } : { isMuted: false, mutedUntil: null }
    },
    env: options.env ?? {},
    now: clock.now,
    scheduler: clock.scheduler,
    log: (line) => { logs.push(line) },
    reconcilerOptions: { scheduler: reconcilerClock, now: clock.now, retryBaseDelayMs: 1_000, uncertainHorizonMs: 20 * 60_000 },
  })
  service.boot(options.boot ?? [])
  const call = (fn: VoiceChatService['handleTokenRequest'], profileId: string, voiceTableId: string, clientInstanceId: string): Promise<VoiceHttpResult> =>
    new Promise((resolvePromise, rejectPromise) => {
      let result: VoiceHttpResult | null = null
      fn({ profileId, voiceTableId, clientInstanceId }, (r) => { result = r }).then(() => {
        if (result === null) rejectPromise(new Error('без отговор'))
        else resolvePromise(result)
      }, rejectPromise)
    })
  const harness: Harness = {
    store: db.store,
    path: db.path,
    seedProfile: db.seedProfile,
    service,
    clock,
    dispatcher,
    seats,
    open,
    vip,
    banned,
    muted,
    failMuteLookup,
    sent,
    logs,
    token: (p, t, i) => call(service.handleTokenRequest, p, t, i),
    speak: (p, t, i) => call(service.handleSpeakAccessRequest, p, t, i),
    presence: (connectionId, profileId, voiceTableId, clientInstanceId, onTableScreen = true) => {
      const before = sent.length
      service.handlePresence(connectionId, profileId, { type: 'voice_presence', voiceTableId, clientInstanceId, onTableScreen })
      return sent.slice(before).find((entry) => entry.connectionId === connectionId && entry.message.type === 'voice_presence_result')?.message
    },
    seat: (voiceTableId, profileId, connectionId) => {
      seats.set(`${voiceTableId}|${profileId}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: connectionId })
      open.add(connectionId)
      service.onMemberSeated(voiceTableId, profileId)
    },
    createTable: (creator, connectionId) => {
      vip.add(creator)
      const reserved = service.reserveVoiceTableForPrivateRoom({ profileId: creator, isFullAdmin: false })
      if (!reserved.ok) throw new Error(`reserve: ${reserved.code}`)
      service.attachPrivateRoom(reserved.voiceTableId, `private-${randomUUID()}`, creator)
      seats.set(`${reserved.voiceTableId}|${creator}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: connectionId })
      open.add(connectionId)
      return reserved.voiceTableId
    },
    reconcile: () => service.debug.reconciler.runNow(),
    dispose: () => service.dispose(),
  }
  harnesses.push(harness)
  return harness
}
const harnesses: Harness[] = []

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(base64UrlDecode(token.split('.')[1]!)) as Record<string, unknown>
}

function messagesOf(h: Harness, connectionId: string, type: VoiceServerMessage['type']): VoiceServerMessage[] {
  return h.sent.filter((entry) => entry.connectionId === connectionId && entry.message.type === type).map((entry) => entry.message)
}

/** Подготвя VIP/non-VIP играч с presence и издаден токен. */
async function joinWithToken(h: Harness, table: string, profile: string, conn: string, inst: string, fake: FakeLiveKit): Promise<{ token: string; identity: string; roomName: string }> {
  const ack = h.presence(conn, profile, table, inst)
  assert(ack !== undefined && ack.type === 'voice_presence_result' && ack.ok, `presence ${JSON.stringify(ack)}`)
  const result = await h.token(profile, table, inst)
  assertEqual(result.status, 200, `token ${JSON.stringify(result.body)}`)
  const token = String(result.body.token)
  const identity = String(result.body.identity)
  const roomName = String(decodeJwt(token).video && (decodeJwt(token).video as Record<string, unknown>).room)
  fake.addParticipant(roomName, identity)
  return { token, identity, roomName }
}

const fake = await startFakeLiveKit()

try {
  // ═══ [L] LiveKit API клиент (официален SDK) и dispatcher ════════════════
  await check('[L1] SDK срещу fake Twirp: CreateRoom (4 участника, timeouts), ListRooms, DeleteRoom, RemoveParticipant, UpdateParticipant; admin JWT подписан', async () => {
    fake.reset()
    const api = createVoiceLiveKitApi({ apiUrl: fake.url, apiKey: API_KEY, apiSecret: API_SECRET }, { requestTimeoutSeconds: 1 })
    await api.createRoom({ name: 'pv_probe', maxParticipants: 4, emptyTimeoutSeconds: 120, departureTimeoutSeconds: 120 })
    const create = fake.calls.find((c) => c.method === 'CreateRoom')!
    assertEqual(create.body.name, 'pv_probe', 'name')
    assertEqual(create.body.maxParticipants, 4, 'maxParticipants')
    assertEqual(create.body.emptyTimeout, 120, 'emptyTimeout')
    assertEqual(create.body.departureTimeout, 120, 'departureTimeout')
    assertEqual(create.grants.roomCreate, true, 'admin grant за CreateRoom')
    assertEqual((await api.listRooms(['pv_probe'])).map((r) => r.name).join(','), 'pv_probe', 'ListRooms')
    fake.addParticipant('pv_probe', 'p_x_1')
    await api.updateParticipantPermission('pv_probe', 'p_x_1', { canSubscribe: true, canPublish: true, canPublishSources: ['microphone'], canPublishData: false })
    const update = fake.calls.find((c) => c.method === 'UpdateParticipant')!
    const permission = update.body.permission as Record<string, unknown>
    assertEqual(permission.canPublish, true, 'canPublish')
    assertEqual(JSON.stringify(permission.canPublishSources), '["MICROPHONE"]', 'само микрофон')
    assert(permission.canPublishData !== true && permission.hidden !== true, 'без data/hidden')
    await api.updateParticipantPermission('pv_probe', 'p_x_1', { canSubscribe: false, canPublish: false, canPublishSources: [], canPublishData: false })
    const revoke = fake.calls.filter((c) => c.method === 'UpdateParticipant')[1]!.body.permission as Record<string, unknown>
    assert(revoke.canSubscribe !== true && revoke.canPublish !== true, 'отнемане')
    await api.removeParticipant('pv_probe', 'p_x_1')
    await api.deleteRoom('pv_probe')
    let notFoundKind = ''
    try { await api.deleteRoom('pv_probe') } catch (error) { notFoundKind = classifyLiveKitError(error).kind }
    assertEqual(notFoundKind, 'not_found', 'повторен DeleteRoom -> not_found (= постигната цел)')
    const badKey = createVoiceLiveKitApi({ apiUrl: fake.url, apiKey: API_KEY, apiSecret: 'wrong-secret-0000000000000000' }, { requestTimeoutSeconds: 1 })
    let rejected = ''
    try { await badKey.listRooms() } catch (error) { rejected = classifyLiveKitError(error).kind }
    assertEqual(rejected, 'rejected', 'грешен secret -> 401 rejected')
  })

  await check('[L2] Конфигурация: само https/wss (http/ws само за loopback); липсващи -> null; без тайни в резултата от грешки', () => {
    assertEqual(readVoiceLiveKitConfig({}), null, 'празно')
    const prod = readVoiceLiveKitConfig({ LIVEKIT_API_URL: 'https://voice.example.test', LIVEKIT_WS_URL: 'wss://voice.example.test', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', VOICE_ROOM_NAMESPACE: 'prod' })
    assert(prod !== null && prod.apiUrl === 'https://voice.example.test', 'https')
    assertEqual(readVoiceLiveKitConfig({ LIVEKIT_API_URL: 'http://voice.example.test', LIVEKIT_WS_URL: 'wss://voice.example.test', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', VOICE_ROOM_NAMESPACE: 'prod' }), null, 'http към външен хост')
    assert(readVoiceLiveKitConfig({ LIVEKIT_API_URL: 'http://127.0.0.1:7880', LIVEKIT_WS_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', VOICE_ROOM_NAMESPACE: 'prod' }) !== null, 'loopback')
    assertEqual(readVoiceLiveKitConfig({ LIVEKIT_API_URL: 'https://voice.example.test', LIVEKIT_WS_URL: 'wss://voice.example.test', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }), null, 'без VOICE_ROOM_NAMESPACE -> гласът е недостъпен (fail-safe)')
    assertEqual(readVoiceLiveKitConfig({ LIVEKIT_API_URL: 'https://voice.example.test', LIVEKIT_WS_URL: 'wss://voice.example.test', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', VOICE_ROOM_NAMESPACE: 'Prod_1' }), null, 'невалиден namespace')
  })

  await check('[L3] Реален timeout (hang), 5xx, connection refused -> transient; 4xx -> rejected; not_found', async () => {
    fake.reset()
    const api = createVoiceLiveKitApi({ apiUrl: fake.url, apiKey: API_KEY, apiSecret: API_SECRET }, { requestTimeoutSeconds: 0.3 })
    fake.next.set('ListRooms', [{ kind: 'hang' }, { kind: 'status', status: 503 }, { kind: 'status', status: 400, code: 'invalid_argument' }])
    const started = Date.now()
    const kinds: string[] = []
    for (let index = 0; index < 3; index += 1) {
      try { await api.listRooms() } catch (error) { kinds.push(classifyLiveKitError(error).kind) }
    }
    assert(Date.now() - started < 2_000, 'timeout-ът е реален (не чака безкрайно)')
    assertEqual(kinds.join(','), 'transient,transient,rejected', 'класификация')
    const refused = createVoiceLiveKitApi({ apiUrl: 'http://127.0.0.1:1', apiKey: API_KEY, apiSecret: API_SECRET }, { requestTimeoutSeconds: 0.3 })
    let refusedKind = ''
    try { await refused.listRooms() } catch (error) { refusedKind = classifyLiveKitError(error).kind }
    assertEqual(refusedKind, 'transient', 'connection refused')
  })

  await check('[L4] Circuit breaker: 5 поредни грешки -> open (бърз отказ без мрежа) -> half_open с една проба -> closed / отново open', async () => {
    fake.reset()
    let now = 1_000_000
    const dispatcher = createVoiceLiveKitDispatcher({ breakerFailureThreshold: 5, breakerOpenMs: 30_000, maxAttempts: 1, now: () => now })
    const api = createVoiceLiveKitApi({ apiUrl: fake.url, apiKey: API_KEY, apiSecret: API_SECRET }, { requestTimeoutSeconds: 0.5 })
    fake.defaults.set('ListRooms', { kind: 'status', status: 500 })
    const op = { name: 'ListRooms', priority: 'normal' as const, idempotent: true, run: () => api.listRooms() }
    for (let index = 0; index < 5; index += 1) assertEqual((await dispatcher.run(op)).ok, false, `грешка ${index}`)
    assertEqual(dispatcher.stats().breaker, 'open', 'open')
    const hitsBefore = fake.calls.length
    const fast = await dispatcher.run(op)
    assert(!fast.ok && fast.code === 'breaker_open', 'бърз отказ')
    assertEqual(fake.calls.length, hitsBefore, 'без мрежова заявка при open')
    assert(!dispatcher.isAvailable() && dispatcher.retryAfterMs() > 0, 'retryAfter')
    now += 30_000
    assertEqual(dispatcher.stats().breaker, 'half_open', 'half_open')
    const probe = await dispatcher.run(op)
    assert(!probe.ok && probe.code === 'transient', 'неуспешна проба')
    assertEqual(dispatcher.stats().breaker, 'open', 'обратно open')
    now += 30_000
    fake.defaults.delete('ListRooms')
    const ok = await dispatcher.run(op)
    assert(ok.ok, 'успешна проба')
    assertEqual(dispatcher.stats().breaker, 'closed', 'closed')
    fake.defaults.set('ListRooms', { kind: 'status', status: 404, code: 'not_found' })
    for (let index = 0; index < 8; index += 1) await dispatcher.run(op)
    assertEqual(dispatcher.stats().breaker, 'closed', 'not_found не отваря breaker-а')
    dispatcher.dispose()
  })

  await check('[L5] Ограничени опашки и приоритет: queue_full веднага; high преди чакащите normal', async () => {
    fake.reset()
    const dispatcher = createVoiceLiveKitDispatcher({ maxConcurrent: 1, maxNormalQueue: 2, maxHighQueue: 1, maxAttempts: 1, hardTimeoutMs: 5_000 })
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const blocker = dispatcher.run({ name: 'block', priority: 'normal', idempotent: false, run: async () => { await gate; order.push('block') } })
    const n1 = dispatcher.run({ name: 'n1', priority: 'normal', idempotent: false, run: async () => { order.push('n1') } })
    const n2 = dispatcher.run({ name: 'n2', priority: 'normal', idempotent: false, run: async () => { order.push('n2') } })
    const n3 = await dispatcher.run({ name: 'n3', priority: 'normal', idempotent: false, run: async () => { order.push('n3') } })
    assert(!n3.ok && n3.code === 'queue_full', 'препълнена normal опашка')
    const h1 = dispatcher.run({ name: 'h1', priority: 'high', idempotent: false, run: async () => { order.push('h1') } })
    const h2 = await dispatcher.run({ name: 'h2', priority: 'high', idempotent: false, run: async () => { order.push('h2') } })
    assert(!h2.ok && h2.code === 'queue_full', 'препълнена high опашка')
    assertEqual(dispatcher.stats().queuedNormal + dispatcher.stats().queuedHigh, 3, 'ограничени')
    release()
    await Promise.all([blocker, n1, n2, h1])
    assertEqual(order.join(','), 'block,h1,n1,n2', 'приоритет на отнемането/DeleteRoom')
    dispatcher.dispose()
  })

  await check('[L6] Retry само за идемпотентни при временна грешка, с backoff; не за rejected/неидемпотентни', async () => {
    const dispatcher = createVoiceLiveKitDispatcher({ maxAttempts: 3, retryBaseDelayMs: 5, retryMaxDelayMs: 20 })
    let calls = 0
    const transient = async (): Promise<void> => { calls += 1; throw Object.assign(new Error('x'), { status: 503 }) }
    const r1 = await dispatcher.run({ name: 't', priority: 'normal', idempotent: true, run: transient })
    assert(!r1.ok && r1.attempts === 3 && calls === 3, `идемпотентна: ${calls}`)
    calls = 0
    const r2 = await dispatcher.run({ name: 't', priority: 'normal', idempotent: false, run: transient })
    assert(!r2.ok && r2.attempts === 1 && calls === 1, 'неидемпотентна')
    calls = 0
    const r3 = await dispatcher.run({ name: 'r', priority: 'normal', idempotent: true, run: async () => { calls += 1; throw Object.assign(new Error('x'), { status: 403 }) } })
    assert(!r3.ok && r3.code === 'rejected' && calls === 1, 'rejected без retry')
    dispatcher.dispose()
  })

  // ═══ [T] Токени ════════════════════════════════════════════════════════
  await check('[T1] VIP токен: точни grants (само микрофон, без data/admin), правилната стая и identity, подпис, TTL 600 s; CreateRoom lazy с 4 участника', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Vip')
    const table = h.createTable(creator, 'c1')
    assertEqual(fake.calls.length, 0, 'без LiveKit при създаване на масата')
    const inst = instanceId('vip')
    h.presence('c1', creator, table, inst)
    assertEqual(fake.calls.length, 0, 'без LiveKit при presence')
    const result = await h.token(creator, table, inst)
    assertEqual(result.status, 200, JSON.stringify(result.body))
    const token = String(result.body.token)
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(token)
    const video = claims.video as Record<string, unknown>
    const live = h.store.getLiveGeneration(table)!
    assertEqual(video.room, live.livekitRoomName, 'точно име на стая')
    assertEqual(video.roomJoin, true, 'roomJoin')
    assertEqual(video.canSubscribe, true, 'canSubscribe')
    assertEqual(video.canPublish, true, 'canPublish')
    assertEqual(JSON.stringify(video.canPublishSources), '["microphone"]', 'само микрофон')
    assertEqual(video.canPublishData, false, 'canPublishData')
    for (const forbidden of ['roomCreate', 'roomAdmin', 'roomList', 'roomRecord', 'ingressAdmin', 'agent', 'destinationRoom']) {
      assert(video[forbidden] === undefined || video[forbidden] === false, `без ${forbidden}`)
    }
    assert(video.hidden !== true && video.recorder !== true, 'не е скрит/recorder')
    assertEqual(claims.sub, buildVoiceIdentity(creator, 1), 'identity')
    assert(claims.name === undefined && claims.metadata === undefined, 'без име/metadata')
    assertEqual(Number(claims.exp) - Number(claims.nbf), 600, 'TTL')
    assertEqual(result.body.canSpeak, true, 'canSpeak')
    assertEqual(result.body.url, 'ws://127.0.0.1:7880', 'ws url от env')
    const creates = fake.calls.filter((c) => c.method === 'CreateRoom')
    assertEqual(creates.length, 1, 'един CreateRoom')
    assertEqual(creates[0]!.body.maxParticipants, 4, 'макс. 4')
    assert(!h.logs.some((line) => line.includes(token) || line.includes('eyJ')), 'токенът не е в логовете')
  })

  await check('[T2] Non-VIP токен: canPublish:false, без източници, без data; зрител/чужд/извън масата/без сесия -> без токен и без CreateRoom', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const listener = h.seedProfile('Listener')
    const spectator = h.seedProfile('Spectator')
    const table = h.createTable(creator, 'c1')
    h.seat(table, listener, 'c2')
    const inst = instanceId('l')
    h.presence('c2', listener, table, inst)
    const result = await h.token(listener, table, inst)
    assertEqual(result.status, 200, JSON.stringify(result.body))
    const video = decodeJwt(String(result.body.token)).video as Record<string, unknown>
    assertEqual(video.canPublish, false, 'canPublish')
    assertEqual(JSON.stringify(video.canPublishSources ?? []), '[]', 'без източници')
    assertEqual(video.canPublishData, false, 'data')
    assertEqual(video.canSubscribe, true, 'слуша')
    const creates = fake.calls.length
    h.seats.set(`${table}|${spectator}`, { relation: 'spectator' })
    h.open.add('c3')
    const specAck = h.presence('c3', spectator, table, instanceId('s'))
    assert(specAck?.type === 'voice_presence_result' && !specAck.ok && specAck.code === 'not_a_player', 'зрител presence')
    const specToken = await h.token(spectator, table, instanceId('s'))
    assert(specToken.status === 403 && specToken.body.code === 'spectator', JSON.stringify(specToken.body))
    const strangerToken = await h.token(h.seedProfile('Stranger'), table, instanceId('x'))
    assert(strangerToken.status === 403 && strangerToken.body.code === 'not_a_player', 'чужд профил')
    const otherTable = await h.token(listener, randomUUID(), inst)
    assertEqual(otherTable.status, 404, 'чужд voiceTableId')
    const wrongInstance = await h.token(listener, table, instanceId('other'))
    assert(wrongInstance.status === 409 && wrongInstance.body.code === 'invalid_session', 'чужд clientInstanceId')
    assertEqual(fake.calls.length, creates, 'отказите не викат LiveKit')
    assertEqual(buildVoiceVideoGrant('r', { canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: false }).canPublishData, false, 'pure grant')
  })

  await check('[T3] Session binding: presence само от връзката на мястото; затворена връзка/изтекъл lease -> няма токен; същата връзка не сменя страницата си', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Bind')
    const table = h.createTable(creator, 'c1')
    h.open.add('c-other')
    const wrongConn = h.presence('c-other', creator, table, instanceId('a'))
    assert(wrongConn?.type === 'voice_presence_result' && !wrongConn.ok && wrongConn.code === 'not_seat_connection', 'чужда връзка')
    const inst = instanceId('a')
    h.presence('c1', creator, table, inst)
    const conflict = h.presence('c1', creator, table, instanceId('b'))
    assert(conflict?.type === 'voice_presence_result' && !conflict.ok && conflict.code === 'client_instance_conflict', 'същата връзка, друга страница')
    h.open.delete('c1')
    const closed = await h.token(creator, table, inst)
    assert(closed.status === 409 && closed.body.code === 'invalid_session', 'затворена връзка')
    h.open.add('c1')
    h.clock.advance(61_000)
    const expired = await h.token(creator, table, inst)
    assert(expired.status === 409 && expired.body.code === 'presence_required', 'изтекъл lease')
    h.presence('c1', creator, table, inst)
    assertEqual((await h.token(creator, table, inst)).status, 200, 'подновен lease')
  })

  await check('[T4] HTTP слой: само POST, origin guard, сесия, валидно тяло; Cache-Control: no-store; токенът не излиза в логовете', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Http')
    const table = h.createTable(creator, 'c1')
    const inst = instanceId('http')
    h.presence('c1', creator, table, inst)
    const handler = createVoiceChatHttpRequestHandler({
      service: h.service,
      getSessionProfileId: (req) => (req.headers['x-test-profile'] as string | undefined) ?? null,
      isAllowedOrigin: (req) => req.headers.origin !== 'https://evil.example',
      readJsonBody: (req) => new Promise((resolvePromise, rejectPromise) => {
        let raw = ''
        req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
        req.on('end', () => { try { resolvePromise(JSON.parse(raw)) } catch (error) { rejectPromise(error) } })
      }),
    })
    const server = createServer((req, res) => {
      void handler(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
        if (!handled) { res.writeHead(404); res.end() }
      })
    })
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const body = JSON.stringify({ voiceTableId: table, clientInstanceId: inst })
      const get = await fetch(`${base}/api/voice/token`)
      assertEqual(get.status, 405, 'GET')
      const evil = await fetch(`${base}/api/voice/token`, { method: 'POST', body, headers: { origin: 'https://evil.example', 'x-test-profile': creator } })
      assertEqual(evil.status, 403, 'чужд origin')
      const anon = await fetch(`${base}/api/voice/token`, { method: 'POST', body })
      assertEqual(anon.status, 401, 'без сесия')
      const bad = await fetch(`${base}/api/voice/token`, { method: 'POST', body: JSON.stringify({ voiceTableId: 'x', clientInstanceId: 'y' }), headers: { 'x-test-profile': creator } })
      assertEqual(bad.status, 400, 'невалидно тяло')
      const ok = await fetch(`${base}/api/voice/token`, { method: 'POST', body, headers: { 'x-test-profile': creator } })
      assertEqual(ok.status, 200, 'успех')
      assertEqual(ok.headers.get('cache-control'), 'no-store', 'no-store')
      const json = await ok.json() as Record<string, unknown>
      assert(typeof json.token === 'string' && !h.logs.some((line) => line.includes(String(json.token))), 'токенът не е в логовете')
      const speak = await fetch(`${base}/api/voice/speak-access`, { method: 'POST', body, headers: { 'x-test-profile': creator } })
      assertEqual(speak.headers.get('cache-control'), 'no-store', 'no-store speak-access')
      assertEqual((await fetch(`${base}/api/voice/other`, { method: 'POST' })).status, 404, 'непознат път не се обработва')
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
  })

  await check('[T5] Race: край на участието по време на CreateRoom -> токен НЕ се предава (без ротация — не е издаван)', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const leaver = h.seedProfile('Leaver')
    const table = h.createTable(creator, 'c1')
    h.seat(table, leaver, 'c2')
    const inst = instanceId('race')
    h.presence('c2', leaver, table, inst)
    fake.next.set('CreateRoom', [{ kind: 'delay_apply', delayMs: 150 }])
    const pending = h.token(leaver, table, inst)
    await sleep(40)
    h.seats.delete(`${table}|${leaver}`)
    h.service.onMemberRemoved(table, leaver, 'left_waiting_room')
    const result = await pending
    assert(result.status >= 400 && result.body.token === undefined, `без токен: ${JSON.stringify(result.body)}`)
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без излишна ротация')
  })

  await check('[T6] Race: ротация по време на CreateRoom -> 409, старата генерация никога не получава токен', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const other = h.seedProfile('Other')
    const leaver = h.seedProfile('Leaver')
    const table = h.createTable(creator, 'c1')
    h.seat(table, other, 'c2')
    h.seat(table, leaver, 'c3')
    await joinWithToken(h, table, leaver, 'c3', instanceId('l'), fake)
    const inst = instanceId('o')
    h.presence('c2', other, table, inst)
    fake.next.set('CreateRoom', [{ kind: 'delay_apply', delayMs: 150 }])
    const pending = h.token(other, table, inst)
    await sleep(40)
    h.seats.delete(`${table}|${leaver}`)
    h.service.onMemberRemoved(table, leaver, 'left_waiting_room')
    const result = await pending
    // Fencing (чакащо изтриване) или различен fingerprint — и в двата случая без токен.
    assert(
      result.body.token === undefined &&
        ((result.status === 409 && result.body.code === 'voice_state_changed') || (result.status === 503 && result.body.code === 'voice_rotation_pending')),
      JSON.stringify(result.body),
    )
    assertEqual(h.service.debug.getBinding(table, other)?.issuedRoomName ?? null, null, 'старата генерация не е получила токен')
  })

  await check('[T7] Race: загубено право ПО ВРЕМЕ на подписа -> токенът се изхвърля и (вече маркиран като издаден) води до ротация', async () => {
    fake.reset()
    let releaseSign: () => void = () => {}
    const signGate = new Promise<void>((resolvePromise) => { releaseSign = resolvePromise })
    const realSigner = createVoiceTokenSigner({ apiKey: API_KEY, apiSecret: API_SECRET })
    let gated = false
    const signer: VoiceTokenSigner = async (input) => {
      if (gated) await signGate
      return realSigner(input)
    }
    const h = await createHarness({ fake, signToken: signer })
    const creator = h.seedProfile('Host')
    const leaver = h.seedProfile('Leaver')
    const table = h.createTable(creator, 'c1')
    h.seat(table, leaver, 'c2')
    const inst = instanceId('sign')
    h.presence('c2', leaver, table, inst)
    gated = true
    const pending = h.token(leaver, table, inst)
    await sleep(80)
    h.seats.delete(`${table}|${leaver}`)
    h.service.onMemberRemoved(table, leaver, 'left_waiting_room')
    releaseSign()
    const result = await pending
    assert(result.status >= 400 && result.body.token === undefined, JSON.stringify(result.body))
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация (консервативно)')
  })

  await check('[T8] Едновременни заявки за една стая -> един CreateRoom; breaker open -> 503 веднага без мрежа', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const a = h.seedProfile('A')
    const b = h.seedProfile('B')
    const table = h.createTable(a, 'c1')
    h.seat(table, b, 'c2')
    const ia = instanceId('a')
    const ib = instanceId('b')
    h.presence('c1', a, table, ia)
    h.presence('c2', b, table, ib)
    fake.next.set('CreateRoom', [{ kind: 'delay_apply', delayMs: 60 }])
    const [ra, rb] = await Promise.all([h.token(a, table, ia), h.token(b, table, ib)])
    assert(ra.status === 200 && rb.status === 200, 'и двете')
    assertEqual(fake.calls.filter((c) => c.method === 'CreateRoom').length, 1, 'dedupe')
    let now = 0
    const broken = createVoiceLiveKitDispatcher({ breakerFailureThreshold: 1, maxAttempts: 1, now: () => now })
    await broken.run({ name: 'x', priority: 'normal', idempotent: true, run: async () => { throw Object.assign(new Error('x'), { status: 500 }) } })
    const h2 = await createHarness({ fake, dispatcher: broken })
    const c = h2.seedProfile('C')
    const t2 = h2.createTable(c, 'c9')
    const ic = instanceId('c')
    h2.presence('c9', c, t2, ic)
    const hits = fake.calls.length
    const started = Date.now()
    const r = await h2.token(c, t2, ic)
    assert(r.status === 503 && r.body.code === 'voice_unavailable' && typeof r.body.retryAfterMs === 'number', JSON.stringify(r.body))
    assert(Date.now() - started < 200 && fake.calls.length === hits, 'бърз отказ без мрежа')
    now += 0
  })

  // ═══ [V] Право за говорене (VIP правила) ═════════════════════════════════
  await check('[V1] VIP при сядането: говори в чакалнята; VIP изтича в чакалнята и в играта -> продължава да говори; без ротация', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const player = h.seedProfile('VipPlayer')
    const table = h.createTable(creator, 'c1')
    h.vip.add(player)
    h.seat(table, player, 'c2')
    const inst = instanceId('v')
    h.presence('c2', player, table, inst)
    assertEqual((await h.token(player, table, inst)).body.canSpeak, true, 'VIP в чакалнята')
    h.vip.delete(player)
    assertEqual((await h.token(player, table, inst)).body.canSpeak, true, 'изтекъл VIP в чакалнята')
    h.service.onGameStarted(table, 'server-1')
    assertEqual(h.store.getVoiceTable(table)?.phase, 'in_game', 'старт — същият слот')
    assertEqual((await h.token(player, table, inst)).body.canSpeak, true, 'изтекъл VIP в играта')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без ротация заради VIP')
    assertEqual(h.store.getActiveMembership(table, player)?.speakingEntitledAt !== null, true, 'правото е записано')
  })

  await check('[V2] Няколко поредни повторни игри: правото се пази; "Преиграй" не проверява VIP за отнемане; без ротация', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    h.service.onGameStarted(table, 'server-r')
    const inst = instanceId('r')
    h.presence('c1', creator, table, inst)
    h.vip.delete(creator)
    for (let replay = 1; replay <= 4; replay += 1) {
      // "Преиграй" няма гласова кука по дизайн: същата ServerRoom, същото участие.
      const result = await h.token(creator, table, inst)
      assertEqual(result.body.canSpeak, true, `повторна игра ${replay}`)
    }
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без ротации')
    assertEqual(h.service.stats().counters.rotations, 0, 'брояч')
  })

  await check('[V3] Reconnect (същата страница): без ротация, правото се пази; refresh (нова страница): ротация при издаден токен, правото се пази, нов identity', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    const inst = instanceId('page1')
    const first = await joinWithToken(h, table, creator, 'c1', inst, fake)
    h.vip.delete(creator)
    // network reconnect: старата връзка се затваря, мястото минава на c1b
    h.open.delete('c1')
    h.service.onGameConnectionClosed('c1')
    h.seats.set(`${table}|${creator}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'c1b' })
    h.open.add('c1b')
    h.presence('c1b', creator, table, inst)
    const again = await h.token(creator, table, inst)
    assert(again.status === 200 && again.body.canSpeak === true && again.body.identity === first.identity, 'reconnect: същият identity, говори')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без ротация при reconnect')
    // refresh: нова страница от нова връзка
    h.open.delete('c1b')
    h.service.onGameConnectionClosed('c1b')
    h.seats.set(`${table}|${creator}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'c1c' })
    h.open.add('c1c')
    const inst2 = instanceId('page2')
    h.presence('c1c', creator, table, inst2)
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация (старата страница е имала токен)')
    assertEqual(h.store.getGeneration(first.roomName)?.status, 'delete_pending', 'старата стая чака DeleteRoom')
    const blocked = await h.token(creator, table, inst2)
    assert(blocked.status === 503 && blocked.body.code === 'voice_rotation_pending', 'fencing до потвърдено изтриване')
    await h.reconcile()
    const afterRefresh = await h.token(creator, table, inst2)
    assert(afterRefresh.status === 200 && afterRefresh.body.canSpeak === true, 'правото се пази след refresh')
    assert(afterRefresh.body.identity !== first.identity, 'нов identity (стар токен не може да изхвърли новия)')
    const oldToken = await new TokenVerifier(API_KEY, API_SECRET).verify(first.token)
    assert((oldToken.video as Record<string, unknown>).room !== h.store.getLiveGeneration(table)?.livekitRoomName, 'старият токен е за оттеглена стая')
  })

  await check('[V4] Рестарт на backend: възстановената игра пази участието и правото (без VIP); окончателно напусналите губят; токени след потвърдено изтриване', async () => {
    fake.reset()
    const h1 = await createHarness({ fake })
    const creator = h1.seedProfile('Host')
    const leaver = h1.seedProfile('Leaver')
    const table = h1.createTable(creator, 'c1')
    h1.vip.add(leaver)
    h1.seat(table, leaver, 'c2')
    h1.service.onGameStarted(table, 'server-boot')
    const before = await joinWithToken(h1, table, creator, 'c1', instanceId('a'), fake)
    h1.service.dispose()
    fake.rooms.set('pv_local_00000000000000000000000000000000_g1_aaaaaaaaaaaaaaaaaaaaaaaaaa', { maxParticipants: 4, participants: new Map() })
    fake.rooms.set('pv_prod_00000000000000000000000000000000_g1_aaaaaaaaaaaaaaaaaaaaaaaaaa', { maxParticipants: 4, participants: new Map() })
    const h2 = await createHarness({
      fake,
      existing: { path: h1.path, store: h1.store, seedProfile: h1.seedProfile },
      boot: [{ serverRoomId: 'server-boot', voiceTableId: table, activeProfileIds: [creator] }],
    })
    assertEqual(h2.store.getGeneration(before.roomName)?.retireReason, 'boot_rotation', 'живата стая е ротирана')
    assertEqual(h2.store.getActiveMembership(table, leaver), null, 'напусналият губи участието')
    h2.seats.set(`${table}|${creator}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'n1' })
    h2.open.add('n1')
    const inst = instanceId('b')
    h2.presence('n1', creator, table, inst)
    const blocked = await h2.token(creator, table, inst)
    assertEqual(blocked.body.code, 'voice_rotation_pending', 'стари токени: първо изтриване')
    await h2.reconcile()
    assert(!fake.rooms.has(before.roomName), 'старата стая е изтрита')
    assert(!fake.rooms.has('pv_local_00000000000000000000000000000000_g1_aaaaaaaaaaaaaaaaaaaaaaaaaa'), 'сирак pv_ стая от boot sweep')
    assert(fake.rooms.has('pv_prod_00000000000000000000000000000000_g1_aaaaaaaaaaaaaaaaaaaaaaaaaa'), 'стая на чужд namespace (production) не се пипа')
    const after = await h2.token(creator, table, inst)
    assert(after.status === 200 && after.body.canSpeak === true, 'правото преживява рестарта без VIP')
  })

  await check('[V5] Окончателно напускане и повторно влизане без VIP -> само слуша; старо право не се възстановява', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const player = h.seedProfile('Returner')
    const table = h.createTable(creator, 'c1')
    h.vip.add(player)
    h.seat(table, player, 'c2')
    const firstMembership = h.service.debug.getMembership(table, player)!.membershipId
    h.vip.delete(player)
    h.seats.delete(`${table}|${player}`)
    h.service.onMemberRemoved(table, player, 'left_waiting_room')
    h.seat(table, player, 'c3')
    const inst = instanceId('ret')
    h.presence('c3', player, table, inst)
    const result = await h.token(player, table, inst)
    assert(result.status === 200 && result.body.canSpeak === false, 'само слуша')
    assert(h.service.debug.getMembership(table, player)!.membershipId !== firstMembership, 'ново участие')
    assertEqual(h.store.getMembership(firstMembership)?.endReason, 'left_waiting_room', 'старото участие е приключено')
  })

  await check('[V6] Non-VIP слушател придобива VIP -> speak-access: UpdateParticipant на място (без реконект, без микрофон); иначе нов токен; без VIP -> vip_required', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const listener = h.seedProfile('Buyer')
    const table = h.createTable(creator, 'c1')
    h.seat(table, listener, 'c2')
    const inst = instanceId('buy')
    const joined = await joinWithToken(h, table, listener, 'c2', inst, fake)
    const denied = await h.speak(listener, table, inst)
    assert(denied.status === 200 && denied.body.canSpeak === false && denied.body.code === 'vip_required', 'без VIP')
    h.vip.add(listener)
    const upgraded = await h.speak(listener, table, inst)
    assert(upgraded.body.canSpeak === true && upgraded.body.upgrade === 'updated', JSON.stringify(upgraded.body))
    const update = fake.calls.filter((c) => c.method === 'UpdateParticipant').at(-1)!
    assertEqual(update.body.identity, joined.identity, 'точният участник')
    assertEqual(JSON.stringify((update.body.permission as Record<string, unknown>).canPublishSources), '["MICROPHONE"]', 'само микрофон')
    h.vip.delete(listener)
    const persisted = await h.token(listener, table, inst)
    assertEqual(persisted.body.canSpeak, true, 'придобитото право остава след изтичане на VIP')
    const again = await h.speak(listener, table, inst)
    assertEqual(again.body.upgrade, 'already_allowed', 'вече позволено')
    // участник, който не е в стаята -> нов токен
    const other = h.seedProfile('Other')
    h.seat(table, other, 'c3')
    const instOther = instanceId('o')
    h.presence('c3', other, table, instOther)
    await h.token(other, table, instOther)
    h.vip.add(other)
    const reconnect = await h.speak(other, table, instOther)
    assertEqual(reconnect.body.upgrade, 'request_new_token', 'UpdateParticipant not_found -> нов токен')
    assertEqual((await h.token(other, table, instOther)).body.canSpeak, true, 'новият токен позволява микрофон')
  })

  await check('[V7] Бан: прекратява гласа и правото независимо от придобитото; ротация при издаден токен; без токен след това', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const banned = h.seedProfile('Banned')
    const table = h.createTable(creator, 'c1')
    h.vip.add(banned)
    h.seat(table, banned, 'c2')
    const inst = instanceId('ban')
    await joinWithToken(h, table, banned, 'c2', inst, fake)
    h.banned.add(banned)
    h.service.onProfileRevoked(banned, 'banned')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация')
    assertEqual(h.service.debug.getMembership(table, banned), null, 'участието е приключено')
    assert(messagesOf(h, 'c2', 'voice_access_ended').some((m) => m.type === 'voice_access_ended' && m.reason === 'banned'), 'известие')
    await h.reconcile()
    const after = await h.token(banned, table, inst)
    assert(after.status === 403 && after.body.code === 'banned', JSON.stringify(after.body))
  })

  // ═══ [R] Ротация и reconciliation ═══════════════════════════════════════
  await check('[R1] Напускане с токен: приоритетно отнемане (Update+Remove) ПРЕДИ DeleteRoom; нова генерация; останалите получават сигнал; токени едва след потвърдено изтриване', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const leaver = h.seedProfile('Leaver')
    const table = h.createTable(creator, 'c1')
    h.seat(table, leaver, 'c2')
    const instHost = instanceId('h')
    await joinWithToken(h, table, creator, 'c1', instHost, fake)
    const leaverJoin = await joinWithToken(h, table, leaver, 'c2', instanceId('l'), fake)
    fake.calls.length = 0
    h.seats.delete(`${table}|${leaver}`)
    h.service.onMemberRemoved(table, leaver, 'kicked')
    const updated = messagesOf(h, 'c1', 'voice_table_updated').at(-1)
    assert(updated?.type === 'voice_table_updated' && updated.generation === 2 && !updated.ready, 'сигнал без токен')
    assert(messagesOf(h, 'c2', 'voice_access_ended').some((m) => m.type === 'voice_access_ended' && m.reason === 'kicked'), 'изгоненият е известен')
    const blocked = await h.token(creator, table, instHost)
    assertEqual(blocked.body.code, 'voice_rotation_pending', 'fencing')
    await sleep(100)
    await h.reconcile()
    const methods = fake.calls.map((c) => c.method)
    const firstDelete = methods.indexOf('DeleteRoom')
    assert(methods.indexOf('UpdateParticipant') >= 0 && methods.indexOf('UpdateParticipant') < firstDelete, `ред: ${methods.join(',')}`)
    assert(methods.indexOf('RemoveParticipant') >= 0 && methods.indexOf('RemoveParticipant') < firstDelete, 'Remove преди Delete')
    assert(methods.lastIndexOf('ListRooms') > firstDelete, 'потвърждение с ListRooms')
    assertEqual(h.store.getGeneration(leaverJoin.roomName)?.status, 'deleted', 'потвърдено изтриване')
    const ready = messagesOf(h, 'c1', 'voice_table_updated').at(-1)
    assert(ready?.type === 'voice_table_updated' && ready.ready, 'готовност след изтриването')
    assertEqual((await h.token(creator, table, instHost)).status, 200, 'нов токен за новата генерация')
  })

  await check('[R2] Напускане БЕЗ издаден токен -> без ротация; празна чакалня/затваряне/изтичане освобождават слота и участията', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const quiet = h.seedProfile('Quiet')
    const table = h.createTable(creator, 'c1')
    await joinWithToken(h, table, creator, 'c1', instanceId('h'), fake)
    h.seat(table, quiet, 'c2')
    h.seats.delete(`${table}|${quiet}`)
    h.service.onMemberRemoved(table, quiet, 'left_waiting_room')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без ротация')
    const before = h.store.countActiveVoiceTables()
    h.service.onWaitingRoomEnded(table, 'waiting_room_empty')
    assertEqual(h.store.countActiveVoiceTables(), before - 1, 'слотът е освободен')
    assertEqual(h.store.getVoiceTable(table)?.releaseReason, 'waiting_room_empty', 'причина')
    assertEqual(h.store.getActiveMembership(table, creator), null, 'участията са приключени')
    assert(messagesOf(h, 'c1', 'voice_access_ended').some((m) => m.type === 'voice_access_ended' && m.reason === 'table_released'), 'известие')
    await h.reconcile()
    assertEqual(fake.rooms.size, 0, 'LiveKit стаята е изтрита')
    for (const reason of ['waiting_room_closed', 'waiting_room_expired'] as const) {
      const other = h.createTable(h.seedProfile(reason), `c-${reason}`)
      h.service.onWaitingRoomEnded(other, reason)
      assertEqual(h.store.getVoiceTable(other)?.releaseReason, reason, reason)
    }
    assertEqual(h.store.countActiveVoiceTables(), 0, 'нито един зает слот')
  })

  await check('[R3] Неуспешен DeleteRoom (5xx / ListRooms още я показва) -> остава в durable опашката с backoff; токени блокирани; после успех', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const leaver = h.seedProfile('Leaver')
    const table = h.createTable(creator, 'c1')
    h.seat(table, leaver, 'c2')
    const leaverJoin = await joinWithToken(h, table, leaver, 'c2', instanceId('l'), fake)
    h.seats.delete(`${table}|${leaver}`)
    h.service.onMemberRemoved(table, leaver, 'left_waiting_room')
    fake.defaults.set('DeleteRoom', { kind: 'status', status: 500 })
    await h.reconcile()
    const failedRecord = h.store.getGeneration(leaverJoin.roomName)!
    assert(failedRecord.status === 'delete_pending' && failedRecord.deleteAttempts === 1 && failedRecord.lastDeleteError !== null, JSON.stringify(failedRecord))
    assert(Date.parse(failedRecord.nextDeleteAttemptAt!) > h.clock.now(), 'backoff')
    const inst = instanceId('h')
    h.presence('c1', creator, table, inst)
    assertEqual((await h.token(creator, table, inst)).body.code, 'voice_rotation_pending', 'токени блокирани')
    fake.defaults.delete('DeleteRoom')
    // DeleteRoom "успява", но стаята все още се вижда -> не се маркира deleted.
    fake.next.set('DeleteRoom', [{ kind: 'status', status: 200 }])
    h.clock.advance(10 * 60_000)
    h.presence('c1', creator, table, inst)
    await h.reconcile()
    assertEqual(h.store.getGeneration(leaverJoin.roomName)?.status, 'delete_pending', 'ListRooms още я показва')
    h.clock.advance(10 * 60_000)
    h.presence('c1', creator, table, inst)
    await h.reconcile()
    assertEqual(h.store.getGeneration(leaverJoin.roomName)?.status, 'deleted', 'потвърдено')
    assertEqual((await h.token(creator, table, inst)).status, 200, 'токени отново')
  })

  await check('[R4] Забавен CreateRoom (timeout, но изпълнен по-късно) след оттегляне -> "възкресената" стая се открива и трие; името никога не е живо', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const leaver = h.seedProfile('Leaver')
    const table = h.createTable(creator, 'c1')
    h.seat(table, leaver, 'c2')
    const inst = instanceId('slow')
    h.presence('c2', leaver, table, inst)
    const roomName = (() => { const g = h.store.allocateGeneration(table, null); if (!g.ok) throw new Error('gen'); return g.roomName })()
    // И двата опита изтичат (0.4 s), а сървърът ги изпълнява след 900 ms.
    fake.next.set('CreateRoom', [{ kind: 'delay_apply', delayMs: 900 }, { kind: 'delay_apply', delayMs: 900 }])
    const result = await h.token(leaver, table, inst)
    assert(result.status === 503 && result.body.token === undefined, JSON.stringify(result.body))
    h.seats.delete(`${table}|${leaver}`)
    h.service.onMemberRemoved(table, leaver, 'left_waiting_room')
    // Без издаден токен няма ротация; оттегляме ръчно (напр. освобождаване на масата).
    h.service.onWaitingRoomEnded(table, 'waiting_room_closed')
    await h.reconcile()
    assertEqual(h.store.getGeneration(roomName)?.status, 'deleted', 'потвърдено изтриване (стаята още не съществува)')
    await sleep(1_200) // забавените CreateRoom пристигат
    assert(fake.rooms.has(roomName), 'стаята е "възкресена" от забавената заявка')
    assert(!h.store.isLiveRoomName(roomName), 'името не е живо — токени за него няма')
    assertEqual(h.service.debug.reconciler.stats().uncertainWatches, 1, 'името е под наблюдение')
    h.clock.advance(31_000)
    await h.reconcile()
    assert(!fake.rooms.has(roomName), 'sweep изтри възкресената стая')
  })

  await check('[R5] Изместена сесия: същата страница си връща сесията -> без ротация; иначе след кратък срок -> ротация; изместената връзка не получава токен', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    const inst = instanceId('d')
    await joinWithToken(h, table, creator, 'c1', inst, fake)
    // (a) half-open стар сокет: изместване, после същата страница от нова връзка
    h.service.onGameConnectionDisplaced('c1')
    h.open.delete('c1')
    assert(messagesOf(h, 'c1', 'voice_access_ended').some((m) => m.type === 'voice_access_ended' && m.reason === 'session_displaced'), 'известие')
    h.seats.set(`${table}|${creator}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'c1b' })
    h.open.add('c1b')
    h.presence('c1b', creator, table, inst)
    h.clock.advance(20_000)
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без ротация при върната сесия')
    // (b) друго устройство изтества сесията и не ползва глас
    h.service.onGameConnectionDisplaced('c1b')
    h.open.delete('c1b')
    const stale = await h.token(creator, table, inst)
    assertEqual(stale.status, 409, 'изместената страница не получава токен')
    h.clock.advance(16_000)
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация след срока')
  })

  await check('[R6] Изключване на функцията (OFF): прекратява всички сесии, оттегля стаите, отказва токени; повторното включване не връща старите маси', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    const inst = instanceId('off')
    const joined = await joinWithToken(h, table, creator, 'c1', inst, fake)
    const off = h.store.setMode('off', { profileId: null })
    if (!off.ok) throw new Error('setMode')
    h.service.onModeChanged(off)
    assert(messagesOf(h, 'c1', 'voice_access_ended').some((m) => m.type === 'voice_access_ended' && m.reason === 'voice_off'), 'известие')
    assertEqual((await h.token(creator, table, inst)).body.code, 'voice_off', 'без токени')
    await h.reconcile()
    assert(!fake.rooms.has(joined.roomName), 'LiveKit стаята е изтрита')
    assert(h.store.setMode('public', { profileId: null }).ok, 'повторно включване')
    assertEqual((await h.token(creator, table, inst)).status, 410, 'старата маса остава освободена')
    const reserve = h.service.reserveVoiceTableForPrivateRoom({ profileId: creator, isFullAdmin: false })
    assert(reserve.ok, 'нова маса')
  })

  // ═══ [P] Presence, lease и 120 s ═════════════════════════════════════════
  await check('[P1] 120 s: загубена игрова връзка -> гласът продължава; възстановяване на същата сесия отменя таймера; след 120 s -> край (Remove, без ротация)', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    const inst = instanceId('net')
    const joined = await joinWithToken(h, table, creator, 'c1', inst, fake)
    h.open.delete('c1')
    h.service.onGameConnectionClosed('c1')
    h.clock.advance(119_000)
    assertEqual(h.service.debug.getBinding(table, creator)?.voiceActive, true, 'преди 120 s')
    h.seats.set(`${table}|${creator}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'c2' })
    h.open.add('c2')
    h.presence('c2', creator, table, inst)
    h.clock.advance(10_000)
    assertEqual(h.service.debug.getBinding(table, creator)?.voiceActive, true, 'таймерът е отменен')
    h.open.delete('c2')
    h.service.onGameConnectionClosed('c2')
    fake.calls.length = 0
    h.clock.advance(120_000)
    assertEqual(h.service.debug.getBinding(table, creator)?.voiceActive, false, 'достъпът е прекратен')
    await sleep(100)
    assert(fake.calls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === joined.identity), 'RemoveParticipant')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без ротация (легитимен участник)')
    assertEqual(h.service.stats().counters.disconnectTimeouts, 1, 'брояч')
  })

  await check('[P2] Lease при ЖИВ игрови WS: без подновяване -> край на достъпа; подновяването го удължава; живият WS сам не го удължава', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    const inst = instanceId('lease')
    await joinWithToken(h, table, creator, 'c1', inst, fake)
    for (let index = 0; index < 5; index += 1) {
      h.clock.advance(20_000)
      h.presence('c1', creator, table, inst)
    }
    assertEqual(h.service.debug.getBinding(table, creator)?.voiceActive, true, 'подновяванията пазят достъпа')
    h.clock.advance(61_000)
    assertEqual(h.service.debug.getBinding(table, creator)?.voiceActive, false, 'изтекъл lease')
    assert(messagesOf(h, 'c1', 'voice_access_ended').some((m) => m.type === 'voice_access_ended' && m.reason === 'lease_expired'), 'известие')
    assertEqual((await h.token(creator, table, inst)).body.code, 'presence_required', 'нужно е ново изрично включване')
  })

  await check('[P3] Напускане на екрана (лоби/магазин): прекратява достъпа сървърно; мястото и правото се пазят; връщане -> ново включване', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    const inst = instanceId('lobby')
    const joined = await joinWithToken(h, table, creator, 'c1', inst, fake)
    h.vip.delete(creator)
    fake.calls.length = 0
    const ack = h.presence('c1', creator, table, inst, false)
    assert(ack?.type === 'voice_presence_result' && ack.ok && !ack.onTableScreen, 'ack')
    await sleep(100)
    assert(fake.calls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === joined.identity), 'RemoveParticipant')
    assertEqual((await h.token(creator, table, inst)).body.code, 'presence_required', 'без глас в лобито')
    h.presence('c1', creator, table, inst, true)
    const back = await h.token(creator, table, inst)
    assert(back.status === 200 && back.body.canSpeak === true, 'връщане: правото се пази')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 1, 'без ротация')
  })

  await check('[P4] Таймери само за активни гласови участници; окончателно напускане -> веднага (без 120 s)', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const idle = h.seedProfile('Idle')
    const table = h.createTable(creator, 'c1')
    h.seat(table, idle, 'c2')
    h.presence('c2', idle, table, instanceId('idle'))
    const pendingIdle = h.clock.pending()
    h.service.onGameConnectionClosed('c2')
    assertEqual(h.clock.pending(), pendingIdle, 'без таймер за неактивен (без токен)')
    const binding = h.service.debug.getBinding(table, idle)!
    assert(binding.leaseTimer === null && binding.disconnectTimer === null, 'без lease/disconnect таймер')
    h.service.onGameStarted(table, 'server-p4')
    await joinWithToken(h, table, creator, 'c1', instanceId('h'), fake)
    assert(h.service.debug.getBinding(table, creator)!.leaseTimer !== null, 'активният има lease таймер')
    h.seats.set(`${table}|${creator}`, { relation: 'player', permanentlyLeft: true, seatConnectionId: null })
    h.service.onMemberRemoved(table, creator, 'permanently_left')
    assertEqual(h.service.debug.getBinding(table, creator), null, 'веднага')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация (имал е токен)')
  })

  // ═══ [C] Създаване, лимит, lifecycle ═══════════════════════════════════
  await check('[C1] Създаване: VIP, режими, авариен стоп, липсващ LiveKit, лимит с броячи; неуспешно създаване/старт освобождават слота', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const vipUser = h.seedProfile('Vip')
    const plain = h.seedProfile('Plain')
    h.vip.add(vipUser)
    assertEqual((h.service.reserveVoiceTableForPrivateRoom({ profileId: plain, isFullAdmin: false }) as { code?: string }).code, 'voice_chat_vip_required', 'non-VIP')
    h.banned.add(plain)
    assertEqual((h.service.reserveVoiceTableForPrivateRoom({ profileId: plain, isFullAdmin: false }) as { code?: string }).code, 'voice_chat_banned', 'бан')
    assert(h.store.setMaxTables(2, { profileId: null }).ok, 'лимит 2')
    const a = h.service.reserveVoiceTableForPrivateRoom({ profileId: vipUser, isFullAdmin: false })
    const b = h.service.reserveVoiceTableForPrivateRoom({ profileId: vipUser, isFullAdmin: false })
    const c = h.service.reserveVoiceTableForPrivateRoom({ profileId: vipUser, isFullAdmin: false })
    assert(a.ok && b.ok, 'две маси')
    assert(!c.ok && c.code === 'voice_chat_capacity_reached' && c.activeCount === 2 && c.maxTables === 2, JSON.stringify(c))
    if (!a.ok || !b.ok) return
    h.service.abortReservation(a.voiceTableId)
    assertEqual(h.store.getVoiceTable(a.voiceTableId)?.releaseReason, 'reservation_aborted', 'неуспешно създаване')
    h.service.attachPrivateRoom(b.voiceTableId, 'private-b', vipUser)
    h.service.onGameStartFailed(b.voiceTableId)
    assertEqual(h.store.getVoiceTable(b.voiceTableId)?.releaseReason, 'game_start_failed', 'неуспешен старт')
    assertEqual(h.store.countActiveVoiceTables(), 0, 'нито един слот не остава')
    assert(h.store.setMode('admin_only', { profileId: null }).ok, 'admin_only')
    assertEqual((h.service.reserveVoiceTableForPrivateRoom({ profileId: vipUser, isFullAdmin: false }) as { code?: string }).code, 'voice_chat_admin_only', 'не-admin')
    assert(h.service.reserveVoiceTableForPrivateRoom({ profileId: vipUser, isFullAdmin: true }).ok, 'admin + VIP')
    const stopped = await createHarness({ fake, env: { VOICE_CHAT_ENABLED: '0' } })
    const s = stopped.seedProfile('S')
    stopped.vip.add(s)
    assertEqual((stopped.service.reserveVoiceTableForPrivateRoom({ profileId: s, isFullAdmin: false }) as { code?: string }).code, 'voice_chat_off', 'авариен стоп')
    const noLiveKit = await createHarness({ fake: null })
    const n = noLiveKit.seedProfile('N')
    noLiveKit.vip.add(n)
    assertEqual((noLiveKit.service.reserveVoiceTableForPrivateRoom({ profileId: n, isFullAdmin: false }) as { code?: string }).code, 'voice_chat_unavailable', 'без LiveKit конфигурация')
  })

  await check('[C2] Преход чакалня -> игра: същият voiceTableId и слот; премахване на игралната стая освобождава; повторно освобождаване е идемпотентно', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const creator = h.seedProfile('Host')
    const table = h.createTable(creator, 'c1')
    h.service.onGameStarted(table, 'server-c2')
    h.service.onGameStarted(table, 'server-c2')
    const record = h.store.getVoiceTable(table)!
    assert(record.phase === 'in_game' && record.serverRoomId === 'server-c2' && h.store.countActiveVoiceTables() === 1, 'един слот')
    h.service.onServerRoomRemoved(table)
    h.service.onServerRoomRemoved(table)
    assertEqual(h.store.getVoiceTable(table)?.releaseReason, 'server_room_removed', 'освободена')
    assertEqual(h.store.countActiveVoiceTables(), 0, 'без двойно броене')
  })

  await check('[C3] privateRoomsStore: voiceTableId се носи; onMemberSeated преди onRoomReady; празна чакалня -> onRoomEmptied (без onRoomClosed/onRoomExpired)', () => {
    const events: string[] = []
    const store = createPrivateRoomsStore({
      onRoomsChanged: () => {},
      onRoomReady: (room) => events.push(`ready:${room.voiceTableId}`),
      onRoomExpired: () => events.push('expired'),
      onRoomClosed: () => events.push('closed'),
      onMemberLeft: () => events.push('left'),
      onMemberKicked: () => events.push('kicked'),
      onMemberSeated: (room, occupant) => events.push(`seated:${occupant.profileId}:${room.voiceTableId}`),
      onRoomEmptied: (room, occupant) => events.push(`emptied:${occupant.profileId}:${room.voiceTableId}`),
    })
    const voiceTableId = randomUUID()
    const created = store.createRoom({
      connectionId: 'h', profileId: 'p-host', displayName: 'H', avatarUrl: null, level: 1, rankTitle: null,
      stake: 0 as never, isLocked: false, waitMinutes: 15 as never, manualStart: false, voiceTableId,
    })
    assert(created.ok && created.room.voiceTableId === voiceTableId, 'voiceTableId')
    if (!created.ok) return
    const join = (conn: string, profile: string, team: 'A' | 'B', slotIndex: 0 | 1): void => {
      const result = store.joinTeam({ privateRoomId: created.room.id, connectionId: conn, profileId: profile, displayName: profile, avatarUrl: null, level: 1, rankTitle: null, team, slotIndex, isBlockedWith: () => false })
      assert(result.ok, `join ${profile}`)
    }
    join('c2', 'p2', 'A', 1)
    store.leaveRoom('c2')
    store.leaveRoom('h')
    assertEqual(events.join('|'), `seated:p2:${voiceTableId}|left|emptied:p-host:${voiceTableId}`, 'празна чакалня')
    events.length = 0
    const second = store.createRoom({
      connectionId: 'h2', profileId: 'p-h2', displayName: 'H', avatarUrl: null, level: 1, rankTitle: null,
      stake: 0 as never, isLocked: false, waitMinutes: 15 as never, manualStart: false, voiceTableId,
    })
    if (!second.ok) throw new Error('create')
    for (const [conn, profile, team, slot] of [['x1', 'q1', 'A', 1], ['x2', 'q2', 'B', 0], ['x3', 'q3', 'B', 1]] as const) {
      const result = store.joinTeam({ privateRoomId: second.room.id, connectionId: conn, profileId: profile, displayName: profile, avatarUrl: null, level: 1, rankTitle: null, team, slotIndex: slot, isBlockedWith: () => false })
      assert(result.ok, 'join')
    }
    assertEqual(events.join('|'), `seated:q1:${voiceTableId}|seated:q2:${voiceTableId}|seated:q3:${voiceTableId}|ready:${voiceTableId}`, 'седнал преди старта')
    const withoutVoice = store.createRoom({
      connectionId: 'h3', profileId: 'p-h3', displayName: 'H', avatarUrl: null, level: 1, rankTitle: null,
      stake: 0 as never, isLocked: false, waitMinutes: 15 as never, manualStart: false,
    })
    assert(withoutVoice.ok && (withoutVoice.room as PrivateRoom).voiceTableId === null, 'маса без глас')
    store.closeRoom('h3')
  })

  await check('[C4] Протокол: voice_presence се парсва строго; create_private_room носи voiceEnabled', () => {
    const tableId = randomUUID()
    const valid = parseClientMessage(JSON.stringify({ type: 'voice_presence', voiceTableId: tableId, clientInstanceId: 'abcdefghijklmnop1234', onTableScreen: true }))
    assert(valid !== null && valid.type === 'voice_presence', 'валидно')
    for (const bad of [
      { type: 'voice_presence', voiceTableId: 'x', clientInstanceId: 'abcdefghijklmnop1234', onTableScreen: true },
      { type: 'voice_presence', voiceTableId: tableId, clientInstanceId: 'short', onTableScreen: true },
      { type: 'voice_presence', voiceTableId: tableId, clientInstanceId: 'abcdefghijklmnop1234', onTableScreen: 'yes' },
      { type: 'voice_presence', voiceTableId: tableId, clientInstanceId: 'abcdefghijklmnop1234<script>', onTableScreen: true },
    ]) {
      assertEqual(parseClientMessage(JSON.stringify(bad)), null, JSON.stringify(bad))
    }
    const create = parseClientMessage(JSON.stringify({ type: 'create_private_room', stake: 100, isLocked: false, waitMinutes: 15, voiceEnabled: true }))
    assert(create !== null && create.type === 'create_private_room' && create.voiceEnabled === true, 'voiceEnabled')
    const legacy = parseClientMessage(JSON.stringify({ type: 'create_private_room', stake: 100, isLocked: false, waitMinutes: 15 }))
    assert(legacy !== null && legacy.type === 'create_private_room' && legacy.voiceEnabled === false, 'legacy -> false')
  })

  // ═══ [M] Единният mute забранява говоренето ════════════════════════════
  const MUTED_UNTIL = '2027-05-01T12:00:00.000Z'
  const speakOf = (body: Record<string, unknown>): Record<string, unknown> => (body.speak ?? {}) as Record<string, unknown>
  const lastSpeakUpdate = (h: Harness, conn: string): Record<string, unknown> | null => {
    const message = messagesOf(h, conn, 'voice_speak_access_updated').at(-1)
    return message !== undefined && message.type === 'voice_speak_access_updated' ? (message.speak as unknown as Record<string, unknown>) : null
  }

  await check('[M1] VIP без наказание говори; VIP с mute и non-VIP с mute само слушат (canPublish:false, причина muted, срок само към него); VIP с mute създава гласова маса', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const vipFree = h.seedProfile('VipFree')
    const vipMuted = h.seedProfile('VipMuted')
    const plainMuted = h.seedProfile('PlainMuted')
    h.muted.set(vipMuted, MUTED_UNTIL)
    const table = h.createTable(vipMuted, 'c1')
    assert(h.store.getVoiceTable(table)?.status === 'active', 'VIP с mute създава гласова маса')
    h.vip.add(vipFree)
    h.seat(table, vipFree, 'c2')
    h.muted.set(plainMuted, null)
    h.seat(table, plainMuted, 'c3')
    const free = await h.token(vipFree, table, (h.presence('c2', vipFree, table, 'inst_free_000000000001'), 'inst_free_000000000001'))
    assert(free.body.canSpeak === true && speakOf(free.body).blockedReason === null, 'VIP без наказание')
    const ackMuted = h.presence('c1', vipMuted, table, 'inst_vmut_000000000001')
    assert(ackMuted?.type === 'voice_presence_result' && ackMuted.ok && ackMuted.speak.blockedReason === 'muted' && ackMuted.speak.mutedUntil === MUTED_UNTIL, 'presence: причина и срок')
    const vm = await h.token(vipMuted, table, 'inst_vmut_000000000001')
    assertEqual(vm.status, 200, 'слуша')
    const video = decodeJwt(String(vm.body.token)).video as Record<string, unknown>
    assert(video.canPublish === false && JSON.stringify(video.canPublishSources ?? []) === '[]' && video.canSubscribe === true, 'LiveKit: без publish')
    assert(speakOf(vm.body).blockedReason === 'muted' && speakOf(vm.body).mutedUntil === MUTED_UNTIL && speakOf(vm.body).hasSpeakingEntitlement === true, 'причина, срок, пазено право')
    h.presence('c3', plainMuted, table, 'inst_pmut_000000000001')
    const pm = await h.token(plainMuted, table, 'inst_pmut_000000000001')
    assert(pm.status === 200 && pm.body.canSpeak === false && speakOf(pm.body).blockedReason === 'muted', 'non-VIP с mute слуша')
    const speakMuted = await h.speak(vipMuted, table, 'inst_vmut_000000000001')
    assert(speakMuted.body.canSpeak === false && speakMuted.body.code === 'muted', 'speak-access отказва при mute')
    assert(!h.sent.some((entry) => entry.connectionId !== 'c1' && JSON.stringify(entry.message).includes(MUTED_UNTIL)), 'срокът не стига до други участници')
  })

  await check('[M2] Mute преди влизане и в чакалнята: правото от сядането (VIP) се пази; изтекъл VIP по време на mute; след края -> говори; без автоматичен микрофон', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const host = h.seedProfile('Host')
    const player = h.seedProfile('Player')
    const table = h.createTable(host, 'c1')
    h.vip.add(player)
    h.muted.set(player, MUTED_UNTIL)
    h.seat(table, player, 'c2')
    assertEqual(h.store.getActiveMembership(table, player)?.speakingEntitledAt !== null, true, 'правото е придобито при сядането въпреки mute')
    const inst = 'inst_pre_0000000000001'
    h.presence('c2', player, table, inst)
    assertEqual((await h.token(player, table, inst)).body.canSpeak, false, 'mute преди влизане -> слуша')
    h.vip.delete(player)
    h.muted.delete(player)
    h.service.onChatMuteChanged(player)
    const update = lastSpeakUpdate(h, 'c2')
    assert(update !== null && update.canSpeak === true && update.blockedReason === null, 'известие за край на наказанието')
    assert(!fake.calls.some((c) => c.method === 'UpdateParticipant'), 'без автоматично повишаване (микрофонът не се включва)')
    assertEqual((await h.token(player, table, inst)).body.canSpeak, true, 'изтекъл VIP по време на mute -> говори с придобитото право')
    // mute по време на чакалнята, без издаден publish токен: само известие, без ротация
    const listener = h.seedProfile('Listener')
    h.seat(table, listener, 'c3')
    h.presence('c3', listener, table, 'inst_lst_0000000000001')
    await h.token(listener, table, 'inst_lst_0000000000001')
    const generationBefore = h.store.getLiveGeneration(table)?.generation
    h.muted.set(listener, MUTED_UNTIL)
    h.service.onChatMuteChanged(listener)
    assertEqual(h.store.getLiveGeneration(table)?.generation, generationBefore, 'listen-only токен -> без ротация')
    assertEqual(lastSpeakUpdate(h, 'c3')?.blockedReason, 'muted', 'известие')
  })

  await check('[M3] Mute по време на активен разговор: отнема само publish (слушането и мястото остават), ротация, стар publish токен безполезен, новият токен е само за слушане', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const host = h.seedProfile('Host')
    const speaker = h.seedProfile('Speaker')
    const table = h.createTable(host, 'c1')
    h.vip.add(speaker)
    h.seat(table, speaker, 'c2')
    await joinWithToken(h, table, host, 'c1', 'inst_host_00000000001', fake)
    const joined = await joinWithToken(h, table, speaker, 'c2', 'inst_spk_000000000001', fake)
    fake.calls.length = 0
    h.muted.set(speaker, MUTED_UNTIL)
    h.service.onChatMuteChanged(speaker)
    await sleep(100)
    const revoke = fake.calls.find((c) => c.method === 'UpdateParticipant' && c.body.identity === joined.identity)
    assert(revoke !== undefined, 'UpdateParticipant за наказания')
    const permission = revoke!.body.permission as Record<string, unknown>
    assert(permission.canSubscribe === true && permission.canPublish !== true, 'без publish, слушането остава')
    assert(!fake.calls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === joined.identity), 'не е изхвърлен веднага')
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация (стар publish токен)')
    assertEqual(h.store.getGeneration(joined.roomName)?.retireReason, 'speak_revoked', 'причина')
    assertEqual(lastSpeakUpdate(h, 'c2')?.blockedReason, 'muted', 'известие към наказания')
    assert(h.service.debug.getMembership(table, speaker) !== null && h.service.debug.getBinding(table, speaker) !== null, 'мястото и сесията се пазят')
    await h.reconcile()
    assert(!fake.rooms.has(joined.roomName) && !h.store.isLiveRoomName(joined.roomName), 'старата стая е изтрита; старият publish токен не може да влезе')
    const relisten = await h.token(speaker, table, 'inst_spk_000000000001')
    const video = decodeJwt(String(relisten.body.token)).video as Record<string, unknown>
    assert(relisten.status === 200 && video.canPublish === false && video.canSubscribe === true, 'нов токен само за слушане')
    assertEqual(h.store.getActiveMembership(table, speaker)?.speakingEntitledAt !== null, true, 'придобитото право е запазено')
    assertEqual(h.service.stats().counters.muteRevocations, 1, 'брояч')
  })

  await check('[M4] Mute при временно прекъсната връзка: ротация, известие при reconnect; refresh при mute -> само слушане', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const host = h.seedProfile('Host')
    const table = h.createTable(host, 'c1')
    const inst = 'inst_net_0000000000001'
    await joinWithToken(h, table, host, 'c1', inst, fake)
    h.open.delete('c1')
    h.service.onGameConnectionClosed('c1')
    h.muted.set(host, MUTED_UNTIL)
    h.service.onChatMuteChanged(host)
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация и при прекъсната връзка')
    h.seats.set(`${table}|${host}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'c1b' })
    h.open.add('c1b')
    const ack = h.presence('c1b', host, table, inst)
    assert(ack?.type === 'voice_presence_result' && ack.ok && ack.speak.blockedReason === 'muted', 'reconnect: presence показва mute')
    await h.reconcile()
    assertEqual((await h.token(host, table, inst)).body.canSpeak, false, 'reconnect: само слушане')
    h.open.delete('c1b')
    h.service.onGameConnectionClosed('c1b')
    h.seats.set(`${table}|${host}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'c1c' })
    h.open.add('c1c')
    h.presence('c1c', host, table, 'inst_refresh_000000001')
    await h.reconcile()
    const refreshed = await h.token(host, table, 'inst_refresh_000000001')
    assert(refreshed.status === 200 && refreshed.body.canSpeak === false, 'refresh: само слушане')
  })

  await check('[M5] Mute по време на издаване на токен: токенът се изхвърля (и ротация, защото е маркиран publish); недостъпна mute проверка -> fail-closed за говоренето', async () => {
    fake.reset()
    let releaseSign: () => void = () => {}
    const gate = new Promise<void>((resolvePromise) => { releaseSign = resolvePromise })
    let gated = false
    const real = createVoiceTokenSigner({ apiKey: API_KEY, apiSecret: API_SECRET })
    const h = await createHarness({ fake, signToken: async (input) => { if (gated) await gate; return real(input) } })
    const host = h.seedProfile('Host')
    const table = h.createTable(host, 'c1')
    const inst = 'inst_race_000000000001'
    h.presence('c1', host, table, inst)
    gated = true
    const pending = h.token(host, table, inst)
    await sleep(80)
    h.muted.set(host, MUTED_UNTIL)
    h.service.onChatMuteChanged(host)
    releaseSign()
    const result = await pending
    assert(result.body.token === undefined && result.status >= 400, JSON.stringify(result.body))
    assertEqual(h.store.getLiveGeneration(table)?.generation, 2, 'ротация (publish беше маркиран)')
    gated = false
    h.muted.delete(host)
    h.failMuteLookup.value = true
    await h.reconcile()
    const failClosed = await h.token(host, table, inst)
    assert(failClosed.status === 200 && failClosed.body.canSpeak === false, 'fail-closed: слуша, не говори')
    h.failMuteLookup.value = false
  })

  await check('[M6] Край на mute (изтичане или ръчно премахване): известие, без автоматичен микрофон; изричен speak-access -> UpdateParticipant; без право -> остава слушател; придобит VIP междувременно -> говори', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const host = h.seedProfile('Host')
    const plain = h.seedProfile('Plain')
    const table = h.createTable(host, 'c1')
    h.muted.set(host, MUTED_UNTIL)
    const hostJoin = await joinWithToken(h, table, host, 'c1', 'inst_hst_000000000001', fake)
    h.seat(table, plain, 'c2')
    h.muted.set(plain, MUTED_UNTIL)
    await joinWithToken(h, table, plain, 'c2', 'inst_pln_000000000001', fake)
    fake.calls.length = 0
    h.muted.delete(host)
    h.service.onChatMuteChanged(host)
    assertEqual(lastSpeakUpdate(h, 'c1')?.canSpeak, true, 'известие: може да говори')
    await sleep(50)
    assert(!fake.calls.some((c) => c.method === 'UpdateParticipant'), 'без автоматично повишаване')
    const upgraded = await h.speak(host, table, 'inst_hst_000000000001')
    assertEqual(upgraded.body.upgrade, 'updated', 'изрично включване -> UpdateParticipant')
    const grant = fake.calls.find((c) => c.method === 'UpdateParticipant' && c.body.identity === hostJoin.identity)!
    assertEqual(JSON.stringify((grant.body.permission as Record<string, unknown>).canPublishSources), '["MICROPHONE"]', 'само микрофон')
    h.muted.delete(plain)
    h.service.onChatMuteChanged(plain)
    const plainUpdate = lastSpeakUpdate(h, 'c2')
    assert(plainUpdate?.canSpeak === false && plainUpdate.blockedReason === 'vip_required', 'без право -> остава слушател')
    h.vip.add(plain)
    assertEqual((await h.speak(plain, table, 'inst_pln_000000000001')).body.canSpeak, true, 'придобит VIP междувременно')
  })

  await check('[M7] Рестарт при активен mute: само слушане; след края — правото от участието важи; банът е с най-висок приоритет', async () => {
    fake.reset()
    const h1 = await createHarness({ fake })
    const host = h1.seedProfile('Host')
    const table = h1.createTable(host, 'c1')
    h1.service.onGameStarted(table, 'server-m7')
    h1.service.dispose()
    const h2 = await createHarness({
      fake,
      existing: { path: h1.path, store: h1.store, seedProfile: h1.seedProfile },
      boot: [{ serverRoomId: 'server-m7', voiceTableId: table, activeProfileIds: [host] }],
    })
    h2.muted.set(host, MUTED_UNTIL)
    h2.seats.set(`${table}|${host}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'n1' })
    h2.open.add('n1')
    const inst = 'inst_boot_000000000001'
    h2.presence('n1', host, table, inst)
    await h2.reconcile()
    assertEqual((await h2.token(host, table, inst)).body.canSpeak, false, 'след рестарт при mute')
    h2.muted.delete(host)
    assertEqual((await h2.token(host, table, inst)).body.canSpeak, true, 'правото от участието (VIP изтекъл) важи')
    h2.muted.set(host, MUTED_UNTIL)
    h2.banned.add(host)
    const banned = await h2.token(host, table, inst)
    assert(banned.status === 403 && banned.body.code === 'banned', 'банът печели над mute')
  })

  // ═══ [A] Lease срещу 120 s ═══════════════════════════════════════════════
  await check('[A1] Временно отпадане на игровия WS: 60 s lease НЕ съкращава 120 s; при жив WS и напуснат екран lease-ът остава защитата', async () => {
    fake.reset()
    const h = await createHarness({ fake })
    const host = h.seedProfile('Host')
    const table = h.createTable(host, 'c1')
    const inst = 'inst_lease_00000000001'
    await joinWithToken(h, table, host, 'c1', inst, fake)
    h.clock.advance(50_000) // последното подновяване е преди 50 s -> lease изтича след 10 s
    h.open.delete('c1')
    h.service.onGameConnectionClosed('c1')
    h.clock.advance(100_000) // 100 s без игрова връзка: > lease, < 120 s
    assertEqual(h.service.debug.getBinding(table, host)?.voiceActive, true, 'lease не прекъсва по време на 120 s прозореца')
    h.seats.set(`${table}|${host}`, { relation: 'player', permanentlyLeft: false, seatConnectionId: 'c2' })
    h.open.add('c2')
    h.presence('c2', host, table, inst)
    assertEqual(h.service.debug.getBinding(table, host)?.voiceActive, true, 'възстановено')
    assertEqual((await h.token(host, table, inst)).status, 200, 'нов токен след възстановяване')
    h.clock.advance(61_000) // жив WS, клиентът не подновява (напуснат екран без съобщение)
    assertEqual(h.service.debug.getBinding(table, host)?.voiceActive, false, 'lease-ът прекратява при жив WS')
  })

  // ═══ [B] Изолация production / локална среда ═════════════════════════════
  await check('[B1] Namespace: имената са pv_<namespace>_...; sweep трие само собствени стаи; чужда среда (prod) никога не се пипа', async () => {
    fake.reset()
    const dbDev = await freshDatabase()
    const devStore = await createVoiceChatStore(dbDev.path, { roomNamespace: 'dev' })
    storesToClose.push(devStore)
    assert(devStore.setMode('public', { profileId: null }).ok, 'mode')
    const reserved = devStore.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (!reserved.ok) throw new Error('reserve')
    const gen = devStore.allocateGeneration(reserved.table.voiceTableId, null)
    assert(gen.ok && gen.roomName.startsWith('pv_dev_'), 'името носи namespace-а')
    const api = createVoiceLiveKitApi({ apiUrl: fake.url, apiKey: API_KEY, apiSecret: API_SECRET }, { requestTimeoutSeconds: 1 })
    const dispatcher = createVoiceLiveKitDispatcher()
    const { createVoiceRoomReconciler } = await import('../src/voice/voiceRoomReconciler.js')
    const reconciler = createVoiceRoomReconciler({ store: devStore, api, dispatcher, roomNamespace: 'dev', scheduler: { setTimeout: () => 0, clearTimeout: () => {} } })
    const prodRoom = 'pv_prod_11111111111111111111111111111111_g1_bbbbbbbbbbbbbbbbbbbbbbbbbb'
    const devOrphan = 'pv_dev_22222222222222222222222222222222_g1_cccccccccccccccccccccccccc'
    for (const name of [prodRoom, devOrphan, 'manual-test-1']) fake.rooms.set(name, { maxParticipants: 4, participants: new Map() })
    if (gen.ok) fake.rooms.set(gen.roomName, { maxParticipants: 4, participants: new Map() })
    reconciler.requestBootSweep()
    await reconciler.runNow()
    assert(fake.rooms.has(prodRoom), 'production стая — непокътната')
    assert(fake.rooms.has('manual-test-1'), 'ръчна тестова стая — непокътната')
    assert(!fake.rooms.has(devOrphan), 'собствен сирак — изтрит')
    assert(gen.ok && fake.rooms.has(gen.roomName), 'собствената жива стая остава')
    assert(!fake.calls.some((c) => c.method === 'DeleteRoom' && c.body.room === prodRoom), 'нито един DeleteRoom към чужд namespace')
    reconciler.dispose()
    dispatcher.dispose()
  })

  // ═══ [W] Свързване в index.ts (статично) ════════════════════════════════
  await check('[W1] index.ts: всички lifecycle куки, HTTPS API, presence, boot и dispose; токенът никога през WS', async () => {
    const source = await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')
    const required = [
      'voiceChatService.reserveVoiceTableForPrivateRoom(',
      'voiceChatService.abortReservation(voiceTableId)',
      'voiceChatService.attachPrivateRoom(voiceTableId, createResult.room.id, latestConnection.profileId)',
      "voiceChatService.onWaitingRoomEnded(room.voiceTableId, 'waiting_room_expired')",
      "voiceChatService.onWaitingRoomEnded(room.voiceTableId, 'waiting_room_closed')",
      "voiceChatService.onWaitingRoomEnded(room.voiceTableId, 'waiting_room_empty')",
      "voiceChatService.onMemberRemoved(room.voiceTableId, occupant.profileId, 'left_waiting_room')",
      "voiceChatService.onMemberRemoved(room.voiceTableId, occupant.profileId, 'kicked')",
      'voiceChatService.onMemberSeated(room.voiceTableId, occupant.profileId)',
      'voiceTableId: privateRoom.voiceTableId,',
      'voiceChatService.onGameStarted(privateRoom.voiceTableId, initializedRoom.id)',
      'voiceChatService.onGameStartFailed(privateRoom.voiceTableId)',
      'voiceChatService.onServerRoomRemoved(removedVoiceTableId)',
      "voiceChatService.onMemberRemoved(leftVoiceTableId, leftProfileId, 'permanently_left')",
      'voiceChatService.onGameConnectionDisplaced(conn.id)',
      "voiceChatService.onProfileRevoked(profileId, 'banned')",
      "voiceChatService.onProfileRevoked(profileId, 'profile_revoked')",
      'voiceChatService.onGameConnectionClosed(connection.id)',
      'voiceChatService.handlePresence(',
      'if (await handleVoiceChatApiRequest(req, res, requestUrl)) {',
      'onModeChanged: (result) => voiceChatService.onModeChanged(result)',
      'voiceChatService.boot(',
      "closeStore('voiceChatService', () => voiceChatService.dispose())",
      'voiceChatService.onChatMuteChanged(profileId)',
      'getChatMuteStatus: (profileId) => {',
      'roomNamespace: voiceLiveKitConfig.roomNamespace,',
    ]
    for (const fragment of required) assert(source.includes(fragment), `липсва: ${fragment}`)
    assertEqual((source.match(/voiceChatService\.onGameStartFailed\(/g) ?? []).length, 2, 'и двата неуспешни старта')
    // "Преиграй" нарочно няма гласова кука (правото не се проверява наново).
    const replayStart = source.indexOf('function applyReplayRestart(')
    const replayBlock = source.slice(replayStart, source.indexOf('if (allVoted)', replayStart))
    assert(replayStart > 0 && !replayBlock.includes('voiceChatService'), 'replay без гласова проверка')
    // Токенът никога не минава през WS: в index.ts няма издаване на токен извън HTTPS handler-а.
    assert(!source.includes('handleTokenRequest') && !source.includes('signToken('), 'без токен в index.ts/WS')
    assert(!/await\s+voiceChatService\./.test(source), 'нито една гласова операция не се await-ва в index.ts')
  })
} finally {
  for (const harness of harnesses) {
    try { harness.dispose() } catch { /* вече */ }
  }
  for (const store of storesToClose) {
    try { store.close() } catch { /* вече затворен */ }
  }
  await fake.close()
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
