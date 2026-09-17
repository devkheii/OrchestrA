import { NotImplemented } from "@dem/protocol";
import type { ContextBlock, TaintState } from "@dem/protocol";

/**
 * Context assembly and taint tracking (invariants 9 and 10; tests SEC-016,
 * SEC-007).
 *
 * The defence is structural, not detection-based. We do not try to recognise
 * every phrasing of "ignore previous instructions"; we make file and web
 * content occupy a position in the prompt where an instruction has no force,
 * and we lower the run's privileges once such content is present.
 */

export interface AssembledPrompt {
  /** Instruction-bearing content: system policy and the user's own message. */
  instructions: string;
  /** Everything else, framed as quoted data with its origin attached. */
  data: string;
  taint: TaintState;
}

/**
 * Assemble blocks into a prompt. External and workspace blocks are rendered
 * as attributed data and can never be promoted into the instruction section,
 * whatever they contain.
 */
export function assemblePrompt(_blocks: readonly ContextBlock[]): AssembledPrompt {
  throw new NotImplemented("assemblePrompt", "SEC-016");
}

/** A run is TAINTED once any `external` block has entered it (invariant 10). */
export function taintOf(_blocks: readonly ContextBlock[]): TaintState {
  throw new NotImplemented("taintOf", "SEC-016");
}
