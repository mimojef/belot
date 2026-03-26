export function renderCardBack(extraStyle = '') {
  return `
    <div
      style="
        width: clamp(94px, 7vw, 116px);
        height: clamp(136px, 10.4vw, 164px);
        border-radius: clamp(12px, 1vw, 16px);
        background:
          radial-gradient(circle at 50% 50%, rgba(255,255,255,0.18) 0 10%, transparent 10% 100%),
          radial-gradient(circle at 25% 25%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          radial-gradient(circle at 75% 25%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          radial-gradient(circle at 25% 75%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          radial-gradient(circle at 75% 75%, rgba(255,255,255,0.14) 0 6%, transparent 6% 100%),
          linear-gradient(135deg, #132d4d 0%, #1d456f 48%, #122d4c 100%);
        border: 3px solid rgba(214, 228, 244, 0.78);
        box-shadow: 0 12px 24px rgba(0,0,0,0.20);
        position: relative;
        overflow: hidden;
        ${extraStyle}
      "
    >
      <div
        style="
          position:absolute;
          inset: 8px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.24);
          background:
            repeating-linear-gradient(
              45deg,
              rgba(255,255,255,0.08) 0 4px,
              rgba(255,255,255,0.02) 4px 8px
            );
        "
      ></div>
    </div>
  `
}
