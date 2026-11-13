#!/usr/bin/env node
// Pika.bg — реални интеграционни тестове срещу LiveKit (v1.13.11).
//
// Самостоятелен инструмент (НЕ е част от приложението). Ползва официалните
// SDK-та: livekit-server-sdk (RoomService API + AccessToken) и
// @livekit/rtc-node (истински WebRTC участници със СИНТЕТИЧЕН звук/видео —
// без микрофон, камера или браузър).
//
// Безопасност:
//   * креденшълите се четат САМО от env (LIVEKIT_API_KEY / LIVEKIT_API_SECRET)
//     и никога не се печатат; JWT никога не се печатат и не се записват;
//   * всички стаи са с име itest-<runId>-<nn> — извън production namespace
//     (pv_<namespace>_...) и извън всички стаи на Pika; инструментът отказва
//     да пипне стая без собствения си префикс;
//   * почиства САМО собствените си стаи (и при грешка/Ctrl+C);
//   * без игрови профили и без база — identity-тата са синтетични.
//
// Тестовете (номерата съвпадат с плана в docs/voice-chat/HANDOFF.md, раздел 13):
//    1 Authenticated RoomService API            9 Реално спиране на звука при mute
//    2 auto_create:false                       10 RemoveParticipant + стар токен
//    3 Non-VIP не публикува аудио              11 Стар JWT след DeleteRoom
//    4 VIP публикува микрофон                  12 Refresh token след DeleteRoom (дълъг)
//    5 VIP без видео / екран / data            13 Ротация и изолация на генерациите
//    6 Максимум 4 участници                    14 DUPLICATE_IDENTITY
//    7 UpdateParticipant: слушател -> говорещ  15 DeleteRoom на несъществуваща стая
//    8 UpdateParticipant: отнемане от говорещ  16 revokeTokenTs
//
// Употреба:
//   node run.mjs [--only=1,2,3] [--skip-long] [--long-wait-sec=420] [--report-dir=results]
//   node run.mjs --self-check      (без мрежа: проверява инструмента)
//   node run.mjs --leftovers       (само показва останали itest-* стаи от прекъснати пускания)
//   node run.mjs --purge-leftovers (трие САМО стаи с префикс itest-, никога pv_ или други)
//
// Env:
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET  — задължителни (от /opt/livekit/secrets.env)
//   IT_WS_URL   — по подразбиране wss://voice.pika.bg (реалният път през Caddy)
//   IT_API_URL  — по подразбиране http://127.0.0.1:7880 (локалното API на VPS-а)

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { AccessToken, RoomServiceClient, TokenVerifier, TrackSource as ProtoTrackSource } from 'livekit-server-sdk'
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  dispose,
} from '@livekit/rtc-node'

