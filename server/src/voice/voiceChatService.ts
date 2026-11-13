// Гласов чат — runtime на backend-а (Етап 2б).
//
// Свързва авторитетното игрово състояние (подадено от index.ts чрез
// resolveSeat) с LiveKit. index.ts само вика on*-куките от съществуващите
// lifecycle точки; цялата логика е тук. Нищо от това не се await-ва в
// игрови WebSocket handler-и: куките са синхронни (in-memory + кратки SQLite
// записи само при lifecycle промени), а LiveKit операциите са fire-and-forget
// през ограничения dispatcher.
//
// ── Участие и право за говорене ──────────────────────────────────────────
// Участие (membership) = непрекъснатото присъствие на профил на мястото си
// в конкретна гласова маса: от сядането в чакалнята (или създаването на
// масата) през старта, повторните игри, временните disconnect-и, refresh,
// ротации и рестарт (ако игровата стая е възстановена). Правото за говорене
// се придобива, ако играчът е VIP при сядането или стане VIP по време на
// участието (backend проверка), и се пази до края на участието — изтичане
// на VIP и "Преиграй" не го отнемат и не предизвикват ротация. Край на
// участието (напускане, изгонване, окончателно напускане, бан, разпадане на
// масата, изключване на гласа) прекратява правото; ново сядане = ново
// участие без старото право. Паметта е авторитетна в процеса, базата
// (voice_table_memberships) пази правото при рестарт.
//
// ── Session binding и lease ───────────────────────────────────────────────
// Гласът следва авторитетната игрова сесия: binding (profile+маса ->
// clientInstanceId + игрова връзка) се регистрира САМО през игровия WS от
// връзката, която държи мястото (voice_presence). Токен се издава само за
// текущия binding, само докато връзката е отворена и lease-ът е валиден.
// Lease-ът се подновява от клиента; живият игрови WS НЕ го удължава сам.
// Таймери има само за активни гласови участници (binding с издаден токен):
//   * lease таймер — изтекъл lease при жива игрова връзка -> край на достъпа;
//   * 120 s таймер — от затварянето на игровата връзка до възстановяване на
//     СЪЩАТА сесия (същия clientInstanceId) от нова връзка.
//
// ── Ротация ───────────────────────────────────────────────────────────────
// JWT expiration, RemoveParticipant и UpdateParticipant НЕ анулират вече
// издадени токени (нито LiveKit refresh токените). Затова при загубено право
// (край на участието) или изместена/сменена сесия, на която е издаден токен
// за ТЕКУЩАТА жива генерация: незабавно отнемане на правата на identity-то
// (UpdateParticipant + RemoveParticipant, висок приоритет), нова генерация
// (ново неповторимо име), старата отива в durable DeleteRoom опашката, и
// НОВИ токени не се издават, докато изтриването на старата стая не бъде
// потвърдено (fencing; при недостъпно API — докато не стане достъпно).
// Край на достъпа без загуба на право (напуснат екран, изтекъл lease, 120 s)
// -> само отнемане на правата + RemoveParticipant, без ротация: играчът е
// легитимен участник и ново изрично включване е разрешено.
//
// ── Mute наказание ───────────────────────────────────────────────────────
// Единният административен mute (Лафче, Общи, чатът в чакалнята — един
// източник на истина: getChatMuteStatus) забранява и ГОВОРЕНЕТО: играчът
// играе, създава гласова маса (с VIP) и слуша, но не получава publish
// права. Mute има приоритет пред VIP и пред придобитото право, без да го
// изтрива. Налагане по време на разговор (onChatMuteChanged): приоритетно
// UpdateParticipant само без publish (слушането остава) и — ако на тази
// сесия е издаден publish-способен токен за живата генерация — ротация
// ('speak_revoked'), за да не може стар токен с canPublish:true да върне
// говоренето. Изтичане/премахване: само известие; микрофонът никога не се
// включва автоматично (повишаване по изричен speak-access).

import { randomUUID } from 'node:crypto'
import {
  describeVoiceTableCreationOption,
  evaluateVoiceAccess,
  evaluateVoiceTableCreation,
  isVoiceSessionBindingCurrent,
  shouldPersistSpeakingEntitlement,
  toVoiceLiveKitPermissionProfile,
  type VoiceAccessDecision,
  type VoiceListenDenialCode,
  type VoiceTableCreationOption,
} from './voiceChatEligibility.js'
import { isVoiceChatEmergencyStopActive, resolveEffectiveVoiceChatMode } from './voiceChatFeatureFlag.js'
import type {
  VoiceAccessEndReason,
  VoicePresenceClientMessage,
  VoicePresenceErrorCode,
  VoiceServerMessage,
  VoiceSpeakState,
} from './voiceChatProtocol.js'
import type { SetModeResult, VoiceChatStore } from './voiceChatStore.js'
import type {
  VoiceChatMode,
  VoiceMembershipEndReason,
  VoiceRoomRetireReason,
  VoiceTableId,
  VoiceTableRecord,
  VoiceTableReleaseReason,
} from './voiceChatTypes.js'
import type { VoiceLiveKitApi } from './voiceLiveKitApi.js'
import type { VoiceDispatchResult, VoiceLiveKitDispatcher } from './voiceLiveKitDispatcher.js'
import { createVoiceRoomReconciler, type VoiceRoomReconciler, type VoiceRoomReconcilerOptions } from './voiceRoomReconciler.js'
import { VOICE_PERSONAL_DATA_RETENTION_MS, createVoiceRetentionSweeper, type VoiceRetentionSweeper } from './voiceRetentionSweeper.js'
import { createVoiceStoreWriteQueue, type VoiceStoreWriteQueue } from './voiceStoreWriteQueue.js'
import { createVoiceTableReleaseQueue, type VoiceTableReleaseQueue } from './voiceTableReleaseQueue.js'
import { VOICE_TOKEN_TTL_SECONDS, buildVoiceIdentity, type VoiceTokenSigner } from './voiceTokenIssuer.js'

type EnvSource = Readonly<Record<string, string | undefined>>

// ─── Константи (продуктови правила) ──────────────────────────────────────

/** Загубена игрова връзка: гласът може да продължи най-много толкова. */
export const VOICE_GAME_DISCONNECT_GRACE_MS = 120_000
/**
 * Изместена игрова връзка (session_displaced): толкова време същата
 * страница (същия clientInstanceId) може да си върне сесията от новата
 * връзка без ротация — честият случай е network reconnect с полуотворен
 * стар сокет (Wi-Fi <-> мобилни данни). Иначе — ротация, ако е имало токен.
 */
export const VOICE_DISPLACEMENT_RECLAIM_MS = 15_000
/** Lease без подновяване изтича след толкова (клиентът подновява на VOICE_LEASE_RENEW_MS). */
export const VOICE_LEASE_TTL_MS = 60_000
export const VOICE_LEASE_RENEW_MS = 20_000
export const VOICE_ROOM_MAX_PARTICIPANTS = 4
export const VOICE_ROOM_EMPTY_TIMEOUT_SECONDS = 120
export const VOICE_ROOM_DEPARTURE_TIMEOUT_SECONDS = 120
/** Освободени маси по-стари от това се чистят при старт (ограничено). */
/** 30 дни след окончателното освобождаване на масата (T1 — voiceRetentionSweeper.ts). */
export const VOICE_RELEASED_TABLE_RETENTION_MS = VOICE_PERSONAL_DATA_RETENTION_MS

