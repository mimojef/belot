// PixiJS (WebGL) renderer за анимационния прототип на Свара.
//
// Зарежда се САМО чрез dynamic import от демото (виж
// createSvaraAnimationDemo.ts) — pixi.js не влиза в основния bundle и не
// се precache-ва от service worker-а (vite.config.ts → svara-* chunks).
//
// Без постоянно прерисуване: ticker-ът е спрян, докато няма активни
// движения; при неподвижна маса се рисува само един кадър след промяна.
// Траекторията идва от същата sampleSvaraTrack(), както в DOM renderer-а,
// а сянката — от същата svaraShadowFor().

import { Application, Container, Graphics, Sprite, Texture, Ticker } from 'pixi.js'
import { svaraShadowFor } from './svaraDemoShadow'
import { buildSvaraTracks, findSvaraTrackMove, sampleSvaraTrack, stateToSampled, type SvaraMove, type SvaraSampledState, type SvaraSpriteDef, type SvaraTrack } from './svaraDemoMotion'
import type { SvaraDemoRenderer } from './svaraDemoRenderer'
import { SVARA_DEMO_CARD_BACK_SRC, type SvaraDemoLayout } from './svaraDemoScript'

const CHIP_COLORS: Record<string, { face: number; rim: number }> = {
  red: { face: 0xe23b3b, rim: 0xa51d1d },
  blue: { face: 0x2f6fe0, rim: 0x1b44a3 },
  green: { face: 0x1fae57, rim: 0x137a3b },
}
const MAX_RESOLUTION = 2
// Максималният показан размер на карта е cardWidth(≤96) × REVEAL(1.5) ×
// depth(≤1.2) × resolution(≤2) ≈ 345px → текстура 300px (оригиналния
// размер) е достатъчна; mipmaps пазят остротата при смаляване.
const CARD_TEXTURE_WIDTH = 300
// Сенките са размити форми с поле около тях (виж createShadowTexture).
const SHADOW_PAD_RATIO = { card: { w: 144 / 120, h: 192 / 168 }, chip: { w: 104 / 80, h: 104 / 80 } }

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
  shadow: Sprite
  front: Texture | null
  faceUp: boolean
}

type ActiveTrack = {
  track: SvaraTrack
  sprite: PixiSprite
  lastMoveIndex: number
  resolve: (completed: boolean) => void
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  await img.decode()
  return img
}

/** Текстура със заоблени ъгли (offscreen canvas → един GPU upload). */
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

/** Размита черна форма (карта или кръг) за сянката — веднъж, споделена. */
function createShadowTexture(kind: 'card' | 'chip'): Texture {
  const w = kind === 'card' ? 120 : 80
  const h = kind === 'card' ? 168 : 80
  const pad = 12
  const canvas = document.createElement('canvas')
  canvas.width = w + pad * 2
  canvas.height = h + pad * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.filter = 'blur(5px)'
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.beginPath()
  if (kind === 'card') ctx.roundRect(pad, pad, w, h, w * 0.09)
  else ctx.arc(pad + w / 2, pad + h / 2, w / 2, 0, Math.PI * 2)
  ctx.fill()
  return Texture.from({ resource: canvas, scaleMode: 'linear' })
}

