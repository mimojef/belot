// Свара — глас „Поглеждам!“ при „Виж“. През общата система за игрови звуци
// (playGameSound): уважава настройката „Звуци в играта“, а грешка/блокирано
// аудио се поглъща тихо — никога не спира играта. Snapshot-ът няма пол на
// играча, затова записът е един (мъжки), както при „Плащам“/„Вдигам“/„Бягам“.

import { playGameSound } from '../../../audio/gameSoundSettings'

const LOOK_VOICE_SRC = '/audio/game-sounds/svara-look-male.mp3'

let preloaded = false
/** Файлът се зарежда предварително, за да тръгне едновременно с балончето. */
export function preloadSvaraLookVoice(): void {
  if (preloaded || typeof Audio === 'undefined') return
  preloaded = true
  const audio = new Audio()
  audio.preload = 'auto'
  audio.src = LOOK_VOICE_SRC
}

export function playSvaraLookVoice(): void {
  playGameSound(LOOK_VOICE_SRC, { volume: 0.7 })
}
