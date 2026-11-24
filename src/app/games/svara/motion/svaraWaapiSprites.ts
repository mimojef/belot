// Свара — споделени DOM/WAAPI спрайтове (карта, графичен чип, сянка) и
// превръщане на пътечка от движения (svaraDemoMotion) в WAAPI keyframes.
//
// Използва се от истинската маса (scene/svaraSceneDomRenderer.ts); създадено
// първоначално за анимационното демо (премахнато) — същата визия, траектории,
// easing функции и скорости. Анимират се САМО transform и
// opacity → браузърът ги изпълнява на compositor нишката; всяка пътечка е
// ЕДНА анимация на спрайт (семплирана на 60 Hz от sampleSvaraTrack).

import { sampleSvaraTrack, type SvaraChipColor, type SvaraSampledState, type SvaraTrack } from '../demo/svaraDemoMotion'
import { svaraShadowFor } from '../demo/svaraDemoShadow'

const SAMPLE_STEP_MS = 1000 / 60

export const SVARA_CHIP_STYLES: Record<SvaraChipColor, { face: string; rim: string }> = {
  red: { face: '#e23b3b', rim: '#a51d1d' },
  blue: { face: '#2f6fe0', rim: '#1b44a3' },
  green: { face: '#1fae57', rim: '#137a3b' },
}

export type SvaraWaapiSprite = {
  root: HTMLElement
  shadow: HTMLElement
  front: HTMLElement | null
  back: HTMLElement | null
  width: number
  height: number
}

function image(src: string, style: string): HTMLElement {
  const img = document.createElement('img')
  img.setAttribute('src', src)
  img.setAttribute('alt', '')
  img.setAttribute('draggable', 'false')
  img.style.cssText = style
  return img
}

/** Карта: гръб + (по избор) лице. Лицето се създава само ако е известно. */
export function createSvaraCardSprite(backSrc: string, faceSrc: string | null): SvaraWaapiSprite {
  const root = document.createElement('div')
  root.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none;'
  const shadow = document.createElement('div')
  shadow.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none;background:rgba(0,0,0,0.6);filter:blur(3px);border-radius:9%/6.5%;'
  const faceStyle = 'position:absolute;inset:0;width:100%;height:100%;border-radius:7%/5%;'
  const back = image(backSrc, faceStyle)
  root.append(back)
  let front: HTMLElement | null = null
  if (faceSrc !== null) {
    front = image(faceSrc, `${faceStyle}opacity:0;`)
    root.append(front)
  }
  return { root, shadow, front, back, width: 0, height: 0 }
}

/** Графичният чип от демото: ръб с ивици (conic) + бял пръстен + лице. */
export function createSvaraChipSprite(color: SvaraChipColor): SvaraWaapiSprite {
  const style = SVARA_CHIP_STYLES[color] ?? SVARA_CHIP_STYLES.red
  const root = document.createElement('div')
  root.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none;border-radius:50%;'
  root.style.background = `radial-gradient(circle, ${style.face} 0 47%, rgba(255,255,255,0.95) 48% 53%, ${style.face} 54% 60%, transparent 61%), repeating-conic-gradient(${style.rim} 0deg 30deg, #f8fafc 30deg 45deg)`
  root.style.boxShadow = 'inset 0 -1px 0 rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.35)'
  const shadow = document.createElement('div')
  shadow.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none;background:rgba(0,0,0,0.6);filter:blur(3px);border-radius:50%;'
  return { root, shadow, front: null, back: null, width: 0, height: 0 }
}

export function setSvaraSpriteSize(sprite: SvaraWaapiSprite, width: number, height: number): void {
  sprite.width = width
  sprite.height = height
  for (const el of [sprite.root, sprite.shadow]) {
    el.style.width = `${width}px`
    el.style.height = `${height}px`
  }
}

export function svaraSpriteTransform(sprite: Pick<SvaraWaapiSprite, 'width' | 'height'>, s: SvaraSampledState): string {
  return `translate3d(${(s.x - sprite.width / 2).toFixed(2)}px,${(s.y - sprite.height / 2).toFixed(2)}px,0) rotate(${s.rotation.toFixed(2)}deg) scale(${s.scaleX.toFixed(4)},${s.scaleY.toFixed(4)})`
}

export function svaraShadowFrame(sprite: Pick<SvaraWaapiSprite, 'width' | 'height'>, s: SvaraSampledState): { transform: string; opacity: string } {
  const sh = svaraShadowFor(s, Math.min(sprite.width, sprite.height))
  return {
    transform: `translate3d(${(s.x - sprite.width / 2 + sh.dx).toFixed(2)}px,${(s.y - sprite.height / 2 + sh.dy).toFixed(2)}px,0) rotate(${s.rotation.toFixed(2)}deg) scale(${(s.scaleX * sh.scale).toFixed(4)},${(s.scaleY * sh.scale).toFixed(4)})`,
    opacity: sh.alpha.toFixed(3),
  }
}

