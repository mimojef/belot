import { escapeHtml } from './renderLobbyScreen.js'
import { VIOLET_3D_BUTTON_CLASS } from '../../ui/layout/violet3dButton'

export type TournamentBetaAccessModalState = {
  isOpen: boolean
  isSubmitting: boolean
  errorText: string | null
}

export type TournamentBetaAccessModalOptions = {
  onClose: () => void
  onSubmit: (password: string) => void
}

// light — светлата мобилна рамка (телефон): същите текстове, форма и data-*
// атрибути, различна е само визията.
export function renderTournamentBetaAccessModal(state: TournamentBetaAccessModalState, light = false): string {
  if (!state.isOpen) {
    return ''
  }

  if (light) {
    return `
      <div data-tournament-beta-access-modal-root="1" data-lobby-keep-form="tournament-beta-access" style="position:fixed;inset:0;z-index:13500;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;overflow-y:auto;">
        <div data-tournament-beta-access-modal-backdrop="1" style="position:fixed;inset:0;background:rgba(16,24,40,0.45);"></div>
        <div role="dialog" aria-modal="true" style="position:relative;width:min(100%,400px);max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;margin:auto;border-radius:12px;border:1px solid #E4E7EC;background:#FFFFFF;box-shadow:0 20px 48px rgba(16,24,40,0.18);padding:20px;box-sizing:border-box;">
          <button type="button" data-tournament-beta-access-modal-close="1" aria-label="Затвори" style="position:absolute;right:10px;top:10px;width:36px;height:36px;border:0;border-radius:8px;background:#F2F4F7;color:#667085;font-family:inherit;font-size:20px;font-weight:700;line-height:1;cursor:pointer;">×</button>
          <form data-tournament-beta-access-form="1" style="display:grid;gap:14px;">
            <div style="display:grid;gap:8px;text-align:center;padding:0 30px;">
              <div style="font-size:18px;line-height:1.3;font-weight:800;color:#17233C;">Турнири — тестов достъп</div>
              <div style="font-size:14px;line-height:1.5;color:#667085;font-weight:500;">Секцията „Турнири" е в тестов период. Въведете паролата за достъп.</div>
            </div>
            <input
              type="password"
              data-tournament-beta-access-password-input="1"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="Парола"
              ${state.isSubmitting ? 'disabled' : ''}
              style="width:100%;box-sizing:border-box;height:44px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#111827;font-family:inherit;font-size:16px;font-weight:600;padding:0 12px;color-scheme:light;"
            />
            ${state.errorText !== null ? `
              <div data-tournament-beta-access-error="1" role="alert" style="padding:9px 12px;border:1px solid #FECDCA;background:#FEF3F2;border-radius:8px;color:#B42318;font-size:13px;font-weight:700;line-height:1.4;text-align:center;overflow-wrap:anywhere;">${escapeHtml(state.errorText)}</div>
            ` : ''}
            <button
              type="submit"
              data-tournament-beta-access-submit-button="1"
              ${state.isSubmitting ? 'disabled' : `class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}"`}
              style="height:44px;border:0;border-radius:8px;${state.isSubmitting ? 'background:#B9A6F3;' : ''}color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;"
            >${state.isSubmitting ? 'Проверка…' : 'Влез'}</button>
          </form>
        </div>
      </div>
    `
  }

  return `
    <div data-tournament-beta-access-modal-root="1" data-lobby-keep-form="tournament-beta-access" style="position:fixed;inset:0;z-index:13500;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-tournament-beta-access-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,420px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;box-sizing:border-box;">
        <button type="button" data-tournament-beta-access-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <form data-tournament-beta-access-form="1" style="display:grid;gap:14px;">
          <div style="display:grid;gap:10px;text-align:center;">
            <div style="font-size:19px;line-height:1.3;font-weight:900;color:#f8fafc;">Турнири — тестов достъп</div>
            <div style="font-size:14px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:600;">Секцията „Турнири" е в тестов период. Въведете паролата за достъп.</div>
          </div>
          <input
            type="password"
            data-tournament-beta-access-password-input="1"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="Парола"
            ${state.isSubmitting ? 'disabled' : ''}
            style="width:100%;box-sizing:border-box;height:46px;border-radius:8px;border:1px solid rgba(212,165,32,0.42);background:#0d0d0d;color:#f8fafc;font-size:15px;font-weight:700;padding:0 14px;"
          />
          ${state.errorText !== null ? `
            <div data-tournament-beta-access-error="1" style="font-size:13px;font-weight:700;color:#fca5a5;text-align:center;">${escapeHtml(state.errorText)}</div>
          ` : ''}
          <button
            type="submit"
            data-tournament-beta-access-submit-button="1"
            ${state.isSubmitting ? 'disabled' : ''}
            style="height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;"
          >${state.isSubmitting ? 'Проверка…' : 'Влез'}</button>
        </form>
      </div>
    </div>
  `
}

export function attachTournamentBetaAccessModalEventListeners(
  root: ParentNode,
  options: TournamentBetaAccessModalOptions,
): void {
  root.querySelector('[data-tournament-beta-access-modal-backdrop="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-tournament-beta-access-modal-close="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root
    .querySelector<HTMLElement>('[data-tournament-beta-access-modal-root="1"] [role="dialog"]')
    ?.addEventListener('click', (e) => e.stopPropagation())

  const form = root.querySelector<HTMLFormElement>('[data-tournament-beta-access-form="1"]')
  form?.addEventListener('submit', (e) => {
    e.preventDefault()
    const input = root.querySelector<HTMLInputElement>('[data-tournament-beta-access-password-input="1"]')
    const password = input?.value ?? ''
    if (!password) return
    options.onSubmit(password)
  })
}
