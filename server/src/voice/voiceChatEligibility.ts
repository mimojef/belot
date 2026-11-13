// Гласов чат — чиста eligibility логика (Етап 2а; правото за говорене е
// адаптирано в Етап 2б към участието — voice_table_memberships).
//
// Три ОТДЕЛНИ права:
//   * създаване на гласова маса  -> evaluateVoiceTableCreation
//   * слушане                    -> evaluateVoiceAccess(...).canListen
//   * говорене                   -> evaluateVoiceAccess(...).canSpeak
//
// Всички функции са чисти: без I/O, без часовник, без глобално състояние.
// Caller-ът (voiceChatService.ts) резолвва авторитетните факти точно преди
// решението — и ОТНОВО след всяка асинхронна операция (CreateRoom, подпис на
// JWT) и непосредствено преди да предаде токена. VIP идва единствено от
// vipStore.getStatus(profileId).isActive; администраторите НЯМАТ bypass — те
// минават същите проверки (прецедент: evaluateVipSpectatorGateEligibility).
//
// Лимитът (свободен слот) НЕ се проверява тук — той е атомарна проверка в
// voiceChatStore.reserveVoiceTable() заедно с режима.

import { resolveEffectiveVoiceChatMode } from './voiceChatFeatureFlag.js'
import type {
  VoiceChatMode,
  VoiceLiveKitPermissionProfile,
  VoiceMembershipFacts,
  VoiceSessionBinding,
  VoiceSessionClaim,
  VoiceTablePhase,
  VoiceTableStatus,
} from './voiceChatTypes.js'

export type VoiceModeFacts = {
  /** Записаният режим (voiceChatStore.getSettings().mode). */
  storedMode: VoiceChatMode
  /** isVoiceChatEmergencyStopActive(). */
  emergencyStop: boolean
}

export type VoiceRequesterFacts = {
  /** null = гост / без валидна сесия. */
  profileId: string | null
  /** account.role === 'admin' от СВЕЖА сесия (isFullAdminSession). */
  isFullAdmin: boolean
  /** vipStore.getStatus(profileId).isActive — единственият VIP източник. */
  isVipActive: boolean
  /** profileBanStore.getActiveBan(profileId) !== null. */
  isBanned: boolean
  /**
   * Активно административно mute наказание (единният mute за Лафче, Общи и
   * чата в чакалнята — topicModerationStore.getSectionMuteSnapshot). Не
   * влияе на създаването на гласова маса и на слушането; забранява само
   * говоренето и има приоритет пред придобитото право (без да го изтрива).
   * Липсващо = false (създаването не го ползва).
   */
  isChatMuted?: boolean
}

// ─── Създаване ────────────────────────────────────────────────────────────

export type VoiceTableCreationDenialCode =
  | 'voice_off'
  | 'not_authenticated'
  | 'banned'
  | 'admin_only_mode'
  | 'vip_required'

export type VoiceTableCreationDecision =
  | { ok: true }
  | { ok: false; code: VoiceTableCreationDenialCode }

/**
 * 'public'     -> VIP.
 * 'admin_only' -> пълен admin И VIP (без VIP bypass за администратора).
 * 'off'/авариен стоп -> никой.
 */
export function evaluateVoiceTableCreation(input: {
  mode: VoiceModeFacts
  requester: VoiceRequesterFacts
}): VoiceTableCreationDecision {
  const effectiveMode = resolveEffectiveVoiceChatMode(input.mode.storedMode, input.mode.emergencyStop)
  if (effectiveMode === 'off') return { ok: false, code: 'voice_off' }
  if (input.requester.profileId === null) return { ok: false, code: 'not_authenticated' }
  if (input.requester.isBanned) return { ok: false, code: 'banned' }
  if (effectiveMode === 'admin_only' && !input.requester.isFullAdmin) return { ok: false, code: 'admin_only_mode' }
  if (!input.requester.isVipActive) return { ok: false, code: 'vip_required' }
  return { ok: true }
}

// ─── Слушане и говорене ───────────────────────────────────────────────────

