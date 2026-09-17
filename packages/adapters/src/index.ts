import { NotImplemented } from "@dem/protocol";

/**
 * Provider and tool adapters. FakeProvider lands first so the security suite
 * never depends on a model being loaded (plan 4.3).
 */
export interface ModelEvent {
  type: "delta" | "done" | "error";
  text?: string;
}

export function fakeProvider(_script: readonly string[]): AsyncIterable<ModelEvent> {
  throw new NotImplemented("fakeProvider", "phase-1");
}
