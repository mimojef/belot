// Initial canonical state factory — pure, deterministic (виж task-а т.11.A).
// Огледално на mock/ludoMockState.ts::createLudoMockPieces() като начална
// подредба (за да остане текущия prototype visual behavior идентичен, виж
// т.9), но изразено чрез LudoGamePiece/LudoPiecePosition вместо string cell
// id-та.

import { LUDO_CANONICAL_TURN_ORDER } from '../ludoGeometryConstants'
import type { LudoColor, LudoGamePiece, LudoGameState, LudoPieceSlot } from './ludoEngineTypes'

function trackPiece(color: LudoColor, slot: LudoPieceSlot, trackIndex: number): LudoGamePiece {
  return { color, slot, position: { kind: 'track', trackIndex } }
}

function homePiece(color: LudoColor, slot: LudoPieceSlot): LudoGamePiece {
  return { color, slot, position: { kind: 'home', slot } }
}

// Същото начално разположение като createLudoMockPieces() (mock/ludoMockState.ts):
// по едно пионче все още в базата, по едно близо до собствения старт, и
// по едно/две по-навътре в трасето — включително capture demo (blue slot 3
// на track-27, close to red slot 2 на track-22 + dice 6).
export function createLudoEngineInitialPieces(): LudoGamePiece[] {
  return [
    homePiece('red', 0),
    trackPiece('red', 1, 4),
    trackPiece('red', 2, 22),
    homePiece('red', 3),

    homePiece('blue', 0),
    homePiece('blue', 1),
    trackPiece('blue', 2, 17),
    trackPiece('blue', 3, 27),

    homePiece('green', 0),
    homePiece('green', 1),
    homePiece('green', 2),
    trackPiece('green', 3, 43),

    homePiece('yellow', 0),
    homePiece('yellow', 1),
    homePiece('yellow', 2),
    homePiece('yellow', 3),
  ]
}

export function createLudoEngineInitialState(): LudoGameState {
  return {
    // GAMEPLAY turn order (red -> blue -> yellow -> green -> red), НЕ
    // generic LUDO_COLORS enumeration — виж ludoGeometryConstants.ts за
    // защо са различни концепции и защо turnOrder explicit използва
    // gameplay-семантичната константа.
    turnOrder: LUDO_CANONICAL_TURN_ORDER,
    activeColor: 'red',
    turnPhase: 'waiting_for_roll',
    diceValue: null,
    legalMoves: [],
    pieces: createLudoEngineInitialPieces(),
    status: 'in_progress',
    turnVersion: 0,
  }
}
