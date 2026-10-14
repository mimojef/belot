// Свара — анимационен прототип (Етап 2А). Само демонстрационни данни: без
// реални играчи, жълтици, залози или сървърни заявки.
//
// Слоеве: DOM маса/места/аватари/банка/банер (статични или compositor-only
// WAAPI ефекти) + сменяем renderer за картите и чиповете (DOM/WAAPI или
// PixiJS). PixiJS се зарежда с dynamic import едва при избор.
//
// Прекъсване/възстановяване: „Прекъсни“, resize и смяна на renderer-а
// спират движенията и прилагат детерминистичното крайно (или начално)
// състояние от хореографията — визуалното състояние винаги е коректно.

import { createSvaraDomRenderer } from './svaraDemoDomRenderer'
import { createSvaraFrameMeter, type SvaraFrameStats } from './svaraDemoFrameMeter'
import type { SvaraDemoRenderer, SvaraRendererKind } from './svaraDemoRenderer'
import {
  buildSvaraDemoScript,
  getSvaraDemoFinalStates,
  SVARA_DEMO_AVATAR_SRCS,
  SVARA_DEMO_SEAT_NAMES,
  type SvaraDemoLayout,
  type SvaraDemoPhase,
  type SvaraDemoScript,
} from './svaraDemoScript'

export type SvaraAnimationDemo = {
  readonly element: HTMLElement
  destroy(): void
}

type DemoStatus = 'loading' | 'idle' | 'running' | 'done'

const RESIZE_DEBOUNCE_MS = 120
const START_PAUSE_MS = 250

function stageHeightFor(width: number): number {
  return Math.round(width < 520 ? width * 1.2 : width * 0.62)
}

const BUTTON_STYLE = 'border:1px solid rgba(212,165,32,0.6);border-radius:10px;padding:9px 14px;background:#111;color:#f8fafc;font-size:14px;font-weight:800;cursor:pointer;'

