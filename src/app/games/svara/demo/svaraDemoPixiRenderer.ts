// PixiJS (WebGL) renderer за анимационния прототип на Свара.
//
// Зарежда се САМО чрез dynamic import от демото (виж
// createSvaraAnimationDemo.ts) — pixi.js не влиза в основния bundle и не
// се precache-ва от service worker-а (vite.config.ts → svara-* chunks).
//
// Без постоянно прерисуване: ticker-ът е спрян, докато няма активни
// движения; при неподвижна маса се рисува само един кадър след промяна.
// Траекторията идва от същата sampleSvaraMove(), както в DOM renderer-а.

import { Application, Container, Graphics, Sprite, Texture, Ticker } from 'pixi.js'
import { sampleSvaraMove, stateToSampled, type SvaraMove, type SvaraSampledState, type SvaraSpriteDef } from './svaraDemoMotion'
import type { SvaraDemoRenderer } from './svaraDemoRenderer'
import { SVARA_DEMO_CARD_BACK_SRC, type SvaraDemoLayout } from './svaraDemoScript'

const CHIP_COLORS: Record<string, { fill: number; edge: number }> = {
  red: { fill: 0xef4444, edge: 0xb91c1c },
  blue: { fill: 0x3b82f6, edge: 0x1d4ed8 },
  green: { fill: 0x22c55e, edge: 0x15803d },
}
const MAX_RESOLUTION = 2
// Максималният показан размер на карта е cardWidth(≤72) × REVEAL_SCALE(1.45)
// × resolution(≤2) ≈ 209px → текстура 220px е достатъчна и пести памет.
const CARD_TEXTURE_WIDTH = 220

// PixiJS закача вътрешни услуги (EventTicker, SchedulerSystem/GC) за
// глобалния Ticker.system, който иначе държи requestAnimationFrame цикъл
// постоянно (~60 събуждания/сек и в покой). Свара е единственият
// потребител на pixi.js, затова го управляваме изрично: работи само по
// време на движение. autoStart=false пречи нов listener да го рестартира.
function setPixiSystemTickerActive(active: boolean): void {
  const system = Ticker.system
  system.autoStart = false
  if (active) system.start()
  else system.stop()
}

type PixiSprite = {
  def: SvaraSpriteDef
  node: Container
  body: Sprite
  front: Texture | null
  faceUp: boolean
}

type Tween = {
  move: SvaraMove
  sprite: PixiSprite
  startedAt: number
  zApplied: boolean
  resolve: (completed: boolean) => void
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  await img.decode()
  return img
}

/** Намалена текстура със заоблени ъгли (offscreen canvas → един GPU upload). */
async function createCardTexture(src: string): Promise<Texture> {
  const img = await loadImage(src)
  const width = CARD_TEXTURE_WIDTH
  const height = Math.round((width * img.naturalHeight) / img.naturalWidth)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.beginPath()
  ctx.roundRect(0, 0, width, height, width * 0.07)
  ctx.clip()
  ctx.drawImage(img, 0, 0, width, height)
  return Texture.from({ resource: canvas, autoGenerateMipmaps: true, scaleMode: 'linear' })
}

