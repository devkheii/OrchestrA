import { createHash } from "node:crypto";
import { CAP_TOOL_CALL } from "@dem/protocol";
import type {
  ModelMessage,
  Provider,
  SessionEvent,
  SessionId,
  ToolCall,
} from "@dem/protocol";
import { runToolCall, type CallPolicy, type SessionStore, type ToolRegistry } from "@dem/engine";

/**
 * The agent loop: model, tool, model (invariant 36).
 *
 * The loop holds no state of its own. Everything it needs to continue — the
 * conversation, the tool results, the call waiting on approval — is rebuilt
 * from the event log each time it runs. That is what makes approval possible
 * without a resident run: the daemon can stop mid-task, the user can answer
 * minutes later from another terminal, and the loop picks up from the record
 * rather than from memory it no longer has.
 *
 * It also means an approval cannot be forged by a client holding a stale
 * handle. The pending call is whatever the log says it is.
 */

export type RunStatus = "completed" | "awaiting_approval" | "error" | "cancelled" | "budget";

export interface RunOutcome {
  status: RunStatus;
  /** Set when the loop stopped for approval, so the API can say what is asked. */
  pending?: { call: ToolCall; rule: string };
  detail?: string;
}

export interface LoopDeps {
  store: SessionStore;
  provider: Provider;
  registry: ToolRegistry;
  policy: Omit<CallPolicy, "approved">;
  maxRounds: number;
  signal: AbortSignal;
}

export async function advanceRun(deps: LoopDeps, id: SessionId): Promise<RunOutcome> {
  const { store, provider, registry, policy, maxRounds, signal } = deps;
  const now = () => new Date().toISOString();

  // Which calls this turn has already made, so a model can be told when it is
  // repeating itself rather than discovering something.
  const seen = new Map<string, number>();

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) return { status: "cancelled" };

    const events = await store.events(id);

    // A call already approved and not yet run takes priority over asking the
    // model for anything new: the user answered, so honour it before moving on.
    const approved = pendingApprovedCall(events);
    if (approved) {
      const outcome = await executeAndRecord(deps, id, approved, true, seen);
      if (outcome) return outcome;
      continue;
    }

    await store.append(id, {
      type: "model.started",
      sessionId: id,
      at: now(),
      provider: provider.id,
      model: provider.id,
    });

    const calls: ToolCall[] = [];
    let failed: string | undefined;
    let answer = "";

    // Tools are offered only to a provider that says it can call them.
    //
    // Handing them to one that cannot does not degrade gracefully: the model
    // sees a task it has no way to perform, writes tool-call syntax as prose,
    // and then invents the result. Observed doing exactly that — it fabricated
    // a file's contents and the harness printed the fabrication as an answer.
    const canCallTools = provider.capabilities().includes(CAP_TOOL_CALL);
    const messages = conversationFrom(events);
    if (!canCallTools) messages.unshift({ role: "system", content: NO_TOOLS_NOTICE });

    for await (const event of provider.run(
      {
        messages,
        ...(canCallTools ? { tools: registry.list().map(toDefinition) } : {}),
      },
      { signal },
    )) {
      if (event.type === "rationale") {
        await store.append(id, {
          type: "answer.rationale",
          sessionId: id,
          at: now(),
          text: event.text,
        });
      } else if (event.type === "delta") {
        answer += event.text;
        await store.append(id, { type: "answer.delta", sessionId: id, at: now(), text: event.text });
      } else if (event.type === "tool_call") {
        calls.push(event.call);
      } else if (event.type === "error") {
        failed = event.message;
      } else if (event.type === "done" && event.reason === "cancelled") {
        await store.append(id, {
          type: "session.cancelled",
          sessionId: id,
          at: now(),
          reason: "cancelled during generation",
        });
        return { status: "cancelled" };
      }
    }

    if (failed) {
      await store.append(id, { type: "session.completed", sessionId: id, at: now(), status: "error" });
      return { status: "error", detail: failed };
    }

    if (calls.length === 0) {
      const simulated = simulatedToolUse(answer);
      if (simulated) {
        // The answer describes a tool call that never happened, which means
        // any result it reports was invented (invariant 41). Reported as an
        // error rather than scrubbed: removing the syntax would leave the
        // conclusion drawn from the fabricated output standing, and that
        // conclusion is the harmful part.
        await store.append(id, {
          type: "session.completed",
          sessionId: id,
          at: now(),
          status: "error",
        });
        return {
          status: "error",
          detail:
            `the model wrote tool-call syntax (${simulated}) instead of calling a tool, ` +
            `so any result it reports was invented. No tool ran.`,
        };
      }

      await store.append(id, { type: "session.completed", sessionId: id, at: now(), status: "ok" });
      return { status: "completed" };
    }

    for (const call of calls) {
      const outcome = await executeAndRecord(deps, id, call, false, seen);
      if (outcome) return outcome;
    }
  }

  // Out of rounds. Recorded as an error rather than a quiet stop: a task that
  // ran out of budget mid-way has not been done, and saying nothing would let
  // a caller read the transcript as a finished job.
  await store.append(id, { type: "session.completed", sessionId: id, at: now(), status: "error" });
  return { status: "budget", detail: `exceeded ${maxRounds} tool rounds` };
}

