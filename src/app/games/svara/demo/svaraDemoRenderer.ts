// Общ интерфейс на renderer-ите в анимационния прототип на Свара = общият
// интерфейс на сцената (../scene/svaraSceneDomRenderer.ts). Статичните слоеве
// (маса, аватари, надписи, банер) са в обвивката на сцената
// (../scene/svaraSceneShell.ts); renderer-ът отговаря само за движещите се
// спрайтове (карти и чипове).

export type { SvaraRendererKind, SvaraSceneRendererBase as SvaraDemoRenderer } from '../scene/svaraSceneDomRenderer'