export type VoiceTableFacts = {
  voiceTableId: string
  status: VoiceTableStatus
  phase: VoiceTablePhase
}

export type VoiceListenDenialCode =
  | 'voice_off'
  | 'not_authenticated'
  | 'banned'
  | 'table_not_found'
  | 'table_released'
  | 'spectator'
  | 'bot'
  | 'not_a_player'
  | 'wrong_table'
  | 'permanently_left'
  | 'invalid_session'

/**
 * 'vip'        — активен VIP в момента на проверката;
 * 'membership' — правото е придобито по-рано в ТЕКУЩОТО непрекъснато
 *                участие (VIP при сядането или придобит по време на
 *                участието) и се пази до края му, дори VIP да е изтекъл.
 */
export type VoiceSpeakBasis = 'vip' | 'membership'

export type VoiceAccessDecision =
  | { canListen: false; canSpeak: false; denialCode: VoiceListenDenialCode }
  | {
      canListen: true
      canSpeak: true
      speakBasis: VoiceSpeakBasis
    }
  | {
      canListen: true
      canSpeak: false
      speakDenialCode: 'vip_required'
    }
  | {
      canListen: true
      canSpeak: false
      speakDenialCode: 'muted'
      /**
       * Основанието, на което би говорил без наказанието (null = няма право).
       * Придобитото право се пази: mute само временно забранява ползването му.
       */
      speakBasis: VoiceSpeakBasis | null
    }

export type VoiceAccessInput = {
  mode: VoiceModeFacts
  requester: VoiceRequesterFacts
  /** voiceTableId, за който се иска достъп (от заявката). */
  requestedVoiceTableId: string
  /** Авторитетният запис от voiceChatStore (null = несъществуващ). */
  table: VoiceTableFacts | null
  /** Изведено от авторитетното игрово състояние, не от клиента. */
  membership: VoiceMembershipFacts
  /** isVoiceSessionBindingCurrent(...) за тази заявка. */
  sessionBindingCurrent: boolean
  /**
   * Текущото активно участие на профила в ТАЗИ маса има придобито право за
   * говорене (voice_table_memberships.speaking_entitled_at != NULL). Ново
   * участие след напускане започва без него.
   */
  hasSpeakingEntitlement: boolean
}

/**
 * Ред на проверките (първата неуспешна печели):
 *   режим -> сесия/профил -> бан -> маса -> отношение -> същата маса ->
 *   окончателно напускане -> авторитетна игрова сесия.
 * Банът и окончателното напускане имат приоритет пред придобитото право.
 * Слушането НЕ изисква VIP. Говоренето изисква VIP ИЛИ право, придобито в
 * текущото участие — никога role bypass.
 *
 * Режимите 'admin_only' и 'public' са еднакви за ВЕЧЕ съществуващи маси:
 * превключването между тях не отнема правата в тях.
 */
export function evaluateVoiceAccess(input: VoiceAccessInput): VoiceAccessDecision {
  const deny = (denialCode: VoiceListenDenialCode): VoiceAccessDecision => ({ canListen: false, canSpeak: false, denialCode })

  const effectiveMode = resolveEffectiveVoiceChatMode(input.mode.storedMode, input.mode.emergencyStop)
  if (effectiveMode === 'off') return deny('voice_off')

  const profileId = input.requester.profileId
  if (profileId === null) return deny('not_authenticated')
  if (input.requester.isBanned) return deny('banned')

  const table = input.table
  if (table === null || table.voiceTableId !== input.requestedVoiceTableId) return deny('table_not_found')
  if (table.status !== 'active') return deny('table_released')

  const { relation, seatedVoiceTableId, permanentlyLeft } = input.membership
  if (relation === 'spectator') return deny('spectator')
  if (relation === 'bot') return deny('bot')
  if (relation !== 'player') return deny('not_a_player')
  if (seatedVoiceTableId !== table.voiceTableId) return deny('wrong_table')
  if (permanentlyLeft) return deny('permanently_left')

  if (!input.sessionBindingCurrent) return deny('invalid_session')

  const speakBasis: VoiceSpeakBasis | null = input.requester.isVipActive
    ? 'vip'
    : input.hasSpeakingEntitlement
      ? 'membership'
      : null
  // Mute наказанието има приоритет пред VIP и придобитото право (бан и
  // окончателно напускане вече са отказали и слушането по-горе).
  if (input.requester.isChatMuted === true) return { canListen: true, canSpeak: false, speakDenialCode: 'muted', speakBasis }
  if (speakBasis !== null) return { canListen: true, canSpeak: true, speakBasis }
  return { canListen: true, canSpeak: false, speakDenialCode: 'vip_required' }
}