/** Runs one call through the broker and records it. Returns a stop, or undefined to continue. */

/**
 * What to tell a model that has made this exact call before (SPEC 22.1).
 *
 * Measured: with search working and returning the right answer, an 8B model
 * made the identical `glob` call six times in one turn and never answered the
 * question. The harness cannot make a model reason better, but it can stop
 * letting it treat a repeated call as new information - the one thing it
 * plainly does not know.
 *
 * Not a refusal. The result is still returned; this is added to it.
 *
 * @param count how many times this exact call has been made this turn.
 */
export function repeatNotice(count: number): string | undefined {
  if (count < 2) return undefined;
  if (count === 2) {
    return "(You already made this exact call and got this exact result. " +
      "You have this information - answer the question, or try something different.)";
  }
  return `(You have now made this exact call ${count} times and received the same ` +
    `result every time. Repeating it will not produce anything new. Answer the ` +
    `question with what you have, or say what is missing.)`;
}

async function executeAndRecord(
  deps: LoopDeps,
  id: SessionId,
  call: ToolCall,
  approved: boolean,
  seen?: Map<string, number>,
): Promise<RunOutcome | undefined> {
  const { store, registry, policy } = deps;
  const now = () => new Date().toISOString();

  await store.append(id, {
    type: "tool.requested",
    sessionId: id,
    at: now(),
    tool: call.name,
    argsHash: hash(JSON.stringify(call.arguments)),
    call,
  });

  const result = await runToolCall(registry, call, { ...policy, approved });

  // Counted per turn, so a re-read after an edit in a later turn is not
  // treated as repetition.
  const repeatKey = `${call.name}:${JSON.stringify(call.arguments)}`;
  const seenCount = (seen?.get(repeatKey) ?? 0) + 1;
  seen?.set(repeatKey, seenCount);
  const notice = repeatNotice(seenCount);
  if (notice && result.executed && typeof result.output === "string") {
    result.output = `${result.output}\n\n${notice}`;
  }

  await store.append(id, {
    type: "permission.resolved",
    sessionId: id,
    at: now(),
    decision: result.decision,
  });

  if (result.needsApproval) {
    await store.append(id, {
      type: "permission.requested",
      sessionId: id,
      at: now(),
      request: {
        action: registry.get(call.name)?.action ?? "shell",
        mode: policy.mode,
        taint: policy.taint,
        sandbox: policy.sandbox,
        subject: subjectOf(call),
      },
      call,
    });
    return { status: "awaiting_approval", pending: { call, rule: result.decision.rule } };
  }

  await store.append(id, { type: "tool.started", sessionId: id, at: now(), tool: call.name });
  await store.append(id, {
    type: "tool.finished",
    sessionId: id,
    at: now(),
    tool: call.name,
    ok: result.executed,
    toolCallId: call.id,
    result: result.executed ? render(result.output) : (result.error ?? "failed"),
  });

  return undefined;
}

/**
 * The call the user approved and that has not run yet.
 *
 * Read from the log rather than held in memory, so an approval that arrives
 * after a restart still finds its call.
 */
