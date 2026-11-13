// Гласов чат — общи типове и статус за мобилния интерфейс (Етап 4).
// В ОСНОВНИЯ bundle (лентата в чакалнята и бутонът в игра ги ползват без
// да зареждат lazy chunk-а на панела/прозорците — renderVoicePanel.ts).

import type { VoiceSnapshot } from '../createVoiceController'

export type VoiceUiTheme = 'light' | 'dark'

export type VoiceUiSeat = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  isBot: boolean
  isSelf: boolean
}

export type VoiceStatusTone = 'ok' | 'busy' | 'idle' | 'error'

const IN_VOICE_STATUSES = new Set(['connecting', 'connected_listening', 'connected_speaking', 'connected_muted', 'reconnecting', 'rotating', 'disconnecting'])

export function isInVoice(snapshot: VoiceSnapshot): boolean {
  return IN_VOICE_STATUSES.has(snapshot.status)
}

export function describeVoiceStatus(snapshot: VoiceSnapshot): { label: string; tone: VoiceStatusTone } {
  switch (snapshot.status) {
    case 'connecting':
    case 'rotating':
      return { label: 'Свързване…', tone: 'busy' }
    case 'reconnecting':
      return { label: 'Възстановяване…', tone: 'busy' }
    case 'disconnecting':
      return { label: 'Изключване…', tone: 'busy' }
    case 'connected_speaking':
    case 'connected_listening':
    case 'connected_muted':
      // 2.11: не показвай „свързан“, ако браузърът блокира звука.
      if (snapshot.playbackBlocked) return { label: 'Звукът е спрян', tone: 'busy' }
      // Включен микрофон не означава непременно говорене.
      return { label: snapshot.status === 'connected_speaking' ? 'Микрофонът е включен' : 'Слушате', tone: 'ok' }
    case 'unavailable':
    case 'error':
      return { label: 'Недостъпен', tone: 'error' }
    default:
      return { label: snapshot.canRestore ? 'Прекъснат' : 'Не сте включени', tone: 'idle' }
  }
}
