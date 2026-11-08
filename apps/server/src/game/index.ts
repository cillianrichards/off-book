// The game module: live games, their moves and clocks. Other modules use it only through this file.

export { GAME_ID } from './ids.ts';
export type { ClockSettings, ClockView, GameStatus, GameView } from './live-game.ts';
export type { ClientMessage, Rejection, ServerMessage } from './protocol.ts';
export { GameService } from './service.ts';
export type {
  Connection,
  CreateGame,
  CreatedGame,
  GameServiceOptions,
  Join,
  PlayerSocket,
} from './service.ts';
