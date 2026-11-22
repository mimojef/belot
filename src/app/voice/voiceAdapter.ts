// Гласов чат — абстракция над LiveKit клиента (Етап 3).
//
// Контролерът (createVoiceController.ts) зависи САМО от този интерфейс.
// Реалната имплементация (liveKitVoiceAdapter.ts) импортира livekit-client
// и се зарежда с dynamic import в отделен chunk (assets/voice-*), извън PWA
// precache-а. Тестовете подават fake имплементация.
//
// Правила, които всяка имплементация спазва:
//   * най-много ЕДНА активна стая на адаптер;
//   * токенът се ползва само за connect и не се пази/логва;
//   * acquireMicrophone (и старият път enableMicrophone() без reuse) са
//     единствените места, които могат да поискат достъп до микрофона
//     (getUserMedia) — контролерът ги вика само при изрично действие;
//     публикуването става с enableMicrophone(reuse) след право за говорене;
//   * disableMicrophone спира публикуването И освобождава capture-а
//     (MediaStreamTrack.stop) — индикаторът за запис на OS трябва да изгасне;
//   * единственото изключение е detachMicrophoneForReuse (контролирана
//     ротация) — capture-ът се предава на контролера, който го публикува в
//     новата стая или го освобождава.

// 'busy' — устройството е заето/недостъпно (NotReadableError); за потребителя
// същото съобщение като 'unavailable', отделно само в диагностиката.
// 'interrupted' — публикуването е прекъснато от reconnect на LiveKit SDK;
// живият capture е върнат в `retained` (за публикуване след възстановяването).
export type VoiceMicrophoneFailure = 'not_found' | 'permission_denied' | 'unavailable' | 'not_permitted' | 'busy' | 'interrupted'

/** Клас на грешката при публикуване (само за диагностиката; без текст на грешката). */
export type VoicePublishErrorKind = 'cancelled' | 'timeout' | 'negotiation' | 'not_connected' | 'not_permitted' | 'other'

export class VoiceMicrophoneError extends Error {
  readonly failure: VoiceMicrophoneFailure
  /** Само при 'interrupted': непубликуваният жив capture — получателят го публикува или освобождава. */
  readonly retained: VoiceRetainedMicrophone | null
  readonly publishError: VoicePublishErrorKind | null
  constructor(failure: VoiceMicrophoneFailure, extra: { retained?: VoiceRetainedMicrophone; publishError?: VoicePublishErrorKind } = {}) {
    super(`microphone_${failure}`)
    this.name = 'VoiceMicrophoneError'
    this.failure = failure
    this.retained = extra.retained ?? null
    this.publishError = extra.publishError ?? null
  }
}

/** Защо адаптерът е загубил вече публикуван микрофон (само за диагностиката). */
export type VoiceMicrophoneLossReason = 'track_ended' | 'republish_failed' | 'server_unpublished' | 'device_removed'

export type VoiceDisconnectCause =
  /** Нашият disconnect() — не е грешка. */
  | 'client'
  /** Стаята е изтрита (ротация/освобождаване/OFF) — backend ще съобщи следващата стъпка. */
  | 'room_deleted'
  /** RemoveParticipant (lease, напуснат екран, 120 s сървърно). */
  | 'removed'
  /** Същият identity влезе отново (друг таб на същата страница не е възможен). */
  | 'duplicate_identity'
  /** Официалният reconnect на LiveKit не е успял / мрежа / сървър. */
  | 'connection_lost'

/** Подробна причина за прекъсване на LiveKit (само за анонимната диагностика). */
export type VoiceLiveKitDisconnectReason =
  | 'network' | 'server_shutdown' | 'room_deleted' | 'participant_removed' | 'duplicate_identity'
  | 'join_failure' | 'signal_close' | 'state_mismatch' | 'migration' | 'client' | 'other'

export type VoiceRemoteParticipantInfo = {
  identity: string
  /** Има публикуван (и неизключен) микрофонен track. */
  microphonePublished: boolean
}

