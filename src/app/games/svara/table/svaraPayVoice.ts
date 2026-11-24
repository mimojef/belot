// Свара — гласове при залагане: „Плащам!“ (call, без повишаване) и
// „Вдигам!“ (повишаване на текущия залог). През общата система за игрови
// звуци (playGameSound): уважава настройката „Звуци в играта“, а
// грешка/блокирано аудио се поглъща тихо — никога не спира играта.
// Snapshot-ът няма пол на играча, затова записите са по един.

import { playGameSound } from '../../../audio/gameSoundSettings'

const PAY_VOICE_SRC = '/audio/game-sounds/svara-pay-male.mp3'
const RAISE_VOICE_SRC = '/audio/game-sounds/svara-raise-male.mp3'
const BLIND_VOICE_SRC = '/audio/game-sounds/svara-blind-male.mp3'

let preloaded = false
/** Файловете се зареждат предварително, за да тръгнат едновременно с балончето. */
export function preloadSvaraPayVoice(): void {
  if (preloaded || typeof Audio === 'undefined') return
  preloaded = true
  for (const src of [PAY_VOICE_SRC, RAISE_VOICE_SRC, BLIND_VOICE_SRC]) {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.src = src
  }
}

export function playSvaraPayVoice(): void {
  playGameSound(PAY_VOICE_SRC, { volume: 0.7 })
}

export function playSvaraRaiseVoice(): void {
  playGameSound(RAISE_VOICE_SRC, { volume: 0.7 })
}

/** „Тъмни!“ — при залог на тъмно (вместо „Вдигам!“). */
export function playSvaraBlindVoice(): void {
  playGameSound(BLIND_VOICE_SRC, { volume: 0.7 })
}
