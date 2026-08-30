import { isPikaHostname } from '../utils/isPikaHostname.js'

// Позволени target-и за рекламна кампания: (1) relative SPA path (единичен
// водещ '/', НЕ '//' protocol-relative, НЕ backslash — browsers нормализират
// '\' към '/' и това е познат open-redirect/XSS bypass trick), ИЛИ (2)
// абсолютен https:// адрес на pika.bg/*.pika.bg (positive allowlist, не
// blacklist на опасни схеми — javascript:/data:/vbscript: автоматично се
// отхвърлят, защото не минават нито едната проверка).
export function isSafeAdCampaignTargetUrl(value: string): boolean {
  const v = value.trim()

  if (v.length === 0 || v.length > 2048) {
    return false
  }

  if (v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && !/[\x00-\x1f]/.test(v)) {
    return true
  }

  try {
    const url = new URL(v)
    return url.protocol === 'https:' && isPikaHostname(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export type AdCampaignTargetUrlNormalizationResult =
  | { ok: true; targetUrl: string | null }
  | { ok: false; message: string }

// target е optional — кампания може да съществува само с изображение, без
// "Виж" бутон (виж §"Кампания без target" в брифа). missing/null/празен
// string (след trim) НЕ е грешка — нормализира се до null ("без target").
// Само НЕПразен string минава през isSafeAdCampaignTargetUrl.
export function normalizeAdCampaignTargetUrl(value: unknown): AdCampaignTargetUrlNormalizationResult {
  if (value === undefined || value === null) {
    return { ok: true, targetUrl: null }
  }

  if (typeof value !== 'string') {
    return { ok: false, message: 'Невалиден адрес.' }
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return { ok: true, targetUrl: null }
  }

  if (!isSafeAdCampaignTargetUrl(trimmed)) {
    return { ok: false, message: 'Невалиден адрес. Разрешени са само вътрешни адреси или https://pika.bg линкове.' }
  }

  return { ok: true, targetUrl: trimmed }
}
