// Свара — обща визуална сцена: обвивка (сукно, рамка, места, банка, банер,
// пръстен около победителя, анимирана спечелена сума).
//
// Изнесено ДОСЛОВНО от анимационното демо (demo/createSvaraAnimationDemo.ts):
// същите стилове, размери и WAAPI ефекти. Демото и истинската игра използват
// една и съща обвивка; демото задава примерни имена/аватари, истинската игра —
// реалните, плюс собствен HUD (баланс, залог, таймер) в `seatInfo`.

import type { SvaraSceneLayout } from './svaraSceneLayout'

export type SvaraSceneSeatNode = {
  node: HTMLElement
  ring: HTMLElement
  avatar: HTMLImageElement
  name: HTMLElement
  /** Допълнителна информация под името (истинската игра: баланс, залог, статус). */
  info: HTMLElement
}

export type SvaraSceneShell = {
  /** Цялата сцена (рамка + сукно + слоеве). */
  stage: HTMLElement
  seatsLayer: HTMLElement
  spritesHost: HTMLElement
  /** Слой над спрайтовете за допълнителен HUD (истинската игра). */
  hudLayer: HTMLElement
  potLabel: HTMLElement
  winLabel: HTMLElement
  banner: HTMLElement
  seats: SvaraSceneSeatNode[]
  applyLayout(layout: SvaraSceneLayout, visibleSeats?: readonly number[]): void
  setPot(value: number, pulse: boolean, text?: string): void
  showWinner(seatIndex: number, amount: number, animate: boolean): void
  hideWinner(): void
  /** Банерът от демото; elapsedMs > 0 — превъртане (reconnect). */
  playBanner(totalMs: number, elapsedMs?: number): void
  resetHud(): void
  destroy(): void
}

