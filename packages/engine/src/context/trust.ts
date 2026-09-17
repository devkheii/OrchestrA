import { INSTRUCTION_BEARING } from "@dem/protocol";
import type { ContextBlock, TaintState, TrustLevel } from "@dem/protocol";

/**
 * Context assembly and taint tracking (invariants 9 and 10; tests SEC-016,
 * SEC-007).
 *
 * The defence is structural, not detection-based. We do not try to recognise
 * every phrasing of "ignore previous instructions" — that is an arms race
 * against natural language, and losing it once is enough. Instead file and web
 * content is placed where an instruction has no standing, and the run's
 * privileges drop while such content is present.
 */

export interface AssembledPrompt {
  /** Instruction-bearing content: system policy and the user's own message. */
  instructions: string;
  /** Everything else, quoted as data with its origin attached. */
  data: string;
  taint: TaintState;
}

/** Trust levels whose content is data, whatever it says. */
function isData(trust: TrustLevel): boolean {
  return !INSTRUCTION_BEARING.includes(trust);
}

export function assemblePrompt(blocks: readonly ContextBlock[]): AssembledPrompt {
  const instructions: string[] = [];
  const data: string[] = [];

  for (const block of blocks) {
    if (isData(block.trust)) {
      // Origin is attached so the model can weigh the source, and so a reader
      // of the transcript can see where a claim came from.
      data.push(
        `<${block.trust} origin="${block.origin}">\n${block.content}\n</${block.trust}>`,
      );
    } else {
      instructions.push(block.content);
    }
  }

  return {
    instructions: instructions.join("\n\n"),
    data: data.join("\n\n"),
    taint: taintOf(blocks),
  };
}

/**
 * A run is TAINTED once any `external` block has entered it (invariant 10).
 *
 * Workspace files are untrusted as *data* — they are never promoted to
 * instructions — but they do not taint the run on their own. The user chose
 * this workspace; they did not choose what a fetched page contains.
 */
export function taintOf(blocks: readonly ContextBlock[]): TaintState {
  return blocks.some((block) => block.trust === "external") ? "TAINTED" : "CLEAN";
}