// ─── Аргументи и конфигурация ────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`))
  return found === undefined ? fallback : found.slice(name.length + 3)
}
const ONLY = option('only', '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)
const SKIP_LONG = flag('skip-long')
const LONG_WAIT_SEC = Math.max(60, Number(option('long-wait-sec', '420')) || 420)
const REPORT_DIR = option('report-dir', 'results')
const SELF_CHECK = flag('self-check')
const LEFTOVERS = flag('leftovers') || flag('purge-leftovers')
const PURGE_LEFTOVERS = flag('purge-leftovers')

const API_KEY = process.env.LIVEKIT_API_KEY?.trim() ?? ''
const API_SECRET = process.env.LIVEKIT_API_SECRET?.trim() ?? ''
const WS_URL = process.env.IT_WS_URL?.trim() || 'wss://voice.pika.bg'
const API_URL = process.env.IT_API_URL?.trim() || 'http://127.0.0.1:7880'

const RUN_ID = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}${randomBytes(3).toString('hex')}`
const ROOM_PREFIX = `itest-${RUN_ID}-`

// Точно същите права като Pika (server/src/voice/voiceTokenIssuer.ts
// buildVoiceVideoGrant и voiceLiveKitApi.ts updateParticipantPermission).
const ROOM_OPTIONS = { maxParticipants: 4, emptyTimeout: 120, departureTimeout: 120 }
function pikaGrant(room, speak) {
  return {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: speak,
    canPublishSources: speak ? [ProtoTrackSource.MICROPHONE] : [],
    canPublishData: false,
    canUpdateOwnMetadata: false,
    hidden: false,
    recorder: false,
  }
}
function pikaPermission({ canSubscribe, canPublish }) {
  return {
    canSubscribe,
    canPublish,
    canPublishData: false,
    canPublishSources: canPublish ? [ProtoTrackSource.MICROPHONE] : [],
    canUpdateMetadata: false,
    hidden: false,
  }
}
const SPEAK = { canSubscribe: true, canPublish: true }
const LISTEN = { canSubscribe: true, canPublish: false }

// ─── Помощни ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
/** Никога не извежда JWT/тайни в съобщения за грешки. */
function clean(value) {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  text = text.replace(JWT_PATTERN, '<jwt>')
  if (API_SECRET.length > 0) text = text.split(API_SECRET).join('<secret>')
  if (API_KEY.length > 0) text = text.split(API_KEY).join('<key>')
  return text.slice(0, 240)
}
function withTimeout(promise, ms, label) {
  let handle
  return Promise.race([
    promise.finally(() => clearTimeout(handle)),
    new Promise((_, reject) => {
      handle = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms)
    }),
  ])
}
async function waitUntil(predicate, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  throw new Error(`timeout ${ms}ms: ${label}`)
}
function decodeClaims(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}
const reasonName = (reason) => (reason === undefined || reason === null ? 'none' : (DisconnectReason[reason] ?? String(reason)))

// ─── Собствени стаи ───────────────────────────────────────────────────────

const ownRooms = new Set()
let roomSeq = 0
function newRoomName(label) {
  roomSeq += 1
  return `${ROOM_PREFIX}${String(roomSeq).padStart(2, '0')}-${label}`
}
function assertOwn(name) {
  if (typeof name !== 'string' || !name.startsWith(ROOM_PREFIX) || name.startsWith('pv_')) {
    throw new Error('safety: refusing to touch a room outside this run')
  }
}

let svc = null
function service() {
  svc ??= new RoomServiceClient(API_URL, API_KEY, API_SECRET, { requestTimeout: 10, failover: false })
  return svc
}
async function createRoom(name, maxParticipants = ROOM_OPTIONS.maxParticipants) {
  assertOwn(name)
  ownRooms.add(name)
  await service().createRoom({ name, maxParticipants, emptyTimeout: ROOM_OPTIONS.emptyTimeout, departureTimeout: ROOM_OPTIONS.departureTimeout })
}
async function deleteRoom(name) {
  assertOwn(name)
  try {
    await service().deleteRoom(name)
    return 'deleted'
  } catch (error) {
    if (error?.status === 404 || error?.code === 'not_found') return 'not_found'
    throw error
  }
}
async function roomExists(name) {
  assertOwn(name)
  const rooms = await service().listRooms([name])
  return rooms.some((room) => room.name === name)
}
async function updatePermission(room, identity, permission) {
  assertOwn(room)
  await service().updateParticipant(room, identity, { permission: pikaPermission(permission) })
}
async function removeParticipant(room, identity, options) {
  assertOwn(room)
  await service().removeParticipant(room, identity, options)
}

async function token(room, identity, { speak = false, ttl = 600, grant } = {}) {
  const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl })
  at.addGrant(grant ?? pikaGrant(room, speak))
  return at.toJwt()
}

// ─── WebRTC участници ─────────────────────────────────────────────────────

const liveClients = new Set()
async function join(identity, jwt, label = identity) {
  const room = new Room()
  const client = { identity, label, room, events: [], disconnectReason: null }
  room.on(RoomEvent.Disconnected, (reason) => {
    client.disconnectReason = reason
    client.events.push({ type: 'disconnected', reason: reasonName(reason), at: Date.now() })
  })
  room.on(RoomEvent.Reconnecting, () => client.events.push({ type: 'reconnecting', at: Date.now() }))
  room.on(RoomEvent.Reconnected, () => client.events.push({ type: 'reconnected', at: Date.now() }))
  room.on(RoomEvent.TokenRefreshed, () => client.events.push({ type: 'tokenRefreshed', at: Date.now() }))
  room.on(RoomEvent.DataReceived, (_payload, participant) => client.events.push({ type: 'data', from: participant?.identity ?? null, at: Date.now() }))
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) =>
    client.events.push({ type: 'subscribed', from: participant.identity, kind: track.kind, source: publication.source, at: Date.now() }))
  room.on(RoomEvent.TrackUnpublished, (publication, participant) =>
    client.events.push({ type: 'unpublished', from: participant.identity, source: publication.source, at: Date.now() }))
  await withTimeout(room.connect(WS_URL, jwt, { autoSubscribe: true, dynacast: false }), 20_000, `connect ${label}`)
  liveClients.add(client)
  return client
}
/**
 * Класифицира отказ за влизане. PASS за "стаята не съществува" се дава САМО
 * при потвърден отговор на сървъра (404 / not found), никога при мрежова или
 * TLS грешка (напр. липсващ CA bundle в контейнера).
 */
function classifyJoinError(message) {
  if (/certificate|tls|ssl|root ca|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|timeout|dns|socket hang up|network|unreachable/i.test(message)) return 'network'
  if (/404|not[ _-]?found|does not exist/i.test(message)) return 'not_found'
  return 'other'
}
async function tryJoin(identity, jwt, label) {
  try {
    return { ok: true, client: await join(identity, jwt, label) }
  } catch (error) {
    const message = clean(error)
    return { ok: false, error: message, kind: classifyJoinError(message) }
  }
}
/** Потвърден отказ "стаята не съществува" (не мрежова грешка). */
const rejectedAsNotFound = (outcome) => !outcome.ok && outcome.kind === 'not_found'
async function leave(client) {
  if (client === null || client === undefined) return
  liveClients.delete(client)
  try {
    await withTimeout(client.room.disconnect(), 10_000, `disconnect ${client.label}`)
  } catch {
    // вече изключен
  }
}
const isConnected = (client) => client.room.isConnected

function remoteTrack(client, fromIdentity, kind = TrackKind.KIND_AUDIO) {
  const participant = [...client.room.remoteParticipants.values()].find((p) => p.identity === fromIdentity)
  if (participant === undefined) return null
  for (const publication of participant.trackPublications.values()) {
    if (publication.kind === kind && publication.track) return publication.track
  }
  return null
}

/** Синтетичен тон (без микрофон): 48 kHz моно, 10 ms кадри в реално време. */
async function startTone(client, { frequency = 440, source = TrackSource.SOURCE_MICROPHONE, name = 'itest-tone' } = {}) {
  const audioSource = new AudioSource(48_000, 1)
  const track = LocalAudioTrack.createAudioTrack(name, audioSource)
  const publication = await withTimeout(
    client.room.localParticipant.publishTrack(track, new TrackPublishOptions({ source })),
    10_000,
    `publish audio ${client.label}`,
  )
  let running = true
  let phase = 0
  const samples = 480
  const step = (2 * Math.PI * frequency) / 48_000
  const loop = (async () => {
    let next = Date.now()
    while (running) {
      const data = new Int16Array(samples)
      for (let index = 0; index < samples; index += 1) {
        data[index] = Math.round(Math.sin(phase) * 0.3 * 32767)
        phase += step
      }
      try {
        await audioSource.captureFrame(new AudioFrame(data, 48_000, 1, samples))
      } catch {
        break
      }
      next += 10
      const delay = next - Date.now()
      if (delay > 0) await sleep(delay)
    }
  })()
  return {
    publication,
    stop: async () => {
      running = false
      await loop
      await audioSource.close().catch(() => {})
    },
  }
}

/** Опит за публикуване, който ТРЯБВА да бъде отказан (timeout също се брои за отказ). */
async function attempt(fn) {
  try {
    await fn()
    return { published: true, error: null }
  } catch (error) {
    return { published: false, error: clean(error) }
  }
}

/** RMS на получения звук от fromIdentity за ms (0 кадъра = нищо не е получено). */
async function measureAudio(receiver, fromIdentity, ms, { waitTrackMs = 8_000 } = {}) {
  try {
    await waitUntil(() => remoteTrack(receiver, fromIdentity) !== null, waitTrackMs, 'remote audio track')
  } catch {
    return { frames: 0, rms: 0, track: false }
  }
  const stream = new AudioStream(remoteTrack(receiver, fromIdentity), 48_000, 1)
  const reader = stream.getReader()
  let frames = 0
  let sumSquares = 0
  let count = 0
  const end = Date.now() + ms
  try {
    while (Date.now() < end) {
      const result = await Promise.race([reader.read(), sleep(Math.max(1, end - Date.now())).then(() => null)])
      if (result === null || result.done) break
      frames += 1
      const data = result.value.data
      for (let index = 0; index < data.length; index += 1) {
        sumSquares += data[index] * data[index]
        count += 1
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { frames, rms: count === 0 ? 0 : Math.round(Math.sqrt(sumSquares / count)), track: true }
}
const AUDIBLE_RMS = 1_000
const SILENT_RMS = 200

/** Синтетичен видео кадър (RGBA). */
async function publishVideo(client, source) {
  const videoSource = new VideoSource(320, 240)
  const track = LocalVideoTrack.createVideoTrack('itest-video', videoSource)
  const frame = new VideoFrame(new Uint8Array(320 * 240 * 4).fill(128), 320, 240, VideoBufferType.RGBA)
  const timer = setInterval(() => {
    try {
      videoSource.captureFrame(frame)
    } catch {
      // източникът е затворен
    }
  }, 100)
  try {
    await withTimeout(client.room.localParticipant.publishTrack(track, new TrackPublishOptions({ source })), 10_000, 'publish video')
  } finally {
    setTimeout(() => {
      clearInterval(timer)
      void videoSource.close().catch(() => {})
    }, 3_000)
  }
}

// ─── Резултати ────────────────────────────────────────────────────────────

const results = []
function record(id, title, status, details) {
  results.push({ id, title, status, details })
  const mark = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO', SKIP: 'SKIP' }[status] ?? status
  console.log(`  [${String(id).padStart(2, ' ')}] ${mark.padEnd(4)} ${title}`)
  for (const [key, value] of Object.entries(details ?? {})) console.log(`         ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

