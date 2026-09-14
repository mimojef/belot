// Браузърна тестова "сглобка" за checkRegistrationVerificationTypingStability.ts —
// кара РЕАЛНИЯ createLobbyFlowController() (не мокап), зареден през Vite dev
// server, в истински браузър (Playwright). Отваря register формата и я
// подава през РЕАЛЕН DOM submit (мокнат е само onRegisterSubmit constructor
// option-а — самият popup се отваря по ТОЧНО СЪЩИЯ production path:
// submitRegister() -> openRegistrationVerificationPopup()), после пише в
// РЕАЛНИЯ <input data-registration-verification-code-input="1"> буква по
// буква, докато 60s resend countdown interval-ът реално тик-ва в реално
// време — виж checkRegistrationVerificationTypingStability.ts за точното
// driving и production bug-а, който доказва (countdown interval-ът преди
// викаше пълен render() всяка секунда, което пресъздаваше root.innerHTML,
// включително code input-а, с празен value).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let pendingCounter = 0
let lastVerifySubmission: { pendingRegistrationId: string; code: string; rememberMe: boolean } | null = null
let verifyResultQueue: Array<{ errorText: string | null; code?: string }> = []
let resendCallCount = 0

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
    resendCallCount += 1
    return {
      errorText: null,
      maskedEmail: 'r***@example.com',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }
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
  displayNameInput.value = 'TypingTestUser'
  emailInput.value = `typing-${Date.now()}-${pendingCounter}@example.com`
  passwordInput.value = 'correct horse battery'
  confirmPasswordInput.value = 'correct horse battery'
  genderRadio.checked = true
  form.requestSubmit()
}

function getCodeInputEl(): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('[data-registration-verification-code-input="1"]')
}

function typeChar(char: string): void {
  const input = getCodeInputEl()
  if (input === null) throw new Error('code input not found')
  input.focus()
  input.value = input.value + char
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function pasteValue(value: string): void {
  const input = getCodeInputEl()
  if (input === null) throw new Error('code input not found')
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function submitCodeForm(): void {
  const form = root.querySelector<HTMLFormElement>('[data-registration-verification-form="1"]')
  if (!form) throw new Error('verification form not found')
  form.requestSubmit()
}

;(window as any).__registrationVerificationTypingStabilityHarness = {
  openRegister: () => controller.openAuthModal('register'),
  fillRegisterFormAndSubmit,
  flush,
  waitRealMs: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  typeChar,
  pasteValue,
  submitCodeForm,
  clickResend: () => {
    root.querySelector<HTMLButtonElement>('[data-registration-verification-resend="1"]')?.click()
  },
  clickClose: () => {
    root.querySelector<HTMLButtonElement>('[data-registration-verification-modal-close="1"]')?.click()
  },
  getCodeInputValue: () => getCodeInputEl()?.value ?? null,
  getCodeInputElementId: () => {
    const el = getCodeInputEl()
    if (el === null) return null
    // Stamp a stable marker the first time we see this exact node, so later
    // reads can prove "same node" vs "different node after a rebuild".
    if (!el.dataset.harnessNodeId) {
      el.dataset.harnessNodeId = String(Math.random())
    }
    return el.dataset.harnessNodeId
  },
  isCodeInputFocused: () => document.activeElement === getCodeInputEl(),
  isPopupOpen: () => root.querySelector('[data-registration-verification-modal-root="1"]') !== null,
  getResendButtonText: () => root.querySelector('[data-registration-verification-resend="1"]')?.textContent ?? null,
  getResendButtonDisabled: () => root.querySelector<HTMLButtonElement>('[data-registration-verification-resend="1"]')?.disabled ?? null,
  hasTwentyFourHourText: () => root.textContent?.includes('Кодът е валиден 24 часа.') === true,
  getLastVerifySubmission: () => lastVerifySubmission,
  getResendCallCount: () => resendCallCount,
  queueVerifyResult: (result: { errorText: string | null; code?: string }) => {
    verifyResultQueue.push(result)
  },
  reset: () => {
    lastVerifySubmission = null
    verifyResultQueue = []
    resendCallCount = 0
  },
}