/** Моментално състояние (inline) — покой, начало и край на движение. */
export function applySvaraSpriteStatic(sprite: SvaraWaapiSprite, s: SvaraSampledState, z: number): void {
  sprite.root.style.transform = svaraSpriteTransform(sprite, s)
  sprite.root.style.opacity = String(s.alpha)
  sprite.root.style.zIndex = String(z)
  const sh = svaraShadowFrame(sprite, s)
  sprite.shadow.style.transform = sh.transform
  sprite.shadow.style.opacity = sh.opacity
  if (sprite.front && sprite.back) {
    sprite.front.style.opacity = s.faceUp ? '1' : '0'
    sprite.back.style.opacity = s.faceUp ? '0' : '1'
  }
}

/** Моменти (ms) за семплиране на пътечката: 60 Hz във всяко движение. */
function sampleTimes(track: SvaraTrack): number[] {
  const times: number[] = []
  for (const move of track.moves) {
    const steps = Math.max(2, Math.ceil(move.durationMs / SAMPLE_STEP_MS))
    for (let i = 0; i <= steps; i += 1) times.push(move.delayMs + (move.durationMs * i) / steps)
  }
  return times
}

function faceKeyframes(track: SvaraTrack, initialFaceUp: boolean, front: boolean): Keyframe[] {
  const span = Math.max(1, track.endMs - track.startMs)
  const value = (faceUp: boolean) => ((faceUp === front) ? 1 : 0)
  const frames: Keyframe[] = [{ opacity: value(initialFaceUp), offset: 0 }]
  let faceUp = initialFaceUp
  for (const move of track.moves) {
    if (move.from.faceUp === move.to.faceUp) continue
    const at = Math.min(1, Math.max(0, (move.delayMs + move.durationMs * 0.5 - track.startMs) / span))
    frames.push({ opacity: value(faceUp), offset: at }, { opacity: value(move.to.faceUp), offset: at })
    faceUp = move.to.faceUp
  }
  frames.push({ opacity: value(faceUp), offset: 1 })
  return frames
}

export type SvaraTrackKeyframes = {
  sprite: Keyframe[]
  shadow: Keyframe[]
  /** Само ако пътечката обръща картата. */
  faces: { front: Keyframe[]; back: Keyframe[] } | null
  startMs: number
  spanMs: number
}

/** Цялата пътечка на спрайта като keyframes (offset 0..1 спрямо startMs..endMs). */
export function buildSvaraTrackKeyframes(sprite: SvaraWaapiSprite, track: SvaraTrack): SvaraTrackKeyframes {
  const spanMs = Math.max(1, track.endMs - track.startMs)
  const spriteFrames: Keyframe[] = []
  const shadowFrames: Keyframe[] = []
  for (const time of sampleTimes(track)) {
    const s = sampleSvaraTrack(track, time)
    const offset = Math.min(1, Math.max(0, (time - track.startMs) / spanMs))
    spriteFrames.push({ transform: svaraSpriteTransform(sprite, s), opacity: s.alpha.toFixed(3), offset })
    shadowFrames.push({ ...svaraShadowFrame(sprite, s), offset })
  }
  const flips = track.moves.some((m) => m.from.faceUp !== m.to.faceUp)
  const initialFaceUp = track.moves[0]!.from.faceUp
  return {
    sprite: spriteFrames,
    shadow: shadowFrames,
    faces: flips && sprite.front && sprite.back
      ? { front: faceKeyframes(track, initialFaceUp, true), back: faceKeyframes(track, initialFaceUp, false) }
      : null,
    startMs: track.startMs,
    spanMs,
  }
}

/**
 * Пуска пътечката като WAAPI анимации. `delayMs` може да е отрицателно — тогава
 * анимацията започва от средата (reconnect/късно откриване: без повторение).
 * fill:'both' — до старта е видимо началото, след края — крайното състояние.
 */
export function playSvaraTrack(sprite: SvaraWaapiSprite, frames: SvaraTrackKeyframes, delayMs: number): Animation[] {
  const timing: KeyframeAnimationOptions = { duration: frames.spanMs, delay: delayMs, easing: 'linear', fill: 'both' }
  const animations = [sprite.root.animate(frames.sprite, timing), sprite.shadow.animate(frames.shadow, timing)]
  if (frames.faces && sprite.front && sprite.back) {
    animations.push(sprite.front.animate(frames.faces.front, timing), sprite.back.animate(frames.faces.back, timing))
  }
  return animations
}
