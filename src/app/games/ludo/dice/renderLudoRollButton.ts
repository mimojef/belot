// "Хвърли зара" бутон — зелен, с glow, следва референтния стил.

export function renderLudoRollButton(disabled = false): string {
  return `
    <button
      type="button"
      data-ludo-dice-roll-button="1"
      ${disabled ? 'disabled' : ''}
      style="
        display:block;
        margin:10px auto 0;
        padding:12px 40px;
        border:none;
        border-radius:12px;
        background:linear-gradient(180deg, #3fbf5f 0%, #1f8f3c 100%);
        color:#ffffff;
        font-size:15px;
        font-weight:800;
        letter-spacing:0.02em;
        cursor:${disabled ? 'default' : 'pointer'};
        opacity:${disabled ? '0.55' : '1'};
        box-shadow:0 0 0 1px rgba(255,255,255,0.15) inset, 0 6px 16px rgba(31,143,60,0.45);
        transition:filter 140ms ease, transform 140ms ease;
      "
    >Хвърли зара</button>
  `
}
