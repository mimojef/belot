// Mock данни за visual prototype — 4 играча, 16 пионки (част в базите, част
// на трасето). Legal moves вече НЕ са тук — изчисляват се динамично от
// board/computeLudoLegalMoves.ts спрямо реалния dice резултат (виж audit-а
// защо старите hardcoded legalMoves бяха премахнати). Engine-ът по-късно ще
// замени този модул изцяло; renderer-ът не трябва да прави предположения
// отвъд типовете тук.

import { ludoCellId } from '../ludoTypes'
import type { LudoColor, LudoPiece, LudoPlayer } from '../ludoTypes'
import { LUDO_COLORS } from '../ludoTypes'

export function createLudoMockPlayers(): Record<LudoColor, LudoPlayer> {
  return {
    red: { color: 'red', name: 'Иван', avatarUrl: null, isBot: false },
    blue: { color: 'blue', name: 'Мария', avatarUrl: null, isBot: true },
    green: { color: 'green', name: 'Георги', avatarUrl: null, isBot: true },
    yellow: { color: 'yellow', name: 'Петя', avatarUrl: null, isBot: true },
  }
}

function homeCell(color: LudoColor, slot: number) {
  return ludoCellId({ kind: 'home', color, slot })
}

function trackCell(index: number) {
  return ludoCellId({ kind: 'track', index })
}

// Разположение, което показва как изглежда реална игра в разгара си:
// по едно пионче все още в базата, по едно близо до собствения старт, и
// по едно/две по-навътре в трасето — включително среща за capture demo.
export function createLudoMockPieces(): LudoPiece[] {
  return [
    { id: 'red-0', color: 'red', cell: homeCell('red', 0) },
    { id: 'red-1', color: 'red', cell: trackCell(4) },
    { id: 'red-2', color: 'red', cell: trackCell(22) },
    { id: 'red-3', color: 'red', cell: homeCell('red', 3) },

    { id: 'blue-0', color: 'blue', cell: homeCell('blue', 0) },
    { id: 'blue-1', color: 'blue', cell: homeCell('blue', 1) },
    { id: 'blue-2', color: 'blue', cell: trackCell(17) },
    { id: 'blue-3', color: 'blue', cell: trackCell(27) },

    { id: 'green-0', color: 'green', cell: homeCell('green', 0) },
    { id: 'green-1', color: 'green', cell: homeCell('green', 1) },
    { id: 'green-2', color: 'green', cell: homeCell('green', 2) },
    { id: 'green-3', color: 'green', cell: trackCell(43) },

    { id: 'yellow-0', color: 'yellow', cell: homeCell('yellow', 0) },
    { id: 'yellow-1', color: 'yellow', cell: homeCell('yellow', 1) },
    { id: 'yellow-2', color: 'yellow', cell: homeCell('yellow', 2) },
    { id: 'yellow-3', color: 'yellow', cell: homeCell('yellow', 3) },
  ]
}

export function ludoMockPlayerOrder(): readonly LudoColor[] {
  return LUDO_COLORS
}
