// DOM + Web Animations API renderer (подобреният текущ подход на Pika.bg).
//
// Анимират се САМО transform и opacity → браузърът ги изпълнява на
// compositor нишката, дори когато main нишката е заета. Траекторията
// (дъга, повдигане, обръщане) се семплира от sampleSvaraMove() в keyframes с
// линейна интерполация между тях — същото движение като PixiJS renderer-а.
// Без постоянно прерисуване: при неподвижна маса няма активни анимации.

import { findSvaraFlipMoment, sampleSvaraMove, stateToSampled, type SvaraMove, type SvaraSampledState, type SvaraSpriteDef } from './svaraDemoMotion'
import type { SvaraDemoRenderer } from './svaraDemoRenderer'
import { SVARA_DEMO_CARD_BACK_SRC, type SvaraDemoLayout } from './svaraDemoScript'

const CHIP_GRADIENTS: Record<string, string> = {
  red: 'radial-gradient(circle at 50% 50%, #ef4444 0 52%, #fff 53% 58%, #b91c1c 59% 100%)',
  blue: 'radial-gradient(circle at 50% 50%, #3b82f6 0 52%, #fff 53% 58%, #1d4ed8 59% 100%)',
  green: 'radial-gradient(circle at 50% 50%, #22c55e 0 52%, #fff 53% 58%, #15803d 59% 100%)',
}

type DomSprite = {
  def: SvaraSpriteDef
  root: HTMLElement
  front: HTMLElement | null
  back: HTMLElement | null
  width: number
  height: number
}

export function createSvaraDomRenderer(): SvaraDemoRenderer {
  let host: HTMLElement | null = null
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

  function transformOf(sprite: DomSprite, s: SvaraSampledState): string {
    return `translate3d(${(s.x - sprite.width / 2).toFixed(2)}px, ${(s.y - sprite.height / 2).toFixed(2)}px, 0) rotate(${s.rotation.toFixed(2)}deg) scale(${s.scaleX.toFixed(4)}, ${s.scaleY.toFixed(4)})`
  }

  function setFace(sprite: DomSprite, faceUp: boolean): void {
    if (!sprite.front || !sprite.back) return
    sprite.front.style.opacity = faceUp ? '1' : '0'
    sprite.back.style.opacity = faceUp ? '0' : '1'
  }

  function createSprite(def: SvaraSpriteDef): DomSprite {
    const root = document.createElement('div')
    root.dataset.svaraSprite = def.id
    root.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none;'
    let front: HTMLElement | null = null
    let back: HTMLElement | null = null
    if (def.kind === 'card') {
      const faceStyle = 'position:absolute;inset:0;width:100%;height:100%;border-radius:7%/5%;box-shadow:0 2px 6px rgba(0,0,0,0.35);'
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
      root.style.borderRadius = '50%'
      root.style.background = CHIP_GRADIENTS[def.color] ?? CHIP_GRADIENTS.red!
      root.style.boxShadow = '0 2px 3px rgba(0,0,0,0.45), inset 0 0 0 2px rgba(255,255,255,0.35)'
    }
    return { def, root, front, back, ...sizeOf(def) }
  }

  function applySpriteSize(sprite: DomSprite): void {
    const size = sizeOf(sprite.def)
    sprite.width = size.width
    sprite.height = size.height
    sprite.root.style.width = `${size.width}px`
    sprite.root.style.height = `${size.height}px`
  }

  function clearRunning(): void {
    runToken += 1
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
    for (const animation of running) animation.cancel()
    running.clear()
  }

  function animateMove(move: SvaraMove, token: number): Promise<boolean> {
    const sprite = sprites.get(move.id)
    if (!sprite) return Promise.resolve(true)

    const steps = Math.max(8, Math.round(move.durationMs / 40))
    const keyframes: Keyframe[] = []
    for (let i = 0; i <= steps; i += 1) {
      const s = sampleSvaraMove(move, i / steps)
      keyframes.push({ transform: transformOf(sprite, s), opacity: s.alpha.toFixed(3) })
    }
    const timing: KeyframeAnimationOptions = { duration: move.durationMs, delay: move.delayMs, easing: 'linear', fill: 'both' }
    const motion = sprite.root.animate(keyframes, timing)
    const animations = [motion]

    // Обръщане: смяна на лицето точно в момента, в който scaleX минава през
    // ~0 — стъпкова opacity анимация (също compositor-only).
    if (move.from.faceUp !== move.to.faceUp && sprite.front && sprite.back) {
      const at = findSvaraFlipMoment(move)
      const fromFront = move.from.faceUp ? 1 : 0
      const toFront = move.to.faceUp ? 1 : 0
      const faceFrames = (a: number, b: number): Keyframe[] => [
        { opacity: a, offset: 0 },
        { opacity: a, offset: at },
        { opacity: b, offset: at },
        { opacity: b, offset: 1 },
      ]
      animations.push(sprite.front.animate(faceFrames(fromFront, toFront), timing))
      animations.push(sprite.back.animate(faceFrames(1 - fromFront, 1 - toFront), timing))
    }

    // z-index не е compositor свойство — сменя се с таймер в началото на хода.
    const timer = window.setTimeout(() => {
      timers.delete(timer)
      if (token === runToken) sprite.root.style.zIndex = String(move.to.z)
    }, move.delayMs)
    timers.add(timer)

    for (const animation of animations) running.add(animation)
    return motion.finished.then(
      () => {
        if (token !== runToken) return false
        // Записваме крайното състояние inline и освобождаваме анимациите,
        // за да не се трупат fill:'both' ефекти.
        sprite.root.style.transform = transformOf(sprite, stateToSampled(move.to))
        sprite.root.style.opacity = String(move.to.alpha)
        sprite.root.style.zIndex = String(move.to.z)
        setFace(sprite, move.to.faceUp)
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

    async mount(target, defs, nextLayout) {
      host = target
      layout = nextLayout
      layer = document.createElement('div')
      layer.dataset.svaraRenderer = 'dom'
      layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict;'
      for (const def of defs) {
        const sprite = createSprite(def)
        applySpriteSize(sprite)
        sprites.set(def.id, sprite)
        layer.appendChild(sprite.root)
      }
      host.appendChild(layer)
      // Изчакваме декодирането на гърба и видимите лица, за да няма
      // „изскачане“ на празни карти при първото пускане.
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
        if (!sprite) continue
        sprite.root.style.transform = transformOf(sprite, stateToSampled(state))
        sprite.root.style.opacity = String(state.alpha)
        sprite.root.style.zIndex = String(state.z)
        setFace(sprite, state.faceUp)
      }
    },

    async play(moves) {
      const token = runToken
      const results = await Promise.all(moves.map((move) => animateMove(move, token)))
      return token === runToken && results.every(Boolean)
    },

    cancel() {
      clearRunning()
    },

    getDebugInfo() {
      return `DOM/WAAPI · ${sprites.size} елемента · активни анимации: ${running.size}`
    },

    destroy() {
      clearRunning()
      layer?.remove()
      sprites.clear()
      layer = null
      host = null
    },
  }
}
