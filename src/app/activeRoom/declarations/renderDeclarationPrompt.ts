import { escapeHtml } from '../activeRoomShared'
import type {
  ClientDeclarationCandidate,
  PendingDeclarationPrompt,
} from './declarationPromptTypes'
import { clientDeclarationCandidatesOverlap } from './resolveClientDeclarationConflicts'

const PROMPT_SELECTOR = '[data-declaration-prompt-root="1"]'

export function removeDeclarationPrompt(root: ParentNode = document): void {
  root.querySelector(PROMPT_SELECTOR)?.remove()
}

function hasSelectedOverlap(
  option: ClientDeclarationCandidate,
  selectedOptions: ClientDeclarationCandidate[],
): boolean {
  return selectedOptions.some((selectedOption) =>
    selectedOption.key !== option.key &&
    clientDeclarationCandidatesOverlap(option, selectedOption),
  )
}

function renderOption(option: ClientDeclarationCandidate, params: {
  isChecked: boolean
  isDisabled: boolean
}): string {
  const { isChecked, isDisabled } = params

  return `
    <label
      style="
        display:grid;
        grid-template-columns:34px minmax(0,1fr) auto;
        align-items:center;
        gap:12px;
        min-height:68px;
        padding:12px 8px;
        border-bottom:1px solid rgba(245,166,35,0.28);
        cursor:${isDisabled ? 'not-allowed' : 'pointer'};
        opacity:${isDisabled ? '0.48' : '1'};
      "
    >
      <input
        type="checkbox"
        data-declaration-option="${escapeHtml(option.key)}"
        ${isChecked ? 'checked' : ''}
        ${isDisabled ? 'disabled' : ''}
        style="
          width:24px;
          height:24px;
          margin:0;
          cursor:${isDisabled ? 'not-allowed' : 'pointer'};
          accent-color:#f5a623;
        "
      />
      <span
        style="
          min-width:0;
          color:#f8fafc;
          font-size:24px;
          line-height:1.05;
          font-weight:800;
        "
      >${escapeHtml(option.publicLabel)}</span>
      <span
        style="
          color:#fde68a;
          font-size:18px;
          line-height:1;
          font-weight:800;
          white-space:nowrap;
        "
      >${option.points} т.</span>
    </label>
  `
}

export function renderDeclarationPrompt(params: {
  root: HTMLElement
  prompt: PendingDeclarationPrompt
  onSelectionChange: (selectedKeys: string[]) => void
  onContinue: (selectedKeys: string[]) => void
}): void {
  const { root, prompt, onSelectionChange, onContinue } = params
  removeDeclarationPrompt(root)

  const selectedKeys = new Set(prompt.selectedKeys)
  const selectedOptions = prompt.options.filter((option) => selectedKeys.has(option.key))
  const optionsHtml = prompt.options.map((option) => {
    const isChecked = selectedKeys.has(option.key)
    const isDisabled = !isChecked && hasSelectedOverlap(option, selectedOptions)

    return renderOption(option, { isChecked, isDisabled })
  }).join('')

  const overlay = document.createElement('div')
  overlay.setAttribute('data-declaration-prompt-root', '1')
  overlay.innerHTML = `
    <div
      style="
        position:fixed;
        inset:0;
        z-index:9999;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:18px;
        background:rgba(6,16,32,0.52);
        box-sizing:border-box;
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Избор на анонс"
        style="
          width:min(92vw,520px);
          box-sizing:border-box;
          border:2px solid rgba(245,166,35,0.9);
          border-radius:12px;
          background:rgba(14,33,51,0.97);
          box-shadow:0 24px 60px rgba(0,0,0,0.30);
          color:#f8fafc;
          padding:18px 16px 16px;
        "
      >
        <div
          style="
            margin:0 0 12px;
            text-align:center;
            color:#f8fafc;
            font-size:28px;
            line-height:1.05;
            font-weight:900;
          "
        >Избери анонс</div>
        <div
          style="
            border-top:1px solid rgba(245,166,35,0.28);
            margin-bottom:14px;
          "
        >
          ${optionsHtml}
        </div>
        <div
          style="
            display:grid;
            grid-template-columns:1fr 1fr;
            gap:10px;
          "
        >
          <button
            type="button"
            data-declaration-none="1"
            style="
              min-height:54px;
              border:1px solid rgba(248,250,252,0.22);
              border-radius:8px;
              background:rgba(248,250,252,0.08);
              color:#f8fafc;
              font-size:18px;
              line-height:1;
              font-weight:800;
              cursor:pointer;
            "
          >Без анонс</button>
          <button
            type="button"
            data-declaration-continue="1"
            style="
              min-height:54px;
              border:0;
              border-radius:8px;
              background:#f5a623;
              color:#fff7ed;
              font-size:20px;
              line-height:1;
              font-weight:900;
              cursor:pointer;
              box-shadow:inset 0 -3px 0 rgba(0,0,0,0.14);
            "
          >Продължи</button>
        </div>
      </div>
    </div>
  `

  root.appendChild(overlay)

  overlay.querySelectorAll<HTMLInputElement>('[data-declaration-option]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.declarationOption
      if (!key) {
        return
      }

      const nextSelectedKeys = input.checked
        ? [...prompt.selectedKeys, key]
        : prompt.selectedKeys.filter((selectedKey) => selectedKey !== key)

      onSelectionChange([...new Set(nextSelectedKeys)])
    })
  })

  overlay.querySelector<HTMLButtonElement>('[data-declaration-none="1"]')
    ?.addEventListener('click', () => {
      onSelectionChange([])
    })

  overlay.querySelector<HTMLButtonElement>('[data-declaration-continue="1"]')
    ?.addEventListener('click', () => {
      onContinue(prompt.selectedKeys)
    })
}
