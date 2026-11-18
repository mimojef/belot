// Свара — анимационен прототип (Етап 2А / 2А.1). Само демонстрационни
// данни: без реални играчи, жълтици, залози или сървърни заявки.
//
// Слоеве: ОБЩАТА визуална сцена (../scene/: обвивка — маса/места/аватари/
// банка/банер/ефект за победа; оформление; хореография) + сменяем renderer за
// картите и чиповете (DOM/WAAPI или PixiJS). Същата сцена рисува и истинската
// игра. PixiJS се зарежда с dynamic import едва при избор.
//
// Прекъсване/възстановяване: „Прекъсни“ и смяна на renderer-а прилагат
// детерминистичното крайно (или начално) състояние; resize по време на
// пускане прилага състоянието след текущата фаза в новия размер и
// продължава със следващата — координатите винаги идват от новия layout.

import { playGameSound } from '../../../audio/gameSoundSettings'
import { createSvaraSceneShell } from '../scene/svaraSceneShell'
import { createSvaraDomRenderer } from './svaraDemoDomRenderer'
import { createSvaraFrameMeter, type SvaraFrameStats } from './svaraDemoFrameMeter'
import type { SvaraDemoRenderer, SvaraRendererKind } from './svaraDemoRenderer'
import {
  buildSvaraDemoScript,
  getSvaraDemoFinalStates,
  getSvaraPhaseDurationMs,
  SVARA_DEMO_AVATAR_SRCS,
  SVARA_DEMO_SEAT_NAMES,
  SVARA_DEMO_SOUND_SRCS,
  type SvaraDemoEvent,
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
const MOBILE_BREAKPOINT = 560
const SOUND_VOLUME: Record<'deal' | 'land' | 'chips', number> = { deal: 0.35, land: 0.4, chips: 0.35 }

const BUTTON_STYLE = 'border:1px solid rgba(212,165,32,0.6);border-radius:10px;padding:9px 14px;background:#111;color:#f8fafc;font-size:14px;font-weight:800;cursor:pointer;'

export function createSvaraAnimationDemo(): SvaraAnimationDemo {
  const element = document.createElement('section')
  element.dataset.svaraDemo = '1'
  element.style.cssText = 'margin-top:18px;'
  element.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;">
      <button type="button" data-svara-demo-action="replay" style="${BUTTON_STYLE}">▶ Пусни отново</button>
      <button type="button" data-svara-demo-action="skip" style="${BUTTON_STYLE}">⏭ Прекъсни</button>
      <span style="flex:1 1 auto;"></span>
      <div role="group" aria-label="Графичен енджин" style="display:inline-flex;border:1px solid rgba(212,165,32,0.6);border-radius:10px;overflow:hidden;">
        <button type="button" data-svara-demo-renderer="dom" style="border:0;padding:9px 12px;font-size:13px;font-weight:800;cursor:pointer;">DOM / WAAPI</button>
        <button type="button" data-svara-demo-renderer="pixi" style="border:0;padding:9px 12px;font-size:13px;font-weight:800;cursor:pointer;">PixiJS</button>
      </div>
    </div>
    <div data-svara-demo-stats style="margin-top:10px;color:rgba(248,250,252,0.78);font-size:12px;line-height:1.5;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-word;white-space:pre-line;"></div>
    <div style="margin-top:6px;color:rgba(248,250,252,0.5);font-size:12px;">Демонстрация с примерни данни — без реални играчи, жълтици и залози. Звуците следват настройката „Звуци в играта“.</div>
  `

  // Общата сцена (същата като в истинската игра) + атрибутите на демото.
  const shell = createSvaraSceneShell({ bannerText: 'СВАРКА!', avatarSrcs: SVARA_DEMO_AVATAR_SRCS, names: SVARA_DEMO_SEAT_NAMES })
  const stage = shell.stage
  stage.dataset.svaraDemoStage = '1'
  shell.seatsLayer.dataset.svaraDemoSeats = ''
  shell.spritesHost.dataset.svaraDemoSprites = ''
  shell.potLabel.dataset.svaraDemoPot = ''
  shell.winLabel.dataset.svaraDemoWin = ''
  shell.banner.dataset.svaraDemoBanner = ''
  shell.seats.forEach((seat, i) => { seat.node.dataset.svaraDemoSeat = String(i) })
  const loadingOverlay = document.createElement('div')
  loadingOverlay.dataset.svaraDemoLoading = ''
  loadingOverlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.85);font-size:14px;font-weight:700;background:rgba(0,0,0,0.25);'
  loadingOverlay.textContent = 'Зареждане на графиката…'
  stage.appendChild(loadingOverlay)
  element.prepend(stage)
  const q = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!
  const spritesHost = shell.spritesHost
  const statsBox = q<HTMLElement>('[data-svara-demo-stats]')

  let destroyed = false
  let status: DemoStatus = 'loading'
  let runToken = 0
  let switchCounter = 0
  let rendererKind: SvaraRendererKind = 'dom'
  let renderer: SvaraDemoRenderer | null = null
  let script: SvaraDemoScript | null = null
  let currentPhaseIndex = -1
  let rendererLoadMs = 0
  let lastStats: SvaraFrameStats | null = null
  let lastRunInterrupted = false
  let lastRunResized = false
  const eventTimers = new Set<number>()
  const meter = createSvaraFrameMeter()

  // ── Размер на масата ─────────────────────────────────────────────────────
  // Desktop лобито е мащабирано с CSS zoom; височината се ограничава от
  // видимата част на прозореца, за да се вижда цялата маса без скрол.
  function stageSize(): { width: number; height: number } {
    const width = Math.max(240, Math.round(stage.clientWidth))
    if (width < MOBILE_BREAKPOINT) return { width, height: Math.round(width * 1.35) }
    const rect = stage.getBoundingClientRect()
    const zoom = stage.offsetWidth > 0 ? rect.width / stage.offsetWidth : 1
    const viewportHeight = window.innerHeight / (zoom || 1)
    const available = viewportHeight - 210
    return { width, height: Math.round(Math.max(380, Math.min(width * 0.6, available))) }
  }

  function applyLayoutToDom(layout: SvaraDemoLayout): void {
    shell.applyLayout(layout)
  }

  // ── HUD (банка, банер, победител) ────────────────────────────────────────
  function setPot(value: number, pulse: boolean): void {
    shell.setPot(value, pulse)
  }

  function clearEventTimers(): void {
    for (const timer of eventTimers) window.clearTimeout(timer)
    eventTimers.clear()
  }

  function resetHud(): void {
    clearEventTimers()
    shell.resetHud()
  }

  function showWinner(seatIndex: number, amount: number, animate: boolean): void {
    shell.showWinner(seatIndex, amount, animate)
  }

  function playBanner(phase: SvaraDemoPhase): void {
    shell.playBanner(getSvaraPhaseDurationMs(phase) + phase.holdAfterMs)
  }

  function scheduleEvents(events: SvaraDemoEvent[], token: number): void {
    for (const event of events) {
      const timer = window.setTimeout(() => {
        eventTimers.delete(timer)
        if (token !== runToken || destroyed) return
        if (event.kind === 'sound') playGameSound(SVARA_DEMO_SOUND_SRCS[event.sound], { volume: SOUND_VOLUME[event.sound] })
        else if (event.kind === 'pot') setPot(event.value, true)
        else showWinner(event.seat, event.amount, true)
      }, event.atMs)
      eventTimers.add(timer)
    }
  }

  /** HUD състоянието след фаза index (без анимации) — за прекъсване/resize. */
  function applyHudAfter(currentScript: SvaraDemoScript, index: number): void {
    resetHud()
    const phase = currentScript.phases[index]
    if (!phase) return
    setPot(phase.potAfter, false)
    if (phase.winnerSeat !== null) showWinner(phase.winnerSeat, 0, false)
  }

  // ── Статистика ───────────────────────────────────────────────────────────
  function renderStats(): void {
    const lines: string[] = []
    if (renderer) lines.push(renderer.getDebugInfo())
    if (script) lines.push(`маса ${script.layout.width}×${script.layout.height} · карта ${Math.round(script.layout.cardWidth)} px · чип ${Math.round(script.layout.chipSize)} px`)
    lines.push(`зареждане на renderer-а: ${Math.round(rendererLoadMs)} ms`)
    if (lastStats) {
      const note = lastRunInterrupted ? ' (прекъснато)' : lastRunResized ? ' (с resize)' : ''
      lines.push(
        `последно пускане${note}: ${lastStats.frames} кадъра за ${Math.round(lastStats.durationMs)} ms · средно ${lastStats.avgFps.toFixed(1)} fps · p95 ${lastStats.p95FrameMs.toFixed(1)} ms · най-дълъг ${lastStats.maxFrameMs.toFixed(1)} ms · кадри > 25 ms: ${lastStats.longFrames}`,
      )
    }
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    if (memory) lines.push(`JS heap: ${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`)
    statsBox.textContent = lines.join('\n')
    statsBox.dataset.svaraDemoMetrics = JSON.stringify({
      renderer: rendererKind,
      status,
      rendererLoadMs,
      interrupted: lastRunInterrupted,
      resized: lastRunResized,
      phaseIndex: currentPhaseIndex,
      layout: script ? { width: script.layout.width, height: script.layout.height, cardWidth: script.layout.cardWidth, chipSize: script.layout.chipSize } : null,
      stats: lastStats,
    })
  }

  function syncButtons(): void {
    element.querySelectorAll<HTMLButtonElement>('[data-svara-demo-renderer]').forEach((button) => {
      const isActive = button.dataset.svaraDemoRenderer === rendererKind
      button.style.background = isActive ? 'linear-gradient(180deg,#f5d06f,#d4a520)' : '#111'
      button.style.color = isActive ? '#1a1203' : '#f8fafc'
      button.setAttribute('aria-pressed', String(isActive))
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

  async function runPhases(fromIndex: number, token: number): Promise<void> {
    for (let index = fromIndex; index < (script?.phases.length ?? 0); index += 1) {
      if (token !== runToken || !renderer || !script) return
      const phase = script.phases[index]!
      currentPhaseIndex = index
      if (phase.showSvarkaBanner) playBanner(phase)
      scheduleEvents(phase.events, token)
      const completed = await renderer.play(phase.moves)
      if (!completed || token !== runToken) return
      setPot(phase.potAfter, false)
      if (phase.holdAfterMs > 0) await wait(phase.holdAfterMs)
    }
    if (token !== runToken) return
    lastStats = meter.stop()
    setStatus('done')
  }

  async function run(): Promise<void> {
    if (!renderer || !script) return
    const token = ++runToken
    resetHud()
    renderer.applyState(script.initial)
    currentPhaseIndex = -1
    lastRunInterrupted = false
    lastRunResized = false
    setStatus('running')
    meter.start()
    await wait(START_PAUSE_MS)
    if (token !== runToken) return
    await runPhases(0, token)
  }

  function interrupt(): void {
    if (!renderer || !script || status !== 'running') return
    runToken += 1
    renderer.cancel()
    renderer.applyState(getSvaraDemoFinalStates(script))
    applyHudAfter(script, script.phases.length - 1)
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
    const size = stageSize()
    script = buildSvaraDemoScript(size.width, size.height)
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

  // ── Resize: нов layout; по време на пускане продължава от следващата фаза ─
  let lastSizeKey = ''
  let resizeTimer: number | null = null
  // Ширината идва от ResizeObserver, височината зависи и от прозореца.
  function scheduleResize(): void {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(handleResize, RESIZE_DEBOUNCE_MS)
  }

  function handleResize(): void {
      resizeTimer = null
      if (destroyed || !renderer || !script || status === 'loading') return
      const size = stageSize()
      const key = `${size.width}x${size.height}`
      if (key === lastSizeKey || size.width === 0) return
      lastSizeKey = key
      const wasRunning = status === 'running'
      const phaseIndex = currentPhaseIndex
      runToken += 1
      renderer.cancel()
      script = buildSvaraDemoScript(size.width, size.height)
      applyLayoutToDom(script.layout)
      renderer.setLayout(script.layout)
      if (status === 'idle') {
        renderer.applyState(script.initial)
        applyHudAfter(script, -1)
      } else if (wasRunning) {
        // Състоянието след текущата фаза в новите координати → продължаваме.
        const states = phaseIndex >= 0 ? script.statesAfter[phaseIndex]! : script.initial
        renderer.applyState(states)
        applyHudAfter(script, phaseIndex)
        lastRunResized = true
        const token = runToken
        renderStats()
        void runPhases(phaseIndex + 1, token)
      } else {
        renderer.applyState(getSvaraDemoFinalStates(script))
        applyHudAfter(script, script.phases.length - 1)
        renderStats()
      }
  }
  const resizeObserver = new ResizeObserver(scheduleResize)

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
    const size = stageSize()
    lastSizeKey = `${size.width}x${size.height}`
    resizeObserver.observe(stage)
    void switchRenderer('dom', true)
  })
  window.addEventListener('resize', scheduleResize)
  syncButtons()

  return {
    element,
    destroy() {
      destroyed = true
      runToken += 1
      meter.stop()
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleResize)
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resetHud()
      renderer?.destroy()
      renderer = null
      element.remove()
    },
  }
}
