// Гласов чат — тънък LiveKit RoomService клиент (Етап 2б).
//
// ЕДИНСТВЕНОТО място (заедно с voiceTokenIssuer.ts), което импортира
// livekit-server-sdk. Ползва официалния RoomServiceClient (Twirp/JSON),
// проверен за livekit-server-sdk@2.19.2:
//   * requestTimeout (секунди) -> AbortSignal.timeout за всяка заявка
//     (fetch + четене на тялото);
//   * failover:false — регионален failover има само за *.livekit.cloud;
//     изрично е изключен, за да няма скрити повторни опити;
//   * всяка заявка се подписва с краткотраен admin JWT от SDK-то — той НЕ
//     напуска backend-а и НЕ се логва.
//
// Никакви повторни опити, опашки или circuit breaker тук — това е работа на
// voiceLiveKitDispatcher.ts. Тук е само преводът към/от SDK и класификацията
// на грешките (без съдържанието на отговорите в логовете).

import { RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import type { VoiceLiveKitPermissionProfile } from './voiceChatTypes.js'

type EnvSource = Readonly<Record<string, string | undefined>>

/** Стойностите живеят само в server-side env; никога в Git/frontend/логове. */
export type VoiceLiveKitConfig = {
  /** https://voice.pika.bg (HTTP Twirp API през Caddy). */
  apiUrl: string
  /** wss://voice.pika.bg (връща се на клиента заедно с токена). */
  wsUrl: string
  apiKey: string
  apiSecret: string
}

/**
 * null -> липсваща/невалидна конфигурация (гласът е "недостъпен"; играта
 * продължава). http:// и ws:// се приемат САМО за loopback (тестове с fake
 * Twirp сървър); production изисква https/wss.
 */
export function readVoiceLiveKitConfig(env: EnvSource = process.env): VoiceLiveKitConfig | null {
  const apiUrl = env.LIVEKIT_API_URL?.trim() ?? ''
  const wsUrl = env.LIVEKIT_WS_URL?.trim() ?? ''
  const apiKey = env.LIVEKIT_API_KEY?.trim() ?? ''
  const apiSecret = env.LIVEKIT_API_SECRET?.trim() ?? ''
  if (apiUrl === '' || wsUrl === '' || apiKey === '' || apiSecret === '') return null
  if (!isAllowedUrl(apiUrl, ['https:'], ['http:']) || !isAllowedUrl(wsUrl, ['wss:'], ['ws:'])) return null
  return { apiUrl: apiUrl.replace(/\/+$/, ''), wsUrl: wsUrl.replace(/\/+$/, ''), apiKey, apiSecret }
}

function isAllowedUrl(value: string, secureProtocols: string[], loopbackOnlyProtocols: string[]): boolean {
  try {
    const url = new URL(value)
    if (secureProtocols.includes(url.protocol)) return true
    if (!loopbackOnlyProtocols.includes(url.protocol)) return false
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

// ─── Класификация на грешките ─────────────────────────────────────────────

/**
 * 'not_found' — стаята/участникът не съществува (за DeleteRoom и
 *               RemoveParticipant това е успех — целта е постигната);
 * 'rejected'  — 4xx (невалидна заявка/права) — повторен опит няма да помогне;
 * 'transient' — timeout, мрежа, 5xx — повторим; брои се за circuit breaker.
 *               ВАЖНО: timeout НЕ доказва, че операцията не е изпълнена.
 */
export type VoiceLiveKitErrorKind = 'not_found' | 'rejected' | 'transient'

export class VoiceLiveKitError extends Error {
  readonly kind: VoiceLiveKitErrorKind
  readonly status: number | null
  constructor(kind: VoiceLiveKitErrorKind, status: number | null, message: string) {
    super(message)
    this.name = 'VoiceLiveKitError'
    this.kind = kind
    this.status = status
  }
}

/** Кратко техническо описание без тела/токени (за last_delete_error и логове). */
export function describeLiveKitError(error: unknown): string {
  if (error instanceof VoiceLiveKitError) return `${error.kind}${error.status === null ? '' : `:${error.status}`}`
  if (error instanceof Error) return error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.name
  return 'unknown'
}

export function classifyLiveKitError(error: unknown): VoiceLiveKitError {
  if (error instanceof VoiceLiveKitError) return error
  const candidate = error as { status?: unknown; code?: unknown; name?: unknown } | null
  const status = typeof candidate?.status === 'number' ? candidate.status : null
  const code = typeof candidate?.code === 'string' ? candidate.code : null
  if (status === 404 || code === 'not_found') return new VoiceLiveKitError('not_found', status, 'not_found')
  if (status !== null && status >= 400 && status < 500) {
    // 408/429 са временни по природа.
    if (status === 408 || status === 429) return new VoiceLiveKitError('transient', status, 'transient')
    return new VoiceLiveKitError('rejected', status, 'rejected')
  }
  const name = typeof candidate?.name === 'string' ? candidate.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return new VoiceLiveKitError('transient', null, 'timeout')
  return new VoiceLiveKitError('transient', status, 'transient')
}

// ─── API ──────────────────────────────────────────────────────────────────

export type VoiceLiveKitRoomSummary = { name: string; numParticipants: number }

export type VoiceLiveKitApi = {
  /** Идемпотентна в LiveKit (съществуваща стая се връща). auto_create:false изисква изричното ѝ създаване. */
  createRoom: (input: { name: string; maxParticipants: number; emptyTimeoutSeconds: number; departureTimeoutSeconds: number }) => Promise<void>
  /** not_found се хвърля като VoiceLiveKitError('not_found') — caller-ът го третира като успех. */
  deleteRoom: (name: string) => Promise<void>
  /** names=undefined -> всички стаи на сървъра (за reconciliation по префикс pv_). */
  listRooms: (names?: string[]) => Promise<VoiceLiveKitRoomSummary[]>
  removeParticipant: (room: string, identity: string) => Promise<void>
  updateParticipantPermission: (room: string, identity: string, permission: VoiceLiveKitParticipantPermission) => Promise<void>
}

/** Права за UpdateParticipant — винаги само аудио, никога data/video/admin. */
export type VoiceLiveKitParticipantPermission =
  | VoiceLiveKitPermissionProfile
  /** Незабавно отнемане преди ротация/изтриване (не анулира издадени JWT!). */
  | { canSubscribe: false; canPublish: false; canPublishSources: readonly []; canPublishData: false }

export const VOICE_LIVEKIT_REQUEST_TIMEOUT_SECONDS = 3

export function createVoiceLiveKitApi(config: Pick<VoiceLiveKitConfig, 'apiUrl' | 'apiKey' | 'apiSecret'>, options: { requestTimeoutSeconds?: number } = {}): VoiceLiveKitApi {
  const client = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret, {
    requestTimeout: options.requestTimeoutSeconds ?? VOICE_LIVEKIT_REQUEST_TIMEOUT_SECONDS,
    failover: false,
  })

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      throw classifyLiveKitError(error)
    }
  }

  return {
    async createRoom(input) {
      await call(() =>
        client.createRoom({
          name: input.name,
          maxParticipants: input.maxParticipants,
          emptyTimeout: input.emptyTimeoutSeconds,
          departureTimeout: input.departureTimeoutSeconds,
        }),
      )
    },
    async deleteRoom(name) {
      await call(() => client.deleteRoom(name))
    },
    async listRooms(names) {
      const rooms = await call(() => client.listRooms(names))
      return rooms.map((room) => ({ name: room.name, numParticipants: Number(room.numParticipants ?? 0) }))
    },
    async removeParticipant(room, identity) {
      await call(() => client.removeParticipant(room, identity))
    },
    async updateParticipantPermission(room, identity, permission) {
      await call(() =>
        client.updateParticipant(room, identity, {
          permission: {
            canSubscribe: permission.canSubscribe,
            canPublish: permission.canPublish,
            canPublishData: false,
            canPublishSources: permission.canPublish ? [TrackSource.MICROPHONE] : [],
            canUpdateMetadata: false,
            hidden: false,
          },
        }),
      )
    },
  }
}
