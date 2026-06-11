export type GuestContactMessage = {
  name: string
  email: string
  subject: string
  message: string
}

export type GuestContactValidationResult =
  | { ok: true; value: GuestContactMessage }
  | { ok: false; code: 'invalid' | 'honeypot'; message: string }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function readStringField(payload: Record<string, unknown>, fieldName: string): string {
  const value = payload[fieldName]
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function validateGuestContactPayload(payload: unknown): GuestContactValidationResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: 'invalid', message: 'Невалидна заявка.' }
  }

  const record = payload as Record<string, unknown>
  const website = readStringField(record, 'website')
  const companyName = readStringField(record, 'companyName')

  if (website.length > 0 || companyName.length > 0) {
    return { ok: false, code: 'honeypot', message: 'Невалидна заявка.' }
  }

  const name = normalizeSingleLine(readStringField(record, 'name'))
  const email = readStringField(record, 'email').toLowerCase()
  const subject = normalizeSingleLine(readStringField(record, 'subject'))
  const message = readStringField(record, 'message')

  if (name.length === 0) {
    return { ok: false, code: 'invalid', message: 'Моля, въведете име.' }
  }

  if (name.length > 80) {
    return { ok: false, code: 'invalid', message: 'Името трябва да бъде до 80 символа.' }
  }

  if (email.length === 0) {
    return { ok: false, code: 'invalid', message: 'Моля, въведете имейл адрес.' }
  }

  if (email.length > 160 || !EMAIL_PATTERN.test(email)) {
    return { ok: false, code: 'invalid', message: 'Моля, въведете валиден имейл адрес.' }
  }

  if (subject.length > 120) {
    return { ok: false, code: 'invalid', message: 'Темата трябва да бъде до 120 символа.' }
  }

  if (message.length < 10) {
    return { ok: false, code: 'invalid', message: 'Съобщението трябва да бъде поне 10 символа.' }
  }

  if (message.length > 3000) {
    return { ok: false, code: 'invalid', message: 'Съобщението трябва да бъде до 3000 символа.' }
  }

  return {
    ok: true,
    value: {
      name,
      email,
      subject,
      message,
    },
  }
}
