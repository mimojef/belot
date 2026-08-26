export type GiftLimitErrorPayload = {
  code: 'RECIPIENT_WINDOW_LIMIT_PARTIAL' | 'RECIPIENT_WINDOW_LIMIT_FULL'
  receivedInWindow: number
  remainingAllowance: number
  attemptedAmount: number
  nextReleaseAt: string | null
  nextReleaseAmount: number
}

export type PikaTeamDailyGiftLimitErrorPayload = {
  code: 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED'
  limit: number
  used: number
  remaining: number
}

const numFmt = new Intl.NumberFormat('bg-BG')
const dateFmt = new Intl.DateTimeFormat('bg-BG', {
  timeZone: 'Europe/Sofia',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const FULL_BASE = 'Този играч вече е получил максималния размер от 30 000 подарени жълтици за последните 60 дни.'

// Server вече връща готово Bulgarian съобщение (remaining > 0 vs remaining
// === 0 branch-ове, виж yellowCoinGiftStore.ts sendGiftCore §4.5) — тази
// функция е чист pass-through wrapper, не преизчислява текста, само пази
// единен извикващ pattern (formatGiftLimitError(result)) в контролера
// независимо от кой code branch е дошъл резултатът.
export function formatPikaTeamDailyGiftLimitError(
  result: PikaTeamDailyGiftLimitErrorPayload & { message?: string },
): string {
  if (result.remaining > 0) {
    return `Можеш да подариш още максимум ${numFmt.format(result.remaining)} жълтици днес.`
  }
  return 'Достигнат е дневният лимит за подаряване на жълтици. Лимитът се занулява в 00:00 ч.'
}

export function formatGiftLimitError(
  result: GiftLimitErrorPayload,
  nowMs: number = Date.now(),
): string {
  if (result.code === 'RECIPIENT_WINDOW_LIMIT_PARTIAL') {
    return `Този играч може да получи още най-много ${numFmt.format(result.remainingAllowance)} жълтици в текущия 60-дневен период.`
  }

  // RECIPIENT_WINDOW_LIMIT_FULL
  const raw = result.nextReleaseAt
  if (raw == null || raw === '') {
    return FULL_BASE
  }

  const releaseDate = new Date(raw)
  if (isNaN(releaseDate.getTime())) {
    return FULL_BASE
  }

  const daysUntilRelease = Math.max(
    0,
    Math.ceil((releaseDate.getTime() - nowMs) / (24 * 60 * 60 * 1000)),
  )

  const formattedDate = dateFmt.format(releaseDate)

  return `${FULL_BASE} Ще може да получава отново след ${daysUntilRelease} дни — на ${formattedDate}`
}
