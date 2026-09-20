// Централен Ludo sound preferences store + play gate (виж task-а "Ludo
// sound settings"). ЕДИНСТВЕНАТА точка, през която минава ВСЕКИ Ludo
// gameplay звук (dice roll, pawn step, star landing, triangle entry,
// capture, end-game) — вместо разпръснати `if (soundsEnabled) ...`
// проверки на 6 различни места (виж git history — преди тази задача всеки
// от playLudoDiceFlightOverlay.ts/playLudoCaptureImpactOverlay.ts/
// playLudoMoveRouteOverlay.ts си правеше собствен `new Audio(src);
// audio.play()` directno, без каквато и да е settings проверка).
//
// Persistence: reuse-ва established localStorage preference pattern (виж
// src/main.ts::loadPrivateRoomCreatedSoundEnabled/
// setPrivateRoomCreatedSoundEnabled — `localStorage.getItem(key) !==
// 'false'`, default ON при липсваща/невалидна стойност, try/catch safe).
// Чисто клиентска preference — НИКОГА не се праща към сървъра/DB.

const GAME_SOUNDS_ENABLED_KEY = 'pika.ludoGameSoundsEnabled'
const DICE_SOUND_ENABLED_KEY = 'pika.ludoDiceSoundEnabled'

function loadBooleanPreference(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'false'
  } catch {
    return true
  }
}

function saveBooleanPreference(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, enabled ? 'true' : 'false')
  } catch {
    // Ignore storage failures — in-memory setting still applies for this tab.
  }
}

let gameSoundsEnabled = loadBooleanPreference(GAME_SOUNDS_ENABLED_KEY)
let diceSoundEnabled = loadBooleanPreference(DICE_SOUND_ENABLED_KEY)

export function isLudoGameSoundsEnabled(): boolean {
  return gameSoundsEnabled
}

export function isLudoDiceSoundEnabled(): boolean {
  return diceSoundEnabled
}

// "Звуци в играта" е master mute — не променя/не пипа diceSoundEnabled
// стойността изобщо (виж task-а §5 "запази собствената стойност"), само
// gate-ва playLudoSound()-а по-долу докато е false. Спира веднага всеки
// В МОМЕНТА звучащ Ludo звук (независимо от категория) — виж
// stopActiveLudoSounds по-долу.
export function setLudoGameSoundsEnabled(enabled: boolean): void {
  gameSoundsEnabled = enabled
  saveBooleanPreference(GAME_SOUNDS_ENABLED_KEY, enabled)
  if (!enabled) stopActiveLudoSounds(() => true)
}

// "Звук на зара" — само dice категорията (виж playLudoSound-a по-долу).
// Спира веднага В МОМЕНТА звучащ dice звук конкретно, без да пипа други.
export function setLudoDiceSoundEnabled(enabled: boolean): void {
  diceSoundEnabled = enabled
  saveBooleanPreference(DICE_SOUND_ENABLED_KEY, enabled)
  if (!enabled) stopActiveLudoSounds((category) => category === 'dice')
}

export type LudoSoundCategory = 'dice' | 'gameplay'

type TrackedLudoAudio = { audio: HTMLAudioElement; category: LudoSoundCategory }
const activeLudoAudioElements = new Set<TrackedLudoAudio>()

function stopActiveLudoSounds(shouldStop: (category: LudoSoundCategory) => boolean): void {
  for (const entry of activeLudoAudioElements) {
    if (!shouldStop(entry.category)) continue
    entry.audio.pause()
    entry.audio.currentTime = 0
    activeLudoAudioElements.delete(entry)
  }
}

// Единственият play entry point за ВСИЧКИ Ludo gameplay звуци (dice roll,
// pawn step, star landing, triangle entry, capture, end-game) — виж call
// site-овете в playLudoDiceFlightOverlay.ts/playLudoCaptureImpactOverlay.ts/
// playLudoMoveRouteOverlay.ts, всичките вече минават оттук вместо собствен
// `new Audio()`. Правилото (виж task-а §5): master mute
// (gameSoundsEnabled=false) блокира ВСичко, независимо от category; ако
// master-ът е ON, category==='dice' допълнително се gate-ва зад
// diceSoundEnabled — категорията 'gameplay' никога не я пипа.
export function playLudoSound(src: string, category: LudoSoundCategory): void {
  if (!gameSoundsEnabled) return
  if (category === 'dice' && !diceSoundEnabled) return
  if (typeof Audio === 'undefined') return
  const audio = new Audio(src)
  const entry: TrackedLudoAudio = { audio, category }
  activeLudoAudioElements.add(entry)
  const untrack = () => activeLudoAudioElements.delete(entry)
  audio.addEventListener('ended', untrack, { once: true })
  void audio.play().catch(untrack)
}
