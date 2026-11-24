// Свара — обща визуална сцена: DOM + Web Animations API renderer.
//
// Това е renderer-ът на анимационното демо (досегашният
// demo/svaraDemoDomRenderer.ts), използван НЕПРОМЕНЕН и от истинската игра.
//
// Анимират се САМО transform и opacity → браузърът ги изпълнява на
// compositor нишката. Всеки спрайт получава ЕДНА анимация на пътечка
// (всички движения на спрайта в една заявка), семплирана на 60 Hz от
// sampleSvaraTrack() — същото движение като PixiJS. Сенките са отделен слой
// под спрайтовете. В покой няма анимации.
//
// Добавено за истинската игра (демото не ги ползва): динамични спрайтове,
// късно задаване на лице (само когато сървърът го е изпратил), превъртане
// при reconnect (`playFrom` с изминало време) и отмяна на предишната
// пътечка на същия спрайт (никога две анимации върху един спрайт).

import { buildSvaraTracks, stateToSampled, type SvaraMove, type SvaraSampledState, type SvaraSpriteDef, type SvaraSpriteState, type SvaraTrack } from '../demo/svaraDemoMotion'
import { applySvaraSpriteStatic, buildSvaraTrackKeyframes, createSvaraCardSprite, createSvaraChipSprite, playSvaraTrack, setSvaraSpriteSize, type SvaraWaapiSprite } from '../motion/svaraWaapiSprites'
import type { SvaraSceneLayout } from './svaraSceneLayout'

export const SVARA_SCENE_CARD_BACK_SRC = '/images/cards/card-back.webp'

export type SvaraSceneStates = Record<string, SvaraSpriteState>
export type SvaraRendererKind = 'dom' | 'pixi'

/** Общ интерфейс на renderer-ите (демото поддържа DOM/WAAPI и PixiJS). */
export interface SvaraSceneRendererBase {
  readonly kind: SvaraRendererKind
  mount(host: HTMLElement, sprites: SvaraSpriteDef[], layout: SvaraSceneLayout): Promise<void>
  /** Нов размер на масата — без анимация. */
  setLayout(layout: SvaraSceneLayout): void
  /** Моментално прилага състоянието (възстановяване след прекъсване/resize). */
  applyState(states: SvaraSceneStates): void
  /** Изпълнява движенията; true ако са завършили, false ако са прекъснати. */
  play(moves: SvaraMove[]): Promise<boolean>
  /** Спира текущите движения (без да прилага състояние). */
  cancel(): void
  getDebugInfo(): string
  destroy(): void
}

/** Разширенията за истинската игра (само DOM renderer-ът). */
export interface SvaraSceneRenderer extends SvaraSceneRendererBase {
  addSprites(defs: SvaraSpriteDef[], states: SvaraSceneStates): void
  removeSprites(ids: string[]): void
  hasSprite(id: string): boolean
  spriteIds(): string[]
  /** Лицето на карта — само когато е позволено (null = само гръб). */
  setFace(id: string, faceSrc: string | null): void
  /** Моментално състояние САМО за дадените спрайтове (спира тяхната анимация). */
  setStates(states: SvaraSceneStates): void
  /** Движения, превъртени с elapsedMs (reconnect: без повторение). Отменя предишната пътечка на същите спрайтове. */
  playFrom(moves: SvaraMove[], elapsedMs: number): Promise<boolean>
  /** Брой активни анимации и спрайтове (диагностика/тестове). */
  stats(): { sprites: number; animations: number }
}

type DomSprite = SvaraWaapiSprite & { def: SvaraSpriteDef; animations: Animation[]; timers: number[]; token: number }

export type SvaraSceneDomRendererOptions = {
  /**
   * Истинската игра: спрайтовете се подреждат по z заедно с останалите слоеве на
   * сцената (слоят им не е отделен stacking context) — така картите могат да са
   * зад профилните карета и пред тях. Функцията превежда z на спрайта в z-index
   * на сцената. Демото не подава опцията (без промяна).
   */
  stageZ?: (z: number) => number
}