export type VoiceAdapterEvents = {
  /**
   * retained: само при 'room_deleted' и жив локален capture (ротация, при
   * която LiveKit е изтрил стаята ПРЕДИ voice_table_updated) — получателят
   * го публикува в новата генерация или го освобождава. Иначе null (capture-ът
   * вече е спрян от адаптера).
   */
  onDisconnected: (cause: VoiceDisconnectCause, retained: VoiceRetainedMicrophone | null, reason?: VoiceLiveKitDisconnectReason) => void
  onReconnecting: () => void
  onReconnected: () => void
  /** Identity-тата на говорещите в момента (вкл. локалния участник). */
  onActiveSpeakersChanged: (identities: string[]) => void
  /** Някой отдалечен участник влезе/излезе/смени микрофонното си състояние. */
  onParticipantsChanged: () => void
  /** Възпроизвеждането е блокирано/разблокирано от браузъра (autoplay). */
  onPlaybackStatusChanged: (canPlayback: boolean) => void
  /** Локалният микрофон е спрял сам (изключено устройство, OS прекъсване, track ended). */
  onLocalMicrophoneLost: (reason?: VoiceMicrophoneLossReason) => void
  /** Списъкът с аудио устройства се е сменил (само информация — без автоматично включване). */
  onDevicesChanged: () => void
  /**
   * Етап H1: здраве на собствения публикуван микрофон (само наблюдение —
   * адаптерът НЕ предприема възстановяване на микрофона). Липсва -> не се ползва.
   */
  onMicHealthChanged?: (health: VoiceMicHealth, evidence?: VoiceMediaInputEvidence) => void
  /** Етап H1/H2: анонимно медийно събитие за диагностиката (при промяна на състояние). */
  onMediaDiagnostic?: (report: VoiceMediaDiagnosticReport) => void
}

/**
 * Здраве на собствения микрофон (Етап H1):
 *   * 'ok' — няма установен проблем (вкл. нормална тишина и DTX);
 *   * 'system_muted' — устройството/ОС е прекъснало capture-а (track.muted)
 *     или LiveKit е спрял изходящото аудио заради това;
 *   * 'stall_suspected' — RTP изпращането стои, без независимо доказателство
 *     за дефект (подозрение — не се възстановява автоматично).
 */
export type VoiceMicHealth = 'ok' | 'system_muted' | 'stall_suspected'

/** Медийна диагностика (затворени изброявания; виж server voiceClientDiagnostics). */
export type VoiceMediaInputState = 'system_muted' | 'system_unmuted' | 'stall_suspected' | 'stall_cleared'
/**
 * Допълнително (НЕ доказателство) при stall: 'capture_stalled' — media-source
 * не получава кадри; 'capture_active' — capture-ът дава кадри, а RTP стои;
 * 'packets_only' — няма media-source показател.
 */
export type VoiceMediaInputEvidence = 'none' | 'packets_only' | 'capture_stalled' | 'capture_active'
export type VoiceMediaDurationBucket = 'none' | 'lt10s' | '10to60s' | 'gt60s'
export type VoiceMediaOutputState = 'element_paused' | 'element_missing' | 'playback_blocked' | 'remote_stall_suspected'
export type VoiceMediaRecoveryStep = 'play' | 'reattach' | 'start_audio'
export type VoiceMediaRecoveryResult = 'success' | 'failed' | 'gesture_required' | 'limited'
export type VoiceMediaTrigger = 'pause' | 'visible' | 'focus' | 'pageshow' | 'devicechange' | 'attach_check' | 'gesture'
/**
 * Етап H3: резултат от възстановяването на микрофона (нов capture + replaceTrack
 * в СЪЩАТА публикация). 'aborted_orphaned' — отменено (reconnect и др.), след като
 * старият capture вече е спрян: публикацията е заглушена и чака ръчно възстановяване.
 */
export type VoiceMicRecoveryResult =
  | 'recovered' | 'no_rtp' | 'gum_failed' | 'gum_denied' | 'replace_failed'
  | 'aborted' | 'aborted_orphaned' | 'busy' | 'system_muted' | 'not_applicable'
/** Независимо потвърждение (броячи на кадрите, не енергия), че capture-ът е спрял. */
export type VoiceCaptureStallConfirmation = 'confirmed' | 'not_confirmed' | 'unavailable'
/** Диагностика на H3 (затворени стойности; виж server voiceClientDiagnostics). */
export type VoiceMicRecoveryMode = 'auto' | 'manual'
export type VoiceMicRecoveryOutcome =
  | 'recovered' | 'no_rtp' | 'gum_failed' | 'gum_denied' | 'replace_failed' | 'aborted'
  | 'not_confirmed' | 'unavailable' | 'permission_required' | 'cooldown' | 'limit' | 'capture_active' | 'disabled'
export type VoiceMediaDiagnosticReport =
  | { event: 'media_input'; state: VoiceMediaInputState; evidence: VoiceMediaInputEvidence; duration: VoiceMediaDurationBucket }
  | { event: 'media_output'; state: VoiceMediaOutputState }
  | { event: 'media_recovery'; target: 'output'; step: VoiceMediaRecoveryStep; result: VoiceMediaRecoveryResult; trigger: VoiceMediaTrigger }
  | { event: 'mic_recovery'; mode: VoiceMicRecoveryMode; outcome: VoiceMicRecoveryOutcome }

/**
 * Запазен (непубликуван) микрофонен capture при контролирана ротация — за
 * повторно публикуване в новата стая БЕЗ нов getUserMedia. Притежателят
 * задължително вика release(), ако не го публикува.
 */
