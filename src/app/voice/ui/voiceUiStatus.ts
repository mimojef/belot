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

/**
 * Икона/цвят на собствения микрофон в компактните места (лента, бутон в
 * игра): 'on' — реално публикуван (зелен микрофон); 'pending' — изчаква се
 * разрешение или публикуване (неутрален микрофон); 'off' — в гласа, но
 * микрофонът не е включен (червен зачеркнат); 'warn' — публикуван, но
 * устройството го е прекъснало или не се изпраща звук (Етап H1 — кехлибарен,
 * никога зелен); null — не е в гласа.
 */
export type VoiceMicState = 'on' | 'pending' | 'off' | 'warn'

export function voiceMicState(snapshot: VoiceSnapshot): VoiceMicState | null {
  if (!isInVoice(snapshot)) return null
  if (snapshot.microphone === 'live') return (snapshot.microphoneHealth ?? 'ok') === 'ok' ? 'on' : 'warn'
  return snapshot.microphone === 'requesting' ? 'pending' : 'off'
}

/**
 * Етап H1/H3: текст за собствения микрофон при проблем (само за самия играч).
 * action — да се покаже ли „Възстанови микрофона“ (изрично действие).
 */
export function describeMicHealth(snapshot: VoiceSnapshot): { short: string; title: string; text: string; action: boolean } | null {
  if (voiceMicState(snapshot) !== 'warn') return null
  const recovery = snapshot.microphoneRecovery ?? 'none'
  if (recovery === 'recovering') {
    return {
      short: 'Възстановяване на микрофона…',
      title: 'Микрофонът се възстановява',
      text: 'Включваме микрофона наново, без да прекъсваме разговора.',
      action: false,
    }
  }
  if (snapshot.microphoneHealth === 'system_muted') {
    // Не се „борим“ със системата — без бутон, докато трае прекъсването.
    return {
      short: 'Микрофонът е прекъснат',
      title: 'Микрофонът е прекъснат от устройството',
      text: 'Устройството временно спря микрофона (например при обаждане или друго приложение). Останалите не ви чуват, докато устройството не го освободи.',
      action: false,
    }
  }
  if (recovery === 'failed') {
    return {
      short: 'Микрофонът не предава',
      title: 'Микрофонът не можа да бъде възстановен',
      text: 'Останалите не ви чуват. Натиснете „Възстанови микрофона“. Ако не помогне, изключете и включете микрофона.',
      action: true,
    }
  }
  return {
    short: 'Микрофонът не предава',
    title: 'Микрофонът може да не предава звук',
    text: 'От известно време не се изпраща звук от микрофона ви. Ако останалите не ви чуват, натиснете „Възстанови микрофона“.',
    action: true,
  }
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
      // Реалното състояние на собствения микрофон: всичко, което не е
      // публикуван микрофон (само слушане, още невключен, неуспешно включване,
      // изключен, заглушен), е „изключен“ — ясно в червено.
      switch (voiceMicState(snapshot)) {
        case 'on': return { label: 'Микрофон включен', tone: 'ok' }
        // Етап H1: реалното състояние — не подвеждащ зелен микрофон.
        case 'warn': return { label: describeMicHealth(snapshot)!.short, tone: 'busy' }
        // Неутрално, докато се чака разрешение/публикуване (после зелено или червено).
        case 'pending': return { label: 'Включване…', tone: 'idle' }
        default: return { label: 'Микрофон изключен', tone: 'error' }
      }
    case 'unavailable':
    case 'error':
      return { label: 'Недостъпен', tone: 'error' }
    default:
      return { label: snapshot.canRestore ? 'Прекъснат' : 'Не сте включени', tone: 'idle' }
  }
}
