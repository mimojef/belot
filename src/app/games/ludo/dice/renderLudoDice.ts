// Истински CSS 3D зар — 6 страни, всяка отделен DOM елемент с
// transform-style:preserve-3d, а не изображение. Резултатът винаги идва
// отвън (mock/server) — CSS-ът само върти куба до правилната страна.
//
// Размерът НЕ е фиксиран (виж task-а — responsive scaling bug: desktop
// имаше добър визуален размер, но на mobile дъската се смалява, а зарът
// оставаше с твърд 64px, значи изглеждаше прекалено голям спрямо клетките).
// renderLudoDice() сега приема size (px) като параметър — всяка вътрешна
// геометрия (face size, border-radius, box-shadow offsets, perspective,
// ground ellipse, drop-shadow) е derived от НЕГО чрез един-единствен scale
// коефициент, не отделни hardcoded desktop/mobile стойности.

// Референтният desktop размер, спрямо който бяха тествани/одобрени
// bevel/shadow/perspective стойностите по-долу (виж по-старите task-ове за
// dice 3D визията) — служи само за извеждане на scale коефициента, не е
// hardcoded viewport-specific константа. halfDepth (translateZ) винаги е
// точно size/2, без значение от BASE_DICE_SIZE.
const BASE_DICE_SIZE = 64

const PIP_POSITIONS: Record<number, Array<{ top: string; left: string }>> = {
  1: [{ top: '50%', left: '50%' }],
  2: [{ top: '25%', left: '25%' }, { top: '75%', left: '75%' }],
  3: [{ top: '25%', left: '25%' }, { top: '50%', left: '50%' }, { top: '75%', left: '75%' }],
  4: [{ top: '25%', left: '25%' }, { top: '25%', left: '75%' }, { top: '75%', left: '25%' }, { top: '75%', left: '75%' }],
  5: [{ top: '25%', left: '25%' }, { top: '25%', left: '75%' }, { top: '50%', left: '50%' }, { top: '75%', left: '25%' }, { top: '75%', left: '75%' }],
  6: [{ top: '22%', left: '25%' }, { top: '22%', left: '75%' }, { top: '50%', left: '25%' }, { top: '50%', left: '75%' }, { top: '78%', left: '25%' }, { top: '78%', left: '75%' }],
}

// Изнесена (export) за преизползване от renderLudoDiceControl.ts (плоският
// зар в player card-а показва същите pip позиции — % based, size-agnostic,
// значи работи непроменено на всякакъв размер контейнер). pipInsetShadowPx
// е единствената non-% детайла тук (inset 0 1px 1px) — по подразбиране 1px
// (launcher-ът, непроменен размер), landing die-то подава scale-натата
// стойност изрично.
export function renderPips(face: number, pipInsetShadowPx = 1): string {
  const positions = PIP_POSITIONS[face] ?? []
  return positions.map((p) => `
    <span style="
      position:absolute;
      top:${p.top}; left:${p.left};
      width:20%; height:20%;
      transform:translate(-50%, -50%);
      border-radius:50%;
      background:#1a1a1a;
      box-shadow:inset 0 ${pipInsetShadowPx}px ${pipInsetShadowPx}px rgba(0,0,0,0.4);
    "></span>
  `).join('')
}

// Face transform-и, консистентни с LUDO_DICE_FACE_ROTATION в
// ludoDiceState.ts — всяка страна се позиционира на куба чрез translateZ и
// собствената си rotation спрямо центъра. halfDepth = size/2 — геометрично
// правило, пазено изрично (виж task-а), не приблизително.
function buildFaceTransforms(halfDepth: number): Array<{ face: number; transform: string }> {
  return [
    { face: 1, transform: `rotateY(0deg) translateZ(${halfDepth}px)` },
    { face: 6, transform: `rotateY(180deg) translateZ(${halfDepth}px)` },
    { face: 3, transform: `rotateY(90deg) translateZ(${halfDepth}px)` },
    { face: 4, transform: `rotateY(-90deg) translateZ(${halfDepth}px)` },
    { face: 2, transform: `rotateX(90deg) translateZ(${halfDepth}px)` },
    { face: 5, transform: `rotateX(-90deg) translateZ(${halfDepth}px)` },
  ]
}

