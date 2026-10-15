// Сянка от „височината“ на спрайта — една формула за двата renderer-а, за
// да изглеждат дълбочината и кацането еднакво в DOM/WAAPI и PixiJS.

import type { SvaraSampledState } from './svaraDemoMotion'

export function svaraShadowFor(s: SvaraSampledState, size: number): { dx: number; dy: number; scale: number; alpha: number } {
  return {
    dx: size * (0.02 + 0.1 * s.height),
    dy: size * (0.05 + 0.32 * s.height),
    scale: 1 + 0.12 * s.height,
    alpha: s.alpha * (0.42 - 0.22 * s.height),
  }
}
