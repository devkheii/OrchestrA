import { CAP_TEXT_GENERATE, CAP_TOOL_CALL } from "@dem/protocol";
import type {
  ModelEvent,
  ModelRequest,
  Provider,
  ProviderHealth,
  RunContext,
} from "@dem/protocol";

/**
 * A provider that streams a fixed script (plan 4.3).
 *
 * This exists so the security and lifecycle suites never need a model loaded.
 * A security test that depends on a multi-gigabyte GGUF being present is a
 * security test that quietly stops being run, and the tests guarding the
 * perimeter are the last ones that should be skippable.
 *
 * It is also the only provider whose output is exactly reproducible, which is
 * what makes assertions about ordering, cancellation and audit content
 * possible at all.
 */
export class FakeProvider implements Provider {
  readonly id = "fake";

  /**
   * @param script chunks to emit in order. When omitted, the reply is derived
   *   from the request so different inputs give different — but still
   *   deterministic — output.
   */
  constructor(private readonly script?: readonly string[]) {}

  capabilities(): readonly string[] {
    return [CAP_TEXT_GENERATE, CAP_TOOL_CALL];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: "fake provider is always available" };
  }

  async *run(request: ModelRequest, context?: RunContext): AsyncIterable<ModelEvent> {
    const chunks = this.script ?? derive(request);

    for (const text of chunks) {
      if (context?.signal?.aborted) {
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "delta", text };
    }

    // Checked again: the last chunk may have been what triggered the abort.
    yield { type: "done", reason: context?.signal?.aborted ? "cancelled" : "stop" };
  }
}

/** Deterministic echo, so a caller can tell which prompt produced which reply. */
function derive(request: ModelRequest): string[] {
  const last = request.messages.at(-1)?.content ?? "";
  return [`[fake] `, `you said: `, last];
}