export type VoiceRetainedMicrophone = {
  isLive: () => boolean
  release: () => void
}

export type VoiceConnectedRoom = {
  /** Изключва (идемпотентно), спира локалните tracks и премахва audio елементите. */
  disconnect: () => Promise<void>
  /**
   * Само при ротация, ПРЕДИ disconnect(): спира публикуването, но запазва
   * живия capture. null — няма жив микрофон (или неуспех; capture-ът е спрян).
   */
  detachMicrophoneForReuse: () => Promise<VoiceRetainedMicrophone | null>
  /**
   * Изисква право за говорене (backend) — иначе хвърля VoiceMicrophoneError('not_permitted').
   * С `reuse` публикува запазения capture (без getUserMedia); ако той вече не е
   * жив — освобождава го и хвърля VoiceMicrophoneError('unavailable').
   */
  enableMicrophone: (reuse?: VoiceRetainedMicrophone) => Promise<void>
  /** Спира публикуването и освобождава capture-а (идемпотентно). */
  disableMicrophone: () => Promise<void>
  isMicrophoneLive: () => boolean
  /** Вика се синхронно от потребителски жест. */
  startAudio: () => Promise<void>
  canPlaybackAudio: () => boolean
  listRemoteParticipants: () => VoiceRemoteParticipantInfo[]
  /** Локално заглушаване/пускане на всички аудио tracks на identity (само за този клиент). */
  setRemoteIdentityVolume: (identity: string, volume: 0 | 1) => void
  /**
   * Етап 6 (по избор): вид на избраната ICE двойка и мрежови показатели от
   * getStats() на аудио track — за анонимната админ статистика. null — още
   * няма аудио track/статистика.
   */
  getTransportInfo?: () => Promise<VoiceTransportInfo | null>
  /** Само за тестове/измерване на натоварването (броячи на медийното наблюдение). */
  debugMedia?: () => Record<string, number>
  /** Етап H3: независимо потвърждение на спрял capture (само при capture_stalled). */
  confirmCaptureStall?: () => Promise<VoiceCaptureStallConfirmation>
  /**
   * Етап H3: нов capture + replaceTrack в СЪЩАТА публикация (същият track sid).
   * Старият capture се спира ПРЕДИ новия (никога два живи). explicit — от жест
   * (прозорец за разрешение е позволен); иначе само при вече разрешен микрофон.
   */
  recoverMicrophone?: (options: { explicit: boolean }) => Promise<VoiceMicRecoveryResult>
  /**
   * Етап H4 (експериментално, САМО ръчно от жест): пресъздава входящите audio
   * елементи — всички текущи се откачат и премахват, после всеки абониран
   * отдалечен track се закача към НОВ елемент и се пуска. Микрофонът,
   * абонаментите, връзката и стаята не се пипат. Успешен play() НЕ доказва,
   * че звукът реално се чува. Извикване по време на друго връща същото обещание.
   */
  restoreIncomingAudio?: () => Promise<VoiceIncomingAudioRestoreResult>
}

/**
 * Технически резултат на H4:
 *   * 'played' — всички нови елементи са пуснати (play() е успял);
 *   * 'partial' — част от тях;
 *   * 'gesture_required' — браузърът изисква жест (показва се „Включи звука“);
 *   * 'failed' — нито един не е пуснат;
 *   * 'no_tracks' — няма абонирани входящи потоци (нищо не е пипнато);
 *   * 'not_connected' — стаята не е свързана (нищо не е пипнато);
 *   * 'aborted' — стаята е затворена по време на възстановяването.
 */
export type VoiceIncomingAudioRestoreOutcome = 'played' | 'partial' | 'gesture_required' | 'failed' | 'no_tracks' | 'not_connected' | 'aborted'
/** Името на грешката от play() (затворен списък — без текст на грешката). */
export type VoiceIncomingAudioRestoreError = 'NotAllowedError' | 'AbortError' | 'NotSupportedError' | 'missing_element' | 'other'
export type VoiceIncomingAudioRestoreResult = {
  outcome: VoiceIncomingAudioRestoreOutcome
  /** Абонирани входящи потоци при старта. */
  tracks: number
  /** Откачени и премахнати стари елементи. */
  detached: number
  /** Нови елементи (attachAudio). */
  attached: number
  /** Нови елементи с успешен play(). */
  playing: number
  errors: VoiceIncomingAudioRestoreError[]
}

/** Без адреси/IP — само вид и протокол на кандидата и закръглени показатели. */
export type VoiceTransportInfo = {
  candidateType: 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown'
  protocol: 'udp' | 'tcp' | 'tls' | 'unknown'
  rttMs: number | null
  jitterMs: number | null
  packetLossPercent: number | null
}

