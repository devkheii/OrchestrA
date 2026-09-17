import { CAP_TEXT_GENERATE, CAP_TOOL_CALL } from "@dem/protocol";
import type {
  ModelEvent,
  ModelRequest,
  Provider,
  ProviderHealth,
  RunContext,
  ToolCall,
} from "@dem/protocol";

/**
 * A provider that replays a fixed script (plan 4.3).
 *
 * This exists so the security and lifecycle suites never need a model loaded.
 * A security test that depends on a multi-gigabyte GGUF being present is a
 * security test that quietly stops being run, and the tests guarding the
 * perimeter are the last ones that should be skippable.
 *
 * It is also the only provider whose output is exactly reproducible, which is
 * what makes assertions about ordering, cancellation, tool sequencing and
 * audit content possible at all.
 */

/** One model turn: some text, and any tool calls it ends with. */
export interface FakeTurn {
  text?: string | readonly string[];
  toolCalls?: readonly ToolCall[];
  reason?: "stop" | "length";
}

export class FakeProvider implements Provider {
  readonly id = "fake";
  private turn = 0;

  /**
   * @param script chunks for a single text reply, or a list of turns when the
   *   test needs a tool loop. Omitted, the reply is derived from the request so
   *   different inputs give different — but still deterministic — output.
   */
  constructor(private readonly script?: readonly string[] | readonly FakeTurn[]) {}

  capabilities(): readonly string[] {
    return [CAP_TEXT_GENERATE, CAP_TOOL_CALL];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: "fake provider is always available" };
  }

  async *run(request: ModelRequest, context?: RunContext): AsyncIterable<ModelEvent> {
    const turn = this.nextTurn(request);

    const chunks =
      typeof turn.text === "string" ? [turn.text] : (turn.text ?? []);

    for (const text of chunks) {
      if (context?.signal?.aborted) {
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "delta", text };
    }

    for (const call of turn.toolCalls ?? []) {
      yield { type: "tool_call", call };
    }

    // Checked again: the last chunk may have been what triggered the abort.
    yield {
      type: "done",
      reason: context?.signal?.aborted ? "cancelled" : (turn.reason ?? "stop"),
    };
  }

  private nextTurn(request: ModelRequest): FakeTurn {
    if (!this.script) return { text: derive(request) };

    if (isTextScript(this.script)) return { text: this.script };

    // Turns are consumed in order. Past the end the model has nothing further
    // to say, which is how a scripted loop terminates.
    const turn = this.script[this.turn];
    this.turn += 1;
    return turn ?? { text: "" };
  }
}

function isTextScript(script: readonly string[] | readonly FakeTurn[]): script is readonly string[] {
  return script.length === 0 || typeof script[0] === "string";
}

/** Deterministic echo, so a caller can tell which prompt produced which reply. */
function derive(request: ModelRequest): string[] {
  const last = request.messages.at(-1)?.content ?? "";
  return [`[fake] `, `you said: `, last];
}