export function createSvaraSceneDomRenderer(options: SvaraSceneDomRendererOptions = {}): SvaraSceneRenderer {
  const zIndexOf = (z: number) => String(options.stageZ ? options.stageZ(z) : z)
  let layer: HTMLElement | null = null
  let shadowLayer: HTMLElement | null = null
  let spriteLayer: HTMLElement | null = null
  let layout: SvaraSceneLayout | null = null
  const sprites = new Map<string, DomSprite>()
  const running = new Set<Animation>()
  const timers = new Set<number>()
  let runToken = 0

  function sizeOf(def: SvaraSpriteDef): { width: number; height: number } {
    if (!layout) return { width: 0, height: 0 }
    return def.kind === 'card'
      ? { width: layout.cardSprite.w, height: layout.cardSprite.h }
      : { width: layout.chipSize, height: layout.chipSize }
  }

  function setStatic(sprite: DomSprite, s: SvaraSampledState, z: number): void {
    applySvaraSpriteStatic(sprite, s, z)
    if (options.stageZ) sprite.root.style.zIndex = zIndexOf(z)
  }

  function createSprite(def: SvaraSpriteDef): DomSprite {
    const base = def.kind === 'card' ? createSvaraCardSprite(SVARA_SCENE_CARD_BACK_SRC, def.faceSrc) : createSvaraChipSprite(def.color)
    base.root.dataset.svaraSprite = def.id
    base.root.dataset.svaraSpriteKind = def.kind
    return { ...base, def, ...sizeOf(def), animations: [], timers: [], token: 0 }
  }

  function applySpriteSize(sprite: DomSprite): void {
    const size = sizeOf(sprite.def)
    setSvaraSpriteSize(sprite, size.width, size.height)
  }

  function stopSprite(sprite: DomSprite): void {
    sprite.token += 1
    for (const timer of sprite.timers) { window.clearTimeout(timer); timers.delete(timer) }
    sprite.timers = []
    for (const animation of sprite.animations) { animation.cancel(); running.delete(animation) }
    sprite.animations = []
    sprite.root.dataset.moving = '0'
  }

  function clearRunning(): void {
    runToken += 1
    for (const sprite of sprites.values()) stopSprite(sprite)
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
    for (const animation of running) animation.cancel()
    running.clear()
  }

  function attach(sprite: DomSprite): void {
    shadowLayer?.appendChild(sprite.shadow)
    spriteLayer?.appendChild(sprite.root)
  }

  /** Една пътечка на един спрайт. `token` (демо) — общ; `elapsedMs` — превъртане. */
  function animateTrack(track: SvaraTrack, isCurrent: () => boolean, elapsedMs: number): Promise<boolean> {
    const sprite = sprites.get(track.id)
    if (!sprite) return Promise.resolve(true)
    stopSprite(sprite)
    const own = sprite.token
    const alive = () => isCurrent() && sprite.token === own && sprites.get(track.id) === sprite
    const last = track.moves[track.moves.length - 1]!
    // Изцяло минала пътечка (reconnect) — направо крайното състояние.
    if (elapsedMs >= track.endMs) {
      setStatic(sprite, stateToSampled(last.to), last.to.z)
      return Promise.resolve(true)
    }
    const animations = playSvaraTrack(sprite, buildSvaraTrackKeyframes(sprite, track), track.startMs - elapsedMs)
    const motion = animations[0]!
    sprite.animations = animations
    sprite.root.dataset.moving = '1'

    // z-index не е compositor свойство — сменя се с таймер в началото на всеки ход.
    for (const move of track.moves) {
      const at = move.delayMs - elapsedMs
      if (at <= 0) { sprite.root.style.zIndex = zIndexOf(move.to.z); continue }
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        if (alive()) sprite.root.style.zIndex = zIndexOf(move.to.z)
      }, at)
      timers.add(timer)
      sprite.timers.push(timer)
    }

    for (const animation of animations) running.add(animation)
    return motion.finished.then(
      () => {
        if (!alive()) return false
        // Крайното състояние inline; освобождаваме анимациите (без натрупване).
        setStatic(sprite, stateToSampled(last.to), last.to.z)
        for (const animation of animations) {
          animation.cancel()
          running.delete(animation)
        }
        sprite.animations = []
        sprite.root.dataset.moving = '0'
        return true
      },
      () => false,
    )
  }

  function ensureFace(sprite: DomSprite, faceSrc: string | null): void {
    if (sprite.def.kind !== 'card') return
    sprite.def = { ...sprite.def, faceSrc }
    if (faceSrc === null) {
      sprite.front?.remove()
      sprite.front = null
      if (sprite.back) sprite.back.style.opacity = '1'
      return
    }
    if (sprite.front) {
      if (sprite.front.getAttribute('src') !== faceSrc) sprite.front.setAttribute('src', faceSrc)
      return
    }
    const front = document.createElement('img')
    front.setAttribute('src', faceSrc)
    front.setAttribute('alt', '')
    front.setAttribute('draggable', 'false')
    front.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border-radius:7%/5%;opacity:0;'
    sprite.root.append(front)
    sprite.front = front
  }

  return {
    kind: 'dom',

    async mount(host, defs, nextLayout) {
      layout = nextLayout
      layer = document.createElement('div')
      layer.dataset.svaraRenderer = 'dom'
      layer.style.cssText = options.stageZ
        ? 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:size style;'
        : 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict;'
      shadowLayer = document.createElement('div')
      shadowLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
      spriteLayer = document.createElement('div')
      spriteLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
      for (const def of defs) {
        const sprite = createSprite(def)
        applySpriteSize(sprite)
        sprites.set(def.id, sprite)
        attach(sprite)
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
      const results = await Promise.all(buildSvaraTracks(moves).map((track) => animateTrack(track, () => token === runToken, 0)))
      return token === runToken && results.every(Boolean)
    },

    cancel() {
      clearRunning()
    },

    addSprites(defs, states) {
      for (const def of defs) {
        if (sprites.has(def.id)) continue
        const sprite = createSprite(def)
        applySpriteSize(sprite)
        sprites.set(def.id, sprite)
        const state = states[def.id]
        if (state) setStatic(sprite, stateToSampled(state), state.z)
        attach(sprite)
      }
    },

    removeSprites(ids) {
      for (const id of ids) {
        const sprite = sprites.get(id)
        if (!sprite) continue
        stopSprite(sprite)
        sprite.root.remove()
        sprite.shadow.remove()
        sprites.delete(id)
      }
    },

    hasSprite: (id) => sprites.has(id),
    spriteIds: () => [...sprites.keys()],

    setFace(id, faceSrc) {
      const sprite = sprites.get(id)
      if (sprite) ensureFace(sprite, faceSrc)
    },

    setStates(states) {
      for (const [id, state] of Object.entries(states)) {
        const sprite = sprites.get(id)
        if (!sprite) continue
        stopSprite(sprite)
        setStatic(sprite, stateToSampled(state), state.z)
      }
    },

    async playFrom(moves, elapsedMs) {
      const results = await Promise.all(buildSvaraTracks(moves).map((track) => animateTrack(track, () => true, Math.max(0, elapsedMs))))
      return results.every(Boolean)
    },

    stats: () => ({ sprites: sprites.size, animations: running.size }),

    getDebugInfo() {
      return `DOM/WAAPI · ${sprites.size} спрайта + ${sprites.size} сенки · активни анимации: ${running.size}`
    },

    destroy() {
      clearRunning()
      layer?.remove()
      sprites.clear()
      layer = null
      shadowLayer = null
      spriteLayer = null
    },
  }
}