/** Етап 6: анонимно диагностично събитие (виж server voiceClientDiagnostics.ts). */
export type VoiceDiagnosticReport =
  | { event: 'connected' | 'reconnecting' | 'reconnected' | 'connection_lost' | 'reconnect_failed' }
  | { event: 'connect_failed'; reason: 'sdk_load_failed' | 'presence_failed' | 'token_unavailable' | 'livekit_connect_failed' }
  | { event: 'mic_failed'; reason: 'mic_not_found' | 'mic_permission_denied' | 'mic_unavailable' | 'mic_not_permitted' }
  | { event: 'transport'; transport: VoiceTransportInfo }
  | VoiceMicDiagnosticReport
  | VoiceMediaDiagnosticReport

/**
 * Микрофон — анонимна диагностика на включването (без аудио, токени, IP,
 * имена на устройства). Затворени изброявания (виж server voiceClientDiagnostics).
 */
export type VoiceMicRequestSource = 'initial' | 'panel'
export type VoiceMicInterruption = 'none' | 'sdk_reconnect' | 'connection_lost' | 'rotation' | 'room_deleted'
export type VoiceMicAttemptResult = 'enabled' | 'recovered' | 'lost' | 'failed' | 'cancelled'
export type VoiceMicAttemptFailure =
  | 'none' | 'permission_denied' | 'not_found' | 'device_busy' | 'gum_failed' | 'publish_failed'
  | 'publish_cancelled' | 'publish_timeout' | 'publish_negotiation' | 'publish_not_connected'
  | 'not_permitted' | 'acquired_not_published' | 'session_failed'
export type VoiceMicGumBucket = 'none' | 'lt1s' | '1to5s' | '5to15s' | 'gt15s'
export type VoiceMicDiagnosticReport =
  | {
      event: 'mic_attempt'
      source: VoiceMicRequestSource
      result: VoiceMicAttemptResult
      interruption: VoiceMicInterruption
      gum: VoiceMicGumBucket
      failure: VoiceMicAttemptFailure
    }
  /** Вече включен микрофон е загубен (без заявка в ход). */
  | { event: 'mic_lost'; reason: VoiceMicrophoneLossReason | 'rotation' | 'connection_lost' }
  | { event: 'livekit_disconnect'; reason: VoiceLiveKitDisconnectReason }
  /** Прекратена гласова сесия на страницата: защо; при fail_connection — на кой етап. */
  | { event: 'session_end'; reason: VoiceSessionEndReason; stage: VoiceFailStage }

/** Защо страницата прекратява гласовата сесия (само диагностика). */
export type VoiceSessionEndReason =
  | 'leave_voice' | 'off_table' | 'page_hide' | 'page_restored' | 'context_changed' | 'fail_connection'
  | 'disabled' | 'access_ended' | 'removed' | 'duplicate_identity' | 'game_connection_timeout' | 'disposed'
/** Етап, на който failConnection е прекратил опита. */
export type VoiceFailStage =
  | 'none' | 'sdk_load' | 'presence' | 'token' | 'connect' | 'reconnect_exhausted' | 'rotation_resume' | 'permissions_reconnect'

export type VoiceAdapter = {
  /**
   * Само придобиване на микрофона (getUserMedia) — независимо от стаята, за да
   * не зависи от прекъсване/ротация по време на чакане на разрешението.
   * Резултатът се публикува с enableMicrophone(reuse) в текущата стая или се
   * освобождава (release спира track-а). Липсва -> старият път (enableMicrophone()).
   */
  acquireMicrophone?: () => Promise<VoiceRetainedMicrophone>
  /**
   * Микрофонът вече е разрешен в браузъра (нов capture БЕЗ прозорец за
   * разрешение). Липсва/false -> автоматично възстановяване на микрофона
   * без нов capture не е възможно (нужно е изрично действие).
   */
  microphonePermissionGranted?: () => Promise<boolean>
  /**
   * Създава (синхронно) обект на стаята и отключва аудиото в същия
   * потребителски жест (startAudio), ПРЕДИ мрежата. Връща функция за
   * свързване. Най-много една стая на адаптер — предишната трябва да е
   * изключена.
   */
  prepare: (events: VoiceAdapterEvents, isProfileLocallyMuted: (identity: string) => boolean) => {
    connect: (url: string, token: string) => Promise<VoiceConnectedRoom>
    /** Отказ преди/по време на connect (идемпотентно). */
    abort: () => Promise<void>
  }
  /** Само за тестове: активни таймери/слушатели на медийното наблюдение във всички стаи (изтичане). */
  debugMediaGlobal?: () => Record<string, number>
}

export type VoiceAdapterLoader = () => Promise<VoiceAdapter>
