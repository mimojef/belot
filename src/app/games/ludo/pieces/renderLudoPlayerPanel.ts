// Player панел — адаптация на Belot "side seat" card-а (виж
// src/app/activeRoom/cutting/renderCuttingSeatPanels.ts:
// createCuttingSeatPanelHtml, side-seat клон ~1436-1519, и
// renderSideCuttingCountdownFooter ~219-296) — точно тази карта се
// вижда в реалния Belot gameplay екран (renderPlayingScreen.ts използва
// createCuttingSeatPanelsHtml за seat panel-ите по време на игра, не
// само в lobby/cutting).
//
// Взето директно от Belot pattern-а:
//  - голяма светла avatar кутия (inset 8px в картата), fallback инициали
//  - долен footer бар с името, тъмен фон + gold gradient countdown fill,
//    който drain-ва отляво надясно (border-top gold accent) — същият
//    визуален език като renderSideCuttingCountdownFooter.
// Адаптирано за Ludo (Belot няма per-seat цвят):
//  - card border/glow в цвета на играча — единственият identity сигнал
//    (текстов color badge беше премахнат: рамката сама е достатъчна) +
//    по-силен glow при активен ход, вместо Belot-овия неутрален gold
//    highlight;
//  - countdown fill-ът остава gold (както в Belot) — само появява се
//    и drain-ва за играча, чийто ред е сега, аналогично на
//    countdownSeat логиката в Belot.
// Не е взето (няма смисъл в Ludo): dealt card fans, bid/declaration/
// emoji/phrase балончета, gift икони, dealer badge, tournament bot
// replacement логика.

import { LUDO_COLOR_HEX, LUDO_COLOR_LABEL } from '../ludoTypes'
import type { LudoPiece, LudoPlayer } from '../ludoTypes'
import { renderLudoDiceControl } from '../dice/renderLudoDiceControl'

const TURN_COUNTDOWN_MS = 20_000

// turnElapsedMs (подадено от renderLudoGameScreen, изчислено спрямо реален
// Date.now() deadline в createLudoFlowController.ts) се превръща в
// ОТРИЦАТЕЛЕН animation-delay — established pattern в проекта (виж
// renderCuttingCountdownFillStyle в renderCuttingSeatPanels.ts). Причина:
// countdown fill div-ът е чисто нов DOM node при ВСЕКИ render() (resize,
// dice roll, piece move — не само нов ход), а CSS animation на нов елемент
// винаги тръгва от 0%. Без този delay countdown-ът визуално би рестартирал
// на всеки такъв re-render — точно проблемът от audit-а (на mobile resize/
// viewport промени се случват много по-често заради динамичния browser
// chrome). С -elapsedMs delay, дори чисто нов елемент веднага "скача" на
// правилната текуща позиция, вместо да рестартира.
function clampedTurnDelayMs(turnElapsedMs: number): number {
  return Math.min(Math.max(turnElapsedMs, 0), TURN_COUNTDOWN_MS)
}

// Mobile-only countdown визуализация (виж audit-а: 70px footer travel
// distance е твърде къс — на DPR1 mobile emulation се вижда стъпаловидно,
// въпреки перфектно smooth 60fps CSS анимация). Desktop countdown-ът
// (footer fill, по-долу в render-а) остава напълно непроменен.
//
// SVG rounded-square пръстен в празния inset между аватара и card border-а
// — периметър ~242px (срещу 70px на старата footer лента), затова същата
// 20s линейна drain-анимация показва видима промяна много по-често дори на
// DPR1. pathLength="100" нормализира дължината, за да не се налага ръчно
// пресмятане на точния геометричен периметър на заоблен path.
function buildMobileCountdownRingPath(size: number, inset: number, radius: number): string {
  const min = inset
  const max = size - inset
  const topMid = size / 2
  return [
    `M ${topMid},${min}`,
    `L ${max - radius},${min}`,
    `A ${radius},${radius} 0 0 1 ${max},${min + radius}`,
    `L ${max},${max - radius}`,
    `A ${radius},${radius} 0 0 1 ${max - radius},${max}`,
    `L ${min + radius},${max}`,
    `A ${radius},${radius} 0 0 1 ${min},${max - radius}`,
    `L ${min},${min + radius}`,
    `A ${radius},${radius} 0 0 1 ${min + radius},${min}`,
    `L ${topMid},${min}`,
  ].join(' ')
}

export interface LudoPlayerPanelDiceControl {
  face: number
  isRollable: boolean
  isRolling: boolean
}

