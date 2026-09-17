#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI that emits the same stream-json frames.
 *
 * A real call spends the user's Claude subscription quota — the same five-hour
 * window they use for their own work — and takes seconds. So the adapter's
 * behaviour (frame parsing, thinking suppression, cancellation, error handling)
 * is exercised against this instead. A suite that eats the quota it is meant to
 * protect is a suite that stops being run.
 *
 * Behaviour is driven by the prompt it receives on stdin, so a test picks a
 * scenario by asking for it.
 */

let prompt = "";
process.stdin.on("data", (d) => (prompt += d.toString()));
process.stdin.on("end", () => {
  if (process.argv.includes("--version")) {
    process.stdout.write("9.9.9 (Fake Claude Code)\n");
    process.exit(0);
  }

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const textDelta = (text) =>
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

  emit({ type: "system", subtype: "init", tools: [], argv: process.argv.slice(2) });

  if (prompt.includes("SCENARIO_ERROR")) {
    emit({ type: "result", subtype: "error", is_error: true, result: "upstream failed" });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_THINKING")) {
    // The reasoning channel, in the shape the real CLI emits it.
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "SECRET_REASONING" } },
    });
    textDelta("visible answer");
    emit({ type: "result", subtype: "success", is_error: false, result: "visible answer", stop_reason: "end_turn" });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_TRUNCATED")) {
    textDelta("cut off here");
    emit({ type: "result", subtype: "success", is_error: false, result: "cut off here", stop_reason: "max_tokens" });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_RESULT_ONLY")) {
    // No partial deltas at all — only the final result.
    emit({ type: "result", subtype: "success", is_error: false, result: "final only", stop_reason: "end_turn" });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_SLOW")) {
    let i = 0;
    const timer = setInterval(() => {
      textDelta(`chunk${i++} `);
      if (i > 50) clearInterval(timer);
    }, 30);
    return; // never exits on its own; the test cancels it
  }

  if (prompt.includes("SCENARIO_GARBAGE")) {
    process.stdout.write("this is not json\n");
    textDelta("still ");
    process.stdout.write("{broken\n");
    textDelta("works");
    emit({ type: "result", subtype: "success", is_error: false, result: "still works", stop_reason: "end_turn" });
    process.exit(0);
  }

  // Default: echo the prompt back so a test can assert delivery.
  textDelta("echo: ");
  textDelta(prompt.trim());
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `echo: ${prompt.trim()}`,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
  });
  process.exit(0);
});
