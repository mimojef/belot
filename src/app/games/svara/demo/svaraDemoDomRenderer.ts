// DOM + Web Animations API renderer (подобреният текущ подход на Pika.bg).
//
// Анимират се САМО transform и opacity → браузърът ги изпълнява на
// compositor нишката, дори когато main нишката е заета. Всеки спрайт
// получава ЕДНА анимация на фаза: пътечката му (всички движения в фазата)
// се семплира на 60 Hz от sampleSvaraTrack() — същото движение като PixiJS.
// Сенките са отделен слой под спрайтовете (също transform/opacity), за да
// дават дълбочина без box-shadow прерисуване. В покой няма анимации.

import { buildSvaraTracks, sampleSvaraTrack, stateToSampled, type SvaraMove, type SvaraSampledState, type SvaraSpriteDef, type SvaraTrack } from './svaraDemoMotion'
import type { SvaraDemoRenderer } from './svaraDemoRenderer'
import { svaraShadowFor } from './svaraDemoShadow'
import { SVARA_DEMO_CARD_BACK_SRC, type SvaraDemoLayout } from './svaraDemoScript'

const SAMPLE_STEP_MS = 1000 / 60

const CHIP_STYLES: Record<string, { face: string; rim: string }> = {
  red: { face: '#e23b3b', rim: '#a51d1d' },
  blue: { face: '#2f6fe0', rim: '#1b44a3' },
  green: { face: '#1fae57', rim: '#137a3b' },
}

type DomSprite = {
  def: SvaraSpriteDef
  root: HTMLElement
  shadow: HTMLElement
  front: HTMLElement | null
  back: HTMLElement | null
  width: number
  height: number
}

