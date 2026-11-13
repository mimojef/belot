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
//   * enableMicrophone е единственото място, което може да поиска достъп до
//     микрофона (getUserMedia) — контролерът го вика само при право за
//     говорене и изрично действие;
//   * disableMicrophone спира публикуването И освобождава capture-а
//     (MediaStreamTrack.stop) — индикаторът за запис на OS трябва да изгасне;
//   * единственото изключение е detachMicrophoneForReuse (контролирана
//     ротация) — capture-ът се предава на контролера, който го публикува в
//     новата стая или го освобождава.

export type VoiceMicrophoneFailure = 'not_found' | 'permission_denied' | 'unavailable' | 'not_permitted'

export class VoiceMicrophoneError extends Error {
  readonly failure: VoiceMicrophoneFailure
  constructor(failure: VoiceMicrophoneFailure) {
    super(`microphone_${failure}`)
    this.name = 'VoiceMicrophoneError'
    this.failure = failure
  }
}

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
  onDisconnected: (cause: VoiceDisconnectCause, retained: VoiceRetainedMicrophone | null) => void
  onReconnecting: () => void
  onReconnected: () => void
  /** Identity-тата на говорещите в момента (вкл. локалния участник). */
  onActiveSpeakersChanged: (identities: string[]) => void
  /** Някой отдалечен участник влезе/излезе/смени микрофонното си състояние. */
  onParticipantsChanged: () => void
  /** Възпроизвеждането е блокирано/разблокирано от браузъра (autoplay). */
  onPlaybackStatusChanged: (canPlayback: boolean) => void
  /** Локалният микрофон е спрял сам (изключено устройство, OS прекъсване, track ended). */
  onLocalMicrophoneLost: () => void
  /** Списъкът с аудио устройства се е сменил (само информация — без автоматично включване). */
  onDevicesChanged: () => void
}

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
}

export type VoiceAdapter = {
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
}

export type VoiceAdapterLoader = () => Promise<VoiceAdapter>
