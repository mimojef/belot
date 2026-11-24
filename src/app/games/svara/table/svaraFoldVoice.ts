// Свара — глас „Бягам!“ при ДОБРОВОЛЕН отказ (никога при принудителен:
// изтекло време/отсъствие/изход). През общата система за игрови звуци
// (playGameSound): уважава настройката „Звуци в играта“, а грешка/блокирано
// аудио се поглъща тихо — никога не спира играта. Snapshot-ът няма пол на
// играча, затова записът е един (мъжки), както при „Плащам“/„Вдигам“.

import { playGameSound } from '../../../audio/gameSoundSettings'

const FOLD_VOICE_SRC = '/audio/game-sounds/svara-fold-male.mp3'

let preloaded = false
/** Файлът се зарежда предварително, за да тръгне едновременно с балончето. */
export function preloadSvaraFoldVoice(): void {
  if (preloaded || typeof Audio === 'undefined') return
  preloaded = true
  const audio = new Audio()
  audio.preload = 'auto'
  audio.src = FOLD_VOICE_SRC
}

export function playSvaraFoldVoice(): void {
  playGameSound(FOLD_VOICE_SRC, { volume: 0.7 })
}
