// Общ интерфейс на renderer-ите в анимационния прототип на Свара.
// Статичните слоеве (маса, аватари, надписи, банер) са DOM в контролера;
// renderer-ът отговаря само за движещите се спрайтове (карти и чипове).

import type { SvaraMove, SvaraSpriteDef } from './svaraDemoMotion'
import type { SvaraDemoLayout, SvaraSceneStates } from './svaraDemoScript'

export type SvaraRendererKind = 'dom' | 'pixi'

export interface SvaraDemoRenderer {
  readonly kind: SvaraRendererKind
  mount(host: HTMLElement, sprites: SvaraSpriteDef[], layout: SvaraDemoLayout): Promise<void>
  /** Нов размер на масата — без анимация. */
  setLayout(layout: SvaraDemoLayout): void
  /** Моментално прилага състоянието (възстановяване след прекъсване/resize). */
  applyState(states: SvaraSceneStates): void
  /** Изпълнява движенията; true ако са завършили, false ако са прекъснати. */
  play(moves: SvaraMove[]): Promise<boolean>
  /** Спира текущите движения (без да прилага състояние). */
  cancel(): void
  getDebugInfo(): string
  destroy(): void
}