function pendingApprovedCall(events: readonly SessionEvent[]): ToolCall | null {
  let pending: ToolCall | null = null;
  let granted = false;

  // The whole log is walked before answering. Returning at the grant would
  // hand back a call that a later `tool.finished` already completed, and the
  // loop would run it again on every round until the budget ran out — which is
  // exactly what it did before this was written out.
  for (const event of events) {
    if (event.type === "permission.requested") {
      pending = event.call;
      granted = false;
    } else if (event.type === "permission.granted") {
      granted = true;
    } else if (event.type === "tool.finished") {
      pending = null;
      granted = false;
    }
  }

  return granted ? pending : null;
}

/**
 * Rebuild the model conversation from the event log.
 *
 * The log is the state, so this is a projection rather than a cache. Answer
 * text and tool results replay as they were recorded; rationale does not — it
 * was the model's note to the reader, not part of the exchange.
 */
function conversationFrom(events: readonly SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let assistant = "";

  // Calls seen since the last assistant turn was flushed. An assistant turn
  // has to carry the tool_use blocks its tool results answer: Anthropic
  // rejects a tool_result with no matching call, and a projection that drops
  // them cannot rebuild the conversation at all.
  let pendingCalls: ToolCall[] = [];

  const flushWith = () => {
    if (assistant || pendingCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistant,
        ...(pendingCalls.length > 0 ? { toolCalls: pendingCalls } : {}),
      });
    }
    assistant = "";
    pendingCalls = [];
  };

  for (const event of events) {
    if (event.type === "message.received") {
      flushWith();
      messages.push({ role: "user", content: event.content ?? "" });
    } else if (event.type === "answer.delta") {
      assistant += event.text;
    } else if (event.type === "tool.requested") {
      if (event.call) pendingCalls.push(event.call);
    } else if (event.type === "tool.finished") {
      flushWith();
      messages.push({
        role: "tool",
        content: event.result ?? "",
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      });
    }
  }
  flushWith();
  return messages;
}

function toDefinition(spec: { name: string; description: string; parameters: Record<string, unknown> }) {
  return { name: spec.name, description: spec.description, parameters: spec.parameters };
}

const NO_TOOLS_NOTICE =
  "You have no tools in this session. You cannot read files, run commands, or " +
  "search. If the request needs one, say plainly that you cannot do it here. " +
  "Never write tool-call syntax and never state the result of a call you did " +
  "not make.";

/**
 * Markers of a model narrating a tool call rather than making one.
 *
 * The first version of this was a list of literal tags, and it missed the very
 * next model it met: a local Qwen wrote `<tool>{"name":...}</tool>`, which was
 * not on the list, so the narration passed through as an answer. That is the
 * denylist failure this codebase argues against in two other places, made
 * here for a third time.
 *
 * These patterns are shaped by kind rather than by spelling. Any tag whose
 * name contains "tool" or "function" counts, in any of the wrappings models
 * reach for, and the last rule catches the shape itself: an object carrying a
 * name and arguments, which is what a tool call is whatever it is wrapped in.
 */
const SIMULATED_TOOL_SYNTAX: ReadonlyArray<[string, RegExp]> = [
  // <tool>, <tool_call>, <function_calls>, </function_response>, <toolcall> …
  ["a tool-shaped tag", /<\/?\s*(?:tool|function)[a-z_]*\s*>/i],
  ["<invoke name=", /<invoke\s+name\s*=/i],
  // ```tool_code, ```tool_call, ```function
  ["a tool-shaped code fence", /```\s*(?:tool|function)[a-z_]*/i],
  // [TOOL_CALL], [/TOOL], <|tool_call|> …
  ["a tool-shaped delimiter", /[[|<]\s*\/?\s*tool_?call\s*[\]|>]/i],
  // The shape itself: a JSON object naming a call and its arguments.
  ["a call-shaped JSON object", /\{\s*"(?:name|tool|function)"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|parameters|input)"\s*:/i],
];

function simulatedToolUse(answer: string): string | null {
  for (const [label, pattern] of SIMULATED_TOOL_SYNTAX) {
    if (pattern.test(answer)) return label;
  }
  return null;
}

function subjectOf(call: ToolCall): string {
  const args = call.arguments;
  return typeof args["command"] === "string" ? args["command"] : String(args["path"] ?? call.name);
}

function render(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