// Фиксиран per-face gradient tone (не спрямо динамичната ротация, спрямо
// ПОСТОЯННАТА позиция на всяко лице върху куба) — симулира мека directional
// светлина идваща отгоре-ляво: face 4 (ляво, rotateY(-90)) е най-светло,
// face 3 (дясно, rotateY(90)) е най-тъмно, face 1 (фронт, основното четимо
// лице) остава close to baseline яркост. Преди тази промяна всичките 6
// лица имаха ЕДИН И СЪЩ цвят, затова кубът изглеждаше напълно плосък дори
// при реална 3D ротация — самата геометрия/transform остава недокосната,
// само тона на всяко лице се различава леко сега. Умерен диапазон нарочно
// (виж task-а — по-силна версия беше пробвана и отхвърлена като прекалена).
const FACE_TONES: Record<number, { from: string; to: string }> = {
  4: { from: '#fefdf9', to: '#f6eed9' }, // ляво — най-светло
  2: { from: '#fcf8ee', to: '#f1e6c8' }, // "горе"
  1: { from: '#fdfaf3', to: '#eee2c1' }, // фронт — основно четимо лице (baseline)
  6: { from: '#f2e8ce', to: '#e0cea5' }, // гръб
  5: { from: '#ecdfbc', to: '#d6c197' }, // "долу"
  3: { from: '#e5d6ae', to: '#ccb488' }, // дясно — най-тъмно
}

function renderDiceFace(face: number, transform: string, size: number, scale: number): string {
  const tone = FACE_TONES[face] ?? FACE_TONES[1]
  const borderRadiusPx = 13 * scale
  const borderWidthPx = 1 * scale
  const bevelLight = 1.5 * scale
  const bevelDark = 2 * scale
  return `
    <div style="
      position:absolute;
      width:${size}px; height:${size}px;
      background:linear-gradient(160deg, ${tone.from} 0%, ${tone.to} 100%);
      border:${borderWidthPx}px solid rgba(70,52,24,0.2);
      border-radius:${borderRadiusPx}px;
      box-shadow:
        inset 0 ${bevelLight}px 0 rgba(255,255,255,0.7),
        inset 0 -${bevelLight}px ${bevelDark}px rgba(60,45,20,0.16),
        inset ${bevelLight}px 0 0 rgba(255,255,255,0.3),
        inset -${bevelLight}px 0 ${bevelDark}px rgba(60,45,20,0.12);
      transform:${transform};
    ">
      ${renderPips(face, Math.max(0.5, 1 * scale))}
    </div>
  `
}

// AUDIT (виж task-а — "pop" точно преди landing): потвърдено с
// getComputedStyle на всеки кадър, че border-radius на 6-те face div-а
// (renderDiceFace) НИКОГА не се променя по време на flight/landing —
// проблемът беше composite 3D silhouette геометрия (виж git history),
// оправен веднъж завинаги чрез overflow:hidden + border-radius на wrapper-а
// ПОД (не на [data-ludo-dice-cube] елемента — той пази transform-style:
// preserve-3d недокоснато).
//
// size (px) заменя стария hardcoded DICE_SIZE=64 — целият блок скалира
// пропорционално чрез scale = size/BASE_DICE_SIZE. halfDepth (translateZ)
// е ТОЧНО size/2 (геометрично правило, не приближение).
export function renderLudoDice(size: number, rotationDeg: { x: number; y: number }, isRolling: boolean): string {
  const scale = size / BASE_DICE_SIZE
  const halfDepth = size / 2
  const faceTransforms = buildFaceTransforms(halfDepth)
  const faces = faceTransforms.map(({ face, transform }) => renderDiceFace(face, transform, size, scale)).join('')

  const perspectivePx = 400 * scale
  const groundHeightPx = 10 * scale
  const groundBlurPx = 1 * scale
  const maskBorderRadiusPx = 13 * scale
  const shadowNearPx = { y: 2 * scale, blur: 3 * scale }
  const shadowFarPx = { y: 9 * scale, blur: 14 * scale }

  return `
    <div style="perspective:${perspectivePx}px; width:${size}px; height:${size}px; margin:0 auto; position:relative;">
      <div style="
        position:absolute; left:50%; bottom:-${groundHeightPx}px; transform:translateX(-50%);
        width:70%; height:${groundHeightPx}px; border-radius:50%;
        background:radial-gradient(ellipse at center, rgba(212,165,32,0.5) 0%, rgba(212,165,32,0) 72%);
        filter:blur(${groundBlurPx}px);
      "></div>
      <div style="
        position:relative; width:100%; height:100%;
        overflow:hidden;
        border-radius:${maskBorderRadiusPx}px;
        filter:
          drop-shadow(0 ${shadowNearPx.y}px ${shadowNearPx.blur}px rgba(0,0,0,0.22))
          drop-shadow(0 ${shadowFarPx.y}px ${shadowFarPx.blur}px rgba(0,0,0,0.3));
      ">
        <div
          data-ludo-dice-cube="1"
          style="
            position:relative;
            width:100%; height:100%;
            transform-style:preserve-3d;
            transform:rotateX(${rotationDeg.x}deg) rotateY(${rotationDeg.y}deg);
            ${isRolling ? 'transition:transform 900ms cubic-bezier(0.25, 0.8, 0.3, 1);' : ''}
          "
        >
          ${faces}
        </div>
      </div>
    </div>
  `
}
