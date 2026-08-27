type TournamentReclaimModalController = {
  /** null скрива modal-а — единствено authoritative "team елиминиран/
   * tournament participation приключила" доказателство или успешен
   * reclaim/return трябва да води до това (виж §"КОГА MODAL МОЖЕ ДА СЕ
   * ЗАТВОРИ АВТОМАТИЧНО" в допълнението). tournamentName е чисто display,
   * не носи destination — бутонът винаги re-resolve-ва CURRENT authoritative
   * state в момента на click (виж §"BUTTON 'ПОЕМИ ИГРАТА'"), не пази stale
   * snapshot от момента, когато modal-ът е бил отворен. */
  show: (tournamentName: string) => void
  hide: () => void
  isVisible: () => boolean
  destroy: () => void
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

// Истински blocking modal (§"BLOCKING MODAL" в task spec-а) — за разлика от
// tournamentMatchStartPopup (dismissible/minimizable), този НЯМА X, НЕ се
// затваря с click извън него, и блокира background interaction чрез opaque
// overlay зад себе си. Vezan е към "активно tournament participation
// изисква връщане" (§"ОСНОВЕН ПРИНЦИП" в допълнението) — НЕ към lifecycle-а
// на конкретен match/room. Кой конкретен destination (attendance/countdown/
// gameplay/STATE A/STATE B) стои зад бутона се решава ИЗЦЯЛО от caller-а при
// click (resolveTournamentReturnDestination в main.ts), не тук — този модул
// не пази никакво assignment/destination state, само видимост + display name.
export function createTournamentReclaimModal(options: {
  container: HTMLElement
  onReclaimClick: () => void
}): TournamentReclaimModalController {
  let visible = false
  let tournamentName = ''

  function render(): void {
    if (!visible) {
      options.container.innerHTML = ''
      return
    }
    options.container.innerHTML = `
      <div
        data-tournament-reclaim-overlay="1"
        role="dialog"
        aria-modal="true"
        aria-live="assertive"
        style="position:fixed;inset:0;z-index:200000;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,0.82);backdrop-filter:blur(2px);font-family:Inter,system-ui,sans-serif;"
      >
        <div style="width:min(420px, calc(100vw - 32px));box-sizing:border-box;border:1px solid rgba(250,204,21,0.4);border-radius:10px;background:#101625;color:#f8fafc;box-shadow:0 24px 70px rgba(2,6,23,0.6);padding:22px 20px;text-align:center;">
          <div style="font-size:13px;font-weight:900;color:#93c5fd;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(tournamentName)}</div>
          <div style="margin-top:12px;font-size:18px;font-weight:900;line-height:1.35;">Тече турнир с ваше участие.</div>
          <div style="margin-top:8px;font-size:14px;line-height:1.5;color:rgba(248,250,252,0.75);">Играта ви временно е поета от бот.</div>
          <button type="button" data-tournament-reclaim-button="1" style="margin-top:18px;width:100%;height:44px;border:0;border-radius:8px;background:#facc15;color:#1c1400;font-size:15px;font-weight:900;cursor:pointer;">Поеми играта</button>
        </div>
      </div>
    `
    options.container.querySelector('[data-tournament-reclaim-button="1"]')?.addEventListener('click', () => {
      options.onReclaimClick()
    })
  }

  return {
    show(name) {
      tournamentName = name
      if (visible) return
      visible = true
      render()
    },
    hide() {
      if (!visible) return
      visible = false
      render()
    },
    isVisible() {
      return visible
    },
    destroy() {
      options.container.innerHTML = ''
      visible = false
    },
  }
}
