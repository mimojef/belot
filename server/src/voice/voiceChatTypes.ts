// Гласов чат в частните маси на Белот — общи типове (Етапи 2а и 2б).
//
// Модулът server/src/voice/ НЕ зависи от index.ts или WebSocket слоя.
// Етап 2а: режим/лимит (voiceChatStore.ts), чиста eligibility логика
// (voiceChatEligibility.ts), слотове и генерации на стаята. Етап 2б: право
// за говорене, обвързано с участието (voice_table_memberships), session
// binding, LiveKit API клиент, издаване на токени, ротация и reconciliation
// (voiceChatService.ts и съседните модули). LiveKit SDK се ползва само от
// voiceLiveKitApi.ts и voiceTokenIssuer.ts.

// ─── Административен режим ────────────────────────────────────────────────

/**
 * 'off'        — функцията е изключена: нови гласови маси/токени няма;
 *                превключването към 'off' освобождава всички активни гласови
 *                маси и оттегля живите им стаи (voiceChatStore.setMode).
 * 'admin_only' — само пълен admin С активен VIP създава гласова маса;
 *                участниците в нея следват общите права за слушане/говорене.
 * 'public'     — всеки VIP играч създава гласова маса.
 *
 * Превключване public <-> admin_only НЕ засяга вече съществуващите маси —
 * ограничението важи само за новите.
 */
export type VoiceChatMode = 'off' | 'admin_only' | 'public'

export const VOICE_CHAT_MODES: readonly VoiceChatMode[] = ['off', 'admin_only', 'public']

/** Без нито един запис в одита — винаги изключено. */
export const VOICE_CHAT_DEFAULT_MODE: VoiceChatMode = 'off'

export const VOICE_CHAT_DEFAULT_MAX_TABLES = 10

/** Защитен таван за административната настройка (не е продуктов лимит). */
export const VOICE_CHAT_MAX_TABLES_UPPER_BOUND = 200

export function isVoiceChatMode(value: unknown): value is VoiceChatMode {
  return value === 'off' || value === 'admin_only' || value === 'public'
}

export type VoiceChatAdminSetting = 'mode' | 'max_tables'

export type VoiceChatActor = {
  /** null за системни промени (тестове/скриптове); реалните са от пълен admin. */
  profileId: string | null
}

export type VoiceChatSettingsSnapshot = {
  /** Записаният режим (без аварийния стоп — той е env, виж voiceChatFeatureFlag.ts). */
  mode: VoiceChatMode
  modeChangedAt: string | null
  modeChangedByProfileId: string | null
  maxTables: number
  maxTablesChangedAt: string | null
  maxTablesChangedByProfileId: string | null
}

export type VoiceChatAdminChange = {
  changeId: string
  setting: VoiceChatAdminSetting
  newValue: string
  previousValue: string
  changedByProfileId: string | null
  changedAt: string
}

// ─── Гласова маса и слот ──────────────────────────────────────────────────

/** Отделен случаен UUID — НЕ съвпада с privateRoomId или ServerRoom.id. */
export type VoiceTableId = string

/**
 * 'active'   — заема точно един слот от лимита (и в чакалнята, и в играта,
 *              и на финалния екран, и в повторните игри).
 * 'released' — крайно състояние; редът никога не се активира отново.
 */
export type VoiceTableStatus = 'active' | 'released'

/** Само описание къде е масата — НЕ е второ резервиране. */
export type VoiceTablePhase = 'waiting' | 'in_game'

export type VoiceTableReleaseReason =
  /** Резервацията е направена, но create_private_room не е завършил. */
  | 'reservation_aborted'
  | 'waiting_room_closed'
  | 'waiting_room_expired'
  /** Последният човек е напуснал чакалнята (privateRoomsStore трие масата без onRoomClosed). */
  | 'waiting_room_empty'
  /** handlePrivateRoomReady не е успял да стартира играта (капацитет/залози). */
  | 'game_start_failed'
  | 'server_room_removed'
  | 'mode_off'
  /** Рестарт: чакалните (in-memory) не оцеляват. */
  | 'boot_waiting_room_lost'
  /** Рестарт: игровата стая не е възстановена от snapshot. */
  | 'boot_server_room_missing'

export const VOICE_TABLE_RELEASE_REASONS: readonly VoiceTableReleaseReason[] = [
  'reservation_aborted',
  'waiting_room_closed',
  'waiting_room_expired',
  'waiting_room_empty',
  'game_start_failed',
  'server_room_removed',
  'mode_off',
  'boot_waiting_room_lost',
  'boot_server_room_missing',
]

export type VoiceTableRecord = {
  voiceTableId: VoiceTableId
  status: VoiceTableStatus
  phase: VoiceTablePhase
  privateRoomId: string | null
  serverRoomId: string | null
  /** Наследено от Етап 2а (match-scoped grace); от Етап 2б винаги 1 и не се използва. */
  matchSeq: number
  createdAt: string
  inGameAt: string | null
  releasedAt: string | null
  releaseReason: VoiceTableReleaseReason | null
}

// ─── Генерации на LiveKit стаята ──────────────────────────────────────────

/** Уникално, неповторимо име: виж voiceRoomNaming.ts. */
export type VoiceRoomName = string

/**
 * 'live'           — единствената генерация, за която може да се издава токен.
 * 'delete_pending' — оттеглена; чака потвърден DeleteRoom (durable опашка).
 * 'deleted'        — DeleteRoom е потвърден. Името НИКОГА не се създава отново.
 */
