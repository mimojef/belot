export function renderSeatAnimationTarget(position) {
  const seatStyles = {
    top: `
      top: 13.5%;
      left: 50%;
      transform: translate(-50%, -50%);
    `,
    left: `
      top: 50%;
      left: 14%;
      transform: translate(-50%, -50%);
    `,
    right: `
      top: 50%;
      left: 86%;
      transform: translate(-50%, -50%);
    `,
    bottom: `
      top: 84%;
      left: 50%;
      transform: translate(-50%, -50%);
    `,
  }

  return `
    <div
      data-seat-animation-target="${position}"
      aria-hidden="true"
      style="
        position: absolute;
        ${seatStyles[position] ?? ''}
        width: 1px;
        height: 1px;
        pointer-events: none;
        opacity: 0;
        z-index: 1;
      "
    ></div>
  `
}