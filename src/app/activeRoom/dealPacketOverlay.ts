export type DealPacketOverlayState = {
  element: HTMLDivElement | null
  phaseKey: string | null
  startedAt: number
}

export function createDealPacketOverlayState(): DealPacketOverlayState {
  return { element: null, phaseKey: null, startedAt: 0 }
}

export function mountDealPacketOverlay(
  state: DealPacketOverlayState,
  phaseKey: string,
  overlayHtml: string,
  stageScale: number,
  stageWidth: number,
  stageHeight: number,
  host: HTMLElement = document.body,
): void {
  if (state.phaseKey === phaseKey && state.element !== null && state.element.isConnected) return
  unmountDealPacketOverlay(state)

  const wrapper = document.createElement('div')
  wrapper.setAttribute('data-deal-packet-overlay', '1')
  // Keep this in the active-room stacking context: above the table, below seat panels.
  wrapper.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2;overflow:hidden;'
  wrapper.innerHTML =
    `<div style="position:absolute;left:50%;top:50%;` +
    `width:${stageWidth}px;height:${stageHeight}px;` +
    `transform:translate(-50%,-50%) scale(${stageScale});` +
    `transform-origin:center center;overflow:visible;">` +
    `<div style="position:absolute;inset:0;overflow:visible;">${overlayHtml}</div>` +
    `</div>`

  host.appendChild(wrapper)

  state.element = wrapper as HTMLDivElement
  state.phaseKey = phaseKey
  state.startedAt = performance.now()
}

export function unmountDealPacketOverlay(state: DealPacketOverlayState): void {
  state.element?.remove()
  state.element = null
  state.phaseKey = null
  state.startedAt = 0
}

export function getDealPacketOverlayElapsedMs(state: DealPacketOverlayState): number {
  if (state.element === null || state.startedAt === 0) return 0
  return Math.max(0, performance.now() - state.startedAt)
}