export type VoiceRoomGenerationStatus = 'live' | 'delete_pending' | 'deleted'

export type VoiceRoomRetireReason =
  /** Член с издаден токен е загубил правото да слуша (напускане/изгонване/бан). */
  | 'listen_revoked'
  /**
   * Наследено от Етап 2а. От Етап 2б правото за говорене НЕ се отнема при
   * изтичане на VIP (виж voice_table_memberships), затова не се използва.
   */
  | 'speak_revoked'
  /** Изместена игрова сесия, на която е бил издаден токен. */
  | 'session_displaced'
  | 'table_released'
  | 'mode_off'
  /** След рестарт: издадените токени не са известни -> нова генерация. */
  | 'boot_rotation'

export type VoiceRoomGenerationRecord = {
  livekitRoomName: VoiceRoomName
  voiceTableId: VoiceTableId
  generation: number
  status: VoiceRoomGenerationStatus
  createdAt: string
  retireRequestedAt: string | null
  retireReason: VoiceRoomRetireReason | null
  deleteAttempts: number
  nextDeleteAttemptAt: string | null
  lastDeleteError: string | null
  deletedConfirmedAt: string | null
}

// ─── Membership, сесия и права ────────────────────────────────────────────

/**
 * Отношение на профила към гласовата маса, изведено от АВТОРИТЕТНОТО
 * игрово състояние (PrivateRoom slots / ServerRoom seats), никога от клиента.
 */
export type VoiceRelation = 'player' | 'spectator' | 'bot' | 'none'

export type VoiceMembershipFacts = {
  relation: VoiceRelation
  /** voiceTableId на масата, на която профилът реално седи (null = не седи на гласова маса). */
  seatedVoiceTableId: VoiceTableId | null
  /** HumanRoomParticipant.permanentlyLeftAt !== null — окончателно напуснал. */
  permanentlyLeft: boolean
}

/**
 * Обвързване на гласовия достъп с АВТОРИТЕТНАТА игрова сесия (Етап 2б).
 * clientInstanceId е случаен идентификатор на конкретната страница/таб
 * (генерира се в паметта на клиента, не се пази в storage). Обикновен
 * WebSocket reconnect от същата страница пази същия clientInstanceId (сменя
 * се само gameConnectionId); refresh/друг таб/устройство = друг
 * clientInstanceId. Регистрира се САМО през игровия WebSocket от връзката,
 * която в момента държи мястото на масата (seat connection) — HTTP заявка
 * не може да създаде/премести binding. bindingEpoch расте при всяка смяна
 * на clientInstanceId за профила на масата и е част от LiveKit identity —
 * стар токен на изместена сесия има ДРУГО identity (не може да изхвърли
 * новия участник чрез DUPLICATE_IDENTITY) и се обезсилва чрез ротация
 * (VoiceRoomRetireReason 'session_displaced').
 */
export type VoiceSessionBinding = {
  profileId: string
  voiceTableId: VoiceTableId
  clientInstanceId: string
  /** Игровата WS връзка, през която е регистриран binding-ът; null = връзката е затворена. */
  gameConnectionId: string | null
  bindingEpoch: number
}

/** Това, което заявката за токен представя (Етап 2б). */
export type VoiceSessionClaim = {
  profileId: string
  voiceTableId: VoiceTableId
  clientInstanceId: string
}

// ─── Участие и право за говорене (Етап 2б) ───────────────────────────────

export type VoiceMembershipEndReason =
  /** Напуснал е чакалнята (освободил е мястото си). */
  | 'left_waiting_room'
  /** Изгонен от домакина в чакалнята. */
  | 'kicked'
  /** Окончателно напускане на започналата игра (permanentlyLeftAt). */
  | 'permanently_left'
  | 'banned'
  /** Профилът е изтрит/спрян от администратор. */
  | 'profile_revoked'
  /** Ново сядане на същия профил — предишното участие безусловно приключва. */
  | 'superseded'
  /** Гласовата маса е освободена (разпадане, край, изключване на гласа). */
  | 'table_released'
  /** Рестарт: профилът не е активен участник във възстановената игрова стая. */
  | 'boot_not_restored'

export const VOICE_MEMBERSHIP_END_REASONS: readonly VoiceMembershipEndReason[] = [
  'left_waiting_room',
  'kicked',
  'permanently_left',
  'banned',
  'profile_revoked',
  'superseded',
  'table_released',
  'boot_not_restored',
]

/**
 * Едно НЕПРЕКЪСНАТО участие на профил в гласова маса (DB:
 * voice_table_memberships). speakingEntitledAt != null -> правото за
 * говорене е придобито и не се губи при изтичане на VIP до края на ТОВА
 * участие. Ново сядане = ново membershipId без старото право.
 */
export type VoiceTableMembership = {
  membershipId: string
  voiceTableId: VoiceTableId
  profileId: string
  startedAt: string
  speakingEntitledAt: string | null
  endedAt: string | null
  endReason: VoiceMembershipEndReason | null
}

// ─── LiveKit permission профил (само данни — без SDK, без JWT) ───────────

export type VoicePublishSource = 'microphone'

export type VoiceLiveKitPermissionProfile = {
  canSubscribe: true
  canPublish: boolean
  canPublishSources: readonly VoicePublishSource[]
  canPublishData: false
}