export function createSvaraSceneShell(options: { bannerText: string; avatarSrcs: readonly string[]; names: readonly string[] }): SvaraSceneShell {
  const stage = document.createElement('div')
  stage.dataset.svaraSceneStage = '1'
  stage.style.cssText = 'position:relative;width:100%;border-radius:22px;overflow:hidden;background:linear-gradient(180deg,#5b3a1c,#3a2410);box-shadow:0 10px 30px rgba(0,0,0,0.45);user-select:none;-webkit-user-select:none;touch-action:manipulation;'
  stage.innerHTML = `
    <div style="position:absolute;inset:7px;border-radius:17px;background:radial-gradient(ellipse at 50% 45%,#22985a 0%,#157240 55%,#0c4d2a 100%);box-shadow:inset 0 0 40px rgba(0,0,0,0.45);"></div>
    <div data-svara-scene-seats style="position:absolute;inset:0;"></div>
    <div data-svara-scene-sprites style="position:absolute;inset:0;"></div>
    <div data-svara-scene-pot style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);padding:4px 11px;border-radius:999px;background:rgba(0,0,0,0.55);border:1px solid rgba(212,165,32,0.55);color:#f5d06f;font-weight:900;white-space:nowrap;opacity:0;transition:opacity 200ms ease;will-change:transform;">Банка: 0</div>
    <div data-svara-scene-win style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);opacity:0;pointer-events:none;color:#ffe08a;font-weight:900;text-shadow:0 2px 6px rgba(0,0,0,0.7);white-space:nowrap;will-change:transform,opacity;">+0</div>
    <div data-svara-scene-hud style="position:absolute;inset:0;pointer-events:none;"></div>
    <div data-svara-scene-banner style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);opacity:0;pointer-events:none;padding:10px 26px;border-radius:14px;background:linear-gradient(180deg,#f5d06f,#d4a520);color:#1a1203;font-size:clamp(22px,6vw,40px);font-weight:900;letter-spacing:2px;box-shadow:0 8px 24px rgba(0,0,0,0.5);will-change:transform,opacity;"></div>
  `
  const q = <T extends HTMLElement>(selector: string) => stage.querySelector<T>(selector)!
  const seatsLayer = q<HTMLElement>('[data-svara-scene-seats]')
  const spritesHost = q<HTMLElement>('[data-svara-scene-sprites]')
  const hudLayer = q<HTMLElement>('[data-svara-scene-hud]')
  const potLabel = q<HTMLElement>('[data-svara-scene-pot]')
  const winLabel = q<HTMLElement>('[data-svara-scene-win]')
  const banner = q<HTMLElement>('[data-svara-scene-banner]')
  banner.textContent = options.bannerText

  const hudAnimations = new Set<Animation>()
  let layout: SvaraSceneLayout | null = null

  // ── Места и аватари (статичен DOM) ───────────────────────────────────────
  const seats: SvaraSceneSeatNode[] = []
  for (let i = 0; i < 4; i += 1) {
    const node = document.createElement('div')
    node.dataset.svaraSceneSeat = String(i)
    node.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-50%);'
    node.innerHTML = `
      <div data-ring style="position:absolute;inset:-7px;border-radius:50%;border:3px solid #f5d06f;box-shadow:0 0 18px rgba(245,208,111,0.85);opacity:0;will-change:transform,opacity;"></div>
      <img data-avatar src="${options.avatarSrcs[i] ?? ''}" alt="" draggable="false" style="display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid rgba(212,165,32,0.85);background:#0b0b0b;box-sizing:border-box;">
      <div data-name style="position:absolute;left:50%;bottom:0;transform:translate(-50%,45%);padding:1px 8px;border-radius:999px;background:rgba(0,0,0,0.72);color:#fff;font-size:11px;font-weight:800;white-space:nowrap;"></div>
      <div data-info style="position:absolute;left:50%;top:100%;transform:translate(-50%,10px);display:flex;flex-direction:column;align-items:center;gap:2px;white-space:nowrap;pointer-events:none;"></div>
    `
    const name = node.querySelector<HTMLElement>('[data-name]')!
    name.textContent = options.names[i] ?? ''
    seatsLayer.appendChild(node)
    seats.push({ node, ring: node.querySelector<HTMLElement>('[data-ring]')!, avatar: node.querySelector<HTMLImageElement>('[data-avatar]')!, name, info: node.querySelector<HTMLElement>('[data-info]')! })
  }

  function track(animation: Animation): void {
    hudAnimations.add(animation)
    animation.finished.then(() => hudAnimations.delete(animation), () => hudAnimations.delete(animation))
  }

  return {
    stage, seatsLayer, spritesHost, hudLayer, potLabel, winLabel, banner, seats,

    applyLayout(next, visibleSeats) {
      layout = next
      stage.style.height = `${next.height}px`
      next.seats.forEach((seat, i) => {
        const node = seats[i]!.node
        node.style.left = `${seat.avatar.x}px`
        node.style.top = `${seat.avatar.y}px`
        node.style.width = `${next.avatarSize}px`
        node.style.height = `${next.avatarSize}px`
        node.style.display = !visibleSeats || visibleSeats.includes(i) ? '' : 'none'
      })
      potLabel.style.left = `${next.potLabel.x}px`
      potLabel.style.top = `${next.potLabel.y}px`
      potLabel.style.fontSize = `${Math.round(Math.max(12, next.chipSize * 0.5))}px`
      winLabel.style.fontSize = `${Math.round(Math.max(18, next.chipSize * 0.9))}px`
      // Банерът е над банката, за да не скрива чиповете.
      banner.style.top = `${Math.max(next.height * 0.2, next.pot.y - next.chipSize * 2.8)}px`
    },

    setPot(value, pulse, text) {
      potLabel.textContent = text ?? `Банка: ${value}`
      potLabel.style.opacity = value > 0 ? '1' : '0'
      if (pulse && value > 0) {
        track(potLabel.animate(
          [{ transform: 'translate(-50%,-50%) scale(1)' }, { transform: 'translate(-50%,-50%) scale(1.14)', offset: 0.35 }, { transform: 'translate(-50%,-50%) scale(1)' }],
          { duration: 240, easing: 'ease-out' },
        ))
      }
    },

    showWinner(seatIndex, amount, animate) {
      const ring = seats[seatIndex]?.ring
      if (!ring || !layout) return
      ring.style.opacity = '1'
      if (!animate) return
      // Умерен ефект: пулс на пръстена + „+сума“, която се издига и изчезва.
      track(ring.animate(
        [
          { transform: 'scale(0.85)', opacity: 0 },
          { transform: 'scale(1.16)', opacity: 1, offset: 0.3 },
          { transform: 'scale(0.98)', opacity: 1, offset: 0.65 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: 700, easing: 'ease-out' },
      ))
      const seat = layout.seats[seatIndex]!
      winLabel.textContent = `+${amount}`
      winLabel.style.left = `${seat.avatar.x}px`
      winLabel.style.top = `${seat.avatar.y - layout.avatarSize * 0.9}px`
      track(winLabel.animate(
        [
          { transform: 'translate(-50%,-50%) translateY(8px) scale(0.7)', opacity: 0 },
          { transform: 'translate(-50%,-50%) translateY(0) scale(1.08)', opacity: 1, offset: 0.25 },
          { transform: 'translate(-50%,-50%) translateY(-6px) scale(1)', opacity: 1, offset: 0.7 },
          { transform: 'translate(-50%,-50%) translateY(-18px) scale(1)', opacity: 0 },
        ],
        { duration: 1300, easing: 'ease-out' },
      ))
    },

    hideWinner() {
      for (const seat of seats) seat.ring.style.opacity = '0'
      winLabel.style.opacity = '0'
    },

    playBanner(totalMs, elapsedMs = 0) {
      track(banner.animate(
        [
          { opacity: 0, transform: 'translate(-50%,-50%) scale(0.6)' },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1.12)', offset: 0.14 },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.26 },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.82 },
          { opacity: 0, transform: 'translate(-50%,-50%) scale(1.06)' },
        ],
        { duration: totalMs, delay: -Math.max(0, elapsedMs), easing: 'ease-out' },
      ))
    },

    resetHud() {
      for (const animation of hudAnimations) animation.cancel()
      hudAnimations.clear()
      banner.style.opacity = '0'
      winLabel.style.opacity = '0'
      for (const seat of seats) seat.ring.style.opacity = '0'
      potLabel.textContent = 'Банка: 0'
      potLabel.style.opacity = '0'
    },

    destroy() {
      for (const animation of hudAnimations) animation.cancel()
      hudAnimations.clear()
      stage.remove()
    },
  }
}