/**
 * LiveKit permission профил за решението (само данни — JWT се подписва в
 * Етап 2б). null = никакъв токен (зрители, ботове, напуснали, чужди и т.н.).
 * Без право за говорене -> canPublish:false на ниво LiveKit, не само в UI.
 */
export function toVoiceLiveKitPermissionProfile(decision: VoiceAccessDecision): VoiceLiveKitPermissionProfile | null {
  if (!decision.canListen) return null
  return decision.canSpeak
    ? { canSubscribe: true, canPublish: true, canPublishSources: ['microphone'], canPublishData: false }
    : { canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: false }
}

/**
 * Кога правото за говорене трябва да се запише в участието: играчът е VIP
 * сега, а участието още няма придобито право. Записаното право не се
 * "самоудължава" — то вече важи до края на участието.
 */
export function shouldPersistSpeakingEntitlement(decision: VoiceAccessDecision, alreadyEntitled: boolean): boolean {
  if (alreadyEntitled || !decision.canListen) return false
  // И при mute: VIP по време на участието придобива правото (ще го ползва
  // след края на наказанието, дори VIP дотогава да е изтекъл).
  return 'speakBasis' in decision && decision.speakBasis === 'vip'
}

/**
 * Изисква ли загубата на право ротация на стаята. Стар токен (вкл. LiveKit
 * refresh token) пази правата си до изтичане и е вързан за ИМЕТО на стаята,
 * затова отнемането е сигурно само с нова генерация:
 *   * загубено слушане при токен, издаден за ТЕКУЩАТА жива генерация -> 'listen_revoked';
 *   * иначе (никога не е получавал токен или токенът е за вече оттеглена
 *     генерация) -> без ротация.
 * От Етап 2б правото за говорене не се отнема самостоятелно (изтичането на
 * VIP не го прекратява в текущото участие), затова 'speak_revoked' не се
 * връща — говоренето се губи само заедно със слушането (край на участието).
 */
export function resolveRevocationRotation(input: {
  wasIssuedTokenForLiveGeneration: boolean
  decision: VoiceAccessDecision
}): 'listen_revoked' | null {
  if (!input.decision.canListen) return input.wasIssuedTokenForLiveGeneration ? 'listen_revoked' : null
  return null
}

/**
 * Гласът следва АВТОРИТЕТНАТА игрова сесия, не последния LiveKit join.
 * Заявката е валидна само ако:
 *   * представя текущия clientInstanceId на профила за тази маса (изместен
 *     таб/стара страница има друг clientInstanceId -> отказ);
 *   * binding-ът е регистриран от връзката, която В МОМЕНТА държи мястото
 *     на масата (seatConnectionId от PrivateRoom occupant / ServerRoom
 *     participant). Затворена или изместена връзка -> отказ.
 */
export function isVoiceSessionBindingCurrent(
  claim: VoiceSessionClaim,
  authoritative: VoiceSessionBinding | null,
  seatConnectionId: string | null,
): boolean {
  return (
    authoritative !== null &&
    claim.clientInstanceId.length > 0 &&
    authoritative.profileId === claim.profileId &&
    authoritative.voiceTableId === claim.voiceTableId &&
    authoritative.clientInstanceId === claim.clientInstanceId &&
    authoritative.gameConnectionId !== null &&
    seatConnectionId !== null &&
    authoritative.gameConnectionId === seatConnectionId
  )
}