export function renderLudoPlayerPanel(
  player: LudoPlayer,
  pieces: LudoPiece[],
  isActive: boolean,
  useCompactLayout = false,
  turnElapsedMs = 0,
  diceControl: LudoPlayerPanelDiceControl | null = null,
): string {
  void pieces
  const hex = LUDO_COLOR_HEX[player.color]
  const initials = player.name.trim().slice(0, 1).toUpperCase()

  // Belot-овата side card е 186x234 (avatar top:8/left:8/right:8/bottom:64,
  // footer 52-64px) — тук avatar кутията е explicit width===height, за да
  // е гарантирано квадратна (Belot-овата е почти, но не точно квадратна).
  const borderWidthPx = 2

  // insetPx е ЕДНАКЪВ gap от аватара до всичките 4 страни на рамката
  // (ляво/дясно/горе/долу-преди-footer-а) — за ДВАТА layout-а (desktop и
  // mobile compact), не само desktop. Картата ползва box-sizing:border-box,
  // а top/left/right на absolute-positioned аватар се мерят спрямо PADDING
  // BOX-а (вътре в border-а, не спрямо външния ръб) — ако cardWidth/
  // cardHeight се смятат само от avatarSize+insetPx*2 (без да се извади
  // border-а), padding box-ът излиза с border*2 (4px) по-тесен/нисък от
  // очакваното, и тези "изядени" 4px липсват само от дясната/долната страна
  // (лявата/горната са директно зададени top/left стойности, недокоснати).
  // Desktop вече беше поправен по-рано; compact (mobile) имаше СЪЩИЯ бъг
  // (6px ляво vs 2px дясно, и аватарът дори леко застъпваше footer-а
  // отдолу, защото липсваше и bottom-gap-преди-footer). Затова формулата е
  // ЕДНА обща за двата layout-а, border-ът се добавя ИЗРИЧНО обратно:
  //   paddingBoxWidth  = cardWidth  - 2*border = avatarSize + insetPx*2  ✓
  //   paddingBoxHeight = cardHeight - 2*border = avatarSize + insetPx*2 + footerHeight ✓
  // → дясно = paddingBoxWidth - insetPx - avatarSize = insetPx (= ляво)
  // → долу (преди footer-а) = insetPx (= горе), доказано алгебрично, не
  //   "на око".
  const avatarSize = useCompactLayout ? 58 : 124
  const insetPx = useCompactLayout ? 6 : 8
  // Mobile name bar по-нисък от преди (30 → 24px) — по-компактно каре,
  // името остава четимо на същия font-size (footer-ът си остава
  // vertically-centered flex, не разчита на height за баланс на текста).
  const footerHeight = useCompactLayout ? 24 : 38
  const cardWidth = avatarSize + insetPx * 2 + borderWidthPx * 2
  const cardHeight = avatarSize + insetPx * 2 + footerHeight + borderWidthPx * 2
  const nameFontSize = useCompactLayout ? '11px' : '14px'
  const fallbackFontSize = useCompactLayout ? '22px' : '40px'
  const borderRadius = useCompactLayout ? '12px' : '16px'
  const avatarRadius = useCompactLayout ? '9px' : '13px'
  // Badge-ът с текстовия цвят ("ЧЕРВЕН"/"СИН"/...) е премахнат — рамката
  // сама носи идентичността вече, затова трябва да се разпознава ясно и
  // при неактивна карта, не само на активна (иначе 3 от 4 карти биха
  // изглеждали "безцветни" без badge-а). Вдигнат alpha за inactive от
  // 0x66 (40%) на 0x99 (60%).
  const borderColor = isActive ? hex : `${hex}99`
  // Border-ът остава физически 2px (borderWidthPx, непроменен — засяга
  // cardWidth/cardHeight формулата, виж коментара по-горе; промяна тук би
  // променила card размерите, изрично забранено). "По-дебела" рамка е
  // постигната визуално чрез плътен box-shadow пръстен веднага извън
  // border-а (0 0 0 2px) в СЪЩИЯ цвят — реалният border box остава 2px, но
  // визуалната цветна лента е ~4px (2px border + 2px solid shadow ring),
  // без да пипа layout/размерите на картата.
  const thickenRingShadow = `0 0 0 2px ${borderColor}`
  const activeGlow = isActive ? `, 0 0 26px ${hex}80, 0 0 46px ${hex}45` : ''
  const depthShadow = isActive ? ', 0 16px 30px rgba(0,0,0,0.3)' : ', 0 12px 24px rgba(0,0,0,0.24)'
  const shadow = `${thickenRingShadow}${activeGlow}${depthShadow}`

  return `
    <div
      data-ludo-player-panel="${player.color}"
      style="
        position:relative;
        width:${cardWidth}px;
        height:${cardHeight}px;
        box-sizing:border-box;
        border-radius:${borderRadius};
        border:${borderWidthPx}px solid ${borderColor};
        background:
          radial-gradient(circle at 30% 25%, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.025) 18%, rgba(255,255,255,0.0) 40%),
          linear-gradient(180deg, rgba(34,34,34,0.97) 0%, rgba(18,18,18,0.98) 54%, rgba(8,8,8,0.99) 100%);
        box-shadow:${shadow};
        overflow:hidden;
        transition:box-shadow 200ms ease, border-color 200ms ease;
        flex-shrink:0;
      "
    >
      ${isActive && diceControl
        ? renderLudoDiceControl({
            color: player.color,
            hex,
            avatarSize,
            insetPx,
            face: diceControl.face,
            isRollable: diceControl.isRollable,
            isRolling: diceControl.isRolling,
          })
        : `
      <div style="
        position:absolute;
        top:${insetPx}px; left:${insetPx}px;
        width:${avatarSize}px; height:${avatarSize}px;
        border-radius:${avatarRadius};
        background:linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(232,240,248,0.98) 100%);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.8),
          0 10px 18px rgba(0,0,0,0.18);
        display:flex; align-items:center; justify-content:center;
        color:#16314f; font-weight:900; font-size:${fallbackFontSize};
        overflow:hidden;
      ">
        ${player.avatarUrl
          ? `<img src="${player.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;">`
          : initials}
      </div>
      `}

      ${isActive && useCompactLayout ? (() => {
        const ringSize = avatarSize + insetPx * 2 // топ area над footer-а (58+6*2=70)
        const ringInset = 3 // център на 6px gap-а между avatar edge (6) и card padding-box edge (0)
        const ringRadius = 8
        const ringStrokeWidth = 2
        const ringPath = buildMobileCountdownRingPath(ringSize, ringInset, ringRadius)
        return `
          <svg
            data-ludo-seat-countdown-ring="${player.color}"
            width="${ringSize}" height="${ringSize}"
            viewBox="0 0 ${ringSize} ${ringSize}"
            style="position:absolute; top:0; left:0; z-index:4; pointer-events:none;"
          >
            <path
              d="${ringPath}"
              fill="none"
              stroke="#f5bb37"
              stroke-width="${ringStrokeWidth}"
              stroke-linecap="round"
              pathLength="100"
              style="
                stroke-dasharray:100;
                will-change:stroke-dashoffset;
                animation:ludo-seat-countdown-ring-drain ${TURN_COUNTDOWN_MS}ms linear forwards;
                animation-delay:-${clampedTurnDelayMs(turnElapsedMs)}ms;
              "
            ></path>
          </svg>
        `
      })() : ''}

      <div style="
        position:absolute; left:0; right:0; bottom:0; height:${footerHeight}px;
        background:rgba(10,10,10,0.94);
        border-top:1px solid ${isActive ? `${hex}99` : 'rgba(255,255,255,0.1)'};
        overflow:hidden;
      ">
        ${isActive && !useCompactLayout ? `
          <div
            data-ludo-seat-countdown-fill="${player.color}"
            style="
              position:absolute; inset:0;
              background:linear-gradient(90deg, rgba(245,187,55,0.98) 0%, rgba(255,166,0,0.98) 100%);
              box-shadow:inset 0 1px 0 rgba(255,255,255,0.22), 0 0 10px rgba(245,187,55,0.26);
              transform-origin:left center;
              will-change:transform;
              animation:ludo-seat-countdown-drain ${TURN_COUNTDOWN_MS}ms linear forwards;
              animation-delay:-${clampedTurnDelayMs(turnElapsedMs)}ms;
            "
          ></div>
        ` : ''}
        <div style="
          position:relative; z-index:2;
          height:100%;
          display:flex; align-items:center; justify-content:center;
          padding:0 6px;
          box-sizing:border-box;
        ">
          <div style="
            font-size:${nameFontSize}; font-weight:900; color:#f4f8ff;
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;
            text-shadow:0 1px 3px rgba(0,0,0,0.4);
          ">${player.name}</div>
        </div>
      </div>
    </div>
  `
}

export function ludoPlayerAriaLabel(player: LudoPlayer): string {
  return `${player.name} — ${LUDO_COLOR_LABEL[player.color]}`
}