export function createSvaraAnimationDemo(): SvaraAnimationDemo {
  const element = document.createElement('section')
  element.dataset.svaraDemo = '1'
  element.style.cssText = 'margin-top:18px;'
  element.innerHTML = `
    <div data-svara-demo-stage style="position:relative;width:100%;border-radius:22px;overflow:hidden;background:linear-gradient(180deg,#5b3a1c,#3a2410);box-shadow:0 10px 30px rgba(0,0,0,0.45);user-select:none;-webkit-user-select:none;touch-action:manipulation;">
      <div style="position:absolute;inset:7px;border-radius:17px;background:radial-gradient(ellipse at 50% 45%,#22985a 0%,#157240 55%,#0c4d2a 100%);box-shadow:inset 0 0 40px rgba(0,0,0,0.45);"></div>
      <div data-svara-demo-seats style="position:absolute;inset:0;"></div>
      <div data-svara-demo-sprites style="position:absolute;inset:0;"></div>
      <div data-svara-demo-pot style="position:absolute;left:0;top:0;transform:translate(-50%,0);padding:3px 10px;border-radius:999px;background:rgba(0,0,0,0.45);color:#f5d06f;font-size:12px;font-weight:800;white-space:nowrap;opacity:0;transition:opacity 200ms ease;">Банка: 0</div>
      <div data-svara-demo-banner style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);opacity:0;pointer-events:none;padding:10px 26px;border-radius:14px;background:linear-gradient(180deg,#f5d06f,#d4a520);color:#1a1203;font-size:clamp(22px,6vw,38px);font-weight:900;letter-spacing:2px;box-shadow:0 8px 24px rgba(0,0,0,0.5);will-change:transform,opacity;">СВАРКА!</div>
      <div data-svara-demo-loading style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.85);font-size:14px;font-weight:700;background:rgba(0,0,0,0.25);">Зареждане на графиката…</div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;">
      <button type="button" data-svara-demo-action="replay" style="${BUTTON_STYLE}">▶ Пусни отново</button>
      <button type="button" data-svara-demo-action="skip" style="${BUTTON_STYLE}">⏭ Прекъсни</button>
      <span style="flex:1 1 auto;"></span>
      <div role="group" aria-label="Графичен енджин" style="display:inline-flex;border:1px solid rgba(212,165,32,0.6);border-radius:10px;overflow:hidden;">
        <button type="button" data-svara-demo-renderer="dom" style="border:0;padding:9px 12px;font-size:13px;font-weight:800;cursor:pointer;">DOM / WAAPI</button>
        <button type="button" data-svara-demo-renderer="pixi" style="border:0;padding:9px 12px;font-size:13px;font-weight:800;cursor:pointer;">PixiJS</button>
      </div>
    </div>
    <div data-svara-demo-stats style="margin-top:10px;color:rgba(248,250,252,0.78);font-size:12px;line-height:1.5;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-word;"></div>
    <div style="margin-top:6px;color:rgba(248,250,252,0.5);font-size:12px;">Демонстрация с примерни данни — без реални играчи, жълтици и залози.</div>
  `

  const q = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!
  const stage = q<HTMLElement>('[data-svara-demo-stage]')
  const seatsLayer = q<HTMLElement>('[data-svara-demo-seats]')
  const spritesHost = q<HTMLElement>('[data-svara-demo-sprites]')
  const potLabel = q<HTMLElement>('[data-svara-demo-pot]')
  const banner = q<HTMLElement>('[data-svara-demo-banner]')
  const loadingOverlay = q<HTMLElement>('[data-svara-demo-loading]')
  const statsBox = q<HTMLElement>('[data-svara-demo-stats]')

  let destroyed = false
  let status: DemoStatus = 'loading'
  let runToken = 0
  let switchCounter = 0
  let rendererKind: SvaraRendererKind = 'dom'
  let renderer: SvaraDemoRenderer | null = null
  let script: SvaraDemoScript | null = null
  let rendererLoadMs = 0
  let lastStats: SvaraFrameStats | null = null
  let lastRunInterrupted = false
  let bannerAnimation: Animation | null = null
  const ringAnimations: Animation[] = []
  const meter = createSvaraFrameMeter()
  const seatRings: HTMLElement[] = []
  const seatNodes: HTMLElement[] = []

  // ── Места и аватари (статичен DOM) ───────────────────────────────────────
  for (let i = 0; i < 4; i += 1) {
    const seat = document.createElement('div')
    seat.dataset.svaraDemoSeat = String(i)
    seat.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-50%);'
    seat.innerHTML = `
      <div data-ring style="position:absolute;inset:-6px;border-radius:50%;border:3px solid #f5d06f;box-shadow:0 0 14px rgba(245,208,111,0.8);opacity:0;will-change:transform,opacity;"></div>
      <img src="${SVARA_DEMO_AVATAR_SRCS[i]}" alt="" draggable="false" style="display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid rgba(212,165,32,0.85);background:#0b0b0b;box-sizing:border-box;">
      <div style="position:absolute;left:50%;bottom:0;transform:translate(-50%,45%);padding:1px 8px;border-radius:999px;background:rgba(0,0,0,0.72);color:#fff;font-size:11px;font-weight:800;white-space:nowrap;">${SVARA_DEMO_SEAT_NAMES[i]}</div>
    `
    seatsLayer.appendChild(seat)
    seatNodes.push(seat)
    seatRings.push(seat.querySelector<HTMLElement>('[data-ring]')!)
  }

  function applyLayoutToDom(layout: SvaraDemoLayout): void {
    stage.style.height = `${layout.height}px`
    layout.seats.forEach((seat, i) => {
      const node = seatNodes[i]!
      node.style.left = `${seat.avatar.x}px`
      node.style.top = `${seat.avatar.y}px`
      node.style.width = `${layout.avatarSize}px`
      node.style.height = `${layout.avatarSize}px`
    })
    potLabel.style.left = `${layout.pot.x}px`
    potLabel.style.top = `${layout.pot.y + layout.chipSize * 1.05}px`
    // Банерът е над банката, за да не скрива подреждането на чиповете.
    banner.style.top = `${Math.max(layout.height * 0.2, layout.pot.y - layout.chipSize * 2.6)}px`
  }

  // ── HUD (банка, банер, победител) ────────────────────────────────────────
  function setPot(value: number): void {
    potLabel.textContent = `Банка: ${value}`
    potLabel.style.opacity = value > 0 ? '1' : '0'
  }

  function resetHud(): void {
    bannerAnimation?.cancel()
    bannerAnimation = null
    for (const animation of ringAnimations) animation.cancel()
    ringAnimations.length = 0
    banner.style.opacity = '0'
    for (const ring of seatRings) ring.style.opacity = '0'
    setPot(0)
  }

  function showWinner(seatIndex: number, animate: boolean): void {
    const ring = seatRings[seatIndex]
    if (!ring) return
    ring.style.opacity = '1'
    if (!animate) return
    ringAnimations.push(ring.animate(
      [
        { transform: 'scale(0.85)', opacity: 0 },
        { transform: 'scale(1.12)', opacity: 1, offset: 0.35 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 650, easing: 'ease-out' },
    ))
  }

  function playBanner(phase: SvaraDemoPhase): void {
    const totalMs = Math.max(...phase.moves.map((m) => m.delayMs + m.durationMs), 0) + phase.holdAfterMs
    bannerAnimation?.cancel()
    bannerAnimation = banner.animate(
      [
        { opacity: 0, transform: 'translate(-50%,-50%) scale(0.6)' },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1.12)', offset: 0.16 },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.28 },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.82 },
        { opacity: 0, transform: 'translate(-50%,-50%) scale(1.06)' },
      ],
      { duration: totalMs, easing: 'ease-out' },
    )
  }

  function applyFinalHud(currentScript: SvaraDemoScript): void {
    resetHud()
    const last = currentScript.phases[currentScript.phases.length - 1]
    setPot(last?.potAfter ?? 0)
    if (last?.winnerSeat !== null && last?.winnerSeat !== undefined) showWinner(last.winnerSeat, false)
  }

  // ── Статистика ───────────────────────────────────────────────────────────
  function renderStats(): void {
    const lines: string[] = []
    if (renderer) lines.push(renderer.getDebugInfo())
    lines.push(`зареждане на renderer-а: ${Math.round(rendererLoadMs)} ms`)
    if (lastStats) {
      lines.push(
        `последно пускане${lastRunInterrupted ? ' (прекъснато)' : ''}: ${lastStats.frames} кадъра за ${Math.round(lastStats.durationMs)} ms · средно ${lastStats.avgFps.toFixed(1)} fps · p95 ${lastStats.p95FrameMs.toFixed(1)} ms · най-дълъг ${lastStats.maxFrameMs.toFixed(1)} ms · кадри > 25 ms: ${lastStats.longFrames}`,
      )
    }
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    if (memory) lines.push(`JS heap: ${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`)
    statsBox.textContent = lines.join('\n')
    statsBox.style.whiteSpace = 'pre-line'
    statsBox.dataset.svaraDemoMetrics = JSON.stringify({
      renderer: rendererKind,
      status,
      rendererLoadMs,
      interrupted: lastRunInterrupted,
      stats: lastStats,
    })
  }

  function syncButtons(): void {
    element.querySelectorAll<HTMLButtonElement>('[data-svara-demo-renderer]').forEach((button) => {
      const active = button.dataset.svaraDemoRenderer === rendererKind
      button.style.background = active ? 'linear-gradient(180deg,#f5d06f,#d4a520)' : '#111'
      button.style.color = active ? '#1a1203' : '#f8fafc'
      button.setAttribute('aria-pressed', String(active))
      button.disabled = status === 'loading'
    })
    q<HTMLButtonElement>('[data-svara-demo-action="skip"]').disabled = status !== 'running'
    q<HTMLButtonElement>('[data-svara-demo-action="replay"]').disabled = status === 'loading'
  }

  function setStatus(next: DemoStatus): void {
    status = next
    stage.dataset.svaraDemoStatus = next
    loadingOverlay.style.display = next === 'loading' ? 'flex' : 'none'
    syncButtons()
    renderStats()
  }

  // ── Пускане / прекъсване ─────────────────────────────────────────────────
  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

  async function run(): Promise<void> {
    if (!renderer || !script) return
    const token = ++runToken
    const currentRenderer = renderer
    const currentScript = script
    resetHud()
    currentRenderer.applyState(currentScript.initial)
    lastRunInterrupted = false
    setStatus('running')
    meter.start()
    await wait(START_PAUSE_MS)
    for (const phase of currentScript.phases) {
      if (token !== runToken) return
      if (phase.showSvarkaBanner) playBanner(phase)
      const completed = await currentRenderer.play(phase.moves)
      if (!completed || token !== runToken) return
      setPot(phase.potAfter)
      if (phase.winnerSeat !== null) showWinner(phase.winnerSeat, true)
      if (phase.holdAfterMs > 0) await wait(phase.holdAfterMs)
    }
    if (token !== runToken) return
    lastStats = meter.stop()
    setStatus('done')
  }

  function interrupt(): void {
    if (!renderer || !script || status !== 'running') return
    runToken += 1
    renderer.cancel()
    renderer.applyState(getSvaraDemoFinalStates(script))
    applyFinalHud(script)
    lastStats = meter.stop()
    lastRunInterrupted = true
    setStatus('done')
  }

  async function loadRenderer(kind: SvaraRendererKind): Promise<SvaraDemoRenderer> {
    if (kind === 'pixi') {
      const { createSvaraPixiRenderer } = await import('./svaraDemoPixiRenderer')
      return createSvaraPixiRenderer()
    }
    return createSvaraDomRenderer()
  }

  async function switchRenderer(kind: SvaraRendererKind, autoPlay: boolean): Promise<void> {
    const switchId = ++switchCounter
    runToken += 1
    meter.stop()
    lastStats = null
    rendererKind = kind
    setStatus('loading')
    renderer?.destroy()
    renderer = null
    resetHud()
    const width = Math.max(240, Math.round(stage.clientWidth))
    script = buildSvaraDemoScript(width, stageHeightFor(width))
    applyLayoutToDom(script.layout)

    const startedAt = performance.now()
    let next: SvaraDemoRenderer
    try {
      next = await loadRenderer(kind)
      await next.mount(spritesHost, script.sprites, script.layout)
    } catch (error) {
      if (destroyed || switchId !== switchCounter) return
      console.warn('[svara-demo] renderer failed, falling back to DOM', error)
      next = createSvaraDomRenderer()
      rendererKind = 'dom'
      await next.mount(spritesHost, script.sprites, script.layout)
    }
    rendererLoadMs = performance.now() - startedAt
    if (destroyed || switchId !== switchCounter) {
      next.destroy()
      return
    }
    renderer = next
    renderer.applyState(script.initial)
    setStatus('idle')
    if (autoPlay) void run()
  }

  // ── Resize: нов layout и моментално коректно състояние ──────────────────
  let lastWidth = 0
  let resizeTimer: number | null = null
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null
      const width = Math.round(stage.clientWidth)
      if (destroyed || width === lastWidth || width === 0 || !renderer || !script) return
      lastWidth = width
      const wasRunning = status === 'running'
      runToken += 1
      renderer.cancel()
      script = buildSvaraDemoScript(width, stageHeightFor(width))
      applyLayoutToDom(script.layout)
      renderer.setLayout(script.layout)
      if (status === 'idle') {
        renderer.applyState(script.initial)
      } else {
        renderer.applyState(getSvaraDemoFinalStates(script))
        applyFinalHud(script)
        if (wasRunning) {
          lastStats = meter.stop()
          lastRunInterrupted = true
          setStatus('done')
        }
      }
    }, RESIZE_DEBOUNCE_MS)
  })

  element.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const action = target.closest<HTMLElement>('[data-svara-demo-action]')?.dataset.svaraDemoAction
    if (action === 'replay' && status !== 'loading') void run()
    if (action === 'skip') interrupt()
    const kind = target.closest<HTMLElement>('[data-svara-demo-renderer]')?.dataset.svaraDemoRenderer
    if ((kind === 'dom' || kind === 'pixi') && status !== 'loading' && kind !== rendererKind) void switchRenderer(kind, true)
  })

  // Първоначалното зареждане изчаква елемента да влезе в DOM (нужна е ширина).
  requestAnimationFrame(() => {
    if (destroyed) return
    lastWidth = Math.round(stage.clientWidth)
    resizeObserver.observe(stage)
    void switchRenderer('dom', true)
  })
  syncButtons()

  return {
    element,
    destroy() {
      destroyed = true
      runToken += 1
      meter.stop()
      resizeObserver.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resetHud()
      renderer?.destroy()
      renderer = null
      element.remove()
    },
  }
}
