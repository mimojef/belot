// Свара — избор на запис според пола на профила на играча, извършил действието.
// Същото правило като в Белот (createGameAudioController): 'female' → женски
// запис, всичко друго (мъжки или неопределен пол) → мъжки запис.

import type { PlayerGender } from '../../../network/createGameServerClient'

export type SvaraVoiceGender = PlayerGender | null | undefined

/** Пътят към записа: svara-<действие>-male.mp3 или svara-<действие>-female.mp3. */
export function svaraVoiceSrc(action: 'pay' | 'raise' | 'blind' | 'fold' | 'look', gender: SvaraVoiceGender): string {
  return `/audio/game-sounds/svara-${action}-${gender === 'female' ? 'female' : 'male'}.mp3`
}

/** Предварително зареждане на двата варианта (мъжки и женски) на действията. */
export function preloadSvaraVoices(actions: ReadonlyArray<'pay' | 'raise' | 'blind' | 'fold' | 'look'>): void {
  if (typeof Audio === 'undefined') return
  for (const action of actions) {
    for (const gender of ['male', 'female'] as const) {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.src = svaraVoiceSrc(action, gender)
    }
  }
}
