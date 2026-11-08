// The game module: live games, their moves and clocks. Other modules use it only through this file.

export { GAME_ID } from './ids.ts';
export type {
  ClockReading,
  ClockSettings,
  ClockView,
  GameStatus,
  GameTermination,
  GameView,
  Result,
} from './live-game.ts';
export { PostgresGameStore } from './postgres-store.ts';
export type { ClientMessage, OpponentStatus, Rejection, ServerMessage } from './protocol.ts';
export { GameService } from './service.ts';
export type {
  Connection,
  CreateGame,
  CreatedGame,
  GameServiceOptions,
  Join,
  PlayerSocket,
} from './service.ts';
export type { GameRecord, GameStore } from './store.ts';
