// Всички Ludo-специфични @keyframes и hover правила на едно място, вградени
// като <style> таг в екрана (проектната конвенция е inline style="" + от
// време на време вграден <style> за неща, които не могат да бъдат inline —
// виж renderStakeSection в lobby). Не пипа src/style.css — изцяло изолирано.

export function renderLudoAnimationStyles(): string {
  return `
    <style>
      @keyframes ludo-normal-highlight-pulse {
        0%, 100% { opacity:0.72; transform:scale(0.94); }
        50% { opacity:1; transform:scale(1.05); }
      }
      @keyframes ludo-capture-ring-pulse {
        0%, 100% { opacity:0.55; transform:scale(0.94); }
        50% { opacity:1; transform:scale(1.12); }
      }
      @keyframes ludo-piece-selectable-pulse {
        0%, 100% { filter:brightness(1); }
        50% { filter:brightness(1.35); }
      }
      @keyframes ludo-piece-shake {
        0%, 100% { transform:translate(0, 0); }
        20% { transform:translate(-3px, -2px); }
        40% { transform:translate(3px, 2px); }
        60% { transform:translate(-2px, 2px); }
        80% { transform:translate(2px, -2px); }
      }
      @keyframes ludo-seat-countdown-drain {
        0% { transform:scaleX(1); }
        100% { transform:scaleX(0); }
      }
      @keyframes ludo-seat-countdown-ring-drain {
        0% { stroke-dashoffset:0; }
        100% { stroke-dashoffset:100; }
      }
      @keyframes ludo-dice-arrows-spin {
        from { transform:rotate(0deg); }
        to { transform:rotate(360deg); }
      }
      [data-ludo-dice-roll-button]:hover {
        filter:brightness(1.08);
        transform:translateY(-1px);
      }
      [data-ludo-piece-selectable]:hover {
        filter:brightness(1.25);
      }
      [data-ludo-bottom-bar-button]:hover {
        background:rgba(212,165,32,0.18) !important;
      }
    </style>
  `
}
