import type { GuestContactMessage } from './guestContactValidation.js'

export type SendGuestContactEmailResult =
  | { ok: true }
  | { ok: false; message: string }

const BREVO_SEND_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildTextContent(input: GuestContactMessage): string {
  const subject = input.subject.length > 0 ? input.subject : 'Без тема'

  return [
    'Ново съобщение от публичната контактна форма на Pika.bg.',
    '',
    `Име: ${input.name}`,
    `Имейл за отговор: ${input.email}`,
    `Тема: ${subject}`,
    '',
    'Съобщение:',
    input.message,
  ].join('\n')
}

function buildHtmlContent(input: GuestContactMessage): string {
  const subject = input.subject.length > 0 ? input.subject : 'Без тема'
  const escapedMessage = escapeHtml(input.message).replace(/\n/g, '<br>')

  return `
    <p>Ново съобщение от публичната контактна форма на Pika.bg.</p>
    <p>
      <strong>Име:</strong> ${escapeHtml(input.name)}<br>
      <strong>Имейл за отговор:</strong> ${escapeHtml(input.email)}<br>
      <strong>Тема:</strong> ${escapeHtml(subject)}
    </p>
    <p><strong>Съобщение:</strong></p>
    <p>${escapedMessage}</p>
  `
}

export async function sendGuestContactEmail(input: GuestContactMessage): Promise<SendGuestContactEmailResult> {
  const apiKey = process.env.BREVO_API_KEY?.trim()
  const toEmail = process.env.CONTACT_TO_EMAIL?.trim()
  const fromEmail = process.env.CONTACT_FROM_EMAIL?.trim()
  const fromName = process.env.CONTACT_FROM_NAME?.trim() || 'Pika.bg'

  if (!apiKey || !toEmail || !fromEmail) {
    return { ok: false, message: 'Контактната форма не е конфигурирана на сървъра.' }
  }

  const response = await fetch(BREVO_SEND_EMAIL_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        email: fromEmail,
        name: fromName,
      },
      to: [
        {
          email: toEmail,
        },
      ],
      replyTo: {
        email: input.email,
        name: input.name,
      },
      subject:
        input.subject.length > 0
          ? `[Pika.bg] ${input.subject}`
          : '[Pika.bg] Ново съобщение от контактната форма',
      textContent: buildTextContent(input),
      htmlContent: buildHtmlContent(input),
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return {
      ok: false,
      message: body.trim() || `Brevo върна HTTP ${response.status}.`,
    }
  }

  return { ok: true }
}
