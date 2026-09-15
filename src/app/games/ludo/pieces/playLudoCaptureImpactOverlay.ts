// Presentation-only "explosion impact burst" overlay при capture (виж
// task-а: cartoon/arcade-style explosion, не просто glow ring — ярко жълто-
// бяло ядро + неправилен клъстер от оранжево-червени "cloud puff" топки +
// остри spike-лъчи навън, вдъхновено от класически pixel-art explosion
// sprite ефекти, но НЕ копирано 1:1 — оригинална композиция от чист CSS/
// WAAPI слоеве). Reuse-ва СЪЩИЯ document.body overlay pattern като
// playLudoDiceFlightOverlay.ts/playLudoCaptureFlightOverlay.ts
// (position:fixed + real getBoundingClientRect() rect + WAAPI за lifecycle),
// само с CSS-съставен multi-layer visual вместо piece/dice markup — няма
// canvas, няма external assets/sprite sheets, няма emoji.
//
// ЧИСТО presentation: не пипа engine state, не дублира capture rules, не
// знае нищо за victim id-та или stack size — вика се ТОЧНО ВЕДНЪЖ на target
// rect-а, независимо дали capture-ът е единичен или stack (controller-ът,
// не този overlay, решава да го извика само веднъж — виж call site-а в
// createLudoFlowController.ts::animateCapture).
//
// 3 фази, споделящи ЕДИН timeline (IMPACT_DURATION_MS):
//   POP   (0-15%)  — бърз bright flash в центъра, scale 0->1.1.
//   BURST (15-60%) — puff клъстерът и spike-овете едновременно изригват
//                    навън (различни delay/distance за органичен, не
//                    perfectly symmetric вид), shockwave ring се разширява.
//   FADE  (60-100%)— всичко избледнява бързо до 0 opacity, overlay-ят се
//                    маха от DOM-а — без remaining halo/outline.
// Overlay-ят се маха сам след завършване, caller-ът просто await-ва промиса.

const IMPACT_DURATION_MS = 340
const PUFF_COUNT = 7
const SPIKE_COUNT = 8

// Fisher-Yates-style детерминистичен "organic" offset набор — НЕ perfect
// symmetric spacing (за разлика от старата версия), за да прилича на
// неправилния cloud-puff клъстер от референтния explosion стил. Стойностите
// са фиксирани (не Math.random()) — presentation остава детерминистична/
// тестваема, без нужда от seed управление.
const PUFF_ANGLES_DEG = [15, 65, 110, 150, 200, 260, 320]
const PUFF_DISTANCE_FRACTIONS = [0.32, 0.42, 0.28, 0.45, 0.35, 0.4, 0.3]
const PUFF_SIZE_FRACTIONS = [0.55, 0.68, 0.5, 0.72, 0.58, 0.62, 0.52]

const SPIKE_ANGLES_DEG = [0, 45, 95, 140, 180, 225, 275, 320]
const SPIKE_LENGTH_FRACTIONS = [1.0, 0.72, 0.92, 0.68, 1.05, 0.75, 0.88, 0.7]

export interface LudoCaptureImpactOptions {
  // Target клетката (viewer-relative rendered rect, вече измерена от
  // caller-а чрез getBoundingClientRect() — този overlay не преизчислява
  // никаква geometry/perspective, само центрира спрямо подадения rect).
  targetRect: DOMRect
  // Bot-takeover popup layering fix (виж createLudoFlowController.ts
  // audit-а и playLudoDiceFlightOverlay.ts LudoDiceFlightOptions doc
  // коментара за пълния root cause): overlay-ят живее на document.body,
  // sibling на Ludo overlay root-а (не вложен в него) — popup-ът е mount-
  // нат ВЪТРЕ в overlay root-а, чийто ограничен родителски stacking
  // context прави дори по-нисък-номер z-index sibling на body да застане
  // визуално над него. initiallyHidden се прилага ВЕДНАГА при DOM element
  // creation (не след burst-а завърши) — same fix pattern като dice/
  // capture-flight overlay-ите.
  initiallyHidden: boolean
}

