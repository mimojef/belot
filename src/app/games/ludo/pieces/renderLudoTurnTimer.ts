// Примерен таймер за текущия ход — mock стойност, визуален стил следва
// референта ("Твой ход" card с пясъчен часовник и секунди).

export function renderLudoTurnTimer(label: string, secondsLeft: number): string {
  return `
    <div style="
      background:rgba(10,14,20,0.82);
      border:1px solid rgba(212,165,32,0.4);
      border-radius:12px;
      padding:10px 18px;
      text-align:center;
      min-width:110px;
    ">
      <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.65); text-transform:uppercase; letter-spacing:0.04em;">${label}</div>
      <div style="display:flex; align-items:center; justify-content:center; gap:6px; margin-top:4px; font-size:18px; font-weight:800; color:#d4a520;">
        <span>&#8987;</span><span data-ludo-turn-timer-value="1">${secondsLeft} сек</span>
      </div>
    </div>
  `
}
