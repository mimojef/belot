// Dice control, който замества avatar-а на активния играч, докато чака да
// хвърли зара (виж task-а — старият самостоятелен "Хвърли зара" бутон под
// дъската отпада, roll тригерът се мести в player card-а). Компонентът НЕ
// съдържа собствена roll логика — само render + click target; реалният
// handler (handleRollDice в createLudoFlowController.ts) се закача отвън
// през СЪЩИЯ data-ludo-dice-roll-button="1" атрибут, който преди носеше
// старият <button>.
//
// Два визуални слоя, ДВА отделни DOM елемента (не един nested), с explicit
// local z-index hierarchy вътре в player card-а (position:relative root, виж
// renderLudoPlayerPanel.ts):
//  - z-index:1 (base) — production dice-turn image в avatar-sized click
//    target-а, СЪЩИЯТ border-radius + overflow:hidden clipping pattern като
//    normal avatar кутията (не квадратна с остри ръбове);
//  - z-index:2 (overlay) — SVG пръстен с 2 извити arc-и + arrowhead markers,
//    който се върти ПОСТОЯННО около зара (CSS transform:rotate на самия
//    <svg>, зарът остава напълно статичен). По-висок z-index от зара
//    гарантира стрелките да се рисуват ВИНАГИ над образа, не под него (бъгът,
//    който тази йерархия оправя — преди образът беше на по-висок z-index от
//    пръстена).
// Пръстенът е SIBLING на зара (не child), позициониран top:0;left:0 спрямо
// card-а — same convention като mobile countdown ring-а
// (renderLudoPlayerPanel.ts), за да НЕ бъде изрязан от зара box-а
// overflow:hidden (сега добавен на зара, но пръстенът е извън него).
// Footer-ът (името на играча) остава z-index:auto/position:absolute без
// numeric z-index — винаги под explicit-numbered siblings по CSS spec,
// независимо от DOM ред, затова не се налага собствен z-index тук.

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

export interface LudoDiceControlOptions {
  color: string // player color key за уникален arrow marker id (напр. "red")
  hex: string // player hex цвят — стрелките го ползват (виж task-а т.6)
  avatarSize: number // same box размер като avatar-а, който замества
  insetPx: number // same inset gap като avatar-а — arrow ring-ът ползва точно този gap (avatarSize+insetPx*2), same formula като mobile countdown ring-а
  // Same border-radius стойност като avatarRadius в renderLudoPlayerPanel.ts
  // ('9px' compact / '13px' desktop) — dice image-ът замества avatar-а
  // визуално 1:1, затова носи ТОЧНО същия radius + overflow:hidden clipping
  // pattern като normal avatar кутията, вместо остри правоъгълни ръбове.
  avatarRadius: string
  isRollable: boolean // true само за локалния играч на ход — добавя data-ludo-dice-roll-button="1" + pointer cursor
  // Единственото правило за rotating arrows (виж task-а): true само когато
  // ТОЗИ player е активен И turnPhase==='waiting_for_roll' — вярно за
  // local human, bot, auto-roll еднакво (виж renderLudoGameScreen.ts::
  // renderPlayerPanelSlot). НЕ isDiceRolling/isRolling — root cause на
  // предишния бъг беше точно тази по-широка (и грешна) връзка.
  shouldRotateArrows: boolean
}

export function renderLudoDiceControl(options: LudoDiceControlOptions): string {
  const { color, hex, avatarSize, insetPx, avatarRadius, isRollable, shouldRotateArrows } = options
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
  // -webkit-tap-highlight-color:transparent — needed LOCALLY here because
  // the whole Ludo game screen mounts on [data-ludo-overlay-root], a div
  // appended directly to document.body (createLobbyFlowController.ts), i.e.
  // a SIBLING of #app, not a descendant. The global mobile tap-highlight
  // reset in style.css only targets "#app *" (+ the two other body-level
  // exceptions it already lists) — same root cause documented there for the
  // bidding popup/bottom-hand-cards flash, this dice tap target falls into
  // that exact gap too. Fixed locally per this task's scope, not by
  // widening the global selector.
  return `
    <div
      data-ludo-dice-anchor="${color}"
      ${isRollable ? 'data-ludo-dice-roll-button="1"' : ''}
      style="
        position:absolute;
        top:${insetPx}px; left:${insetPx}px;
        width:${avatarSize}px; height:${avatarSize}px;
        display:flex; align-items:center; justify-content:center;
        border-radius:${avatarRadius};
        overflow:hidden;
        z-index:1;
        cursor:${isRollable ? 'pointer' : 'default'};
        -webkit-tap-highlight-color:transparent;
        ${isRollable ? '' : 'pointer-events:none;'}
      "
    >
      <img
        data-ludo-dice-turn-image="1"
        src="/images/ludo/dice-turn.webp"
        alt=""
        style="width:100%;height:100%;object-fit:contain;display:block;"
      >
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
