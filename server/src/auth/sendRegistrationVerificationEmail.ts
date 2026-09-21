// Reuse-ва СЪЩАТА production Brevo transactional email инфраструктура като
// sendPasswordResetEmail.ts (BREVO_API_KEY/CONTACT_FROM_EMAIL/CONTACT_FROM_NAME
// env vars) — умишлено НЕ втори независим mail transport, само нов template.
//
// ОПЕРАЦИОННО ИЗИСКВАНЕ (не code-level, виж final report-а "Brevo click
// tracking" секцията): Brevo-овия transactional `smtp/email` endpoint НЯМА
// documented per-request body поле за disable-ване на click tracking —
// tracking-ът за transactional пращания се контролира на ниво Brevo
// account/sender settings (Brevo dashboard), не чрез request payload тук.
// Затова click-tracking disable-ването на verification email-а трябва да
// стане ръчно в Brevo dashboard-а за sender-а, използван от
// CONTACT_FROM_EMAIL, ПРЕДИ production deploy на тази функционалност — не
// може да бъде code-enforced от този файл.

import { createRegistrationVerificationToken } from './registrationVerificationLinkToken.js'

const BREVO_SEND_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email'
const BREVO_FETCH_TIMEOUT_MS = 10_000

export type SendRegistrationVerificationEmailResult =
  | { ok: true }
  | { ok: false; message: string }

export type SendRegistrationVerificationEmailInput = {
  toEmail: string
  code: string
  expiresAt: string
  /**
   * Email → dedicated registration verification page (§"EMAIL → DIRECT
   * REGISTRATION VERIFICATION PAGE"). Optional — ако липсва (или
   * REGISTRATION_VERIFICATION_URL env var-ът не е конфигуриран, виж call
   * site-а в index.ts/registrationVerificationHandlers.ts), email-ът просто
   * няма "Въведете кода тук" линк, само кода (старото поведение) — fail-safe,
   * никога fail-closed.
   *
   * §"PREFERRED TOKEN DESIGN"/§"URL FORMAT" — линкът НЕ носи raw
   * pendingRegistrationId никъде (нито query, нито fragment). Носи encrypted
   * (AES-256-GCM) opaque token (createRegistrationVerificationToken(),
   * registrationVerificationLinkToken.ts) в URL FRAGMENT (#token=...), НЕ
   * query string — fragment никога не стига до сървъра (nginx access log,
   * Referer header) при самия GET за страницата; token-ът decrypt-ва се
   * само server-side, при последващите POST заявки от dedicated page-a.
   * Token-ът сам по себе си НЕ активира регистрацията — само идентифицира
   * коя pending регистрация да покаже; кодът от email-а пак трябва да бъде
   * въведен ръчно там.
   */
  verificationPageUrl?: string
  pendingRegistrationId?: string
  /** Нужен само ако pendingRegistrationId е подаден — за token encryption. */
  registrationSecret?: string
}

function formatExpiresAt(expiresAt: string): string {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return expiresAt
  return new Intl.DateTimeFormat('bg-BG', {
    timeZone: 'Europe/Sofia',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** Encrypted token във fragment-а (#token=...), НИКОГА в query string-а —
 * виж SendRegistrationVerificationEmailInput.verificationPageUrl doc
 * коментара за пълния "не разкривай raw pendingRegistrationId" rationale.
 * Mirror на sendPasswordResetEmail.ts's #token= pattern (established в тоя
 * codebase точно за тази цел — fragment никога не стига до сървъра). */
function buildVerificationLink(verificationPageUrl: string, verificationToken: string): string {
  return `${verificationPageUrl}#token=${verificationToken}`
}

function buildTextContent(code: string, expiresAtLabel: string, verificationLink: string | null): string {
  const lines = [
    'Здравейте,',
    '',
    'Вашият код за потвърждение е:',
    '',
    code,
    '',
    `Кодът е валиден до ${expiresAtLabel}.`,
  ]
  if (verificationLink !== null) {
    lines.push(
      '',
      'Въведете кода тук:',
      verificationLink,
    )
  }
  lines.push(
    '',
    'Ако не сте правили регистрация в Pika.bg, можете да игнорирате това съобщение.',
    '',
    'Поздрави,',
    'Екипът на Pika.bg',
  )
  return lines.join('\n')
}

function buildHtmlContent(code: string, expiresAtLabel: string, verificationLink: string | null): string {
  // code е винаги 6 цифри (server-generated, никога user input) — безопасно
  // за директно вмъкване, не се ескейпва потребителски вход тук.
  // verificationLink е построен от server-configured base URL +
  // AES-256-GCM encrypted opaque token в fragment-а (buildVerificationLink) —
  // не user input, безопасно за директно вмъкване в href също.
  const ctaBlock = verificationLink !== null
    ? `
    <p style="text-align:center;margin:24px 0;">
      <a href="${verificationLink}" style="display:inline-block;background:#d4a520;color:#0a0a0a;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;">Въведете кода тук</a>
    </p>
    <p style="font-size:13px;color:#666;">Ако бутонът не работи, копирайте този линк в браузъра си:<br>${verificationLink}</p>
  `
    : ''
  return `
    <p>Здравейте,</p>
    <p>Вашият код за потвърждение е:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>
    <p>Кодът е валиден до ${expiresAtLabel}.</p>
    ${ctaBlock}
    <p>Ако не сте правили регистрация в Pika.bg, можете да игнорирате това съобщение.</p>
    <p>Поздрави,<br>Екипът на Pika.bg</p>
  `
}

export async function sendRegistrationVerificationEmail(
  input: SendRegistrationVerificationEmailInput,
): Promise<SendRegistrationVerificationEmailResult> {
  const apiKey = process.env.BREVO_API_KEY?.trim()
  const fromEmail = process.env.CONTACT_FROM_EMAIL?.trim()
  const fromName = process.env.CONTACT_FROM_NAME?.trim() || 'Pika.bg'

  if (!apiKey || !fromEmail) {
    return { ok: false, message: 'Registration verification email не е конфигуриран на сървъра.' }
  }

  const expiresAtLabel = formatExpiresAt(input.expiresAt)
  // Fail-safe (не fail-closed): ако verificationPageUrl/registrationSecret
  // липсват (env не е конфигуриран, виж doc коментара по-горе), просто няма
  // линк в email-а — старото numeric-code-only поведение продължава да работи.
  const verificationLink =
    input.verificationPageUrl && input.pendingRegistrationId && input.registrationSecret
      ? buildVerificationLink(
          input.verificationPageUrl,
          createRegistrationVerificationToken(
            input.registrationSecret,
            input.pendingRegistrationId,
            input.expiresAt,
          ),
        )
      : null

  let response: Response
  try {
    response = await fetch(BREVO_SEND_EMAIL_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: input.toEmail }],
        subject: 'Код за потвърждение в Pika.bg',
        textContent: buildTextContent(input.code, expiresAtLabel, verificationLink),
        htmlContent: buildHtmlContent(input.code, expiresAtLabel, verificationLink),
      }),
      signal: AbortSignal.timeout(BREVO_FETCH_TIMEOUT_MS),
    })
  } catch {
    // Не логваме грешката директно — избягваме случайно code/email leakage в stack trace.
    return { ok: false, message: 'Brevo fetch failed (timeout or network error).' }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return {
      ok: false,
      message: body.trim() || `Brevo върна HTTP ${response.status}.`,
    }
  }

  return { ok: true }
}
