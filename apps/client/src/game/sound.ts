// Move and capture sounds (P2-15): Lichess's "sfx" set by Enigmahack, AGPL-3.0-or-later. Lichess's own
// default set is not free, so it is not used. A browser plays nothing until the player has touched the
// page, so a refused play is ignored.

export type Sound = 'move' | 'capture';

const cache = new Map<Sound, HTMLAudioElement>();

export function play(sound: Sound): void {
  let audio = cache.get(sound);
  if (audio === undefined) {
    audio = new Audio(`/sound/${sound}.mp3`);
    cache.set(sound, audio);
  }
  audio.currentTime = 0;
  audio.play().catch(() => {});
}
