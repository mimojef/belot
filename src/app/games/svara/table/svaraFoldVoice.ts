// Свара — глас „Бягам!“ при ДОБРОВОЛЕН отказ (никога при принудителен:
// изтекло време/отсъствие/изход). През общата система за игрови звуци
// (playGameSound): уважава настройката „Звуци в играта“, а грешка/блокирано
// аудио се поглъща тихо — никога не спира играта. Записът (мъжки/женски) е
// според пола на профила на играча — виж svaraVoiceGender.

import { playGameSound } from '../../../audio/gameSoundSettings'
import { preloadSvaraVoices, svaraVoiceSrc, type SvaraVoiceGender } from './svaraVoiceGender'

let preloaded = false
/** Файловете се зареждат предварително, за да тръгнат едновременно с балончето. */
export function preloadSvaraFoldVoice(): void {
  if (preloaded || typeof Audio === 'undefined') return
  preloaded = true
  preloadSvaraVoices(['fold'])
}

export function playSvaraFoldVoice(gender: SvaraVoiceGender): void {
  playGameSound(svaraVoiceSrc('fold', gender), { volume: 0.7 })
}
