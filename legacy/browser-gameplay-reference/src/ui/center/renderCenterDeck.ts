export function renderCenterDeck(deckCount: number): string {
  return `
    <div
      style="
        position:relative;
        width:118px;
        height:156px;
        margin:0 auto 18px auto;
      "
    >
      <div
        style="
          position:absolute;
          inset:12px 0 0 0;
          margin:auto;
          width:102px;
          height:144px;
          border-radius:16px;
          background: rgba(18, 40, 67, 0.72);
          border: 1px solid rgba(255,255,255,0.24);
          transform: rotate(-6deg);
          box-shadow: 0 16px 28px rgba(0,0,0,0.16);
        "
      ></div>

      <div
        style="
          position:absolute;
          inset:8px 0 0 0;
          margin:auto;
          width:102px;
          height:144px;
          border-radius:16px;
          background: rgba(24, 50, 82, 0.8);
          border: 1px solid rgba(255,255,255,0.28);
          transform: rotate(5deg);
          box-shadow: 0 16px 28px rgba(0,0,0,0.16);
        "
      ></div>

      <div
        style="
          position:absolute;
          inset:0;
          margin:auto;
          width:102px;
          height:144px;
          border-radius:16px;
          background:
            radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 30%, rgba(255,255,255,0.01) 100%),
            linear-gradient(180deg, #203f66 0%, #173453 100%);
          border: 2px solid rgba(228, 238, 255, 0.5);
          box-shadow:
            0 20px 36px rgba(0,0,0,0.18),
            inset 0 0 0 1px rgba(255,255,255,0.1);
        "
      ></div>

      <div
        style="
          position:absolute;
          left:50%;
          bottom:-18px;
          transform:translateX(-50%);
          min-width:72px;
          padding:8px 12px;
          border-radius:999px;
          background: rgba(8, 23, 39, 0.58);
          border:1px solid rgba(255,255,255,0.12);
          text-align:center;
          font-size:12px;
          font-weight:800;
          letter-spacing:0.08em;
          color:#f3f8ff;
          text-transform:uppercase;
          backdrop-filter: blur(8px);
        "
      >
        ${deckCount} в тесте
      </div>
    </div>
  `
}