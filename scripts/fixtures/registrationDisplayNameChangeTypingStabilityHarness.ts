// Браузърна тестова "сглобка" за
// checkRegistrationDisplayNameChangeTypingStability.ts — кара РЕАЛНИЯ
// createLobbyFlowController() (не мокап) през Vite dev server, в истински
// браузър (Playwright). Отваря register формата, submit-ва я, стига до
// verification popup-а, подава verify code, който сървърът отговаря с
// DISPLAY_NAME_TAKEN (mode превключва към 'displayName' — виж
// submitRegistrationVerificationCode/DISPLAY_NAME_TAKEN клона в
// createLobbyFlowController.ts), после пише в РЕАЛНИЯ
// <input data-registration-verification-display-name-input="1"> и submit-ва
// го с резултат, който ОТНОВО е грешка (напр. invalid_display_name/отново
// taken) — точно сценарият, при който popup-ът прави пълен render() докато
// display-name режимът остава активен.
//
// За разлика от registrationVerificationTypingStabilityHarness.ts (code
// input-а, вече защитен от commit 67914e3 с value="..." baking), ТОЗИ input
// (display-name-change) няма никаква такава защита в текущия production код
// — виж renderRegistrationVerificationPopup.ts::renderDisplayNameForm (няма
// value="${escapeHtml(...)}"), нито explicit save/restore на
// selectionStart/selectionEnd. Тестът доказва (или опровергава) точно това.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let pendingCounter = 0
let lastVerifySubmission: { pendingRegistrationId: string; code: string; rememberMe: boolean } | null = null
let lastDisplayNameSubmission: { pendingRegistrationId: string; displayName: string } | null = null
let verifyResultQueue: Array<{ errorText: string | null; code?: string }> = []
let displayNameResultQueue: Array<{ errorText: string | null; maskedEmail?: string; expiresAt?: string }> = []

function nextPending(): { pendingRegistrationId: string; maskedEmail: string; expiresAt: string } {
  pendingCounter += 1
  return {
    pendingRegistrationId: `pending-${pendingCounter}`,
    maskedEmail: 't***@example.com',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => null,
  onRegisterSubmit: async (_displayName, _email, _password, _gender) => {
    return { errorText: null, pending: nextPending() }
  },
  onVerifyRegistrationEmailSubmit: async (pendingRegistrationId, code, rememberMe) => {
    lastVerifySubmission = { pendingRegistrationId, code, rememberMe }
    const queued = verifyResultQueue.shift()
    if (queued) return queued
    return { errorText: null }
  },
  onResendRegistrationCodeSubmit: async (_pendingRegistrationId) => {
    return {
      errorText: null,
      maskedEmail: 'r***@example.com',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }
  },
  onUpdatePendingRegistrationDisplayNameSubmit: async (pendingRegistrationId, displayName) => {
    lastDisplayNameSubmission = { pendingRegistrationId, displayName }
    const queued = displayNameResultQueue.shift()
    if (queued) return queued
    return { errorText: null }
  },
})

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function fillRegisterFormAndSubmit(): void {
  const form = root.querySelector<HTMLFormElement>('[data-lobby-auth-form="register"]')
  if (!form) throw new Error('register form not found')
  const displayNameInput = form.querySelector<HTMLInputElement>('input[name="displayName"]')
  const emailInput = form.querySelector<HTMLInputElement>('input[name="email"]')
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]')
  const confirmPasswordInput = form.querySelector<HTMLInputElement>('input[name="confirmPassword"]')
  const genderRadio = form.querySelector<HTMLInputElement>('input[name="gender"][value="male"]')
  if (!displayNameInput || !emailInput || !passwordInput || !confirmPasswordInput || !genderRadio) {
    throw new Error('register form fields not found')
  }
  displayNameInput.value = 'TakenNameUser'
  emailInput.value = `dnchange-${Date.now()}-${pendingCounter}@example.com`
  passwordInput.value = 'correct horse battery'
  confirmPasswordInput.value = 'correct horse battery'
  genderRadio.checked = true
  form.requestSubmit()
}

function getCodeInputEl(): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('[data-registration-verification-code-input="1"]')
}

function fillCodeAndSubmit(code: string): void {
  const input = getCodeInputEl()
  if (input === null) throw new Error('code input not found')
  input.value = code
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const form = root.querySelector<HTMLFormElement>('[data-registration-verification-form="1"]')
  if (!form) throw new Error('verification form not found')
  form.requestSubmit()
}

function getDisplayNameInputEl(): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('[data-registration-verification-display-name-input="1"]')
}

function typeDisplayNameChar(char: string): void {
  const input = getDisplayNameInputEl()
  if (input === null) throw new Error('display-name input not found')
  input.focus()
  input.value = input.value + char
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function submitDisplayNameForm(): void {
  const form = root.querySelector<HTMLFormElement>('[data-registration-verification-display-name-form="1"]')
  if (!form) throw new Error('display-name form not found')
  form.requestSubmit()
}

;(window as any).__registrationDisplayNameChangeTypingStabilityHarness = {
  openRegister: () => controller.openAuthModal('register'),
  fillRegisterFormAndSubmit,
  flush,
  fillCodeAndSubmit,
  typeDisplayNameChar,
  submitDisplayNameForm,
  getMode: () => (root.querySelector('[data-registration-verification-display-name-form="1"]') ? 'displayName' : (root.querySelector('[data-registration-verification-form="1"]') ? 'code' : 'none')),
  isPopupOpen: () => root.querySelector('[data-registration-verification-modal-root="1"]') !== null,
  getDisplayNameInputValue: () => getDisplayNameInputEl()?.value ?? null,
  getDisplayNameInputElementId: () => {
    const el = getDisplayNameInputEl()
    if (el === null) return null
    if (!el.dataset.harnessNodeId) {
      el.dataset.harnessNodeId = String(Math.random())
    }
    return el.dataset.harnessNodeId
  },
  isDisplayNameInputFocused: () => document.activeElement === getDisplayNameInputEl(),
  getLastVerifySubmission: () => lastVerifySubmission,
  getLastDisplayNameSubmission: () => lastDisplayNameSubmission,
  queueVerifyResult: (result: { errorText: string | null; code?: string }) => {
    verifyResultQueue.push(result)
  },
  queueDisplayNameResult: (result: { errorText: string | null; maskedEmail?: string; expiresAt?: string }) => {
    displayNameResultQueue.push(result)
  },
  reset: () => {
    lastVerifySubmission = null
    lastDisplayNameSubmission = null
    verifyResultQueue = []
    displayNameResultQueue = []
  },
}
