// Which page an address shows. Game pages sit at the game's id, as lila's do (`/abcd1234`); the id's
// format matches the server's (`apps/server/src/game/ids.ts`).

export type Route =
  | { readonly page: 'home' }
  | { readonly page: 'game'; readonly id: string }
  | { readonly page: 'notFound' };

const GAME_ID = /^[0-9A-Za-z]{8}$/;

export function routeOf(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '');
  if (path === '') return { page: 'home' };
  const segment = path.slice(1);
  if (GAME_ID.test(segment)) return { page: 'game', id: segment };
  return { page: 'notFound' };
}
