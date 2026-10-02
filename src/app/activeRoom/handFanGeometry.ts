// Shared hand-fan geometry: the bottom hand (renderPlayingScreen), the seat
// panel card fans (renderCuttingSeatPanels) and the "Долу картите" reveal fans
// (animateSweepThrowDown) all lay their cards out with this one formula.

export type HandFanOffset = { x: number; y: number; rotate: number }

// Desktop hand fan values for a HAND_FAN_REFERENCE_CARD_WIDTH-wide card.
export const HAND_FAN_REFERENCE_CARD_WIDTH = 195
export const HAND_FAN_SPACING = 62
export const HAND_FAN_EDGE_DROP = 34
export const HAND_FAN_ROTATION_STEP = 5

export function getHandFanOffset(
  index: number,
  count: number,
  options: {
    spacing: number
    edgeDropMax: number
    rotationStep: number
    // multiplies the edge drop only (spacing is passed already scaled)
    edgeDropScale?: number
  },
): HandFanOffset {
  const centered = index - (count - 1) / 2
  const maxCentered = Math.max(1, (count - 1) / 2)
  const edgeProgress = Math.abs(centered) / maxCentered
  const countProgress = Math.min(1, Math.max(0, (count - 1) / 7))
  const edgeDrop = edgeProgress * edgeProgress * options.edgeDropMax * countProgress * (options.edgeDropScale ?? 1)
  return {
    x: centered * options.spacing,
    y: edgeDrop,
    rotate: centered * options.rotationStep,
  }
}
