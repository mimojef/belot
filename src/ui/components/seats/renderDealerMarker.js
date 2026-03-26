export function renderDealerMarker(position, isDealer) {
  if (!isDealer) {
    return ''
  }

  let style = `
    position: absolute;
    z-index: 9;
    width: 38px;
    height: 38px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f2a81d;
    color: #ffffff;
    font-size: 22px;
    font-weight: 900;
    box-shadow: 0 10px 20px rgba(0,0,0,0.22);
    border: 3px solid rgba(255,255,255,0.85);
  `

  if (position === 'top') {
    style += `
      left: calc(50% + 84px);
      top: 86px;
      transform: translateX(-50%);
    `
  }

  if (position === 'left') {
    style += `
      right: 138px;
      top: calc(50% + 92px);
      transform: translateY(-50%);
    `
  }

  if (position === 'right') {
    style += `
      left: 138px;
      top: calc(50% + 92px);
      transform: translateY(-50%);
    `
  }

  if (position === 'bottom') {
    style += `
      right: calc(50% - 210px);
      bottom: 48px;
    `
  }

  return `<div style="${style}">D</div>`
}
