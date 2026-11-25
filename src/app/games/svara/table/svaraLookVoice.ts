// Свара — глас „Поглеждам!“ при „Виж“. През общата система за игрови звуци
// (playSvaraSound — само в активния таб): уважава настройката „Звуци в играта“, а грешка/блокирано
// аудио се поглъща тихо — никога не спира играта. Записът (мъжки/женски) е
// според пола на профила на играча — виж svaraVoiceGender.

import { playSvaraSound } from './svaraSound'
import { preloadSvaraVoices, svaraVoiceSrc, type SvaraVoiceGender } from './svaraVoiceGender'

let preloaded = false
/** Файловете се зареждат предварително, за да тръгнат едновременно с балончето. */
export function preloadSvaraLookVoice(): void {
  if (preloaded || typeof Audio === 'undefined') return
  preloaded = true
  preloadSvaraVoices(['look'])
}

export function playSvaraLookVoice(gender: SvaraVoiceGender): void {
  playSvaraSound(svaraVoiceSrc('look', gender), { volume: 0.7 })
}
