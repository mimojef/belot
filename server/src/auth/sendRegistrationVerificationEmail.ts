// Reuse-ва СЪЩАТА production Brevo transactional email инфраструктура като
// sendPasswordResetEmail.ts (BREVO_API_KEY/CONTACT_FROM_EMAIL/CONTACT_FROM_NAME
// env vars) — умишлено НЕ втори независим mail transport, само нов template.

const BREVO_SEND_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email'
const BREVO_FETCH_TIMEOUT_MS = 10_000

export type SendRegistrationVerificationEmailResult =
  | { ok: true }
  | { ok: false; message: string }

export type SendRegistrationVerificationEmailInput = {
  toEmail: string
  code: string
  expiresAt: string
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

function buildTextContent(code: string, expiresAtLabel: string): string {
  return [
    'Здравейте,',
    '',
    'Вашият код за потвърждение е:',
    '',
    code,
    '',
    `Кодът е валиден до ${expiresAtLabel}.`,
    '',
    'Ако не сте правили регистрация в Pika.bg, можете да игнорирате това съобщение.',
    '',
    'Поздрави,',
    'Екипът на Pika.bg',
  ].join('\n')
}

function buildHtmlContent(code: string, expiresAtLabel: string): string {
  // code е винаги 6 цифри (server-generated, никога user input) — безопасно
  // за директно вмъкване, не се ескейпва потребителски вход тук.
  return `
    <p>Здравейте,</p>
    <p>Вашият код за потвърждение е:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>
    <p>Кодът е валиден до ${expiresAtLabel}.</p>
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
        textContent: buildTextContent(input.code, expiresAtLabel),
        htmlContent: buildHtmlContent(input.code, expiresAtLabel),
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
