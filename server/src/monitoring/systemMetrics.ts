import type { MonitoringDeps } from './monitoringTypes.js'

const MAX_ERROR_LENGTH = 180

// Превръща произволна грешка в безопасен едноредов текст без пътища, stack frames или secrets.
export function sanitizeErrorMessage(error: unknown): string {
  let raw: string

  if (error instanceof Error) {
    raw = error.message
  } else if (typeof error === 'string') {
    raw = error
  } else {
    raw = 'Monitoring error'
  }

  if (!raw || !raw.trim()) {
    return 'Monitoring error'
  }

  // Замести нови редове и tab-ове с интервал, свий поредни whitespace
  let safe = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

  // Премахни очевидни stack-trace части (lines starting with "at ", preceded by whitespace)
  safe = safe.replace(/\bat\s+\S[^\s]*/g, '').replace(/\s{2,}/g, ' ').trim()

  // Премахни абсолютни файлови пътища (Windows и Unix) и node: вградени модули
  safe = safe
    .replace(/[A-Za-z]:\\[^\s,;)"]*/g, '<path>')
    .replace(/node:[a-z][^\s,;)"]{2,}/g, '<internal>')
    .replace(/\/[^\s,;)"]{3,}/g, '<path>')
    .trim()

  // Скрий стойности при чувствителни ключове (token, password, secret, cookie и т.н.)
  // Поддържа: `KEY=value`, `KEY: value`, `Authorization: Bearer value`
  // Взима всичко след separator-а до края на реда / пунктуация (не само първата дума).
  const SECRET_KEYS =
    /\b(access_token|refresh_token|session_token|secret_key|stripe_secret_key|brevo_api_key|api_key|apikey|authorization|password|session|cookie|token|secret)\s*[=:]\s*[^\r\n,;)"]+/gi
  safe = safe.replace(SECRET_KEYS, (match) => {
    const sep = match.search(/[=:]/)
    return match.slice(0, sep + 1) + '<redacted>'
  })
  // Standalone Bearer <value> (не хванато от горното)
  safe = safe.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')

  // Ограничи до MAX_ERROR_LENGTH символа
  if (safe.length > MAX_ERROR_LENGTH) {
    safe = safe.slice(0, MAX_ERROR_LENGTH - 1) + '…'
  }

  return safe || 'Monitoring error'
}

export type OsCpuSnapshot = {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

export type CpuDeltaResult = {
  serverCpuNowPercent: number
  sampleWindowMs: number
}

export type ProcessCpuDeltaResult = {
  nodeCpuNowPercent: number
}

export function sumOsCpuTimes(
  cores: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>,
): OsCpuSnapshot {
  const result: OsCpuSnapshot = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  for (const core of cores) {
    result.user += core.times.user
    result.nice += core.times.nice
    result.sys += core.times.sys
    result.idle += core.times.idle
    result.irq += core.times.irq
  }
  return result
}

export function calcServerCpuPercent(
  prev: OsCpuSnapshot,
  curr: OsCpuSnapshot,
): number {
  const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq
  const currTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq
  const totalDelta = currTotal - prevTotal

  if (totalDelta <= 0) {
    return 0
  }

  const idleDelta = curr.idle - prev.idle
  const usedDelta = totalDelta - idleDelta

  return Math.max(0, Math.min(100, (usedDelta / totalDelta) * 100))
}

export function calcNodeCpuPercent(
  prevUsage: NodeJS.CpuUsage,
  currUsage: NodeJS.CpuUsage,
  elapsedMs: number,
): number {
  if (elapsedMs <= 0) {
    return 0
  }

  const userDeltaUs = currUsage.user - prevUsage.user
  const sysDeltaUs = currUsage.system - prevUsage.system
  const totalCpuUs = userDeltaUs + sysDeltaUs
  const elapsedUs = elapsedMs * 1000

  return Math.max(0, (totalCpuUs / elapsedUs) * 100)
}

export type RamMetrics = {
  ramUsedMb: number
  ramTotalMb: number
  ramPercent: number
  processRssMb: number
}

export function calcRamMetrics(
  deps: Pick<MonitoringDeps, 'osFreeMem' | 'osTotalMem' | 'processMemUsage'>,
): RamMetrics {
  const totalBytes = deps.osTotalMem()
  const freeBytes = deps.osFreeMem()
  const usedBytes = totalBytes - freeBytes
  const memUsage = deps.processMemUsage()

  const MB = 1024 * 1024
  const ramTotalMb = totalBytes / MB
  const ramUsedMb = usedBytes / MB
  const ramPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0
  const processRssMb = memUsage.rss / MB

  return { ramUsedMb, ramTotalMb, ramPercent, processRssMb }
}
