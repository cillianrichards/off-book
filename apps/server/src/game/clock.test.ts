import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  centisOfMillis,
  flagDueAt,
  giveTime,
  newClock,
  outOfTime,
  quotaGainFor,
  remainingAt,
  start,
  step,
  stop,
} from './clock.ts';

const T0 = Date.UTC(2026, 10, 8, 12);
const TEN_PLUS_ZERO = { initialSeconds: 600, incrementSeconds: 0 };
const THREE_PLUS_TWO = { initialSeconds: 180, incrementSeconds: 2 };

/** A 10+0 clock already running for White since T0. */
const running = (settings = TEN_PLUS_ZERO) => start(newClock(settings, 'white'), T0);

describe('units', () => {
  test('rounds milliseconds to centiseconds as scalachess does', () => {
    assert.equal(centisOfMillis(0), 0);
    assert.equal(centisOfMillis(4), 0);
    assert.equal(centisOfMillis(5), 1);
    assert.equal(centisOfMillis(1234), 123);
    assert.equal(centisOfMillis(1235), 124);
    assert.equal(centisOfMillis(-5), 0);
    assert.equal(centisOfMillis(-6), -1);
  });

  test('gives a second of lag quota a move from three minutes up, less for faster games', () => {
    assert.equal(quotaGainFor(TEN_PLUS_ZERO), 100);
    assert.equal(quotaGainFor(THREE_PLUS_TWO), 100);
    assert.equal(quotaGainFor({ initialSeconds: 60, incrementSeconds: 0 }), 39);
    assert.equal(quotaGainFor({ initialSeconds: 15, incrementSeconds: 0 }), 21);
  });
});

describe('before the clock starts', () => {
  test('a move takes no time and passes the turn', () => {
    const clock = newClock(TEN_PLUS_ZERO, 'white');
    const { clock: after, flagged } = step(clock, T0 + 60_000, undefined, true);
    assert.equal(flagged, false);
    assert.deepEqual(after.remaining, { white: 60_000, black: 60_000 });
    assert.equal(after.turn, 'black');
    assert.equal(after.runningSince, undefined);
    assert.equal(remainingAt(after, 'black', T0 + 999_000), 60_000);
    assert.equal(flagDueAt(after), undefined);
  });
});

describe('a running clock', () => {
  test('charges the mover the time since their clock started, and starts the other', () => {
    const { clock } = step(running(), T0 + 12_340, undefined, true);
    assert.deepEqual(clock.remaining, { white: 60_000 - 1234, black: 60_000 });
    assert.equal(clock.turn, 'black');
    assert.equal(clock.runningSince, T0 + 12_340);
    assert.equal(remainingAt(clock, 'black', T0 + 22_340), 60_000 - 1000);
  });

  test('adds the increment', () => {
    const { clock } = step(running(THREE_PLUS_TWO), T0 + 5000, undefined, true);
    assert.equal(clock.remaining.white, 18_000 - 500 + 200);
  });

  test('gives no increment and stops when the move ends the game', () => {
    const { clock } = step(running(THREE_PLUS_TWO), T0 + 5000, undefined, false);
    assert.equal(clock.remaining.white, 18_000 - 500);
    assert.equal(clock.runningSince, undefined);
  });
});

describe('lag compensation (P2-07)', () => {
  test('gives back reported lag, within the quota', () => {
    const { clock } = step(running(), T0 + 5000, 80, true);
    assert.equal(clock.remaining.white, 60_000 - 500 + 80);
    // The quota started at 300 cs, gained 100 and spent 80.
    assert.equal(clock.quota.white, 320);
  });

  test('caps what one move can recover at the quota', () => {
    const { clock } = step(running(), T0 + 20_000, 5000, true);
    assert.equal(clock.remaining.white, 60_000 - 2000 + 300);
    assert.equal(clock.quota.white, 100);
  });

  test('never lets the quota build beyond seven moves’ worth', () => {
    let clock = running();
    for (let move = 0; move < 20; move += 1) {
      const now = T0 + move * 1000;
      clock = step({ ...clock, turn: 'white', runningSince: now }, now + 500, 0, true).clock;
    }
    assert.equal(clock.quota.white, 700);
  });

  test('a faked lag gains nothing beyond what the quota allows over many moves', () => {
    let clock = running();
    let charged = 0;
    for (let move = 0; move < 10; move += 1) {
      const now = T0 + move * 10_000;
      const before = clock.remaining.white;
      clock = step({ ...clock, turn: 'white', runningSince: now }, now + 1000, 1000, true).clock;
      charged += 100 - (before - clock.remaining.white);
    }
    // Compensation over ten moves is the starting quota plus ten gains, and at most the lag claimed.
    assert.ok(charged <= 300 + 10 * 100);
    assert.equal(charged, 1000);
  });
});

describe('flags', () => {
  test('a move arriving after the mover’s time ran out is flagged', () => {
    const almostOut = { ...running(), remaining: { white: 100, black: 60_000 } };
    assert.equal(step(almostOut, T0 + 900, undefined, true).flagged, false);
    assert.equal(step(almostOut, T0 + 1000, undefined, true).flagged, true);
    // Lag compensation can save a move that arrived late.
    assert.equal(step(almostOut, T0 + 1500, 60, true).flagged, false);
  });

  test('the server’s check allows the quota as grace, at most two seconds', () => {
    const almostOut = { ...running(), remaining: { white: 100, black: 60_000 } };
    assert.equal(outOfTime(almostOut, 'white', T0 + 1000, false), true);
    // 2,994 ms is 299 cs; 2,995 rounds up to 300.
    assert.equal(outOfTime(almostOut, 'white', T0 + 2994, true), false);
    assert.equal(outOfTime(almostOut, 'white', T0 + 2995, true), true);
    assert.equal(outOfTime(almostOut, 'white', T0 + 3000, true), true);
    assert.equal(flagDueAt(almostOut), T0 + 3000);
    const smallQuota = { ...almostOut, quota: { white: 50, black: 300 } };
    assert.equal(flagDueAt(smallQuota), T0 + 1500);
    assert.equal(outOfTime(smallQuota, 'white', T0 + 1500, true), true);
  });

  test('the side not to move is out of time only with nothing left', () => {
    const clock = running();
    assert.equal(outOfTime(clock, 'black', T0 + 99_999_999, true), false);
    assert.equal(outOfTime({ ...clock, remaining: { white: 60_000, black: 0 } }, 'black', T0, true), true);
  });
});

describe('stop and giveTime', () => {
  test('stopping charges the side to move for their time so far', () => {
    const clock = stop(running(), T0 + 4000);
    assert.equal(clock.remaining.white, 60_000 - 400);
    assert.equal(clock.runningSince, undefined);
  });

  test('time can be given to either side', () => {
    const clock = giveTime(giveTime(running(), 'white', 2000), 'black', 1000);
    assert.deepEqual(clock.remaining, { white: 62_000, black: 61_000 });
  });
});