// Резолвва се, когато целият burst визуално приключи (~IMPACT_DURATION_MS) —
// caller-ят await-ва преди да продължи към victim flight (виж task-а
// sequencing: shake -> impact burst -> victim се скрива -> flight).
export function playLudoCaptureImpactOverlay(options: LudoCaptureImpactOptions): Promise<void> {
  const { targetRect, initiallyHidden } = options
  const centerX = targetRect.left + targetRect.width / 2
  const centerY = targetRect.top + targetRect.height / 2
  // Размерът на burst-а следва размера на самата клетка (не hardcoded px) —
  // остава четим на малки mobile клетки и не "залива" половината дъска на
  // големи desktop клетки.
  const cellSizePx = Math.max(targetRect.width, targetRect.height)
  const coreSizePx = cellSizePx * 0.85
  const puffBaseSizePx = cellSizePx * 0.62
  const puffTravelPx = cellSizePx * 0.38
  const spikeLengthPx = cellSizePx * 0.95
  const spikeWidthPx = Math.max(3, cellSizePx * 0.11)
  const ringMaxSizePx = cellSizePx * 1.5

  const container = document.createElement('div')
  container.setAttribute('data-ludo-capture-impact', '1')
  container.style.cssText = `
    position:fixed;
    left:${centerX}px; top:${centerY}px;
    width:0; height:0;
    z-index:8500;
    pointer-events:none;
    visibility:${initiallyHidden ? 'hidden' : 'visible'};
  `

  // Shockwave ring — тънък punch пръстен, разширяващ се и избледняващ зад
  // всичко останало (z-index 1, най-долният слой в container-а).
  const ringEl = document.createElement('div')
  ringEl.style.cssText = `
    position:absolute;
    left:50%; top:50%;
    width:${ringMaxSizePx}px; height:${ringMaxSizePx}px;
    transform:translate(-50%, -50%) scale(0.15);
    border-radius:50%;
    border:${Math.max(2, cellSizePx * 0.045)}px solid rgba(255,138,26,0.85);
    box-shadow:0 0 ${cellSizePx * 0.12}px ${cellSizePx * 0.03}px rgba(255,102,0,0.5);
    opacity:0;
  `
  container.appendChild(ringEl)

  // Spikes — остри триъгълни лъчи (clip-path), стърчащи радиално навън,
  // различна дължина за органичен вид (не perfectly symmetric star) — това
  // е основната разлика спрямо старата "кръгчета spark" версия, дава
  // "arcade explosion" усещане вместо просто искри.
  const spikes: Array<{ el: HTMLElement; angleDeg: number }> = []
  for (let i = 0; i < SPIKE_COUNT; i += 1) {
    const angleDeg = SPIKE_ANGLES_DEG[i % SPIKE_ANGLES_DEG.length]!
    const lengthFraction = SPIKE_LENGTH_FRACTIONS[i % SPIKE_LENGTH_FRACTIONS.length]!
    const spikeEl = document.createElement('div')
    const thisSpikeLengthPx = spikeLengthPx * lengthFraction
    spikeEl.style.cssText = `
      position:absolute;
      left:50%; top:50%;
      width:${thisSpikeLengthPx}px; height:${spikeWidthPx}px;
      margin-top:${-spikeWidthPx / 2}px;
      transform-origin:0% 50%;
      transform:rotate(${angleDeg}deg) scaleX(0);
      background:linear-gradient(90deg, rgba(255,229,143,0.98) 0%, rgba(255,159,26,0.9) 45%, rgba(255,90,26,0) 100%);
      clip-path:polygon(0% 35%, 78% 12%, 100% 50%, 78% 88%, 0% 65%);
    `
    container.appendChild(spikeEl)
    spikes.push({ el: spikeEl, angleDeg })
  }

  // Puff клъстер — неправилно разположени "cloud" blobs около центъра,
  // всеки собствен radial gradient (по-светло ядро -> оранжево -> тъмно-
  // червеникав ръб), overlapping за да изглежда като единен explosion
  // силует, не отделни кръгчета. Рисувани СЛЕД spikes-ите (по-висок
  // z-order), за да покрият основите им, точно както в референтния стил
  // (spikes се подават "изпод" клъстера от облачета).
  const puffs: Array<{ el: HTMLElement; dx: number; dy: number }> = []
  for (let i = 0; i < PUFF_COUNT; i += 1) {
    const angleDeg = PUFF_ANGLES_DEG[i % PUFF_ANGLES_DEG.length]!
    const angleRad = (angleDeg * Math.PI) / 180
    const distanceFraction = PUFF_DISTANCE_FRACTIONS[i % PUFF_DISTANCE_FRACTIONS.length]!
    const sizeFraction = PUFF_SIZE_FRACTIONS[i % PUFF_SIZE_FRACTIONS.length]!
    const puffSizePx = puffBaseSizePx * sizeFraction
    const dx = Math.cos(angleRad) * puffTravelPx * distanceFraction
    const dy = Math.sin(angleRad) * puffTravelPx * distanceFraction
    const puffEl = document.createElement('div')
    puffEl.style.cssText = `
      position:absolute;
      left:50%; top:50%;
      width:${puffSizePx}px; height:${puffSizePx}px;
      margin-left:${-puffSizePx / 2}px; margin-top:${-puffSizePx / 2}px;
      border-radius:50%;
      background:radial-gradient(circle at 38% 35%, rgba(255,241,196,0.98) 0%, rgba(255,164,38,0.95) 38%, rgba(230,74,20,0.85) 72%, rgba(200,40,10,0) 100%);
      opacity:0;
      transform:translate(0, 0) scale(0.3);
    `
    container.appendChild(puffEl)
    puffs.push({ el: puffEl, dx, dy })
  }

  // Централен core flash — най-горният слой, ярко бяло-жълто ядро (POP
  // фазата), покрива basите на puff/spike слоевете точно в центъра.
  const coreEl = document.createElement('div')
  coreEl.style.cssText = `
    position:absolute;
    left:50%; top:50%;
    width:${coreSizePx}px; height:${coreSizePx}px;
    transform:translate(-50%, -50%) scale(0.3);
    border-radius:50%;
    background:radial-gradient(circle, rgba(255,255,255,0.98) 0%, rgba(255,245,200,0.96) 30%, rgba(255,196,66,0.9) 58%, rgba(255,140,26,0) 78%);
    opacity:0;
  `
  container.appendChild(coreEl)

  document.body.appendChild(container)

  // --- POP: бърз bright flash, offset 0 -> ~0.15 ---
  const coreAnimation = coreEl.animate(
    [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.25)', offset: 0 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1.08)', offset: 0.16 },
      { opacity: 0.85, transform: 'translate(-50%, -50%) scale(1)', offset: 0.4 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.92)', offset: 1 },
    ],
    { duration: IMPACT_DURATION_MS, easing: 'ease-out', fill: 'forwards' },
  )

  // --- Shockwave ring: разширява се цялото времетраене, зад puffs/core ---
  ringEl.animate(
    [
      { opacity: 0.9, transform: 'translate(-50%, -50%) scale(0.15)', offset: 0 },
      { opacity: 0.6, transform: 'translate(-50%, -50%) scale(0.75)', offset: 0.45 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1)', offset: 1 },
    ],
    { duration: IMPACT_DURATION_MS, easing: 'ease-out', fill: 'forwards' },
  )

  // --- BURST: puffs изригват навън (offset ~0.1 -> 0.7), после FADE ---
  for (const { el: puffEl, dx, dy } of puffs) {
    puffEl.animate(
      [
        { opacity: 0, transform: 'translate(0, 0) scale(0.25)', offset: 0 },
        { opacity: 1, transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) scale(1)`, offset: 0.3 },
        { opacity: 0.85, transform: `translate(${dx}px, ${dy}px) scale(0.92)`, offset: 0.65 },
        { opacity: 0, transform: `translate(${dx * 1.15}px, ${dy * 1.15}px) scale(0.7)`, offset: 1 },
      ],
      { duration: IMPACT_DURATION_MS, easing: 'ease-out', fill: 'forwards' },
    )
  }

  // --- BURST: spikes изстрелват навън (scaleX 0->1 по дължината си, от
  // pivot точката в центъра — transform-origin:0% 50% по-горе), после FADE.
  // rotate(angleDeg) остава ФИКСИРАН през целия timeline (само scaleX
  // анимира) — explicit keyframes, за да не разчитаме на частичен transform
  // string reuse (WAAPI изисква пълния transform низ на всеки keyframe).
  for (const { el: spikeEl, angleDeg } of spikes) {
    spikeEl.animate(
      [
        { opacity: 0, transform: `rotate(${angleDeg}deg) scaleX(0)`, offset: 0 },
        { opacity: 1, transform: `rotate(${angleDeg}deg) scaleX(1.05)`, offset: 0.28 },
        { opacity: 0.8, transform: `rotate(${angleDeg}deg) scaleX(0.95)`, offset: 0.6 },
        { opacity: 0, transform: `rotate(${angleDeg}deg) scaleX(0.8)`, offset: 1 },
      ],
      { duration: IMPACT_DURATION_MS, easing: 'ease-out', fill: 'forwards' },
    )
  }

  return coreAnimation.finished.then(() => {
    container.remove()
  })
}
