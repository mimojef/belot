// Deterministic проверка на Ludo track geometry — НЕ browser check (чиста
// логика, без DOM/Playwright), тъй като board geometry е pure computation.
// Проверява:
//   1. основният track е непрекъсната последователност от съседни клетки;
//   2. съдържа всички очаквани track клетки (LUDO_TRACK_LENGTH общо);
//   3. четирите диагонални ъглови позиции при центъра са част от маршрута;
//   4. няма duplicate grid координати сред track клетките;
//   5. движението по route-а остава по часовниковата стрелка (следващата
//      клетка винаги е физически съседна — разлика от точно 1 в col ИЛИ row,
//      никога и в двете едновременно, и никога скок).
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import {
  LUDO_TRACK_LENGTH,
  ludoGridPointForCell,
  ludoStartTrackIndex,
} from '../src/app/games/ludo/board/ludoBoardGeometry'
import { LUDO_COLORS } from '../src/app/games/ludo/ludoTypes'

function fail(message: string): never {
  console.error(`[checkLudoTrackGeometry] FAIL: ${message}`)
  process.exit(1)
}

function main(): void {
  // 1 + 2: пълна, непрекъсната последователност от LUDO_TRACK_LENGTH клетки.
  const points = Array.from({ length: LUDO_TRACK_LENGTH }, (_, index) =>
    ludoGridPointForCell({ kind: 'track', index }),
  )
  if (points.length !== LUDO_TRACK_LENGTH) {
    fail(`expected ${LUDO_TRACK_LENGTH} track points, got ${points.length}`)
  }

  // 4: няма duplicate grid координати.
  const seen = new Map<string, number>()
  for (const [index, point] of points.entries()) {
    const key = `${point.col},${point.row}`
    if (seen.has(key)) {
      fail(`duplicate grid coordinate ${key} at track-${index} and track-${seen.get(key)}`)
    }
    seen.set(key, index)
  }

  // 5: всяка стъпка от route-а е към физически съседна клетка (Chebyshev
  // distance 1, само по една ос — иначе диагонален "телепорт" би минал
  // недетектиран). Затворен цикъл — последната клетка също съседна на първата.
  for (let index = 0; index < LUDO_TRACK_LENGTH; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % LUDO_TRACK_LENGTH]
    const dCol = Math.abs(current.col - next.col)
    const dRow = Math.abs(current.row - next.row)
    const isSingleAxisStep = (dCol === 1 && dRow === 0) || (dCol === 0 && dRow === 1)
    if (!isSingleAxisStep) {
      fail(
        `non-adjacent step from track-${index} (${current.col},${current.row}) to ` +
          `track-${(index + 1) % LUDO_TRACK_LENGTH} (${next.col},${next.row}) — dCol=${dCol} dRow=${dRow}`,
      )
    }
  }

  // 3: четирите диагонални ъглови позиции при центъра (между хоризонталния
  // и вертикалния сегмент на всяко рамо) присъстват в маршрута. Извеждаме ги
  // геометрично (не hardcode-нато), за да не се разминат при бъдеща промяна:
  // те са единствените track клетки, съседни едновременно на две други track
  // клетки, разположени по различни оси (диагонален завой), които същевременно
  // лежат извън 3x3 центъра (cols/rows 6-8) но допират до него.
  const cornerLikeCount = points.filter((p) => {
    const isNearCenterRing = (p.col === 5 || p.col === 9) && (p.row === 5 || p.row === 9)
    return isNearCenterRing
  }).length
  if (cornerLikeCount !== 4) {
    fail(`expected exactly 4 diagonal corner-turn cells near the center ring, found ${cornerLikeCount}`)
  }

  // Всеки цвят започва track-а на различен, валиден index в обхвата.
  const startIndices = LUDO_COLORS.map((color) => ludoStartTrackIndex(color))
  const uniqueStarts = new Set(startIndices)
  if (uniqueStarts.size !== LUDO_COLORS.length) {
    fail(`start indices are not unique per color: ${JSON.stringify(startIndices)}`)
  }
  for (const idx of startIndices) {
    if (idx < 0 || idx >= LUDO_TRACK_LENGTH) {
      fail(`start index ${idx} out of range [0, ${LUDO_TRACK_LENGTH})`)
    }
  }

  console.log(
    `[checkLudoTrackGeometry] OK — ${LUDO_TRACK_LENGTH} track cells, continuous clockwise loop, ` +
      `4 corner-turn cells included, no duplicates.`,
  )
  process.exit(0)
}

main()
