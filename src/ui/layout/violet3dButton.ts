// Общ, по-изразен 3D релеф за основните виолетови бутони в светлия мобилен
// дизайн (лоби, игри, частни маси, турнири, магазин, профили, попъпи,
// самостоятелни екрани и известия). Единственият източник на стила.
//
// Слага се заедно с .lobby-violet-btn (светлият акцент отгоре идва от
// неговия ::before): class="lobby-violet-btn violet-3d-btn". Класът се
// добавя САМО в светлите мобилни клонове на markup-а, затова desktop/таблет
// никога не го получават. Правилата са закачени за самия клас (не за CSS
// родител) — работят и в попъпи в document.body, и в самостоятелни екрани.
// Глобалният .lobby-violet-btn остава непроменен. Фонът идва оттук, затова
// бутоните са без inline background.
export const VIOLET_3D_BUTTON_CLASS = 'violet-3d-btn'

const STYLE_ID = 'violet-3d-button-style'
const SELECTOR = `.lobby-violet-btn.${VIOLET_3D_BUTTON_CLASS}`

const VIOLET_3D_BUTTON_CSS = `
  ${SELECTOR} {
    background:linear-gradient(180deg,#9473F2 0%,#7950E8 52%,#6639DB 100%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.38),inset 0 -1px 0 rgba(52,22,140,0.25),0 3px 0 #4F2BB8,0 8px 16px rgba(79,43,184,0.32);
    text-shadow:0 1px 1px rgba(40,14,110,0.35);
    transition:translate 0.1s ease,box-shadow 0.1s ease,filter 0.1s ease;
  }
  ${SELECTOR}:not(:disabled):active {
    translate:0 2px;
    filter:brightness(0.97);
    box-shadow:inset 0 2px 3px rgba(40,14,110,0.3),0 1px 0 #4F2BB8,0 3px 6px rgba(79,43,184,0.26);
  }
  /* Неактивен / зареждане: без повдигане — плосък ръб, без сянка (прозрачността
     идва от .lobby-violet-btn:disabled). */
  ${SELECTOR}:disabled {
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.25),0 1px 0 rgba(79,43,184,0.45);
    text-shadow:none;
  }
`

// Веднъж при старта (main.ts) — <style> в <head>, независим от екраните.
export function ensureViolet3dButtonStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = VIOLET_3D_BUTTON_CSS
  document.head.appendChild(style)
}
