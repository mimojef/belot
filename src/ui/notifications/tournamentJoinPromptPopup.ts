// Едно Белот участие — известие „Започнал турнир“ след края на обикновен мач,
// докато турнирният мач на играча още тече (той не е избрал да напусне
// обикновения мач по-рано). Без автоматичен таймер: стои, докато играчът
// приеме или откаже, или докато участието му в турнира приключи (решава
// main.ts). Собствен контейнер в body — обичайните re-render-и на екраните не
// го засягат. Визуално огледало на tournamentMatchStartPopup.

type TournamentJoinPromptPopupController = {
  show: () => void
  hide: () => void
  isVisible: () => boolean
  destroy: () => void
}

export function createTournamentJoinPromptPopup(options: {
  container: HTMLElement
  onAccept: () => void
  onDismiss: () => void
}): TournamentJoinPromptPopupController {
  let visible = false

  function render(): void {
    if (!visible) {
      options.container.innerHTML = ''
      return
    }
    options.container.innerHTML = `
      <div id="tournament-join-prompt" data-tournament-join-prompt="1" data-mobile-notice="top" role="dialog" aria-live="polite" style="${popupShellStyle()}">
        <div data-mobile-notice-part="title" style="font-size:16px;font-weight:900;line-height:1.3;">Започнал турнир</div>
        <div data-mobile-notice-part="text" style="margin-top:6px;font-size:12px;line-height:1.5;color:rgba(248,250,252,0.72);">В момента се провежда турнирен мач с Ваше участие. Желаете ли да се включите?</div>
        <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">
          <button type="button" data-tournament-join-dismiss="1" data-mobile-notice-part="secondary" style="${secondaryButtonStyle()}">Отказ</button>
          <button type="button" data-tournament-join-accept="1" data-mobile-notice-part="primary" style="${primaryButtonStyle()}">Включи се в турнира</button>
        </div>
      </div>
    `
    options.container.querySelector('[data-tournament-join-accept]')?.addEventListener('click', () => {
      options.onAccept()
    })
    options.container.querySelector('[data-tournament-join-dismiss]')?.addEventListener('click', () => {
      options.onDismiss()
    })
  }

  return {
    show() {
      if (visible) return
      visible = true
      render()
    },
    hide() {
      if (!visible) return
      visible = false
      render()
    },
    isVisible: () => visible,
    destroy() {
      visible = false
      options.container.innerHTML = ''
    },
  }
}

function popupShellStyle(): string {
  return [
    'position:fixed;top:18px;right:18px;z-index:100000;',
    'width:min(400px, calc(100vw - 32px));box-sizing:border-box;',
    'border:1px solid rgba(148,163,253,0.42);border-radius:8px;background:#101625;color:#f8fafc;',
    'box-shadow:0 18px 54px rgba(0,0,0,0.55);padding:14px 14px 12px 14px;font-family:Inter,system-ui,sans-serif;',
  ].join('')
}

function primaryButtonStyle(): string {
  return 'height:38px;padding:0 14px;border:0;border-radius:8px;background:#facc15;color:#1c1400;font-size:13px;font-weight:900;cursor:pointer;'
}

function secondaryButtonStyle(): string {
  return 'height:38px;padding:0 14px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#e2e8f0;font-size:13px;font-weight:800;cursor:pointer;'
}
