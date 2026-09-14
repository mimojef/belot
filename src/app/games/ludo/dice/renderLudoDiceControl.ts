// Dice control, който замества avatar-а на активния играч, докато чака да
// хвърли зара (виж task-а — старият самостоятелен "Хвърли зара" бутон под
// дъската отпада, roll тригерът се мести в player card-а). Компонентът НЕ
// съдържа собствена roll логика — само render + click target; реалният
// handler (handleRollDice в createLudoFlowController.ts) се закача отвън
// през СЪЩИЯ data-ludo-dice-roll-button="1" атрибут, който преди носеше
// старият <button>.
//
// Два визуални слоя, ДВА отделни DOM елемента (не един nested):
//  - pseudo-3D isometric зар (inline SVG, 3 видими лица: top/front/right +
//    pip точки на предното лице) — виж renderIsometricDiceCube по-долу;
//  - SVG пръстен с 2 извити arc-и + arrowhead markers, който се върти
//    ПОСТОЯННО около зара (CSS transform:rotate на самия <svg>, зарът
//    остава напълно статичен).
// Пръстенът е SIBLING на зара (не child), позициониран top:0;left:0
// спрямо card-а — same convention като mobile countdown ring-а
// (renderLudoPlayerPanel.ts), за да НЕ бъде изрязан от avatar box-а
// overflow:hidden.

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

// Стандартна SVG arc-path техника: 2 точки на окръжност + "A" команда.
// sweepFlag=1 (по часовниковата стрелка в SVG y-down координати) за двата
// arc-а, за да се въртят визуално в една и съща посока.
function describeArc(cx: number, cy: number, r: number, startAngleDeg: number, endAngleDeg: number): string {
  const start = polarToCartesian(cx, cy, r, startAngleDeg)
  const end = polarToCartesian(cx, cy, r, endAngleDeg)
  const largeArcFlag = endAngleDeg - startAngleDeg <= 180 ? 0 : 1
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

// --- Pseudo-3D dice illustration --------------------------------------
// Локален 100x100 viewBox координатна система — скалира се чисто на всякакъв
// финален пиксел размер само чрез width/height на <svg>, без отделна math на
// call site-а. 3 видими лица (класическа "flattened isometric" кутия):
// голямо квадратно ПРЕДНО лице + тънка ГОРНА ивица (bevel нагоре-надясно) +
// тънка ДЯСНА ивица (bevel надолу-надясно) — точно "предно лице + леко
// видимо горно/странично лице" от task-а, не пълен 6-стенен isometric куб
// (по-опростено, четимо и на 58px mobile).
const FRONT_X = 14
const FRONT_Y = 28
const FRONT_SIZE = 58
const BEVEL_DX = 20
const BEVEL_DY = -20

const PIP_FRACTIONS: Record<number, Array<[number, number]>> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.24], [0.72, 0.24], [0.28, 0.5], [0.72, 0.5], [0.28, 0.76], [0.72, 0.76]],
}

