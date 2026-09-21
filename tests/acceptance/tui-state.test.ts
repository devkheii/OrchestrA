import { describe, expect, it } from "vitest";
import { appendDelta, line, settle, trim } from "@dem/cli";

/**
 * The session's state, without a terminal.
 *
 * A TUI whose logic lives inside components can only be checked by looking at
 * it, and the approval path is the last thing in this harness that should be
 * verified by eye. So the view renders state and this is where the state is
 * tested.
 */

describe("Streaming into the transcript", () => {
  it("extends the line being streamed rather than adding one per delta", () => {
    // Deltas arrive many per second and each one re-renders. A thousand-element
    // list is a terminal redrawing a thousand elements.
    let lines = appendDelta([], "Hel");
    lines = appendDelta(lines, "lo ");
    lines = appendDelta(lines, "world");

    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("Hello world");
    expect(lines[0]!.streaming).toBe(true);
  });

  it("starts a new line when the last one is not a stream", () => {
    const lines = appendDelta([line("user", "hi")], "answer");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.role).toBe("assistant");
  });

  it("starts a new line after the previous answer settled", () => {
    // Two turns are two answers, not one that grew.
    let lines = appendDelta([], "first");
    lines = settle(lines);
    lines = appendDelta(lines, "second");

    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe("first");
    expect(lines[1]!.text).toBe("second");
  });

  it("settling is safe when nothing is streaming", () => {
    const lines = settle([line("user", "hi")]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.streaming).toBeUndefined();
  });
});

describe("Keeping the transcript bounded", () => {
  it("keeps the most recent lines", () => {
    // A session running for an hour must not hold every token it rendered.
    // The whole conversation is in the event log either way — `dem log`.
    const many = Array.from({ length: 60 }, (_, i) => line("user", `m${i}`));
    const kept = trim(many, 10);

    expect(kept).toHaveLength(10);
    expect(kept.at(-1)!.text).toBe("m59");
    expect(kept[0]!.text).toBe("m50");
  });

  it("leaves a short transcript alone", () => {
    const few = [line("user", "a"), line("assistant", "b")];
    expect(trim(few, 10)).toHaveLength(2);
  });
});

describe("Line identity", () => {
  it("gives every line a distinct key, so a re-render does not reuse one", () => {
    const lines = [line("user", "a"), line("user", "a"), line("user", "a")];
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
  });
});
