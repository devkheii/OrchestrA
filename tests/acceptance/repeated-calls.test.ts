import { describe, expect, it } from "vitest";
import { repeatNotice } from "@dem/daemon";

/**
 * Telling a model it has already asked this (SPEC §22.1).
 *
 * Measured. With search working and returning the right answer, an 8B model
 * asked `glob {"pattern":"packages/engine/src/tools/*"}` six times in one
 * turn, received the identical file list each time, and never answered the
 * question. The round budget ended the turn.
 *
 * The harness cannot make a model reason better. It can stop letting it think
 * a repeated call is new information, which is the one thing it plainly does
 * not know.
 *
 * Not a refusal: the call still runs and the result is still returned. What is
 * added is the fact that it is the same as last time.
 */

describe("A call that has already been made", () => {
  it("says nothing the first time", () => {
    expect(repeatNotice(1)).toBeUndefined();
  });

  it("says so on a repeat", () => {
    const notice = repeatNotice(2);
    expect(notice).toBeTruthy();
    expect(notice).toMatch(/already|same/i);
  });

  it("is more insistent as it continues, because the first notice did not work", () => {
    const second = repeatNotice(2) ?? "";
    const fifth = repeatNotice(5) ?? "";
    expect(fifth.length).toBeGreaterThan(second.length);
    expect(fifth).toMatch(/5|five|times/i);
  });

  it("tells it what to do instead, rather than only what it did", () => {
    // "You repeated yourself" is a complaint. A model needs the next move.
    expect(repeatNotice(3)).toMatch(/answer|different|enough/i);
  });
});
