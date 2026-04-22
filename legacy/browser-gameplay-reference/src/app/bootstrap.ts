import { createGameEngine, type GameEngine } from '../core/engine/createGameEngine'

export type AppBootstrap = {
  engine: GameEngine
}

export function bootstrapApp(): AppBootstrap {
  const engine = createGameEngine()

  engine.startNewGame()
  engine.chooseFirstDealer()

  return {
    engine,
  }
}