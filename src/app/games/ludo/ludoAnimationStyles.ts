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
      @keyframes ludo-leave-status-blink {
        0%, 100% { opacity:1; }
        50% { opacity:0.35; }
      }
      /* Огледално на Belot's renderEmojiBubble fade curve (200ms in / hold /
         400ms out от общо 4000ms — виж renderCuttingSeatPanels.ts
         EMOJI_BUBBLE_TOTAL_MS) — процентите тук са фиксирани спрямо СЪЩАТА
         обща продължителност (LUDO_EMOJI_BUBBLE_TOTAL_MS в
         renderLudoPlayerPanel.ts), затова не се преизчисляват per-instance. */
      @keyframes ludo-emoji-bubble-fade {
        0% { opacity:0; }
        5% { opacity:1; }
        90% { opacity:1; }
        100% { opacity:0; }
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
      /* "Емоджита" triggerът е чисто изображение (виж renderLudoBottomBar.ts
         doc коментара) — лек scale/opacity вместо gold background hover-а
         по-горе, за да остане "чисто изображение, което служи за бутон". */
      [data-ludo-emoji-image-button] img {
        transition:transform 140ms ease, opacity 140ms ease;
      }
      [data-ludo-emoji-image-button]:hover img {
        transform:scale(1.08);
      }
      [data-ludo-emoji-image-button]:active img {
        transform:scale(0.94);
        opacity:0.85;
      }
    </style>
  `
}