export function createSvaraPixiRenderer(): SvaraDemoRenderer {
  let app: Application | null = null
  let layout: SvaraDemoLayout | null = null
  let backTexture: Texture | null = null
  const chipTextures = new Map<string, Texture>()
  const faceTextures = new Map<string, Texture>()
  const sprites = new Map<string, PixiSprite>()
  let tweens: Tween[] = []
  let drawnFrames = 0

  function requestRender(): void {
    if (!app) return
    app.render()
    drawnFrames += 1
  }

  function createChipTexture(color: string): Texture {
    if (!app) throw new Error('not mounted')
    const palette = CHIP_COLORS[color] ?? CHIP_COLORS.red!
    const r = 32
    const g = new Graphics()
    g.circle(r, r, r).fill(palette.edge)
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2
      g.circle(r + Math.cos(a) * r * 0.8, r + Math.sin(a) * r * 0.8, r * 0.13).fill(0xffffff)
    }
    g.circle(r, r, r * 0.6).fill(0xffffff)
    g.circle(r, r, r * 0.52).fill(palette.fill)
    const texture = app.renderer.generateTexture({ target: g, resolution: MAX_RESOLUTION, antialias: true })
    g.destroy()
    return texture
  }

  function applySpriteSize(sprite: PixiSprite): void {
    if (!layout) return
    if (sprite.def.kind === 'card') {
      sprite.body.width = layout.cardWidth
      sprite.body.height = layout.cardHeight
    } else {
      sprite.body.width = layout.chipSize
      sprite.body.height = layout.chipSize
    }
  }

  function setFace(sprite: PixiSprite, faceUp: boolean): void {
    if (sprite.def.kind !== 'card' || sprite.faceUp === faceUp) return
    sprite.faceUp = faceUp
    const texture = faceUp && sprite.front ? sprite.front : backTexture
    if (texture) {
      sprite.body.texture = texture
      applySpriteSize(sprite)
    }
  }

  function applySampled(sprite: PixiSprite, s: SvaraSampledState): void {
    sprite.node.position.set(s.x, s.y)
    sprite.node.rotation = (s.rotation * Math.PI) / 180
    sprite.node.scale.set(s.scaleX, s.scaleY)
    sprite.node.alpha = s.alpha
    setFace(sprite, s.faceUp)
  }

  function finishAllTweens(completed: boolean): void {
    const pending = tweens
    tweens = []
    for (const tween of pending) tween.resolve(completed)
  }

  function tick(): void {
    if (!app) return
    const now = performance.now()
    const stillRunning: Tween[] = []
    for (const tween of tweens) {
      const elapsed = now - tween.startedAt - tween.move.delayMs
      if (elapsed < 0) {
        stillRunning.push(tween)
        continue
      }
      if (!tween.zApplied) {
        tween.sprite.node.zIndex = tween.move.to.z
        tween.zApplied = true
      }
      const t = elapsed / tween.move.durationMs
      if (t >= 1) {
        applySampled(tween.sprite, stateToSampled(tween.move.to))
        tween.resolve(true)
      } else {
        applySampled(tween.sprite, sampleSvaraMove(tween.move, t))
        stillRunning.push(tween)
      }
    }
    tweens = stillRunning
    drawnFrames += 1
    if (tweens.length === 0) {
      // Последният кадър се рисува от ticker-а след този callback; след това
      // спираме — неподвижната маса не се прерисува.
      queueMicrotask(() => {
        if (tweens.length > 0) return
        app?.ticker.stop()
        setPixiSystemTickerActive(false)
      })
    }
  }

  return {
    kind: 'pixi',

    async mount(host, defs, nextLayout) {
      layout = nextLayout
      const instance = new Application()
      await instance.init({
        width: nextLayout.width,
        height: nextLayout.height,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION),
        autoStart: false,
        sharedTicker: false,
        preference: 'webgl',
        powerPreference: 'low-power',
      })
      app = instance
      instance.canvas.dataset.svaraRenderer = 'pixi'
      instance.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;'
      instance.stage.sortableChildren = true
      instance.stage.eventMode = 'none'
      instance.ticker.add(tick)
      setPixiSystemTickerActive(false)

      backTexture = await createCardTexture(SVARA_DEMO_CARD_BACK_SRC)
      for (const def of defs) {
        if (def.kind === 'card' && def.faceSrc !== null && !faceTextures.has(def.faceSrc)) {
          faceTextures.set(def.faceSrc, await createCardTexture(def.faceSrc))
        }
        if (def.kind === 'chip' && !chipTextures.has(def.color)) {
          chipTextures.set(def.color, createChipTexture(def.color))
        }
      }

      // Качваме всички текстури в GPU предварително — иначе лицата на
      // картите се качват (с mipmaps) лениво при първото обръщане и
      // предизвикват видимо засичане по средата на анимацията.
      const renderer = instance.renderer as unknown as { texture: { initSource(source: Texture['source']): unknown } }
      for (const texture of [backTexture, ...faceTextures.values(), ...chipTextures.values()]) {
        renderer.texture.initSource(texture.source)
      }

      for (const def of defs) {
        const texture = def.kind === 'card' ? backTexture : chipTextures.get(def.color)!
        const body = new Sprite(texture)
        body.anchor.set(0.5)
        const node = new Container()
        node.addChild(body)
        instance.stage.addChild(node)
        const sprite: PixiSprite = {
          def,
          node,
          body,
          front: def.kind === 'card' && def.faceSrc !== null ? faceTextures.get(def.faceSrc)! : null,
          faceUp: false,
        }
        applySpriteSize(sprite)
        sprites.set(def.id, sprite)
      }
      host.appendChild(instance.canvas)
    },

    setLayout(nextLayout) {
      layout = nextLayout
      if (!app) return
      app.renderer.resize(nextLayout.width, nextLayout.height)
      for (const sprite of sprites.values()) applySpriteSize(sprite)
    },

    applyState(states) {
      finishAllTweens(false)
      app?.ticker.stop()
      setPixiSystemTickerActive(false)
      for (const [id, state] of Object.entries(states)) {
        const sprite = sprites.get(id)
        if (!sprite) continue
        sprite.node.zIndex = state.z
        applySampled(sprite, stateToSampled(state))
      }
      requestRender()
    },

    play(moves) {
      if (!app || moves.length === 0) return Promise.resolve(true)
      const startedAt = performance.now()
      const promises = moves.map((move) => new Promise<boolean>((resolve) => {
        const sprite = sprites.get(move.id)
        if (!sprite) {
          resolve(true)
          return
        }
        tweens.push({ move, sprite, startedAt, zApplied: false, resolve })
      }))
      setPixiSystemTickerActive(true)
      app.ticker.start()
      return Promise.all(promises).then((results) => results.every(Boolean))
    },

    cancel() {
      finishAllTweens(false)
      app?.ticker.stop()
      setPixiSystemTickerActive(false)
    },

    getDebugInfo() {
      if (!app) return 'PixiJS · не е зареден'
      const textures = 1 + faceTextures.size + chipTextures.size
      return `PixiJS ${app.renderer.name} · resolution ${app.renderer.resolution} · ${textures} текстури · рисувани кадри: ${drawnFrames}`
    },

    destroy() {
      finishAllTweens(false)
      sprites.clear()
      if (app) {
        app.ticker.remove(tick)
        app.destroy({ removeView: true }, { children: true, texture: false })
        app = null
      }
      backTexture?.destroy(true)
      backTexture = null
      for (const texture of faceTextures.values()) texture.destroy(true)
      for (const texture of chipTextures.values()) texture.destroy(true)
      faceTextures.clear()
      chipTextures.clear()
      // Връщаме глобалния ticker в изходно състояние на PixiJS.
      Ticker.system.autoStart = true
    },
  }
}