// ─── Вход от index.ts ─────────────────────────────────────────────────────

/**
 * Авторитетното място на профила спрямо гласовата маса — изведено от
 * PrivateRoom slots (чакалня) или ServerRoom seats (игра), никога от клиента.
 */
export type VoiceSeatLookup =
  | {
      relation: 'player'
      permanentlyLeft: boolean
      /** Връзката, която в момента държи мястото (null = няма жива връзка). */
      seatConnectionId: string | null
    }
  | { relation: 'spectator' | 'none' }

export type VoiceChatServiceDeps = {
  store: VoiceChatStore
  /** null -> LiveKit не е конфигуриран: гласът е недостъпен, играта продължава. */
  liveKit: { api: VoiceLiveKitApi; wsUrl: string; signToken: VoiceTokenSigner; roomNamespace?: string } | null
  dispatcher: VoiceLiveKitDispatcher
  resolveSeat: (profileId: string, table: VoiceTableRecord) => VoiceSeatLookup
  isConnectionOpen: (connectionId: string) => boolean
  sendToConnection: (connectionId: string, message: VoiceServerMessage) => void
  isVipActive: (profileId: string) => boolean
  isBanned: (profileId: string) => boolean
  /**
   * Съществуващият единен mute (topicModerationStore.getSectionMuteSnapshot).
   * Хвърлена грешка -> fail-closed за ГОВОРЕНЕТО (третира се като mute),
   * слушането не се засяга.
   */
  getChatMuteStatus: (profileId: string) => { isMuted: boolean; mutedUntil: string | null }
  env?: EnvSource
  now?: () => number
  scheduler?: {
    setTimeout: (callback: () => void, delayMs: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  log?: (line: string) => void
  reconcilerOptions?: Partial<Omit<VoiceRoomReconcilerOptions, 'store' | 'api' | 'dispatcher' | 'onTableDeletionsSettled'>>
  /** T1: само за тестове (интервал, партиди, паузи при busy). */
  retentionOptions?: { intervalMs?: number; batchSize?: number; busyRetryDelaysMs?: readonly number[]; yieldToEventLoop?: () => Promise<void> }
  timing?: {
    disconnectGraceMs?: number
    displacementReclaimMs?: number
    leaseTtlMs?: number
    leaseRenewMs?: number
    storeRetryBaseDelayMs?: number
  }
}

export type VoiceHttpResult = { status: number; body: Record<string, unknown> }

export type VoiceTableCreationResult =
  | { ok: true; voiceTableId: VoiceTableId }
  | {
      ok: false
      code:
        | 'voice_chat_off'
        | 'voice_chat_admin_only'
        | 'voice_chat_vip_required'
        | 'voice_chat_banned'
        | 'voice_chat_unavailable'
        | 'voice_chat_capacity_reached'
        | 'voice_chat_busy'
      message: string
      activeCount?: number
      maxTables?: number
    }

export type VoiceRestoredRoom = {
  serverRoomId: string
  voiceTableId: string | null
  /** profileId-тата на активните човешки участници (без окончателно напуснали). */
  activeProfileIds: readonly string[]
}

export type VoiceRuntimeStats = {
  bootComplete: boolean
  liveKitConfigured: boolean
  bindings: number
  activeVoiceSessions: number
  blockedTables: number
  memberships: number
  pendingStoreWrites: number
  dispatcher: ReturnType<VoiceLiveKitDispatcher['stats']>
  reconciler: ReturnType<VoiceRoomReconciler['stats']>
  counters: Record<string, number>
  /** Етап 6: отказаните заявки за токен по код (натрупващи се от старта на процеса). */
  tokensDeniedByCode: Record<string, number>
}

/** Етап 6 — ред за админ мониторинга: без профили, имена или токени. */
export type VoiceAdminTableRow = {
  voiceTableId: VoiceTableId
  phase: VoiceTableRecord['phase']
  createdAt: string
  inGameAt: string | null
  /** Име на живата LiveKit стая (null = още няма генерация). */
  liveRoomName: string | null
  generation: number | null
  /** Активни участия (седнали реални играчи) в процеса. */
  seatedMembers: number
  /** Сесии с издаден и непрекратен гласов достъп. */
  activeVoiceSessions: number
  /** Временно не се издават токени (ротация/освобождаване чакат). */
  blocked: 'releasing' | 'rotation_pending' | null
}

export type VoiceChatService = {
  // Създаване и чакалня
  reserveVoiceTableForPrivateRoom: (input: { profileId: string; isFullAdmin: boolean }) => VoiceTableCreationResult
  /** Само четене (формата за създаване) — без резервация, без I/O. */
  describeCreationOption: (input: { profileId: string; isFullAdmin: boolean }) => VoiceTableCreationOption
  attachPrivateRoom: (voiceTableId: VoiceTableId, privateRoomId: string, creatorProfileId: string) => void
  abortReservation: (voiceTableId: VoiceTableId) => void
  onMemberSeated: (voiceTableId: VoiceTableId, profileId: string) => void
  onMemberRemoved: (voiceTableId: VoiceTableId, profileId: string, reason: 'left_waiting_room' | 'kicked' | 'permanently_left') => void
  onWaitingRoomEnded: (voiceTableId: VoiceTableId, reason: 'waiting_room_closed' | 'waiting_room_expired' | 'waiting_room_empty') => void
  // Игра
  onGameStarted: (voiceTableId: VoiceTableId, serverRoomId: string) => void
  onGameStartFailed: (voiceTableId: VoiceTableId) => void
  onServerRoomRemoved: (voiceTableId: VoiceTableId) => void
  // Сесии
  onProfileRevoked: (profileId: string, reason: 'banned' | 'profile_revoked') => void
  /** Наложено, изтекло или премахнато mute наказание (вика се от единната точка за известяване). */
  onChatMuteChanged: (profileId: string) => void
  onGameConnectionDisplaced: (connectionId: string) => void
  onGameConnectionClosed: (connectionId: string) => void
  handlePresence: (connectionId: string, profileId: string | null, message: VoicePresenceClientMessage) => void
  // HTTPS (respond се вика СИНХРОННО веднага след окончателната проверка)
  handleTokenRequest: (claim: { profileId: string; voiceTableId: string; clientInstanceId: string }, respond: (result: VoiceHttpResult) => void) => Promise<void>
  handleSpeakAccessRequest: (claim: { profileId: string; voiceTableId: string; clientInstanceId: string }, respond: (result: VoiceHttpResult) => void) => Promise<void>
  // Админ и старт
  onModeChanged: (result: Extract<SetModeResult, { ok: true }>) => void
  boot: (restoredRooms: readonly VoiceRestoredRoom[]) => void
  stats: () => VoiceRuntimeStats
  /** Етап 6: активните гласови маси (само in-memory + индексирани четения). */
  adminTables: () => VoiceAdminTableRow[]
  dispose: () => void
  /** Само за тестове. */
  debug: {
    reconciler: VoiceRoomReconciler
    getBinding: (voiceTableId: string, profileId: string) => Readonly<BindingState> | null
    getMembership: (voiceTableId: string, profileId: string) => Readonly<MembershipState> | null
  }
}

// ─── Вътрешно състояние ───────────────────────────────────────────────────

export type BindingState = {
  key: string
  voiceTableId: VoiceTableId
  profileId: string
  clientInstanceId: string
  connectionId: string | null
  epoch: number
  identity: string
  onTableScreen: boolean
  leaseExpiresAt: number
  leaseTimer: unknown
  disconnectTimer: unknown
  /** Генерацията, за която последно е издаден токен (null = никога). */
  issuedRoomName: string | null
  issuedCanPublish: boolean
  /** Има издаден и непрекратен от сървъра гласов достъп. */
  voiceActive: boolean
}

export type MembershipState = {
  membershipId: string
  voiceTableId: VoiceTableId
  profileId: string
  entitled: boolean
}

type EvaluationFailure = { ok: false; status: number; code: string; retryAfterMs?: number }
type EvaluationSuccess = {
  ok: true
  table: VoiceTableRecord
  binding: BindingState
  membership: MembershipState
  decision: Extract<VoiceAccessDecision, { canListen: true }>
  liveRoomName: string | null
  liveGeneration: number | null
  speak: VoiceSpeakState
  fingerprint: string
}

const SPEAK_PERMISSION = { canSubscribe: true, canPublish: true, canPublishSources: ['microphone'], canPublishData: false } as const
const REVOKED_PERMISSION = { canSubscribe: false, canPublish: false, canPublishSources: [], canPublishData: false } as const
const LISTEN_PERMISSION = { canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: false } as const

const DENIAL_STATUS: Record<VoiceListenDenialCode, number> = {
  voice_off: 403,
  not_authenticated: 401,
  banned: 403,
  table_not_found: 404,
  table_released: 410,
  spectator: 403,
  bot: 403,
  not_a_player: 403,
  wrong_table: 403,
  permanently_left: 403,
  invalid_session: 409,
}

function key(voiceTableId: string, profileId: string): string {
  return `${voiceTableId}|${profileId}`
}

const defaultScheduler = {
  setTimeout: (callback: () => void, delayMs: number): unknown => {
    const handle = setTimeout(callback, delayMs)
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as { unref: () => void }).unref()
    return handle
  },
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createVoiceChatService(deps: VoiceChatServiceDeps): VoiceChatService {
  const { store, dispatcher } = deps
  const liveKit = deps.liveKit
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => Date.now())
  const scheduler = deps.scheduler ?? defaultScheduler
  const log = deps.log ?? ((line: string) => console.log(line))
  const disconnectGraceMs = deps.timing?.disconnectGraceMs ?? VOICE_GAME_DISCONNECT_GRACE_MS
  const displacementReclaimMs = deps.timing?.displacementReclaimMs ?? VOICE_DISPLACEMENT_RECLAIM_MS
  const leaseTtlMs = deps.timing?.leaseTtlMs ?? VOICE_LEASE_TTL_MS
  const leaseRenewMs = deps.timing?.leaseRenewMs ?? VOICE_LEASE_RENEW_MS

  const bindings = new Map<string, BindingState>()
  const epochs = new Map<string, number>()
  const memberships = new Map<string, MembershipState>()
  /** Маси, за които временно НЕ се издават токени (освобождаване/ротация чакат запис). */
  const blockedTables = new Map<VoiceTableId, 'releasing' | 'rotation_pending'>()
  const pendingCreates = new Map<string, Promise<VoiceDispatchResult<void>>>()
  const counters: Record<string, number> = {
    tokensIssued: 0,
    tokensDenied: 0,
    tokensDiscardedStale: 0,
    rotations: 0,
    speakUpgrades: 0,
    leaseExpired: 0,
    disconnectTimeouts: 0,
    createRoomFailures: 0,
    muteRevocations: 0,
  }
  const tokensDeniedByCode: Record<string, number> = {}
  const countDenial = (code: string): void => {
    counters.tokensDenied! += 1
    tokensDeniedByCode[code] = (tokensDeniedByCode[code] ?? 0) + 1
  }
  let bootComplete = false
  let disposed = false

  const writeQueue: VoiceStoreWriteQueue = createVoiceStoreWriteQueue({
    scheduler,
    baseDelayMs: deps.timing?.storeRetryBaseDelayMs ?? 250,
    log,
  })

  const reconciler = createVoiceRoomReconciler({
    ...(deps.reconcilerOptions ?? {}),
    store,
    api: liveKit?.api ?? null,
    dispatcher,
    onTableDeletionsSettled: (voiceTableId) => notifyTableReady(voiceTableId),
    ...(liveKit?.roomNamespace === undefined ? {} : { roomNamespace: liveKit.roomNamespace }),
    log: deps.reconcilerOptions?.log ?? log,
  })

  // T1: периодично изтриване на личните данни (при старт и на всеки 6 часа).
  const retention: VoiceRetentionSweeper = createVoiceRetentionSweeper({
    store,
    scheduler,
    now,
    log,
    retentionMs: VOICE_RELEASED_TABLE_RETENTION_MS,
    ...(deps.retentionOptions ?? {}),
  })

  const releaseQueue: VoiceTableReleaseQueue = createVoiceTableReleaseQueue({
    store,
    scheduler,
    now: () => new Date(now()),
    log,
    onReleased: (voiceTableId) => handleTableReleased(voiceTableId, 'table_released'),
  })

  // ─── Помощни ──────────────────────────────────────────────────────────

  function effectiveMode(): VoiceChatMode {
    return resolveEffectiveVoiceChatMode(store.getSettings().mode, isVoiceChatEmergencyStopActive(env))
  }

  function send(connectionId: string | null, message: VoiceServerMessage): void {
    if (connectionId === null || !deps.isConnectionOpen(connectionId)) return
    try {
      deps.sendToConnection(connectionId, message)
    } catch {
      // Изпращането е best-effort; WS слоят сам се грижи за мъртвите сокети.
    }
  }

  function clearBindingTimers(binding: BindingState): void {
    if (binding.leaseTimer !== null) scheduler.clearTimeout(binding.leaseTimer)
    if (binding.disconnectTimer !== null) scheduler.clearTimeout(binding.disconnectTimer)
    binding.leaseTimer = null
    binding.disconnectTimer = null
  }

  function liveRoomName(voiceTableId: VoiceTableId): string | null {
    return store.getLiveGeneration(voiceTableId)?.livekitRoomName ?? null
  }

  /** Незабавно отнемане на правата + изхвърляне (висок приоритет; не анулира JWT). */
  function revokeParticipant(roomName: string, identity: string): void {
    if (liveKit === null) return
    const api = liveKit.api
    void (async () => {
      await dispatcher.run({
        name: 'UpdateParticipant(revoke)',
        priority: 'high',
        idempotent: true,
        run: () => api.updateParticipantPermission(roomName, identity, REVOKED_PERMISSION),
      })
      await dispatcher.run({
        name: 'RemoveParticipant',
        priority: 'high',
        idempotent: true,
        run: () => api.removeParticipant(roomName, identity),
      })
    })().catch(() => {})
  }

  // ─── Mute ─────────────────────────────────────────────────────────────

  function readMute(profileId: string): { isMuted: boolean; mutedUntil: string | null } {
    try {
      const status = deps.getChatMuteStatus(profileId)
      return { isMuted: status.isMuted, mutedUntil: status.isMuted ? status.mutedUntil : null }
    } catch {
      // Fail-closed само за говоренето (същата политика като текстовия чат).
      return { isMuted: true, mutedUntil: null }
    }
  }

  function speakStateOf(decision: Extract<VoiceAccessDecision, { canListen: true }>, entitled: boolean, mutedUntil: string | null): VoiceSpeakState {
    if (decision.canSpeak) return { canSpeak: true, blockedReason: null, hasSpeakingEntitlement: entitled, mutedUntil: null }
    return {
      canSpeak: false,
      blockedReason: decision.speakDenialCode,
      hasSpeakingEntitlement: entitled,
      mutedUntil: decision.speakDenialCode === 'muted' ? mutedUntil : null,
    }
  }

  /** Състоянието на говорене за играч на масата (за presence/известия), без да създава участие. */
  function currentSpeakState(voiceTableId: VoiceTableId, profileId: string): VoiceSpeakState {
    const mute = readMute(profileId)
    const entitled = memberships.get(key(voiceTableId, profileId))?.entitled === true
    const vip = deps.isVipActive(profileId)
    if (mute.isMuted) return { canSpeak: false, blockedReason: 'muted', hasSpeakingEntitlement: entitled, mutedUntil: mute.mutedUntil }
    if (vip || entitled) return { canSpeak: true, blockedReason: null, hasSpeakingEntitlement: entitled, mutedUntil: null }
    return { canSpeak: false, blockedReason: 'vip_required', hasSpeakingEntitlement: false, mutedUntil: null }
  }

  /** Отнема само publish правото на identity-то (слушането остава); не анулира JWT. */
  function revokePublish(roomName: string, identity: string): void {
    if (liveKit === null) return
    const api = liveKit.api
    void dispatcher
      .run({
        name: 'UpdateParticipant(revoke publish)',
        priority: 'high',
        idempotent: true,
        run: () => api.updateParticipantPermission(roomName, identity, LISTEN_PERMISSION),
      })
      .catch(() => {})
  }

  // ─── Участия ──────────────────────────────────────────────────────────

  function persistMembershipStart(membership: MembershipState): void {
    writeQueue.enqueue(`m:${membership.voiceTableId}|${membership.profileId}`, 'membership start', () => {
      const result = store.startMembership({
        membershipId: membership.membershipId,
        voiceTableId: membership.voiceTableId,
        profileId: membership.profileId,
        entitled: membership.entitled,
        now: new Date(now()),
      })
      return !result.ok && result.code === 'busy' ? 'busy' : 'done'
    })
  }

  function startMembership(voiceTableId: VoiceTableId, profileId: string): MembershipState {
    const membership: MembershipState = {
      membershipId: randomUUID(),
      voiceTableId,
      profileId,
      entitled: deps.isVipActive(profileId),
    }
    memberships.set(key(voiceTableId, profileId), membership)
    persistMembershipStart(membership)
    return membership
  }

  function entitleMembership(membership: MembershipState): void {
    if (membership.entitled) return
    membership.entitled = true
    writeQueue.enqueue(`m:${membership.voiceTableId}|${membership.profileId}`, 'membership entitle', () => {
      const result = store.entitleMembership(membership.membershipId, new Date(now()))
      return !result.ok && result.code === 'busy' ? 'busy' : 'done'
    })
  }

  function endMembership(voiceTableId: VoiceTableId, profileId: string, reason: VoiceMembershipEndReason): void {
    const membershipKey = key(voiceTableId, profileId)
    const membership = memberships.get(membershipKey)
    if (membership === undefined) return
    memberships.delete(membershipKey)
    writeQueue.enqueue(`m:${voiceTableId}|${profileId}`, 'membership end', () => {
      const result = store.endMembership(membership.membershipId, reason, new Date(now()))
      return !result.ok && result.code === 'busy' ? 'busy' : 'done'
    })
  }

  // ─── Ротация ──────────────────────────────────────────────────────────

  function notifyTable(voiceTableId: VoiceTableId, message: VoiceServerMessage): void {
    for (const binding of bindings.values()) {
      if (binding.voiceTableId === voiceTableId) send(binding.connectionId, message)
    }
  }

  function tableReady(voiceTableId: VoiceTableId): boolean {
    return bootComplete && !blockedTables.has(voiceTableId) && !store.hasPendingRoomDeletion(voiceTableId)
  }

  function notifyTableReady(voiceTableId: VoiceTableId): void {
    const table = store.getVoiceTable(voiceTableId)
    if (table === null || table.status !== 'active' || !tableReady(voiceTableId)) return
    notifyTable(voiceTableId, {
      type: 'voice_table_updated',
      voiceTableId,
      generation: store.getLiveGeneration(voiceTableId)?.generation ?? null,
      ready: true,
    })
  }

  function applyRotation(voiceTableId: VoiceTableId, reason: VoiceRoomRetireReason): 'done' | 'busy' {
    const result = store.allocateGeneration(voiceTableId, reason, new Date(now()))
    if (!result.ok) {
      if (result.code === 'busy') return 'busy'
      blockedTables.delete(voiceTableId)
      return 'done'
    }
    blockedTables.delete(voiceTableId)
    counters.rotations! += 1
    log(`[voice-chat] rotation voiceTable=${voiceTableId} generation=${result.generation} reason=${reason}`)
    notifyTable(voiceTableId, { type: 'voice_table_updated', voiceTableId, generation: result.generation, ready: false })
    reconciler.kick()
    return 'done'
  }

  /**
   * Нова генерация на стаята. revoked — identity-та в СТАРАТА стая, чийто
   * достъп се отнема с приоритет преди DeleteRoom.
   */
  function rotateTable(voiceTableId: VoiceTableId, reason: VoiceRoomRetireReason, revoked: Array<{ roomName: string; identity: string }>): void {
    for (const target of revoked) revokeParticipant(target.roomName, target.identity)
    // До успешния запис токени не се издават (fail-closed).
    blockedTables.set(voiceTableId, 'rotation_pending')
    if (applyRotation(voiceTableId, reason) === 'busy') {
      writeQueue.enqueue(`t:${voiceTableId}`, 'rotation', () => applyRotation(voiceTableId, reason))
    }
  }

  // ─── Binding-и ────────────────────────────────────────────────────────

  function armLease(binding: BindingState): void {
    if (!binding.voiceActive || binding.connectionId === null || binding.leaseTimer !== null || disposed) return
    const delay = Math.max(0, binding.leaseExpiresAt - now())
    binding.leaseTimer = scheduler.setTimeout(() => {
      binding.leaseTimer = null
      if (bindings.get(binding.key) !== binding || !binding.voiceActive || binding.connectionId === null) return
      if (binding.leaseExpiresAt > now()) {
        armLease(binding)
        return
      }
      counters.leaseExpired! += 1
      endVoiceSession(binding, 'lease_expired', true)
    }, delay)
  }

  /**
   * Край на гласовия достъп на тази страница БЕЗ загуба на право (lease,
   * напуснат екран, 120 s): отнемане на правата + RemoveParticipant, без
   * ротация. binding-ът остава — ново изрично включване е позволено.
   */
  function endVoiceSession(binding: BindingState, reason: VoiceAccessEndReason, notify: boolean): void {
    clearBindingTimers(binding)
    if (binding.voiceActive && binding.issuedRoomName !== null) revokeParticipant(binding.issuedRoomName, binding.identity)
    binding.voiceActive = false
    if (notify) send(binding.connectionId, { type: 'voice_access_ended', voiceTableId: binding.voiceTableId, reason })
  }

  /**
   * Край на binding-а с ротация, ако на него е издаден токен за ТЕКУЩАТА
   * жива генерация (загубено право / изместена или сменена сесия).
   */
  function endBinding(binding: BindingState, reason: VoiceAccessEndReason, retireReason: VoiceRoomRetireReason): void {
    clearBindingTimers(binding)
    if (bindings.get(binding.key) === binding) bindings.delete(binding.key)
    send(binding.connectionId, { type: 'voice_access_ended', voiceTableId: binding.voiceTableId, reason })
    const live = liveRoomName(binding.voiceTableId)
    if (binding.issuedRoomName !== null && binding.issuedRoomName === live) {
      rotateTable(binding.voiceTableId, retireReason, [{ roomName: live, identity: binding.identity }])
    } else if (binding.voiceActive && binding.issuedRoomName !== null) {
      revokeParticipant(binding.issuedRoomName, binding.identity)
    }
    binding.voiceActive = false
  }

  function createBinding(voiceTableId: VoiceTableId, profileId: string, clientInstanceId: string, connectionId: string): BindingState {
    const bindingKey = key(voiceTableId, profileId)
    const epoch = (epochs.get(bindingKey) ?? 0) + 1
    epochs.set(bindingKey, epoch)
    const binding: BindingState = {
      key: bindingKey,
      voiceTableId,
      profileId,
      clientInstanceId,
      connectionId,
      epoch,
      identity: buildVoiceIdentity(profileId, epoch),
      onTableScreen: false,
      leaseExpiresAt: 0,
      leaseTimer: null,
      disconnectTimer: null,
      issuedRoomName: null,
      issuedCanPublish: false,
      voiceActive: false,
    }
    bindings.set(bindingKey, binding)
    return binding
  }

  // ─── Освобождаване на маса ───────────────────────────────────────────

  function handleTableReleased(voiceTableId: VoiceTableId, reason: 'table_released' | 'voice_off'): void {
    blockedTables.delete(voiceTableId)
    for (const binding of [...bindings.values()]) {
      if (binding.voiceTableId !== voiceTableId) continue
      clearBindingTimers(binding)
      bindings.delete(binding.key)
      send(binding.connectionId, { type: 'voice_access_ended', voiceTableId, reason })
      binding.voiceActive = false
    }
    for (const [membershipKey, membership] of [...memberships.entries()]) {
      if (membership.voiceTableId === voiceTableId) memberships.delete(membershipKey)
    }
    reconciler.kick()
  }

  function releaseTable(voiceTableId: VoiceTableId, reason: VoiceTableReleaseReason): void {
    blockedTables.set(voiceTableId, 'releasing')
    const outcome = releaseQueue.release(voiceTableId, reason)
    if (outcome.status === 'already_released') handleTableReleased(voiceTableId, 'table_released')
    // 'released' -> onReleased вече е извикал handleTableReleased;
    // 'queued'   -> масата остава блокирана до успешния запис.
  }

  // ─── Оценка на заявка (синхронна, авторитетна) ───────────────────────

  function evaluateClaim(
    claim: { profileId: string; voiceTableId: string; clientInstanceId: string },
    options: { createMembership: boolean },
  ): EvaluationFailure | EvaluationSuccess {
    const mode = effectiveMode()
    if (mode === 'off') return { ok: false, status: 403, code: 'voice_off' }
    if (liveKit === null) return { ok: false, status: 503, code: 'voice_unavailable' }
    if (!bootComplete) return { ok: false, status: 503, code: 'voice_starting', retryAfterMs: 2_000 }
    const table = store.getVoiceTable(claim.voiceTableId)
    if (table === null) return { ok: false, status: 404, code: 'table_not_found' }
    if (table.status !== 'active') return { ok: false, status: 410, code: 'table_released' }
    if (blockedTables.has(table.voiceTableId)) return { ok: false, status: 503, code: 'voice_rotation_pending', retryAfterMs: 1_000 }

    const isBanned = deps.isBanned(claim.profileId)
    const seat = deps.resolveSeat(claim.profileId, table)
    const bindingKey = key(table.voiceTableId, claim.profileId)
    const binding = bindings.get(bindingKey) ?? null
    const seatConnectionId = seat.relation === 'player' ? seat.seatConnectionId : null
    const sessionBindingCurrent =
      binding !== null &&
      isVoiceSessionBindingCurrent(
        claim,
        {
          profileId: binding.profileId,
          voiceTableId: binding.voiceTableId,
          clientInstanceId: binding.clientInstanceId,
          gameConnectionId: binding.connectionId,
          bindingEpoch: binding.epoch,
        },
        seatConnectionId,
      ) &&
      deps.isConnectionOpen(binding.connectionId!)

    let membership = memberships.get(bindingKey) ?? null
    const mute = readMute(claim.profileId)
    const decision = evaluateVoiceAccess({
      mode: { storedMode: mode, emergencyStop: false },
      requester: {
        profileId: claim.profileId,
        isFullAdmin: false,
        isVipActive: deps.isVipActive(claim.profileId),
        isBanned,
        isChatMuted: mute.isMuted,
      },
      requestedVoiceTableId: claim.voiceTableId,
      table: { voiceTableId: table.voiceTableId, status: table.status, phase: table.phase },
      membership: {
        relation: seat.relation,
        seatedVoiceTableId: seat.relation === 'player' ? table.voiceTableId : null,
        permanentlyLeft: seat.relation === 'player' && seat.permanentlyLeft,
      },
      sessionBindingCurrent,
      hasSpeakingEntitlement: membership?.entitled === true,
    })
    if (!decision.canListen) return { ok: false, status: DENIAL_STATUS[decision.denialCode], code: decision.denialCode }
    if (binding === null) return { ok: false, status: 409, code: 'invalid_session' }
    if (!binding.onTableScreen || binding.leaseExpiresAt <= now()) return { ok: false, status: 409, code: 'presence_required' }

    if (membership === null) {
      // Пропусната кука за сядане (не би трябвало) — консервативно ново
      // участие с правото, което профилът има СЕГА.
      if (!options.createMembership) return { ok: false, status: 409, code: 'voice_state_changed' }
      membership = startMembership(table.voiceTableId, claim.profileId)
    }
    if (store.hasPendingRoomDeletion(table.voiceTableId)) return { ok: false, status: 503, code: 'voice_rotation_pending', retryAfterMs: 1_000 }

    const live = store.getLiveGeneration(table.voiceTableId)
    const fingerprint = [
      live?.livekitRoomName ?? '-',
      binding.epoch,
      binding.connectionId,
      membership.membershipId,
      decision.canSpeak ? 'speak' : 'listen',
      mode,
    ].join('|')
    return {
      ok: true,
      table,
      binding,
      membership,
      decision,
      liveRoomName: live?.livekitRoomName ?? null,
      liveGeneration: live?.generation ?? null,
      speak: speakStateOf(decision, membership.entitled, mute.mutedUntil),
      fingerprint,
    }
  }

  function failure(evaluation: EvaluationFailure): VoiceHttpResult {
    countDenial(evaluation.code)
    const body: Record<string, unknown> = { ok: false, code: evaluation.code }
    if (evaluation.retryAfterMs !== undefined) body.retryAfterMs = evaluation.retryAfterMs
    return { status: evaluation.status, body }
  }

  function unavailable(code: string, retryAfterMs: number): VoiceHttpResult {
    countDenial(code)
    return { status: 503, body: { ok: false, code, retryAfterMs } }
  }

  // ─── CreateRoom (lazy, сериализиран по име) ──────────────────────────

  function ensureRoomCreated(roomName: string): Promise<VoiceDispatchResult<void>> {
    const existing = pendingCreates.get(roomName)
    if (existing !== undefined) return existing
    if (liveKit === null || !store.isLiveRoomName(roomName)) {
      return Promise.resolve({ ok: false, code: 'rejected', attempts: 0, error: null })
    }
    const api = liveKit.api
    const promise = dispatcher
      .run({
        name: 'CreateRoom',
        priority: 'normal',
        idempotent: true,
        run: () =>
          api.createRoom({
            name: roomName,
            maxParticipants: VOICE_ROOM_MAX_PARTICIPANTS,
            emptyTimeoutSeconds: VOICE_ROOM_EMPTY_TIMEOUT_SECONDS,
            departureTimeoutSeconds: VOICE_ROOM_DEPARTURE_TIMEOUT_SECONDS,
          }),
      })
      .then((result) => {
        // Timeout/мрежова грешка (дори при последващ успех) -> заявката може да
        // стигне до LiveKit по-късно: наблюдение срещу възкресяване на името.
        if ((!result.ok && result.code === 'transient') || result.attempts > 1) reconciler.noteUncertainCreate(roomName)
        if (!result.ok) counters.createRoomFailures! += 1
        return result
      })
    pendingCreates.set(roomName, promise)
    reconciler.trackCreate(roomName, promise)
    void promise.finally(() => {
      if (pendingCreates.get(roomName) === promise) pendingCreates.delete(roomName)
    })
    return promise
  }

  // ─── Публични куки ────────────────────────────────────────────────────

  const service: VoiceChatService = {
    describeCreationOption({ profileId, isFullAdmin }) {
      return describeVoiceTableCreationOption({
        mode: { storedMode: store.getSettings().mode, emergencyStop: isVoiceChatEmergencyStopActive(env) },
        requester: { profileId, isFullAdmin, isVipActive: deps.isVipActive(profileId), isBanned: deps.isBanned(profileId) },
      })
    },
    reserveVoiceTableForPrivateRoom({ profileId, isFullAdmin }) {
      const settings = store.getSettings()
      const emergencyStop = isVoiceChatEmergencyStopActive(env)
      const decision = evaluateVoiceTableCreation({
        mode: { storedMode: settings.mode, emergencyStop },
        requester: { profileId, isFullAdmin, isVipActive: deps.isVipActive(profileId), isBanned: deps.isBanned(profileId) },
      })
      if (!decision.ok) {
        switch (decision.code) {
          case 'voice_off':
            return { ok: false, code: 'voice_chat_off', message: 'Гласовият чат в момента е изключен.' }
          case 'admin_only_mode':
            return { ok: false, code: 'voice_chat_admin_only', message: 'Гласовият чат в момента е достъпен само за тестване от администратори.' }
          case 'vip_required':
            return { ok: false, code: 'voice_chat_vip_required', message: 'Създаването на гласова маса е VIP привилегия.' }
          case 'banned':
            return { ok: false, code: 'voice_chat_banned', message: 'Профилът не може да създава гласови маси.' }
          default:
            return { ok: false, code: 'voice_chat_off', message: 'Гласовият чат не е достъпен.' }
        }
      }
      if (liveKit === null || !bootComplete) {
        return { ok: false, code: 'voice_chat_unavailable', message: 'Гласовият чат временно не е наличен. Можете да създадете масата без гласов чат.' }
      }
      const reserved = store.reserveVoiceTable({ emergencyStop, requesterIsFullAdmin: isFullAdmin, now: new Date(now()) })
      if (reserved.ok) return { ok: true, voiceTableId: reserved.table.voiceTableId }
      switch (reserved.code) {
        case 'capacity_reached':
          return {
            ok: false,
            code: 'voice_chat_capacity_reached',
            message: 'В момента всички гласови маси са заети. Можете да създадете масата без гласов чат.',
            activeCount: reserved.activeCount,
            maxTables: reserved.maxTables,
          }
        case 'admin_only_mode':
          return { ok: false, code: 'voice_chat_admin_only', message: 'Гласовият чат в момента е достъпен само за тестване от администратори.' }
        case 'voice_off':
          return { ok: false, code: 'voice_chat_off', message: 'Гласовият чат в момента е изключен.' }
        default:
          return { ok: false, code: 'voice_chat_busy', message: 'Гласовият чат е зает. Опитайте отново или създайте масата без гласов чат.' }
      }
    },

    attachPrivateRoom(voiceTableId, privateRoomId, creatorProfileId) {
      const bind = (): 'done' | 'busy' => {
        const result = store.bindPrivateRoom(voiceTableId, privateRoomId)
        if (!result.ok && result.code === 'busy') return 'busy'
        if (!result.ok) log(`[voice-chat] bindPrivateRoom voiceTable=${voiceTableId} failed: ${result.code}`)
        return 'done'
      }
      if (bind() === 'busy') writeQueue.enqueue(`t:${voiceTableId}`, 'bind private room', bind)
      startMembership(voiceTableId, creatorProfileId)
    },

    abortReservation(voiceTableId) {
      releaseTable(voiceTableId, 'reservation_aborted')
    },

    onMemberSeated(voiceTableId, profileId) {
      // Ново сядане = ново участие (предишното, ако е останало, приключва).
      const previous = bindings.get(key(voiceTableId, profileId))
      if (previous !== undefined) endBinding(previous, 'left_table', 'listen_revoked')
      startMembership(voiceTableId, profileId)
    },

    onMemberRemoved(voiceTableId, profileId, reason) {
      const binding = bindings.get(key(voiceTableId, profileId))
      if (binding !== undefined) endBinding(binding, reason === 'kicked' ? 'kicked' : 'left_table', 'listen_revoked')
      endMembership(voiceTableId, profileId, reason)
    },

    onWaitingRoomEnded(voiceTableId, reason) {
      releaseTable(voiceTableId, reason)
    },

    onGameStarted(voiceTableId, serverRoomId) {
      const mark = (): 'done' | 'busy' => {
        const result = store.markInGame(voiceTableId, serverRoomId, new Date(now()))
        if (!result.ok && result.code === 'busy') return 'busy'
        if (!result.ok) log(`[voice-chat] markInGame voiceTable=${voiceTableId} failed: ${result.code}`)
        return 'done'
      }
      if (mark() === 'busy') writeQueue.enqueue(`t:${voiceTableId}`, 'mark in game', mark)
    },

    onGameStartFailed(voiceTableId) {
      releaseTable(voiceTableId, 'game_start_failed')
    },

    onServerRoomRemoved(voiceTableId) {
      releaseTable(voiceTableId, 'server_room_removed')
    },

    onProfileRevoked(profileId, reason) {
      for (const binding of [...bindings.values()]) {
        if (binding.profileId === profileId) endBinding(binding, 'banned', 'listen_revoked')
      }
      for (const membership of [...memberships.values()]) {
        if (membership.profileId === profileId) endMembership(membership.voiceTableId, profileId, reason)
      }
    },

    onChatMuteChanged(profileId) {
      const mute = readMute(profileId)
      for (const binding of [...bindings.values()]) {
        if (binding.profileId !== profileId) continue
        if (mute.isMuted) {
          const live = liveRoomName(binding.voiceTableId)
          if (live !== null && binding.issuedRoomName === live && binding.issuedCanPublish) {
            // (1) веднага: без publish (микрофонът спира), слушането остава;
            // (2) ротация: стар токен с canPublish:true е вързан за старото
            //     име и не може да върне говоренето; новият токен е само за
            //     слушане. Мястото, участието и придобитото право се пазят.
            revokePublish(live, binding.identity)
            counters.muteRevocations! += 1
            rotateTable(binding.voiceTableId, 'speak_revoked', [])
          }
        }
        send(binding.connectionId, {
          type: 'voice_speak_access_updated',
          voiceTableId: binding.voiceTableId,
          speak: currentSpeakState(binding.voiceTableId, profileId),
        })
      }
    },

    onGameConnectionDisplaced(connectionId) {
      for (const binding of [...bindings.values()]) {
        if (binding.connectionId !== connectionId) continue
        send(binding.connectionId, { type: 'voice_access_ended', voiceTableId: binding.voiceTableId, reason: 'session_displaced' })
        // Изместената връзка веднага губи правото да иска токени (binding-ът
        // вече не сочи към нея). Ако на нея е имало глас, кратко се изчаква
        // дали същата страница ще си върне сесията от новата връзка; иначе —
        // край с ротация (стар токен на изместена сесия не важи).
        binding.connectionId = null
        if (binding.leaseTimer !== null) scheduler.clearTimeout(binding.leaseTimer)
        binding.leaseTimer = null
        const hadLiveToken = binding.issuedRoomName !== null && binding.issuedRoomName === liveRoomName(binding.voiceTableId)
        if (!binding.voiceActive && !hadLiveToken) continue
        if (binding.disconnectTimer !== null) scheduler.clearTimeout(binding.disconnectTimer)
        binding.disconnectTimer = scheduler.setTimeout(() => {
          binding.disconnectTimer = null
          if (bindings.get(binding.key) !== binding || binding.connectionId !== null) return
          endBinding(binding, 'session_displaced', 'session_displaced')
        }, displacementReclaimMs)
      }
    },

    onGameConnectionClosed(connectionId) {
      for (const binding of bindings.values()) {
        if (binding.connectionId !== connectionId) continue
        binding.connectionId = null
        if (binding.leaseTimer !== null) scheduler.clearTimeout(binding.leaseTimer)
        binding.leaseTimer = null
        if (!binding.voiceActive || binding.disconnectTimer !== null) continue
        binding.disconnectTimer = scheduler.setTimeout(() => {
          binding.disconnectTimer = null
          if (bindings.get(binding.key) !== binding || binding.connectionId !== null || !binding.voiceActive) return
          counters.disconnectTimeouts! += 1
          endVoiceSession(binding, 'game_connection_lost', false)
        }, disconnectGraceMs)
      }
    },

    handlePresence(connectionId, profileId, message) {
      const reply = (code: VoicePresenceErrorCode): void =>
        send(connectionId, { type: 'voice_presence_result', voiceTableId: message.voiceTableId, ok: false, code })
      if (effectiveMode() === 'off') return reply('voice_off')
      if (profileId === null) return reply('not_authenticated')
      const table = store.getVoiceTable(message.voiceTableId)
      if (table === null) return reply('table_not_found')
      if (table.status !== 'active') return reply('table_released')
      if (deps.isBanned(profileId)) return reply('banned')
      const seat = deps.resolveSeat(profileId, table)
      if (seat.relation !== 'player' || seat.permanentlyLeft) return reply('not_a_player')
      if (seat.seatConnectionId !== connectionId) return reply('not_seat_connection')

      const bindingKey = key(table.voiceTableId, profileId)
      let binding = bindings.get(bindingKey) ?? null

      if (!message.onTableScreen) {
        if (binding !== null && binding.clientInstanceId === message.clientInstanceId) {
          binding.connectionId = connectionId
          binding.onTableScreen = false
          binding.leaseExpiresAt = 0
          endVoiceSession(binding, 'left_table', false)
        }
        send(connectionId, {
          type: 'voice_presence_result',
          voiceTableId: table.voiceTableId,
          ok: true,
          onTableScreen: false,
          leaseTtlMs,
          renewAfterMs: leaseRenewMs,
          ready: tableReady(table.voiceTableId),
          speak: currentSpeakState(table.voiceTableId, profileId),
        })
        return
      }

      if (binding !== null && binding.clientInstanceId !== message.clientInstanceId) {
        // Една и съща игрова връзка не може да "смени" страницата си.
        if (binding.connectionId === connectionId) return reply('client_instance_conflict')
        // Нова страница (refresh/друго устройство) от актуалната seat връзка:
        // старата гласова сесия се прекратява; ротация, ако е имала токен.
        endBinding(binding, 'session_replaced', 'session_displaced')
        binding = null
      }
      if (binding === null) {
        binding = createBinding(table.voiceTableId, profileId, message.clientInstanceId, connectionId)
      } else if (binding.connectionId !== connectionId) {
        // Същата страница от нова игрова връзка (network reconnect).
        binding.connectionId = connectionId
      }
      if (binding.disconnectTimer !== null) {
        scheduler.clearTimeout(binding.disconnectTimer)
        binding.disconnectTimer = null
      }
      binding.onTableScreen = true
      binding.leaseExpiresAt = now() + leaseTtlMs
      armLease(binding)
      if (!memberships.has(bindingKey)) startMembership(table.voiceTableId, profileId)
      send(connectionId, {
        type: 'voice_presence_result',
        voiceTableId: table.voiceTableId,
        ok: true,
        onTableScreen: true,
        leaseTtlMs,
        renewAfterMs: leaseRenewMs,
        ready: tableReady(table.voiceTableId),
        speak: currentSpeakState(table.voiceTableId, profileId),
      })
    },

    async handleTokenRequest(claim, respond) {
      // (1) Проверка преди асинхронните операции.
      const first = evaluateClaim(claim, { createMembership: true })
      if (!first.ok) return respond(failure(first))
      if (shouldPersistSpeakingEntitlement(first.decision, first.membership.entitled)) entitleMembership(first.membership)

      if (first.liveRoomName === null) {
        const allocated = store.allocateGeneration(first.table.voiceTableId, null, new Date(now()))
        if (!allocated.ok) return respond(unavailable(allocated.code === 'busy' ? 'voice_busy' : 'voice_state_changed', 1_000))
      }
      if (!dispatcher.isAvailable()) return respond(unavailable('voice_unavailable', Math.max(1_000, dispatcher.retryAfterMs())))

      const before = evaluateClaim(claim, { createMembership: false })
      if (!before.ok) return respond(failure(before))
      if (before.liveRoomName === null) return respond(unavailable('voice_state_changed', 500))
      const roomName = before.liveRoomName

      // (2) CreateRoom (lazy, идемпотентен, с реален timeout) и проверка след него.
      const created = await ensureRoomCreated(roomName)
      if (!created.ok) return respond(unavailable('voice_unavailable', Math.max(1_000, dispatcher.retryAfterMs())))
      const afterCreate = evaluateClaim(claim, { createMembership: false })
      if (!afterCreate.ok) return respond(failure(afterCreate))
      if (afterCreate.fingerprint !== before.fingerprint) {
        counters.tokensDiscardedStale! += 1
        return respond({ status: 409, body: { ok: false, code: 'voice_state_changed' } })
      }

      // Маркира се като издаден ПРЕДИ подписа (консервативно за решенията
      // за ротация, ако състоянието се промени по време на подписа).
      const binding = afterCreate.binding
      const permission = toVoiceLiveKitPermissionProfile(afterCreate.decision)!
      binding.issuedRoomName = roomName
      binding.issuedCanPublish = permission.canPublish
      binding.voiceActive = true
      armLease(binding)

      // (3) Подпис (официален AccessToken, асинхронен) и проверка след него.
      let jwt: string
      try {
        jwt = await liveKit!.signToken({ identity: binding.identity, roomName, permission })
      } catch {
        return respond({ status: 500, body: { ok: false, code: 'token_sign_failed' } })
      }
      // (4) Окончателна синхронна проверка непосредствено преди предаването.
      const final = evaluateClaim(claim, { createMembership: false })
      if (!final.ok) {
        counters.tokensDiscardedStale! += 1
        return respond(failure(final))
      }
      if (final.fingerprint !== before.fingerprint) {
        counters.tokensDiscardedStale! += 1
        return respond({ status: 409, body: { ok: false, code: 'voice_state_changed' } })
      }
      counters.tokensIssued! += 1
      respond({
        status: 200,
        body: {
          ok: true,
          url: liveKit!.wsUrl,
          token: jwt,
          identity: binding.identity,
          voiceTableId: final.table.voiceTableId,
          generation: final.liveGeneration,
          canSpeak: permission.canPublish,
          // Само към самия играч: защо не може да говори (липсващ VIP / mute) и срокът на mute.
          speak: final.speak,
          expiresInSeconds: VOICE_TOKEN_TTL_SECONDS,
        },
      })
    },

    async handleSpeakAccessRequest(claim, respond) {
      const first = evaluateClaim(claim, { createMembership: true })
      if (!first.ok) return respond(failure(first))
      // И при mute: VIP по време на участието придобива правото (за след наказанието).
      if (shouldPersistSpeakingEntitlement(first.decision, first.membership.entitled)) entitleMembership(first.membership)
      if (!first.decision.canSpeak) {
        return respond({
          status: 200,
          body: {
            ok: true,
            canSpeak: false,
            code: first.decision.speakDenialCode,
            speak: speakStateOf(first.decision, first.membership.entitled, first.speak.mutedUntil),
          },
        })
      }
      const binding = first.binding
      const live = first.liveRoomName
      if (!binding.voiceActive || binding.issuedRoomName === null || binding.issuedRoomName !== live) {
        // Няма текуща връзка — следващият токен ще позволява микрофон.
        return respond({ status: 200, body: { ok: true, canSpeak: true, upgrade: 'request_new_token' } })
      }
      if (binding.issuedCanPublish) {
        return respond({ status: 200, body: { ok: true, canSpeak: true, upgrade: 'already_allowed' } })
      }
      // Безопасно повишаване на място (без реконект). Консервативно се
      // маркира преди заявката. Микрофонът НЕ се включва — клиентът изисква
      // второ изрично действие.
      binding.issuedCanPublish = true
      const result = liveKit === null
        ? null
        : await dispatcher.run({
            name: 'UpdateParticipant(grant)',
            priority: 'normal',
            idempotent: true,
            run: () => liveKit.api.updateParticipantPermission(live, binding.identity, SPEAK_PERMISSION),
          })
      const after = evaluateClaim(claim, { createMembership: false })
      if (!after.ok) return respond(failure(after))
      if (after.fingerprint !== first.fingerprint || result === null || !result.ok) {
        return respond({ status: 200, body: { ok: true, canSpeak: true, upgrade: 'request_new_token' } })
      }
      counters.speakUpgrades! += 1
      respond({ status: 200, body: { ok: true, canSpeak: true, upgrade: 'updated' } })
    },

    onModeChanged(result) {
      if (result.settings.mode !== 'off') return
      for (const voiceTableId of result.releasedVoiceTableIds) handleTableReleased(voiceTableId, 'voice_off')
      reconciler.kick()
    },

    boot(restoredRooms) {
      const restoredServerRoomIds = new Set<string>()
      const restoredActiveProfileIds = new Map<string, Set<string>>()
      for (const room of restoredRooms) {
        if (room.voiceTableId === null) continue
        restoredServerRoomIds.add(room.serverRoomId)
        restoredActiveProfileIds.set(room.serverRoomId, new Set(room.activeProfileIds))
      }
      const attempt = (): 'done' | 'busy' => {
        const result = store.reconcileOnBoot({
          restoredServerRoomIds,
          restoredActiveProfileIds,
          releaseAll: isVoiceChatEmergencyStopActive(env),
          now: new Date(now()),
        })
        if (!result.ok) return 'busy'
        for (const membership of store.listActiveMemberships()) {
          memberships.set(key(membership.voiceTableId, membership.profileId), {
            membershipId: membership.membershipId,
            voiceTableId: membership.voiceTableId,
            profileId: membership.profileId,
            entitled: membership.speakingEntitledAt !== null,
          })
        }
        // T1: лични данни + технически записи — малки партиди, повторен опит
        // при busy, после на всеки 6 часа (не блокира старта).
        retention.start()
        bootComplete = true
        log(
          `[voice-chat] boot reconcile released=${result.releasedVoiceTableIds.length} retained=${result.retainedVoiceTableIds.length}` +
            ` retiredRooms=${result.retiredRoomNames.length} endedMemberships=${result.endedMembershipIds.length}`,
        )
        if (liveKit !== null) reconciler.requestBootSweep()
        reconciler.kick()
        return 'done'
      }
      if (attempt() === 'busy') writeQueue.enqueue('boot', 'boot reconcile', attempt)
    },

    stats() {
      let activeVoiceSessions = 0
      for (const binding of bindings.values()) if (binding.voiceActive) activeVoiceSessions += 1
      return {
        bootComplete,
        liveKitConfigured: liveKit !== null,
        bindings: bindings.size,
        activeVoiceSessions,
        blockedTables: blockedTables.size,
        memberships: memberships.size,
        pendingStoreWrites: writeQueue.pendingCount() + releaseQueue.pendingCount(),
        dispatcher: dispatcher.stats(),
        reconciler: reconciler.stats(),
        counters: { ...counters },
        tokensDeniedByCode: { ...tokensDeniedByCode },
      }
    },

    adminTables() {
      const seated = new Map<string, number>()
      for (const membership of memberships.values()) seated.set(membership.voiceTableId, (seated.get(membership.voiceTableId) ?? 0) + 1)
      const active = new Map<string, number>()
      for (const binding of bindings.values()) if (binding.voiceActive) active.set(binding.voiceTableId, (active.get(binding.voiceTableId) ?? 0) + 1)
      return store.listActiveVoiceTables().map((table) => {
        const live = store.getLiveGeneration(table.voiceTableId)
        return {
          voiceTableId: table.voiceTableId,
          phase: table.phase,
          createdAt: table.createdAt,
          inGameAt: table.inGameAt,
          liveRoomName: live?.livekitRoomName ?? null,
          generation: live?.generation ?? null,
          seatedMembers: seated.get(table.voiceTableId) ?? 0,
          activeVoiceSessions: active.get(table.voiceTableId) ?? 0,
          blocked: blockedTables.get(table.voiceTableId) ?? null,
        }
      })
    },

    dispose() {
      disposed = true
      for (const binding of bindings.values()) clearBindingTimers(binding)
      reconciler.dispose()
      retention.dispose()
      releaseQueue.dispose()
      writeQueue.dispose()
      dispatcher.dispose()
    },

    debug: {
      reconciler,
      getBinding: (voiceTableId, profileId) => bindings.get(key(voiceTableId, profileId)) ?? null,
      getMembership: (voiceTableId, profileId) => memberships.get(key(voiceTableId, profileId)) ?? null,
    },
  }

  return service
}
