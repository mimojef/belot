export function renderBiddingButton({
  label,
  icon = '',
  iconColor = '#111827',
  onclick = '',
  enabled = true,
  isAccent = false,
  isDanger = false,
  isPass = false,
}) {
  const background = enabled
    ? isPass
      ? '#f2a81d'
      : '#e8eff1'
    : 'rgba(90, 108, 129, 0.55)'

  const borderColor = enabled
    ? isPass
      ? '#f2a81d'
      : '#d8a02b'
    : 'rgba(255, 255, 255, 0.08)'

  const textColor = enabled
    ? isPass
      ? '#ffffff'
      : isDanger
        ? '#7f1d1d'
        : '#111827'
    : 'rgba(226, 232, 240, 0.45)'

  const iconFinalColor = enabled ? iconColor : 'rgba(226, 232, 240, 0.35)'

  const cursor = enabled ? 'pointer' : 'not-allowed'
  const opacity = enabled ? '1' : '0.68'
  const hoverClass = enabled ? 'bidding-board-btn-active' : ''
  const disabledAttr = enabled ? '' : 'disabled'
  const clickAttr = enabled && onclick ? `onclick="${onclick}"` : ''
  const minHeight = isPass ? '74px' : '78px'
  const fontSize = isPass ? 'clamp(30px, 3vw, 52px)' : 'clamp(12px, 1vw, 18px)'
  const fontWeight = isPass ? '800' : '700'
  const gap = isPass ? '0' : '4px'
  const accentShadow = enabled && (isAccent || isDanger)
    ? 'inset 0 0 0 1px rgba(255,255,255,0.18)'
    : 'none'

  return `
    <button
      type="button"
      class="${hoverClass}"
      ${clickAttr}
      ${disabledAttr}
      style="
        appearance: none;
        width: 100%;
        min-height: ${minHeight};
        border-radius: 10px;
        border: 2px solid ${borderColor};
        background: ${background};
        color: ${textColor};
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: ${gap};
        padding: ${isPass ? '8px 16px' : '10px 12px'};
        box-shadow: ${accentShadow};
        cursor: ${cursor};
        opacity: ${opacity};
        transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
      "
    >
      ${
        icon
          ? `
            <span
              style="
                font-size: ${isPass ? '0' : 'clamp(26px, 2vw, 42px)'};
                line-height: 1;
                font-weight: 800;
                color: ${iconFinalColor};
              "
            >
              ${icon}
            </span>
          `
          : ''
      }
      <span
        style="
          font-size: ${fontSize};
          line-height: 1.05;
          font-weight: ${fontWeight};
          letter-spacing: 0.01em;
          text-transform: uppercase;
          text-align: center;
        "
      >
        ${label}
      </span>
    </button>
  `
}