function renderFacePips(face: number): string {
  const points = PIP_FRACTIONS[face] ?? PIP_FRACTIONS[1]
  const r = FRONT_SIZE * 0.09
  return points
    .map(([fx, fy]) => {
      const cx = FRONT_X + fx * FRONT_SIZE
      const cy = FRONT_Y + fy * FRONT_SIZE
      return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="#241d10" opacity="0.88"></circle>`
    })
    .join('')
}

// size = финален CSS пиксел размер на SVG bounding box-а (квадратен,
// viewBox 0 0 100 100 скалира пропорционално). color — само за уникален
// gradient id (2+ едновременни dice control-а, напр. бъдещ multiplayer,
// не трябва да си делят <defs> id).
function renderIsometricDiceCube(face: number, size: number, color: string): string {
  const gradId = `ludo-dice-face-grad-${color}`
  const top = [
    `${FRONT_X},${FRONT_Y}`,
    `${FRONT_X + FRONT_SIZE},${FRONT_Y}`,
    `${FRONT_X + FRONT_SIZE + BEVEL_DX},${FRONT_Y + BEVEL_DY}`,
    `${FRONT_X + BEVEL_DX},${FRONT_Y + BEVEL_DY}`,
  ].join(' ')
  const right = [
    `${FRONT_X + FRONT_SIZE},${FRONT_Y}`,
    `${FRONT_X + FRONT_SIZE + BEVEL_DX},${FRONT_Y + BEVEL_DY}`,
    `${FRONT_X + FRONT_SIZE + BEVEL_DX},${FRONT_Y + FRONT_SIZE + BEVEL_DY}`,
    `${FRONT_X + FRONT_SIZE},${FRONT_Y + FRONT_SIZE}`,
  ].join(' ')

  return `
    <svg
      width="${size}" height="${size}"
      viewBox="0 0 100 100"
      style="position:relative; z-index:3; filter:drop-shadow(0 3px 4px rgba(0,0,0,0.4));"
    >
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fbf3df"></stop>
          <stop offset="1" stop-color="#efe0b8"></stop>
        </linearGradient>
      </defs>
      <polygon points="${top}" fill="#fdf8ec" stroke="rgba(60,45,20,0.35)" stroke-width="1.5" stroke-linejoin="round"></polygon>
      <polygon points="${right}" fill="#d9c89c" stroke="rgba(60,45,20,0.35)" stroke-width="1.5" stroke-linejoin="round"></polygon>
      <rect x="${FRONT_X}" y="${FRONT_Y}" width="${FRONT_SIZE}" height="${FRONT_SIZE}" rx="6" fill="url(#${gradId})" stroke="rgba(60,45,20,0.4)" stroke-width="1.5"></rect>
      ${renderFacePips(face)}
    </svg>
  `
}
// ------------------------------------------------------------------------

export interface LudoDiceControlOptions {
  color: string // player color key, само за уникален marker/gradient id (напр. "red")
  hex: string // player hex цвят — стрелките го ползват (виж task-а т.6)
  avatarSize: number // same box размер като avatar-а, който замества
  insetPx: number // same inset gap като avatar-а — arrow ring-ът ползва точно този gap (avatarSize+insetPx*2), same formula като mobile countdown ring-а
  // ФИКСИРАНА стойност от caller-а (винаги 1) — launcher-ът е чист бутон,
  // НИКОГА не отразява реалния dice резултат (виж task-а: истинският
  // резултат се вижда само на отделното letящо зарче в центъра на дъската,
  // playLudoDiceFlightOverlay.ts). Полето остава параметризируемо (не
  // hardcode-нато тук) само за да не разпилява renderLudoGameScreen.ts
  // "константата" на 2 места.
  face: number
  isRollable: boolean // true само за локалния играч на ход — добавя data-ludo-dice-roll-button="1" + pointer cursor
  // Единственото правило за rotating arrows (виж task-а): true само когато
  // ТОЗИ player е активен И turnPhase==='waiting_for_roll' — вярно за
  // local human, bot, auto-roll еднакво (виж renderLudoGameScreen.ts::
  // renderPlayerPanelSlot). НЕ isDiceRolling/isRolling — root cause на
  // предишния бъг беше точно тази по-широка (и грешна) връзка.
  shouldRotateArrows: boolean
}

export function renderLudoDiceControl(options: LudoDiceControlOptions): string {
  const { color, hex, avatarSize, insetPx, face, isRollable, shouldRotateArrows } = options
  const ringSize = avatarSize + insetPx * 2 // same formula като buildMobileCountdownRingPath ringSize — гарантирано се събира в inset gap-а, допира footerTop с 0 overlap (виж коментара в renderLudoPlayerPanel.ts)
  const cx = ringSize / 2
  const cy = ringSize / 2
  const strokeWidth = Math.max(2, Math.round(avatarSize * 0.03))
  const r = ringSize / 2 - strokeWidth * 1.8
  // 120° arc + 60° gap от всяка страна (преди: 160°/20°, четеше се почти
  // слепено — виж task-а). Центрирани на горе(-90°)/долу(90°), симетрично.
  const ARC_SPAN_DEG = 120
  const arcTop = describeArc(cx, cy, r, -90 - ARC_SPAN_DEG / 2, -90 + ARC_SPAN_DEG / 2)
  const arcBottom = describeArc(cx, cy, r, 90 - ARC_SPAN_DEG / 2, 90 + ARC_SPAN_DEG / 2)
  const markerId = `ludo-dice-arrow-head-${color}`
  // Зарът заема ~50% от avatar box-а (в исканите 42-55%) — viewBox
  // съдържанието на renderIsometricDiceCube запълва ~78% от собствения си
  // 100x100 box, затова финалният SVG size се скалира с /0.78, за да излезе
  // ВИЗУАЛНИЯТ куб (не svg bounding box-а) точно на ~50% от avatarSize.
  const dieVisualTarget = avatarSize * 0.5
  const dieSize = Math.round(dieVisualTarget / 0.78)

  return `
    <div
      data-ludo-dice-anchor="${color}"
      ${isRollable ? 'data-ludo-dice-roll-button="1"' : ''}
      style="
        position:absolute;
        top:${insetPx}px; left:${insetPx}px;
        width:${avatarSize}px; height:${avatarSize}px;
        display:flex; align-items:center; justify-content:center;
        z-index:3;
        cursor:${isRollable ? 'pointer' : 'default'};
        ${isRollable ? '' : 'pointer-events:none;'}
      "
    >
      ${renderIsometricDiceCube(face, dieSize, color)}
    </div>

    <svg
      data-ludo-dice-arrow-ring="${color}"
      width="${ringSize}" height="${ringSize}"
      viewBox="0 0 ${ringSize} ${ringSize}"
      style="
        position:absolute; top:0; left:0;
        z-index:2;
        pointer-events:none;
        transform-origin:50% 50%;
        will-change:transform;
        ${shouldRotateArrows ? 'animation:ludo-dice-arrows-spin 2.6s linear infinite;' : ''}
      "
    >
      <defs>
        <marker id="${markerId}" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="${hex}"></path>
        </marker>
      </defs>
      <path d="${arcTop}" fill="none" stroke="${hex}" stroke-width="${strokeWidth}" stroke-linecap="round" marker-end="url(#${markerId})"></path>
      <path d="${arcBottom}" fill="none" stroke="${hex}" stroke-width="${strokeWidth}" stroke-linecap="round" marker-end="url(#${markerId})"></path>
    </svg>
  `
}
