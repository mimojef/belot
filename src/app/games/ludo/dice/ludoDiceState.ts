// Логика за 3D зара — резултат идва отвън (mock random сега, сървър по-късно),
// CSS анимацията само визуализира резултата, не го решава.

export type LudoDiceFace = 1 | 2 | 3 | 4 | 5 | 6

export function rollLudoMockDiceResult(): LudoDiceFace {
  return (Math.floor(Math.random() * 6) + 1) as LudoDiceFace
}

// CSS transform rotation (deg по X/Y), нужна за да спре точно тази страна на
// куба фронтално към камерата. Стойностите отговарят на face placement-а в
// ludoDice.css (виж CUBE_FACE_TRANSFORMS в renderLudoDice.ts).
export const LUDO_DICE_FACE_ROTATION: Record<LudoDiceFace, { x: number; y: number }> = {
  1: { x: 0, y: 0 },
  6: { x: 0, y: 180 },
  3: { x: 0, y: -90 },
  4: { x: 0, y: 90 },
  2: { x: -90, y: 0 },
  5: { x: 90, y: 0 },
}

// Извежда финална rotation с добавени пълни обороти за "хвърляне" ефект.
// Различни trajectory-та по X/Y завъртане, за да не изглежда всяко хвърляне
// идентично.
export function computeLudoDiceThrowTransform(result: LudoDiceFace, spins = 2): { x: number; y: number } {
  const base = LUDO_DICE_FACE_ROTATION[result]
  const extraX = 360 * spins
  const extraY = 360 * (spins + (result % 2))
  return { x: base.x + extraX, y: base.y + extraY }
}
