import { renderCardBack } from '../common/renderCardBack.js'

export function renderOpponentCardFan(cardsCount, position) {
  if (!cardsCount) {
    return ''
  }

  const visibleCount = Math.min(cardsCount, 8)
  const middleIndex = (visibleCount - 1) / 2

  if (position === 'top') {
    return `
      <div
        style="
          position: absolute;
          left: 42%;
          top: 0;
          transform: translateX(-50%);
          width: min(48vw, 620px);
          height: 220px;
          pointer-events: none;
          z-index: 1;
          overflow: visible;
        "
      >
        ${Array.from({ length: visibleCount })
          .map((_, index) => {
            const offset = index - middleIndex
            const x = offset * 40
            const y = Math.abs(offset) * 6
            const rotate = offset * 8

            return `
              <div
                style="
                  position: absolute;
                  left: 50%;
                  top: 0;
                  transform: translateX(${x}px) translateY(${y}px) rotate(${rotate}deg);
                  transform-origin: center bottom;
                  z-index: ${20 + index};
                "
              >
                ${renderCardBack()}
              </div>
            `
          })
          .join('')}
      </div>
    `
  }

  if (position === 'left') {
    return `
      <div
        style="
          position: absolute;
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 320px;
          height: min(46vh, 460px);
          pointer-events: none;
          z-index: 1;
          overflow: visible;
        "
      >
        ${Array.from({ length: visibleCount })
          .map((_, index) => {
            const offset = index - middleIndex
            const x = 28 + Math.abs(offset) * 9
            const y = offset * 24
            const rotate = offset * 8

            return `
              <div
                style="
                  position: absolute;
                  right: 100px;
                  top: 30%;
                  transform: translateX(-${x}px) translateY(${y}px) rotate(${rotate}deg);
                  transform-origin: center center;
                  z-index: ${20 + index};
                "
              >
                ${renderCardBack()}
              </div>
            `
          })
          .join('')}
      </div>
    `
  }

  return `
    <div
      style="
        position: absolute;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 320px;
        height: min(46vh, 460px);
        pointer-events: none;
        z-index: 1;
        overflow: visible;
      "
    >
      ${Array.from({ length: visibleCount })
        .map((_, index) => {
          const offset = index - middleIndex
          const x = 58 + Math.abs(offset) * 9
          const y = offset * 24
          const rotate = offset * -8

          return `
            <div
              style="
                position: absolute;
                left: 70px;
                top: 30%;
                transform: translateX(${x}px) translateY(${y}px) rotate(${rotate}deg);
                transform-origin: center center;
                z-index: ${20 + index};
              "
            >
              ${renderCardBack()}
            </div>
          `
        })
        .join('')}
    </div>
  `
}