export function createSvaraDomRenderer(): SvaraDemoRenderer {
  let layer: HTMLElement | null = null
  let layout: SvaraDemoLayout | null = null
  const sprites = new Map<string, DomSprite>()
  const running = new Set<Animation>()
  const timers = new Set<number>()
  let runToken = 0

  function sizeOf(def: SvaraSpriteDef): { width: number; height: number } {
    if (!layout) return { width: 0, height: 0 }
    return def.kind === 'card'
      ? { width: layout.cardWidth, height: layout.cardHeight }
      : { width: layout.chipSize, height: layout.chipSize }
  }

  function spriteTransform(sprite: DomSprite, s: SvaraSampledState): string {
    return `translate3d(${(s.x - sprite.width / 2).toFixed(2)}px,${(s.y - sprite.height / 2).toFixed(2)}px,0) rotate(${s.rotation.toFixed(2)}deg) scale(${s.scaleX.toFixed(4)},${s.scaleY.toFixed(4)})`
  }

  function shadowFrame(sprite: DomSprite, s: SvaraSampledState): { transform: string; opacity: string } {
    const sh = svaraShadowFor(s, Math.min(sprite.width, sprite.height))
    return {
      transform: `translate3d(${(s.x - sprite.width / 2 + sh.dx).toFixed(2)}px,${(s.y - sprite.height / 2 + sh.dy).toFixed(2)}px,0) rotate(${s.rotation.toFixed(2)}deg) scale(${(s.scaleX * sh.scale).toFixed(4)},${(s.scaleY * sh.scale).toFixed(4)})`,
      opacity: sh.alpha.toFixed(3),
    }
  }

  function setStatic(sprite: DomSprite, s: SvaraSampledState, z: number): void {
    sprite.root.style.transform = spriteTransform(sprite, s)
    sprite.root.style.opacity = String(s.alpha)
    sprite.root.style.zIndex = String(z)
    const sh = shadowFrame(sprite, s)
    sprite.shadow.style.transform = sh.transform
    sprite.shadow.style.opacity = sh.opacity
    if (sprite.front && sprite.back) {
      sprite.front.style.opacity = s.faceUp ? '1' : '0'
      sprite.back.style.opacity = s.faceUp ? '0' : '1'
    }
  }

  function createSprite(def: SvaraSpriteDef): DomSprite {
    const root = document.createElement('div')
    root.dataset.svaraSprite = def.id
    root.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none;'
    const shadow = document.createElement('div')
    shadow.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none;background:rgba(0,0,0,0.6);filter:blur(3px);'
    let front: HTMLElement | null = null
    let back: HTMLElement | null = null
    if (def.kind === 'card') {
      shadow.style.borderRadius = '9%/6.5%'
      const faceStyle = 'position:absolute;inset:0;width:100%;height:100%;border-radius:7%/5%;'
      back = document.createElement('img')
      back.setAttribute('src', SVARA_DEMO_CARD_BACK_SRC)
      back.setAttribute('alt', '')
      back.setAttribute('draggable', 'false')
      back.style.cssText = faceStyle
      root.append(back)
      if (def.faceSrc !== null) {
        front = document.createElement('img')
        front.setAttribute('src', def.faceSrc)
        front.setAttribute('alt', '')
        front.setAttribute('draggable', 'false')
        front.style.cssText = `${faceStyle}opacity:0;`
        root.append(front)
      }
    } else {
      const style = CHIP_STYLES[def.color] ?? CHIP_STYLES.red!
      shadow.style.borderRadius = '50%'
      root.style.borderRadius = '50%'
      // Ръб с ивици (conic) + бял пръстен + лице; статично, без изображения.
      root.style.background = `radial-gradient(circle, ${style.face} 0 47%, rgba(255,255,255,0.95) 48% 53%, ${style.face} 54% 60%, transparent 61%), repeating-conic-gradient(${style.rim} 0deg 30deg, #f8fafc 30deg 45deg)`
      root.style.boxShadow = 'inset 0 -1px 0 rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.35)'
    }
    return { def, root, shadow, front, back, ...sizeOf(def) }
  }

  function applySpriteSize(sprite: DomSprite): void {
    const size = sizeOf(sprite.def)
    sprite.width = size.width
    sprite.height = size.height
    for (const el of [sprite.root, sprite.shadow]) {
      el.style.width = `${size.width}px`
      el.style.height = `${size.height}px`
    }
  }

  function clearRunning(): void {
    runToken += 1
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
    for (const animation of running) animation.cancel()
    running.clear()
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
    const span = track.endMs - track.startMs
    const value = (faceUp: boolean) => ((faceUp === front) ? 1 : 0)
    const frames: Keyframe[] = [{ opacity: value(initialFaceUp), offset: 0 }]
    let faceUp = initialFaceUp
    for (const move of track.moves) {
      if (move.from.faceUp === move.to.faceUp) continue
      const at = (move.delayMs + move.durationMs * 0.5 - track.startMs) / span
      frames.push({ opacity: value(faceUp), offset: at }, { opacity: value(move.to.faceUp), offset: at })
      faceUp = move.to.faceUp
    }
    frames.push({ opacity: value(faceUp), offset: 1 })
    return frames
  }

  function animateTrack(track: SvaraTrack, token: number): Promise<boolean> {
    const sprite = sprites.get(track.id)
    if (!sprite) return Promise.resolve(true)
    const span = Math.max(1, track.endMs - track.startMs)
    const spriteFrames: Keyframe[] = []
    const shadowFrames: Keyframe[] = []
    for (const time of sampleTimes(track)) {
      const s = sampleSvaraTrack(track, time)
      const offset = Math.min(1, Math.max(0, (time - track.startMs) / span))
      spriteFrames.push({ transform: spriteTransform(sprite, s), opacity: s.alpha.toFixed(3), offset })
      shadowFrames.push({ ...shadowFrame(sprite, s), offset })
    }
    // fill:'forwards' — до старта видим остава inline състоянието (= from).
    const timing: KeyframeAnimationOptions = { duration: span, delay: track.startMs, easing: 'linear', fill: 'forwards' }
    const motion = sprite.root.animate(spriteFrames, timing)
    const animations = [motion, sprite.shadow.animate(shadowFrames, timing)]

    const flips = track.moves.some((m) => m.from.faceUp !== m.to.faceUp)
    if (flips && sprite.front && sprite.back) {
      const initialFaceUp = track.moves[0]!.from.faceUp
      animations.push(sprite.front.animate(faceKeyframes(track, initialFaceUp, true), timing))
      animations.push(sprite.back.animate(faceKeyframes(track, initialFaceUp, false), timing))
    }

    // z-index не е compositor свойство — сменя се с таймер в началото на всеки ход.
    for (const move of track.moves) {
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        if (token === runToken) sprite.root.style.zIndex = String(move.to.z)
      }, move.delayMs)
      timers.add(timer)
    }

    for (const animation of animations) running.add(animation)
    const last = track.moves[track.moves.length - 1]!
    return motion.finished.then(
      () => {
        if (token !== runToken) return false
        // Крайното състояние inline; освобождаваме анимациите (без натрупване).
        setStatic(sprite, stateToSampled(last.to), last.to.z)
        for (const animation of animations) {
          animation.cancel()
          running.delete(animation)
        }
        return true
      },
      () => false,
    )
  }

  return {
    kind: 'dom',

    async mount(host, defs, nextLayout) {
      layout = nextLayout
      layer = document.createElement('div')
      layer.dataset.svaraRenderer = 'dom'
      layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict;'
      const shadowLayer = document.createElement('div')
      shadowLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
      const spriteLayer = document.createElement('div')
      spriteLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
      for (const def of defs) {
        const sprite = createSprite(def)
        applySpriteSize(sprite)
        sprites.set(def.id, sprite)
        shadowLayer.appendChild(sprite.shadow)
        spriteLayer.appendChild(sprite.root)
      }
      layer.append(shadowLayer, spriteLayer)
      host.appendChild(layer)
      // Изчакваме декодирането, за да няма „изскачане“ на празни карти.
      const images = Array.from(layer.querySelectorAll('img'))
      await Promise.all(images.map((img) => img.decode().catch(() => undefined)))
    },

    setLayout(nextLayout) {
      layout = nextLayout
      for (const sprite of sprites.values()) applySpriteSize(sprite)
    },

    applyState(states) {
      clearRunning()
      for (const [id, state] of Object.entries(states)) {
        const sprite = sprites.get(id)
        if (sprite) setStatic(sprite, stateToSampled(state), state.z)
      }
    },

    async play(moves: SvaraMove[]) {
      const token = runToken
      const results = await Promise.all(buildSvaraTracks(moves).map((track) => animateTrack(track, token)))
      return token === runToken && results.every(Boolean)
    },

    cancel() {
      clearRunning()
    },

    getDebugInfo() {
      return `DOM/WAAPI · ${sprites.size} спрайта + ${sprites.size} сенки · активни анимации: ${running.size}`
    },

    destroy() {
      clearRunning()
      layer?.remove()
      sprites.clear()
      layer = null
    },
  }
}
