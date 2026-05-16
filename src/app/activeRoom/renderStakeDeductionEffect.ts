const COUNTER_DURATION_MS = 700
const HOLD_AFTER_MS = 900
const FADE_OUT_MS = 400

function formatStakeAmount(amount: number): string {
  const rounded = Math.round(amount)
  const parts = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `−${parts}`
}

function getEffectCenter(): { x: number; y: number } {
  const anchor = document.querySelector<HTMLElement>('[data-matchmaking-stake-center="1"]')

  if (anchor) {
    const rect = anchor.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
}

export function showStakeDeductionEffect(
  stakeAmount: number,
  centerOverride?: { x: number; y: number },
): void {
  const audio = new Audio('/audio/game-sounds/coins.mp3')
  audio.volume = 0.9
  void audio.play().catch(() => {})

  const center = centerOverride ?? getEffectCenter()

  const label = document.createElement('div')
  label.style.position = 'fixed'
  label.style.left = `${center.x}px`
  label.style.top = `${center.y}px`
  label.style.transform = 'translate(-50%, -50%)'
  label.style.zIndex = '2147483647'
  label.style.pointerEvents = 'none'
  label.style.color = '#ef4444'
  label.style.fontSize = 'clamp(28px,4vw,52px)'
  label.style.fontWeight = '900'
  label.style.fontFamily = 'Inter,system-ui,sans-serif'
  label.style.letterSpacing = '-0.02em'
  label.style.textShadow = '0 2px 6px #000'
  label.style.opacity = '1'
  label.style.transition = `opacity ${FADE_OUT_MS}ms ease`
  label.textContent = formatStakeAmount(0)

  document.body.appendChild(label)

  const startTime = performance.now()

  function tick(now: number): void {
    const elapsed = Math.min(now - startTime, COUNTER_DURATION_MS)
    const progress = elapsed / COUNTER_DURATION_MS
    const eased = 1 - Math.pow(1 - progress, 2)
    label.textContent = formatStakeAmount(eased * stakeAmount)

    if (elapsed < COUNTER_DURATION_MS) {
      requestAnimationFrame(tick)
      return
    }

    label.textContent = formatStakeAmount(stakeAmount)

    setTimeout(() => {
      label.style.opacity = '0'
      setTimeout(() => label.remove(), FADE_OUT_MS + 50)
    }, HOLD_AFTER_MS)
  }

  requestAnimationFrame(tick)
}
