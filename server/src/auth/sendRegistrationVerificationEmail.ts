// Reuse-ва СЪЩАТА production Brevo transactional email инфраструктура като
// sendPasswordResetEmail.ts (BREVO_API_KEY/CONTACT_FROM_EMAIL/CONTACT_FROM_NAME
// env vars) — умишлено НЕ втори независим mail transport, само нов template.
//
// BREVO CLICK TRACKING (не code-level): вече НЕ е deploy blocker (виж final
// report-а "Brevo" секцията) — линкът по-долу носи PUBLIC LOCATOR (§"PUBLIC
// LOCATOR" в registrationVerificationLinkToken.ts), не bearer capability.
// Дори Brevo да вижда/логва/rewrite-ва линка, locator-ът сам по себе си не
// дава право да verify-не/cancel-не/resend-не/update-не display name —
// всички mutating действия изискват и правилния 6-цифрен код. Click tracking
// може спокойно да остане в текущата Brevo account конфигурация.

import { createRegistrationVerificationLocator } from './registrationVerificationLinkToken.js'

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
   * §"PUBLIC LOCATOR" (revised design) — линкът НЕ носи raw
   * pendingRegistrationId никъде. Носи encrypted (AES-256-GCM) opaque LOCATOR
   * (createRegistrationVerificationLocator(), registrationVerificationLinkToken.ts)
   * в URL QUERY string (?verification=...), не fragment — query е по-устойчив
   * при email click-tracking redirect chains (Brevo и подобни услуги
   * пренаписват href-и през собствен redirect endpoint; #fragment не оцелява
   * надеждно през сървърен redirect, query параметър оцелява). Това вече е
   * безопасно, защото locator-ът е PUBLIC — possession alone НЕ верифицира
   * регистрация, НЕ create-ва сесия, НЕ update-ва display name, НЕ cancel-ва,
   * НЕ resend-ва код (виж registrationVerificationLinkToken.ts doc коментара
   * за пълния security model). Locator-ът само идентифицира коя pending
   * регистрация да покаже; правилният 6-цифрен код остава задължителен
   * authorization proof за всяко state-changing действие.
   */
  verificationPageUrl?: string
  pendingRegistrationId?: string
  /** Нужен само ако pendingRegistrationId е подаден — за locator encryption. */
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

/** Encrypted opaque LOCATOR в query string-а (?verification=...) — виж
 * SendRegistrationVerificationEmailInput.verificationPageUrl doc коментара
 * за пълния "PUBLIC LOCATOR, query е вече допустим" rationale. URL/
 * URLSearchParams гарантират коректно encode-ване дори ако
 * verificationPageUrl вече носи query параметри. */
function buildVerificationLink(verificationPageUrl: string, verificationLocator: string): string {
  const url = new URL(verificationPageUrl)
  url.searchParams.set('verification', verificationLocator)
  return url.toString()
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
          createRegistrationVerificationLocator(
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