export function createSvaraPixiRenderer(): SvaraDemoRenderer {
  let app: Application | null = null
  let layout: SvaraDemoLayout | null = null
  let backTexture: Texture | null = null
  const chipTextures = new Map<string, Texture>()
  const faceTextures = new Map<string, Texture>()
  const shadowTextures = new Map<string, Texture>()
  const sprites = new Map<string, PixiSprite>()
  let active: ActiveTrack[] = []
  let phaseStartedAt = 0
  let drawnFrames = 0

  function requestRender(): void {
    if (!app) return
    app.render()
    drawnFrames += 1
  }

  function createChipTexture(color: string): Texture {
    if (!app) throw new Error('not mounted')
    const palette = CHIP_COLORS[color] ?? CHIP_COLORS.red!
    const r = 40
    const g = new Graphics()
    g.circle(r, r, r).fill(palette.rim)
    // Ивици по ръба (като conic-gradient-а в DOM варианта).
    for (let i = 0; i < 8; i += 1) {
      const a0 = (i / 8) * Math.PI * 2
      g.moveTo(r, r).arc(r, r, r, a0, a0 + Math.PI / 12).lineTo(r, r).fill(0xf8fafc)
    }
    g.circle(r, r, r * 0.6).fill(palette.face)
    g.circle(r, r, r * 0.53).fill(0xffffff)
    g.circle(r, r, r * 0.47).fill(palette.face)
    const texture = app.renderer.generateTexture({ target: g, resolution: MAX_RESOLUTION, antialias: true })
    g.destroy()
    return texture
  }

  function baseSize(sprite: PixiSprite): { w: number; h: number } {
    if (!layout) return { w: 0, h: 0 }
    return sprite.def.kind === 'card'
      ? { w: layout.cardWidth, h: layout.cardHeight }
      : { w: layout.chipSize, h: layout.chipSize }
  }

  function applySpriteSize(sprite: PixiSprite): void {
    const { w, h } = baseSize(sprite)
    sprite.body.width = w
    sprite.body.height = h
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
    const { w, h } = baseSize(sprite)
    const pad = SHADOW_PAD_RATIO[sprite.def.kind]
    const sh = svaraShadowFor(s, Math.min(w, h))
    sprite.shadow.position.set(s.x + sh.dx, s.y + sh.dy)
    sprite.shadow.rotation = sprite.node.rotation
    sprite.shadow.width = w * pad.w * Math.abs(s.scaleX) * sh.scale
    sprite.shadow.height = h * pad.h * s.scaleY * sh.scale
    sprite.shadow.alpha = sh.alpha
  }

  function finishAll(completed: boolean): void {
    const pending = active
    active = []
    for (const entry of pending) entry.resolve(completed)
  }

  function stopTickers(): void {
    app?.ticker.stop()
    setPixiSystemTickerActive(false)
  }

  function tick(): void {
    if (!app) return
    const elapsed = performance.now() - phaseStartedAt
    const stillRunning: ActiveTrack[] = []
    for (const entry of active) {
      const current = findSvaraTrackMove(entry.track, elapsed)
      if (current && current.index !== entry.lastMoveIndex) {
        entry.sprite.node.zIndex = current.move.to.z
        entry.lastMoveIndex = current.index
      }
      if (elapsed >= entry.track.endMs) {
        const last = entry.track.moves[entry.track.moves.length - 1]!
        applySampled(entry.sprite, stateToSampled(last.to))
        entry.resolve(true)
      } else {
        if (current) applySampled(entry.sprite, sampleSvaraTrack(entry.track, elapsed))
        stillRunning.push(entry)
      }
    }
    active = stillRunning
    drawnFrames += 1
    if (active.length === 0) {
      // Последният кадър се рисува от ticker-а след този callback; след това
      // спираме — неподвижната маса не се прерисува.
      queueMicrotask(() => {
        if (active.length === 0) stopTickers()
      })
    }
  }

  return {
    kind: 'pixi',

    async mount(host, defs, nextLayout) {
      layout = nextLayout
      // Лобито на desktop е мащабирано с CSS zoom — рисуваме в реалната
      // екранна резолюция, за да не е canvas-ът размазан или излишно голям.
      const rect = host.getBoundingClientRect()
      const zoom = host.offsetWidth > 0 ? rect.width / host.offsetWidth : 1
      const instance = new Application()
      await instance.init({
        width: nextLayout.width,
        height: nextLayout.height,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(MAX_RESOLUTION, Math.max(1, (window.devicePixelRatio || 1) * zoom)),
        autoStart: false,
        sharedTicker: false,
        preference: 'webgl',
        powerPreference: 'low-power',
      })
      app = instance
      instance.canvas.dataset.svaraRenderer = 'pixi'
      instance.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;'
      instance.stage.eventMode = 'none'
      const shadowLayer = new Container()
      const spriteLayer = new Container()
      spriteLayer.sortableChildren = true
      instance.stage.addChild(shadowLayer, spriteLayer)
      instance.ticker.add(tick)
      setPixiSystemTickerActive(false)

      backTexture = await createCardTexture(SVARA_DEMO_CARD_BACK_SRC)
      shadowTextures.set('card', createShadowTexture('card'))
      shadowTextures.set('chip', createShadowTexture('chip'))
      for (const def of defs) {
        if (def.kind === 'card' && def.faceSrc !== null && !faceTextures.has(def.faceSrc)) {
          faceTextures.set(def.faceSrc, await createCardTexture(def.faceSrc))
        }
        if (def.kind === 'chip' && !chipTextures.has(def.color)) chipTextures.set(def.color, createChipTexture(def.color))
      }
      // Качваме всички текстури в GPU предварително — иначе се качват
      // (с mipmaps) лениво при първа употреба и засичат анимацията.
      const renderer = instance.renderer as unknown as { texture: { initSource(source: Texture['source']): unknown } }
      for (const texture of [backTexture, ...faceTextures.values(), ...chipTextures.values(), ...shadowTextures.values()]) {
        renderer.texture.initSource(texture.source)
      }

      for (const def of defs) {
        const texture = def.kind === 'card' ? backTexture : chipTextures.get(def.color)!
        const body = new Sprite(texture)
        body.anchor.set(0.5)
        const node = new Container()
        node.addChild(body)
        spriteLayer.addChild(node)
        const shadow = new Sprite(shadowTextures.get(def.kind)!)
        shadow.anchor.set(0.5)
        shadowLayer.addChild(shadow)
        const sprite: PixiSprite = {
          def,
          node,
          body,
          shadow,
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
      finishAll(false)
      stopTickers()
      for (const [id, state] of Object.entries(states)) {
        const sprite = sprites.get(id)
        if (!sprite) continue
        sprite.node.zIndex = state.z
        applySampled(sprite, stateToSampled(state))
      }
      requestRender()
    },

    play(moves: SvaraMove[]) {
      if (!app || moves.length === 0) return Promise.resolve(true)
      finishAll(false)
      phaseStartedAt = performance.now()
      const promises = buildSvaraTracks(moves).map((track) => new Promise<boolean>((resolve) => {
        const sprite = sprites.get(track.id)
        if (!sprite) {
          resolve(true)
          return
        }
        active.push({ track, sprite, lastMoveIndex: -1, resolve })
      }))
      setPixiSystemTickerActive(true)
      app.ticker.start()
      return Promise.all(promises).then((results) => results.every(Boolean))
    },

    cancel() {
      finishAll(false)
      stopTickers()
    },

    getDebugInfo() {
      if (!app) return 'PixiJS · не е зареден'
      const textures = 1 + faceTextures.size + chipTextures.size + shadowTextures.size
      return `PixiJS ${app.renderer.name} · resolution ${app.renderer.resolution.toFixed(2)} · ${textures} текстури · рисувани кадри: ${drawnFrames}`
    },

    destroy() {
      finishAll(false)
      sprites.clear()
      if (app) {
        app.ticker.remove(tick)
        app.destroy({ removeView: true }, { children: true, texture: false })
        app = null
      }
      backTexture?.destroy(true)
      backTexture = null
      for (const map of [faceTextures, chipTextures, shadowTextures]) {
        for (const texture of map.values()) texture.destroy(true)
        map.clear()
      }
      // Връщаме глобалния ticker в изходно състояние на PixiJS.
      Ticker.system.autoStart = true
    },
  }
}
