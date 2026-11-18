// DOM + Web Animations API renderer на демото = общият renderer на сцената
// (../scene/svaraSceneDomRenderer.ts), който рисува и истинската игра.

import { createSvaraSceneDomRenderer } from '../scene/svaraSceneDomRenderer'
import type { SvaraDemoRenderer } from './svaraDemoRenderer'

export function createSvaraDomRenderer(): SvaraDemoRenderer {
  return createSvaraSceneDomRenderer()
}
