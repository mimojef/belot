const BREVO_SEND_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email'
const BREVO_FETCH_TIMEOUT_MS = 10_000

export type SendPasswordResetEmailResult =
  | { ok: true }
  | { ok: false; message: string }

export type SendPasswordResetEmailInput = {
  toEmail: string
  rawToken: string
  resetUrl: string
}

function buildTextContent(resetLink: string): string {
  return [
    'Здравейте,',
    '',
    'Получихме заявка за смяна на паролата за Вашия профил в Pika.bg.',
    '',
    'Използвайте следния линк, за да зададете нова парола:',
    '',
    resetLink,
    '',
    'Линкът е активен 30 минути и може да бъде използван само веднъж.',
    '',
    'Ако не сте изпращали тази заявка, не предприемайте нищо.',
    '',
    'Поздрави,',
    'Екипът на Pika.bg',
  ].join('\n')
}

function buildHtmlContent(resetLink: string): string {
  // Само URL-ът се поставя в href — не съдържа потребителски вход и не се ескейпва.
  return `
    <p>Здравейте,</p>
    <p>Получихме заявка за смяна на паролата за Вашия профил в Pika.bg.</p>
    <p>Използвайте следния линк, за да зададете нова парола:</p>
    <p><a href="${resetLink}">${resetLink}</a></p>
    <p>Линкът е активен 30 минути и може да бъде използван само веднъж.</p>
    <p>Ако не сте изпращали тази заявка, не предприемайте нищо.</p>
    <p>Поздрави,<br>Екипът на Pika.bg</p>
  `
}

export async function sendPasswordResetEmail(
  input: SendPasswordResetEmailInput,
): Promise<SendPasswordResetEmailResult> {
  const apiKey = process.env.BREVO_API_KEY?.trim()
  const fromEmail = process.env.CONTACT_FROM_EMAIL?.trim()
  const fromName = process.env.CONTACT_FROM_NAME?.trim() || 'Pika.bg'

  if (!apiKey || !fromEmail) {
    return { ok: false, message: 'Password reset email не е конфигуриран на сървъра.' }
  }

  // Raw token присъства само в #fragment — не в query string, не в логове.
  const resetLink = `${input.resetUrl}#token=${input.rawToken}`

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
        subject: 'Смяна на паролата в Pika.bg',
        textContent: buildTextContent(resetLink),
        htmlContent: buildHtmlContent(resetLink),
      }),
      signal: AbortSignal.timeout(BREVO_FETCH_TIMEOUT_MS),
    })
  } catch {
    // Не логваме грешката директно — може да съдържа URL с token в stack trace.
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
