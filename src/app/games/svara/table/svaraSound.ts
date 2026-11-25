// Свара — единен вход за ВСИЧКИ звуци на играта (гласове, раздаване, чипове,
// „Свара!“). Звучи само докато табът с играта е видим (Page Visibility API):
//  - скрит таб → нови звуци не се пускат (пропуснатите не се наваксват);
//  - при скриване вече звучащите се спират и не се възобновяват при връщане;
//  - при връщане новите звуци работят нормално.
// Уважава общата настройка „Звуци в играта“ (gameSoundSettings): при
// изключване звучащите се спират чрез onGameSoundsDisabled. Само звук —
// таймери, анимации, балончета и мрежата не се засягат.

import { isGameSoundsEnabled, onGameSoundsDisabled } from '../../../audio/gameSoundSettings'

const playing = new Set<HTMLAudioElement>()
let listening = false

function isTabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function stopAll(): void {
  for (const audio of playing) {
    try { audio.pause() } catch { /* звукът не бива да спира играта */ }
  }
  playing.clear()
}

function ensureListeners(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('visibilitychange', () => { if (!isTabVisible()) stopAll() })
  window.addEventListener('pagehide', stopAll)
  onGameSoundsDisabled(stopAll)
}

export function playSvaraSound(src: string, options: { volume?: number } = {}): void {
  if (!isGameSoundsEnabled() || typeof Audio === 'undefined' || !isTabVisible()) return
  ensureListeners()
  const audio = new Audio(src)
  audio.preload = 'auto'
  if (options.volume !== undefined) audio.volume = options.volume
  const forget = () => { playing.delete(audio) }
  audio.addEventListener('ended', forget, { once: true })
  audio.addEventListener('error', forget, { once: true })
  playing.add(audio)
  void audio.play().catch(forget)
}
