// Централна Белот "Звуци по време на игра" preference + play gate.
// createGameAudioController.ts::canPlayAudioNow() я проверява, така че ВСИЧКИ
// звуци от контролера (обяви, декларации, card SFX, deal пакети, countdown
// warning, край на мача) се gate-ват на едно място, без проверки по отделните
// call site-ове. Малкото in-game звуци извън контролера (scoring сума, монети
// при залог) минават през playGameSound() по-долу.
//
// Persistence: същия localStorage pattern като ludoSoundSettings.ts
// (`!== 'false'`, default ON, try/catch safe). Чисто клиентска preference.

const GAME_SOUNDS_ENABLED_KEY = 'pika.belotGameSoundsEnabled'

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(GAME_SOUNDS_ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

function saveEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(GAME_SOUNDS_ENABLED_KEY, enabled ? 'true' : 'false')
  } catch {
    // Ignore storage failures — in-memory setting still applies for this tab.
  }
}

let gameSoundsEnabled = loadEnabled()
const disableListeners = new Set<() => void>()
const activeGameAudioElements = new Set<HTMLAudioElement>()

export function isGameSoundsEnabled(): boolean {
  return gameSoundsEnabled
}

// При изключване спира веднага всеки В МОМЕНТА звучащ игрови звук —
// tracked one-off звуците тук + всичко, което контролерите са регистрирали
// чрез onGameSoundsDisabled() (speech queue, SFX pool-ове, countdown loop).
export function setGameSoundsEnabled(enabled: boolean): void {
  gameSoundsEnabled = enabled
  saveEnabled(enabled)

  if (enabled) {
    return
  }

  stopTrackedGameAudio()

  for (const listener of disableListeners) {
    try {
      listener()
    } catch {
      // Един счупен listener не трябва да остави другите звуци да свирят.
    }
  }
}

export function onGameSoundsDisabled(listener: () => void): () => void {
  disableListeners.add(listener)
  return () => {
    disableListeners.delete(listener)
  }
}

function stopTrackedGameAudio(): void {
  for (const audio of activeGameAudioElements) {
    audio.pause()
    try {
      audio.currentTime = 0
    } catch {
      // Safari може да хвърли при неseekable елемент — pause() стига.
    }
  }
  activeGameAudioElements.clear()
}

// Регистрира audio елемент, създаден извън playGameSound(), за да бъде спрян
// при изключване (напр. one-off SFX в createGameAudioController).
export function trackGameAudio(audio: HTMLAudioElement): void {
  activeGameAudioElements.add(audio)
  const untrack = () => {
    activeGameAudioElements.delete(audio)
  }
  audio.addEventListener('ended', untrack, { once: true })
  audio.addEventListener('error', untrack, { once: true })
}

export function playGameSound(src: string, options: { volume?: number } = {}): void {
  if (!gameSoundsEnabled || typeof Audio === 'undefined') {
    return
  }

  const audio = new Audio(src)
  audio.preload = 'auto'
  if (options.volume !== undefined) {
    audio.volume = options.volume
  }
  trackGameAudio(audio)
  void audio.play().catch(() => {
    activeGameAudioElements.delete(audio)
  })
}
