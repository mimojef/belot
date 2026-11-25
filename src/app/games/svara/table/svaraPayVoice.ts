// Свара — гласове при залагане: „Плащам!“ (call, без повишаване),
// „Вдигам!“ (повишаване на текущия залог) и „Тъмни!“ (залог на тъмно). През
// общата система за игрови звуци (playGameSound): уважава настройката
// „Звуци в играта“, а грешка/блокирано аудио се поглъща тихо — никога не
// спира играта. Записът (мъжки/женски) е според пола на профила на играча —
// виж svaraVoiceGender.

import { playGameSound } from '../../../audio/gameSoundSettings'
import { preloadSvaraVoices, svaraVoiceSrc, type SvaraVoiceGender } from './svaraVoiceGender'

let preloaded = false
/** Файловете се зареждат предварително, за да тръгнат едновременно с балончето. */
export function preloadSvaraPayVoice(): void {
  if (preloaded || typeof Audio === 'undefined') return
  preloaded = true
  preloadSvaraVoices(['pay', 'raise', 'blind'])
}

export function playSvaraPayVoice(gender: SvaraVoiceGender): void {
  playGameSound(svaraVoiceSrc('pay', gender), { volume: 0.7 })
}

export function playSvaraRaiseVoice(gender: SvaraVoiceGender): void {
  playGameSound(svaraVoiceSrc('raise', gender), { volume: 0.7 })
}

/** „Тъмни!“ — при залог на тъмно (вместо „Вдигам!“). */
export function playSvaraBlindVoice(gender: SvaraVoiceGender): void {
  playGameSound(svaraVoiceSrc('blind', gender), { volume: 0.7 })
}