// ─── Тестове ──────────────────────────────────────────────────────────────

const tests = []
const test = (id, title, fn, { long = false } = {}) => tests.push({ id, title, fn, long })

test(1, 'Authenticated RoomService API (валиден подпис -> OK; грешен/липсващ -> отказ)', async () => {
  const listed = await service().listRooms(['itest-none'])
  const wrong = new RoomServiceClient(API_URL, API_KEY, `${API_SECRET}x`, { requestTimeout: 10, failover: false })
  let wrongStatus = null
  try {
    await wrong.listRooms(['itest-none'])
  } catch (error) {
    wrongStatus = error?.status ?? clean(error)
  }
  let anonStatus = null
  try {
    const response = await fetch(`${API_URL}/twirp/livekit.RoomService/ListRooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    anonStatus = response.status
  } catch (error) {
    anonStatus = clean(error)
  }
  const ok = Array.isArray(listed) && wrongStatus === 401 && anonStatus === 401
  return [ok ? 'PASS' : 'FAIL', { validSignature: 'ok', wrongSecretStatus: wrongStatus, noAuthStatus: anonStatus }]
})

test(2, 'auto_create:false — токен за несъществуваща стая не я създава', async () => {
  const ghost = newRoomName('ghost')
  ownRooms.add(ghost)
  const outcome = await tryJoin('itest-ghost', await token(ghost, 'itest-ghost', { speak: true }), 'ghost')
  if (outcome.ok) await leave(outcome.client)
  const exists = await roomExists(ghost)
  const confirmed = rejectedAsNotFound(outcome)
  return [confirmed && !exists ? 'PASS' : 'FAIL', {
    joinRejected: !outcome.ok,
    rejectionKind: outcome.ok ? null : outcome.kind,
    error: outcome.ok ? null : outcome.error,
    roomCreated: exists,
    ...(outcome.ok || confirmed ? {} : { verdict: 'неубедително: отказът не е потвърден "room not found" от сървъра (мрежа/TLS?)' }),
  }]
})

test(3, 'Non-VIP (canPublish:false) не може да публикува аудио', async () => {
  const room = newRoomName('nonvip')
  await createRoom(room)
  const receiver = await join('itest-recv', await token(room, 'itest-recv', { speak: true }))
  const listener = await join('itest-listener', await token(room, 'itest-listener', { speak: false }))
  const tried = await attempt(() => startTone(listener))
  const heard = await measureAudio(receiver, 'itest-listener', 3_000, { waitTrackMs: 4_000 })
  await leave(listener)
  await leave(receiver)
  return [!heard.track && heard.frames === 0 ? 'PASS' : 'FAIL', { publishCallSucceeded: tried.published, publishError: tried.error, receiverGotTrack: heard.track, rms: heard.rms }]
})

test(4, 'VIP (само микрофон) публикува синтетичен звук и другите го чуват', async () => {
  const room = newRoomName('vip')
  await createRoom(room)
  const listener = await join('itest-listener', await token(room, 'itest-listener', { speak: false }))
  const speaker = await join('itest-speaker', await token(room, 'itest-speaker', { speak: true }))
  const tone = await startTone(speaker)
  const heard = await measureAudio(listener, 'itest-speaker', 3_000)
  await tone.stop()
  await leave(speaker)
  await leave(listener)
  return [heard.rms >= AUDIBLE_RMS ? 'PASS' : 'FAIL', { frames: heard.frames, rms: heard.rms, threshold: AUDIBLE_RMS }]
})

test(5, 'VIP не може да публикува видео (камера), споделен екран или data', async () => {
  const room = newRoomName('sources')
  await createRoom(room)
  const receiver = await join('itest-recv', await token(room, 'itest-recv', { speak: true }))
  const speaker = await join('itest-speaker', await token(room, 'itest-speaker', { speak: true }))
  const camera = await attempt(() => publishVideo(speaker, TrackSource.SOURCE_CAMERA))
  const screen = await attempt(() => publishVideo(speaker, TrackSource.SOURCE_SCREENSHARE))
  const screenAudio = await attempt(() => startTone(speaker, { source: TrackSource.SOURCE_SCREENSHARE_AUDIO, name: 'itest-screen-audio' }))
  const data = await attempt(() => speaker.room.localParticipant.publishData(new TextEncoder().encode('itest'), { reliable: true }))
  await sleep(3_000)
  const videoTrack = remoteTrack(receiver, 'itest-speaker', TrackKind.KIND_VIDEO)
  const audioSubs = receiver.events.filter((e) => e.type === 'subscribed' && e.from === 'itest-speaker')
  const dataReceived = receiver.events.some((e) => e.type === 'data' && e.from === 'itest-speaker')
  await leave(speaker)
  await leave(receiver)
  const ok = videoTrack === null && audioSubs.length === 0 && !dataReceived
  return [ok ? 'PASS' : 'FAIL', {
    camera: camera.published ? 'call succeeded' : `rejected (${camera.error})`,
    screenShare: screen.published ? 'call succeeded' : `rejected (${screen.error})`,
    screenShareAudio: screenAudio.published ? 'call succeeded' : `rejected (${screenAudio.error})`,
    dataCall: data.published ? 'call succeeded' : `rejected (${data.error})`,
    receiverGotVideo: videoTrack !== null,
    receiverGotOtherTracks: audioSubs.length,
    receiverGotData: dataReceived,
  }]
})

test(6, 'Максимум 4 участници (петият е отказан)', async () => {
  const room = newRoomName('max4')
  await createRoom(room)
  const joined = []
  for (let index = 1; index <= 4; index += 1) joined.push(await join(`itest-p${index}`, await token(room, `itest-p${index}`)))
  const fifth = await tryJoin('itest-p5', await token(room, 'itest-p5'), 'p5')
  if (fifth.ok) await leave(fifth.client)
  for (const client of joined) await leave(client)
  const fifthRejectedByServer = !fifth.ok && fifth.kind !== 'network'
  return [fifthRejectedByServer ? 'PASS' : 'FAIL', { firstFourConnected: joined.length, fifthRejected: !fifth.ok, rejectionKind: fifth.ok ? null : fifth.kind, error: fifth.ok ? null : fifth.error }]
})

test(7, 'UpdateParticipant: слушател -> говорещ без нова връзка', async () => {
  const room = newRoomName('upgrade')
  await createRoom(room)
  const receiver = await join('itest-recv', await token(room, 'itest-recv', { speak: true }))
  const listener = await join('itest-upgrade', await token(room, 'itest-upgrade', { speak: false }))
  const before = await attempt(() => startTone(listener, { name: 'itest-before' }))
  await updatePermission(room, 'itest-upgrade', SPEAK)
  await sleep(1_500)
  const reconnectsBefore = listener.events.filter((e) => e.type === 'reconnecting').length
  let tone = null
  const after = await attempt(async () => { tone = await startTone(listener, { name: 'itest-after' }) })
  const heard = await measureAudio(receiver, 'itest-upgrade', 3_000)
  if (tone) await tone.stop()
  const reconnects = listener.events.filter((e) => e.type === 'reconnecting').length - reconnectsBefore
  await leave(listener)
  await leave(receiver)
  const status = heard.rms >= AUDIBLE_RMS && reconnects === 0 ? 'PASS' : heard.rms >= AUDIBLE_RMS ? 'WARN' : 'FAIL'
  return [status, { beforeUpgradePublished: before.published, afterUpgradePublished: after.published, afterError: after.error, rms: heard.rms, reconnects }]
})

test(8, 'UpdateParticipant: отнемане на publish от активно говорещ (слушането остава)', async () => {
  const room = newRoomName('revoke')
  await createRoom(room)
  const receiver = await join('itest-recv', await token(room, 'itest-recv', { speak: true }))
  const speaker = await join('itest-speaker', await token(room, 'itest-speaker', { speak: true }))
  const tone = await startTone(speaker)
  const before = await measureAudio(receiver, 'itest-speaker', 1_500)
  const revokedAt = Date.now()
  await updatePermission(room, 'itest-speaker', LISTEN)
  let unpublishedAfterMs = null
  try {
    await waitUntil(() => receiver.events.some((e) => e.type === 'unpublished' && e.from === 'itest-speaker'), 5_000, 'unpublished')
    unpublishedAfterMs = receiver.events.find((e) => e.type === 'unpublished' && e.from === 'itest-speaker').at - revokedAt
  } catch {
    // няма unpublish събитие
  }
  await sleep(500)
  const after = await measureAudio(receiver, 'itest-speaker', 2_000, { waitTrackMs: 500 })
  // Слушането на наказания: receiver говори, наказаният трябва да го чува.
  const back = await startTone(receiver, { frequency: 660, name: 'itest-back' })
  const speakerHears = await measureAudio(speaker, 'itest-recv', 2_500)
  await back.stop()
  await tone.stop()
  const stillConnected = isConnected(speaker)
  await leave(speaker)
  await leave(receiver)
  const ok = before.rms >= AUDIBLE_RMS && after.rms <= SILENT_RMS && speakerHears.rms >= AUDIBLE_RMS && stillConnected
  return [ok ? 'PASS' : 'FAIL', { rmsBefore: before.rms, rmsAfter: after.rms, unpublishedAfterMs, revokedStillHears: speakerHears.rms, stillConnected }]
})

test(9, 'Mute поток на Pika: отнемане на publish + ротация -> звукът спира, стар publish токен безполезен, нов токен само за слушане', async () => {
  const gen1 = newRoomName('mute-g1')
  const gen2 = newRoomName('mute-g2')
  await createRoom(gen1)
  const oldSpeakerToken = await token(gen1, 'itest-muted_1', { speak: true })
  const receiver = await join('itest-recv_1', await token(gen1, 'itest-recv_1', { speak: true }))
  const muted = await join('itest-muted_1', oldSpeakerToken)
  const tone = await startTone(muted)
  const before = await measureAudio(receiver, 'itest-muted_1', 1_500)
  const t0 = Date.now()
  await updatePermission(gen1, 'itest-muted_1', LISTEN)
  const silent = await measureAudio(receiver, 'itest-muted_1', 1_500, { waitTrackMs: 300 })
  const silenceAfterMs = Date.now() - t0
  await createRoom(gen2)
  await deleteRoom(gen1)
  await waitUntil(() => !isConnected(muted) && !isConnected(receiver), 10_000, 'gen1 participants disconnected').catch(() => {})
  await tone.stop()
  const reuseOld = await tryJoin('itest-muted_1', oldSpeakerToken, 'old publish token')
  if (reuseOld.ok) await leave(reuseOld.client)
  const receiver2 = await join('itest-recv_2', await token(gen2, 'itest-recv_2', { speak: true }))
  const muted2 = await join('itest-muted_2', await token(gen2, 'itest-muted_2', { speak: false }))
  const republish = await attempt(() => startTone(muted2))
  const heardMuted2 = await measureAudio(receiver2, 'itest-muted_2', 2_000, { waitTrackMs: 3_000 })
  const back = await startTone(receiver2, { frequency: 660 })
  const mutedHears = await measureAudio(muted2, 'itest-recv_2', 2_500)
  await back.stop()
  await leave(muted2)
  await leave(receiver2)
  await leave(muted)
  await leave(receiver)
  const ok = before.rms >= AUDIBLE_RMS && silent.rms <= SILENT_RMS && rejectedAsNotFound(reuseOld) && heardMuted2.frames === 0 && mutedHears.rms >= AUDIBLE_RMS
  return [ok ? 'PASS' : 'FAIL', {
    rmsBefore: before.rms,
    rmsAfterRevoke: silent.rms,
    silenceMeasuredWithinMs: silenceAfterMs,
    oldDisconnectReason: reasonName(muted.disconnectReason),
    oldPublishTokenRejected: !reuseOld.ok,
    oldPublishTokenRejectionKind: reuseOld.ok ? null : reuseOld.kind,
    newGenPublishCallSucceeded: republish.published,
    newGenOthersHearMuted: heardMuted2.frames > 0,
    mutedStillHears: mutedHears.rms,
  }]
})

test(10, 'RemoveParticipant + повторно влизане със същия токен (наблюдение)', async () => {
  const room = newRoomName('remove')
  await createRoom(room)
  const jwt = await token(room, 'itest-removed', { speak: false })
  const client = await join('itest-removed', jwt)
  await removeParticipant(room, 'itest-removed')
  await waitUntil(() => !isConnected(client), 10_000, 'removed').catch(() => {})
  const reason = reasonName(client.disconnectReason)
  await leave(client)
  await sleep(1_000)
  const again = await tryJoin('itest-removed', jwt, 'reuse after remove')
  if (again.ok) await leave(again.client)
  return ['INFO', {
    disconnectReason: reason,
    reuseSameTokenSucceeded: again.ok,
    reuseError: again.ok ? null : again.error,
    rejectionKind: again.ok ? null : again.kind,
    interpretation: again.ok
      ? 'RemoveParticipant НЕ анулира JWT -> ротацията е задължителна (така е проектирано)'
      : 'RemoveParticipant анулира стария JWT в тази версия (вероятно revokeTokenTs по подразбиране) — ротацията остава допълнителна защита',
  }]
})

test(11, 'Стар JWT след DeleteRoom (и наблюдение: възкресено име)', async () => {
  const room = newRoomName('deleted')
  await createRoom(room)
  const jwt = await token(room, 'itest-old', { speak: true })
  const client = await join('itest-old', jwt)
  await deleteRoom(room)
  await waitUntil(() => !isConnected(client), 10_000, 'room deleted').catch(() => {})
  const reason = reasonName(client.disconnectReason)
  await leave(client)
  const afterDelete = await tryJoin('itest-old', jwt, 'old jwt after delete')
  if (afterDelete.ok) await leave(afterDelete.client)
  // Симулация на забавен CreateRoom: същото име се създава отново.
  await createRoom(room)
  const resurrected = await tryJoin('itest-old', jwt, 'old jwt resurrected')
  if (resurrected.ok) await leave(resurrected.client)
  await deleteRoom(room)
  return [rejectedAsNotFound(afterDelete) ? 'PASS' : 'FAIL', {
    disconnectReason: reason,
    oldJwtAfterDeleteRejected: !afterDelete.ok,
    rejectionKind: afterDelete.ok ? null : afterDelete.kind,
    oldJwtIntoResurrectedRoom: resurrected.ok ? 'влиза (затова sweep трие възкресени имена)' : 'отказан',
  }]
})

test(12, 'LiveKit refresh token след DeleteRoom (чака първия refresh)', async () => {
  const room = newRoomName('refresh')
  await createRoom(room)
  const originalTtl = 90
  const client = await join('itest-refresh', await token(room, 'itest-refresh', { speak: true, ttl: originalTtl }))
  const original = client.room.token
  const startedAt = Date.now()
  let refreshedAt = null
  try {
    await waitUntil(() => client.events.some((e) => e.type === 'tokenRefreshed') && client.room.token !== original, LONG_WAIT_SEC * 1000, 'token refreshed')
    refreshedAt = Date.now()
  } catch {
    // няма refresh в прозореца
  }
  const survivedBeyondOriginalTtl = isConnected(client) && Date.now() - startedAt > originalTtl * 1000
  const refreshed = client.room.token
  if (refreshedAt === null || refreshed === undefined || refreshed === original) {
    await leave(client)
    return ['WARN', { refreshReceivedWithinSec: null, waitedSec: LONG_WAIT_SEC, survivedBeyondOriginalTtl }]
  }
  const claims = decodeClaims(refreshed)
  const refreshTtlSec = Number(claims.exp) - Number(claims.nbf ?? claims.iat ?? Math.floor(refreshedAt / 1000))
  const sameRoom = claims.video?.room === room
  const samePublishGrant = JSON.stringify(claims.video?.canPublishSources ?? []) === JSON.stringify(['microphone'])
  await deleteRoom(room)
  await waitUntil(() => !isConnected(client), 10_000, 'deleted').catch(() => {})
  await leave(client)
  const reuse = await tryJoin('itest-refresh', refreshed, 'refresh token after delete')
  if (reuse.ok) await leave(reuse.client)
  await createRoom(room)
  const resurrected = await tryJoin('itest-refresh', refreshed, 'refresh token resurrected')
  if (resurrected.ok) await leave(resurrected.client)
  await deleteRoom(room)
  const reuseConfirmed = rejectedAsNotFound(reuse)
  const status = reuseConfirmed && refreshTtlSec <= 20 * 60 ? 'PASS' : reuseConfirmed ? 'WARN' : 'FAIL'
  return [status, {
    firstRefreshAfterSec: Math.round((refreshedAt - startedAt) / 1000),
    refreshTokenTtlSec: refreshTtlSec,
    pikaWatchHorizonSec: 20 * 60,
    refreshSameRoomAndGrants: sameRoom && samePublishGrant,
    survivedBeyondOriginalTtl,
    refreshTokenAfterDeleteRejected: !reuse.ok,
    rejectionKind: reuse.ok ? null : reuse.kind,
    refreshTokenIntoResurrectedRoom: resurrected.ok ? 'влиза' : 'отказан',
  }]
}, { long: true })

test(13, 'Ротация: токенът е вързан за генерацията; изтриване на старата не засяга новата', async () => {
  const gen1 = newRoomName('rot-g1')
  const gen2 = newRoomName('rot-g2')
  await createRoom(gen1)
  await createRoom(gen2)
  const g1Token = await token(gen1, 'itest-a_1', { speak: true })
  const a1 = await join('itest-a_1', g1Token)
  // Стаята идва от гранта в токена (точно име) — gen1 токен влиза само в gen1.
  const b2 = await join('itest-b_2', await token(gen2, 'itest-b_2', { speak: true }))
  const toneA = await startTone(a1)
  const leak = await measureAudio(b2, 'itest-a_1', 2_000, { waitTrackMs: 2_000 })
  await toneA.stop()
  const c2 = await join('itest-c_2', await token(gen2, 'itest-c_2', { speak: true }))
  await deleteRoom(gen1)
  await waitUntil(() => !isConnected(a1), 10_000, 'gen1 closed').catch(() => {})
  const toneC = await startTone(c2)
  const gen2Ok = await measureAudio(b2, 'itest-c_2', 2_000)
  await toneC.stop()
  const g1Reuse = await tryJoin('itest-a_1', g1Token, 'gen1 token after rotation')
  if (g1Reuse.ok) await leave(g1Reuse.client)
  await leave(c2)
  await leave(b2)
  await leave(a1)
  const ok = leak.frames === 0 && !isConnected(a1) && gen2Ok.rms >= AUDIBLE_RMS && rejectedAsNotFound(g1Reuse)
  return [ok ? 'PASS' : 'FAIL', {
    gen2HearsGen1: leak.frames > 0,
    gen1DisconnectReason: reasonName(a1.disconnectReason),
    gen2StillWorks: gen2Ok.rms,
    gen1TokenAfterRotationRejected: !g1Reuse.ok,
    rejectionKind: g1Reuse.ok ? null : g1Reuse.kind,
  }]
})

test(14, 'DUPLICATE_IDENTITY: същият identity изхвърля стария; различни епохи съжителстват', async () => {
  const room = newRoomName('dup')
  await createRoom(room)
  const first = await join('itest-p_x_1', await token(room, 'itest-p_x_1'), 'first')
  const second = await join('itest-p_x_1', await token(room, 'itest-p_x_1'), 'second')
  await waitUntil(() => !isConnected(first), 10_000, 'first kicked').catch(() => {})
  const firstReason = reasonName(first.disconnectReason)
  const epoch2 = await join('itest-p_x_2', await token(room, 'itest-p_x_2'), 'epoch2')
  await sleep(1_500)
  const bothEpochs = isConnected(second) && isConnected(epoch2)
  await leave(epoch2)
  await leave(second)
  await leave(first)
  const ok = firstReason === 'DUPLICATE_IDENTITY' && bothEpochs
  return [ok ? 'PASS' : 'FAIL', { firstDisconnectReason: firstReason, differentEpochsCoexist: bothEpochs }]
})

test(15, 'DeleteRoom на несъществуваща стая (наблюдение)', async () => {
  const room = newRoomName('missing')
  ownRooms.add(room)
  let outcome
  try {
    await service().deleteRoom(room)
    outcome = { status: 200 }
  } catch (error) {
    outcome = { status: error?.status ?? null, code: error?.code ?? null, message: clean(error) }
  }
  return ['INFO', { ...outcome, pikaHandling: 'not_found и 200 се приемат като постигната цел' }]
})

test(16, 'revokeTokenTs при RemoveParticipant (поддържа ли се)', async () => {
  const room = newRoomName('revokets')
  await createRoom(room)
  const jwt = await token(room, 'itest-revoke', { speak: false })
  const client = await join('itest-revoke', jwt)
  await sleep(1_100)
  await removeParticipant(room, 'itest-revoke', { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 60) })
  await waitUntil(() => !isConnected(client), 10_000, 'removed').catch(() => {})
  await leave(client)
  await sleep(1_000)
  const reuse = await tryJoin('itest-revoke', jwt, 'reuse after revokeTokenTs')
  if (reuse.ok) await leave(reuse.client)
  return ['INFO', {
    reuseRejected: !reuse.ok,
    rejectionKind: reuse.ok ? null : reuse.kind,
    supported: !reuse.ok ? 'вероятно да (старият токен е отказан)' : 'не (старият токен влиза)',
    reuseError: reuse.ok ? null : reuse.error,
  }]
})

// ─── Самопроверка (без мрежа) ─────────────────────────────────────────────

async function selfCheck() {
  const failures = []
  const expect = (condition, label) => { if (!condition) failures.push(label) }
  expect(ROOM_PREFIX.startsWith('itest-') && !ROOM_PREFIX.startsWith('pv_'), 'префикс')
  let refused = false
  try { assertOwn('pv_prod_x') } catch { refused = true }
  expect(refused, 'отказ за pv_ стая')
  refused = false
  try { assertOwn('itest-other-01') } catch { refused = true }
  expect(refused, 'отказ за чужд run')
  const secret = 'self-check-secret-0123456789abcdef0123456789'
  const at = new AccessToken('APIselfcheck', secret, { identity: 'itest-x', ttl: 600 })
  at.addGrant(pikaGrant(`${ROOM_PREFIX}01-x`, true))
  const jwt = await at.toJwt()
  const claims = await new TokenVerifier('APIselfcheck', secret).verify(jwt)
  expect(JSON.stringify(claims.video.canPublishSources) === '["microphone"]' && claims.video.canPublishData === false, 'VIP grant')
  expect(claims.video.roomAdmin === undefined && claims.video.roomCreate === undefined, 'без admin grants')
  expect(clean(`x ${jwt} y`) === 'x <jwt> y', 'JWT маскиране')
  const listenPermission = pikaPermission(LISTEN)
  expect(listenPermission.canPublish === false && listenPermission.canSubscribe === true && listenPermission.canPublishSources.length === 0, 'listen permission')
  expect(tests.length === 16 && new Set(tests.map((t) => t.id)).size === 16, '16 теста')
  expect(classifyJoinError('Error: no native root CA certificates found') === 'network', 'TLS -> network')
  expect(classifyJoinError('TypeError: fetch failed') === 'network', 'fetch -> network')
  expect(classifyJoinError('ConnectError: failed to connect: 404 Not Found: requested room does not exist') === 'not_found', '404 -> not_found')
  expect(!rejectedAsNotFound({ ok: false, kind: 'network' }) && rejectedAsNotFound({ ok: false, kind: 'not_found' }), 'потвърден отказ')
  console.log(failures.length === 0 ? 'self-check OK' : `self-check FAILED: ${failures.join(', ')}`)
  return failures.length === 0
}

// ─── Изпълнение ───────────────────────────────────────────────────────────

async function cleanup() {
  for (const client of [...liveClients]) await leave(client)
  for (const room of ownRooms) {
    try {
      await deleteRoom(room)
    } catch {
      // ще бъде затворена от empty_timeout (120 s)
    }
  }
}

async function main() {
  if (SELF_CHECK) {
    const ok = await selfCheck()
    await dispose().catch(() => {})
    process.exit(ok ? 0 : 1)
  }
  if (API_KEY === '' || API_SECRET === '') {
    console.error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET липсват в env (стойностите не се печатат).')
    process.exit(2)
  }
  if (LEFTOVERS) {
    const rooms = (await service().listRooms()).filter((room) => /^itest-[0-9a-f]{18}-/.test(room.name))
    console.log(`itest-* стаи: ${rooms.length}`)
    for (const room of rooms) {
      let outcome = ''
      if (PURGE_LEFTOVERS) {
        try {
          await service().deleteRoom(room.name)
          outcome = ' -> изтрита'
        } catch (error) {
          outcome = ` -> ${clean(error)}`
        }
      }
      console.log(`  ${room.name} participants=${room.numParticipants}${outcome}`)
    }
    await dispose().catch(() => {})
    process.exit(0)
  }
  console.log('Pika voice — реални LiveKit тестове')
  console.log(`  run id:      ${RUN_ID}`)
  console.log(`  стаи:        ${ROOM_PREFIX}* (само собствени)`)
  console.log(`  WebSocket:   ${WS_URL}`)
  console.log(`  API:         ${API_URL}`)
  console.log('  креденшъли:  налични (не се печатат)\n')

  let interrupted = false
  process.on('SIGINT', () => {
    interrupted = true
    console.log('\nПрекъсване — почистване на собствените стаи...')
    void cleanup().finally(() => process.exit(130))
  })

  for (const entry of tests) {
    if (interrupted) break
    if (ONLY.length > 0 && !ONLY.includes(entry.id)) continue
    if (entry.long && SKIP_LONG) {
      record(entry.id, entry.title, 'SKIP', { reason: '--skip-long' })
      continue
    }
    try {
      const [status, details] = await withTimeout(entry.fn(), (entry.long ? LONG_WAIT_SEC + 120 : 90) * 1000, `test ${entry.id}`)
      record(entry.id, entry.title, status, details)
    } catch (error) {
      record(entry.id, entry.title, 'FAIL', { error: clean(error) })
    }
    for (const client of [...liveClients]) await leave(client)
  }

  await cleanup()
  const summary = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})
  console.log(`\nОбобщение: ${JSON.stringify(summary)}`)
  try {
    await mkdir(REPORT_DIR, { recursive: true })
    const file = joinPath(REPORT_DIR, `itest-${RUN_ID}.json`)
    await writeFile(file, JSON.stringify({ runId: RUN_ID, wsUrl: WS_URL, apiUrl: API_URL, finishedAt: new Date().toISOString(), summary, results }, null, 2))
    console.log(`Отчет (без токени/ключове): ${file}`)
  } catch (error) {
    console.error(`Отчетът не е записан: ${clean(error)}`)
  }
  await dispose().catch(() => {})
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
}

main().catch(async (error) => {
  console.error(`Фатална грешка: ${clean(error)}`)
  await cleanup().catch(() => {})
  process.exit(1)
})
