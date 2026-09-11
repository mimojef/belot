// Истински CSS 3D зар — 6 страни, всяка отделен DOM елемент с
// transform-style:preserve-3d, а не изображение. Резултатът винаги идва
// отвън (mock/server) — CSS-ът само върти куба до правилната страна.

const DICE_SIZE = 64
const HALF = DICE_SIZE / 2

const PIP_POSITIONS: Record<number, Array<{ top: string; left: string }>> = {
  1: [{ top: '50%', left: '50%' }],
  2: [{ top: '25%', left: '25%' }, { top: '75%', left: '75%' }],
  3: [{ top: '25%', left: '25%' }, { top: '50%', left: '50%' }, { top: '75%', left: '75%' }],
  4: [{ top: '25%', left: '25%' }, { top: '25%', left: '75%' }, { top: '75%', left: '25%' }, { top: '75%', left: '75%' }],
  5: [{ top: '25%', left: '25%' }, { top: '25%', left: '75%' }, { top: '50%', left: '50%' }, { top: '75%', left: '25%' }, { top: '75%', left: '75%' }],
  6: [{ top: '22%', left: '25%' }, { top: '22%', left: '75%' }, { top: '50%', left: '25%' }, { top: '50%', left: '75%' }, { top: '78%', left: '25%' }, { top: '78%', left: '75%' }],
}

function renderPips(face: number): string {
  const positions = PIP_POSITIONS[face] ?? []
  return positions.map((p) => `
    <span style="
      position:absolute;
      top:${p.top}; left:${p.left};
      width:20%; height:20%;
      transform:translate(-50%, -50%);
      border-radius:50%;
      background:#1a1a1a;
      box-shadow:inset 0 1px 1px rgba(0,0,0,0.4);
    "></span>
  `).join('')
}

// Face transform-и, консистентни с LUDO_DICE_FACE_ROTATION в
// ludoDiceState.ts — всяка страна се позиционира на куба чрез translateZ и
// собствената си rotation спрямо центъра.
const FACE_TRANSFORMS: Array<{ face: number; transform: string }> = [
  { face: 1, transform: `rotateY(0deg) translateZ(${HALF}px)` },
  { face: 6, transform: `rotateY(180deg) translateZ(${HALF}px)` },
  { face: 3, transform: `rotateY(90deg) translateZ(${HALF}px)` },
  { face: 4, transform: `rotateY(-90deg) translateZ(${HALF}px)` },
  { face: 2, transform: `rotateX(90deg) translateZ(${HALF}px)` },
  { face: 5, transform: `rotateX(-90deg) translateZ(${HALF}px)` },
]

function renderDiceFace(face: number, transform: string): string {
  return `
    <div style="
      position:absolute;
      width:${DICE_SIZE}px; height:${DICE_SIZE}px;
      background:linear-gradient(135deg, #fdfaf3 0%, #eee0c0 100%);
      border:1px solid rgba(0,0,0,0.15);
      border-radius:8px;
      transform:${transform};
    ">
      ${renderPips(face)}
    </div>
  `
}

export function renderLudoDice(rotationDeg: { x: number; y: number }, isRolling: boolean): string {
  const faces = FACE_TRANSFORMS.map(({ face, transform }) => renderDiceFace(face, transform)).join('')

  return `
    <div style="perspective:400px; width:${DICE_SIZE}px; height:${DICE_SIZE}px; margin:0 auto; position:relative;">
      <div style="
        position:absolute; left:50%; bottom:-10px; transform:translateX(-50%);
        width:70%; height:10px; border-radius:50%;
        background:radial-gradient(ellipse at center, rgba(212,165,32,0.5) 0%, rgba(212,165,32,0) 72%);
        filter:blur(1px);
      "></div>
      <div
        data-ludo-dice-cube="1"
        style="
          position:relative;
          width:100%; height:100%;
          transform-style:preserve-3d;
          transform:rotateX(${rotationDeg.x}deg) rotateY(${rotationDeg.y}deg);
          ${isRolling ? 'transition:transform 900ms cubic-bezier(0.25, 0.8, 0.3, 1);' : ''}
          filter:drop-shadow(0 8px 10px rgba(0,0,0,0.45));
        "
      >
        ${faces}
      </div>
    </div>
  `
}
