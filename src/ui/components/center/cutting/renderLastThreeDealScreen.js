import { escapeHtmlAttribute } from './cuttingScreenUtils.js'
import { renderCardBack } from '../../common/renderCardBack.js'

export function renderLastThreeDealScreen({
  dealCardHtml,
  dealerPosition,
  buildLastThreeAutoStartHandler,
}) {
  return `
    <div
      data-cutting-root
      style="
        position: relative;
        width: min(86vw, 980px);
        height: min(54vh, 520px);
        min-width: 320px;
        min-height: 260px;
        overflow: visible;
      "
    >
      <img
        alt=""
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        style="display:none"
        onload="${escapeHtmlAttribute(buildLastThreeAutoStartHandler(dealCardHtml, dealerPosition))}"
      />

      <div
        data-last-three-stack
        style="
          position: absolute;
          left: 50%;
          top: 50%;
          width: clamp(78px, 5.7vw, 96px);
          height: clamp(116px, 8.7vw, 146px);
          transform: translate(-50%, -50%) scale(1);
          opacity: 1;
          transition: opacity 0.18s ease, transform 0.18s ease;
          pointer-events: none;
        "
      >
        ${Array.from({ length: 7 })
          .map((_, stackIndex) => {
            const offsetX = (stackIndex % 3 - 1) * 2.2
            const offsetY = stackIndex * -0.9
            const rotate = (stackIndex % 3 - 1) * 1.1

            return `
              <div
                style="
                  position: absolute;
                  left: 50%;
                  top: 50%;
                  transform: translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px) rotate(${rotate}deg);
                  transform-origin: center center;
                  filter: drop-shadow(0 8px 14px rgba(0,0,0,0.12));
                "
              >
                ${renderCardBack(`
                  width: clamp(78px, 5.7vw, 96px);
                  height: clamp(116px, 8.7vw, 146px);
                  box-shadow: 0 10px 18px rgba(0,0,0,0.14);
                `)}
              </div>
            `
          })
          .join('')}
      </div>

      <div
        data-cutting-animation-layer
        style="
          position: absolute;
          inset: 0;
          pointer-events: none;
          overflow: visible;
          z-index: 900;
        "
      ></div>
    </div>
  `
}